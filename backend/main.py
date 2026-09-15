"""
FastAPI application for the Lowe's Map System.

Wires the store directory, floor-layout data, and transformation engine
together behind a small, read-mostly JSON API, and serves the static
Leaflet frontend.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

from backend import georeference, layout_service, store_service
from backend.config import ALLOWED_ORIGINS, FRONTEND_DIR, LAYOUT_IMAGES_DIR, LAYOUTS_DIR
from backend.models import GeoreferenceFile, Transform
from backend.store_service import InvalidStoreIdError, StoreNotFoundError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("lowes_map_system")

app = FastAPI(
    title="Lowe's Map System API",
    description=(
        "Associates an interactive store floor layout (local coordinates) "
        "with a real-world geographic location, via a configurable "
        "scale/rotation/translation transformation layer."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup_validation() -> None:
    """Fail fast: load and validate every store and every layout file on
    disk before accepting traffic."""
    logger.info("Validating store directory...")
    store_service.validate_all_stores()
    stores = store_service.list_stores()
    logger.info("Loaded %d store(s).", len(stores))

    logger.info("Validating layout files...")
    layout_service.validate_all_layouts()
    logger.info("Loaded %d layout file(s).", len(layout_service.list_layout_ids()))

    logger.info("Validating building footprints...")
    georeference.validate_all_buildings()

    logger.info("Validating georeference control-point files...")
    georeference.validate_all_georeference()

    # Cross-check: every store's layout_id must resolve to a real layout file.
    layout_ids = set(layout_service.list_layout_ids())
    for store in stores:
        if store.layout_id not in layout_ids:
            raise RuntimeError(
                f"Store {store.store_id!r} references missing layout_id "
                f"{store.layout_id!r}"
            )
    logger.info("Startup validation passed.")


# ---------------------------------------------------------------------------
# Store endpoints
# ---------------------------------------------------------------------------

@app.get("/api/stores")
def api_list_stores():
    return [s.model_dump() for s in store_service.list_stores()]


@app.get("/api/stores/{store_id}")
def api_get_store(store_id: str):
    try:
        store = store_service.get_store(store_id)
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")
    return store.model_dump()


# ---------------------------------------------------------------------------
# Layout endpoints
# ---------------------------------------------------------------------------

@app.get("/api/stores/{store_id}/layout")
def api_get_layout(store_id: str):
    """Geographic (lat/lon-transformed) view of the store's floor layout."""
    try:
        store_service.get_store(store_id)  # 404s if store doesn't exist
        return layout_service.get_geo_layout(store_id)
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")
    except layout_service.LayoutNotFoundError:
        raise HTTPException(status_code=404, detail="Layout not found")


@app.get("/api/stores/{store_id}/layout/raw")
def api_get_layout_raw(store_id: str):
    """Original local-coordinate layout, unmodified."""
    try:
        store_service.get_store(store_id)
        return layout_service.get_raw_layout(store_id).model_dump()
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")
    except layout_service.LayoutNotFoundError:
        raise HTTPException(status_code=404, detail="Layout not found")


@app.get("/api/stores/{store_id}/map")
def api_get_map(store_id: str):
    """Combined view: store info + anchor + full geographic layout."""
    try:
        store = store_service.get_store(store_id)
        geo = layout_service.get_geo_layout(store_id)
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")
    except layout_service.LayoutNotFoundError:
        raise HTTPException(status_code=404, detail="Layout not found")

    return {
        "store": store.model_dump(),
        "anchor": geo["anchor"],
        "layout": {
            "departments": geo["departments"],
            "aisles": geo["aisles"],
            "racks": geo["racks"],
            "markers": geo["markers"],
        },
    }


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------

class CalibrationUpdate(BaseModel):
    anchor_latitude: float
    anchor_longitude: float
    scale: float
    scale_x: Optional[float] = None
    scale_y: Optional[float] = None
    rotation_degrees: float
    offset_x: float
    offset_y: float


@app.post("/api/stores/{store_id}/calibrate")
def api_save_calibration(store_id: str, body: CalibrationUpdate):
    """Persist new anchor/transform values to the store's layout file on
    disk, then invalidate cached geo-transformed data for that store."""
    try:
        store_service.get_store(store_id)
        path = layout_service._layout_path(store_id)  # validated, safe path
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")

    if not path.exists():
        raise HTTPException(status_code=404, detail="Layout not found")

    try:
        new_transform = Transform(
            scale=body.scale,
            scale_x=body.scale_x,
            scale_y=body.scale_y,
            rotation_degrees=body.rotation_degrees,
            offset_x=body.offset_x,
            offset_y=body.offset_y,
        )
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    raw["anchor"] = {
        "latitude": body.anchor_latitude,
        "longitude": body.anchor_longitude,
    }
    raw["transform"] = new_transform.model_dump()

    # Validate the full document before writing it back.
    from backend.models import Layout as LayoutModel

    try:
        LayoutModel.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    with open(path, "w", encoding="utf-8") as f:
        json.dump(raw, f, indent=2)

    layout_service.invalidate(store_id)
    store_service.sync_store_georeference(store_id, raw["anchor"], raw["transform"])
    logger.info("Saved calibration for store %s", store_id)

    return {"status": "ok", "anchor": raw["anchor"], "transform": raw["transform"]}


# ---------------------------------------------------------------------------
# Building footprint + georeferencing
# ---------------------------------------------------------------------------

@app.get("/api/stores/{store_id}/building")
def api_get_building(store_id: str):
    """Real-world building footprint GeoJSON for a store."""
    try:
        store_service.get_store(store_id)
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")

    try:
        return georeference.load_building(store_id)
    except georeference.BuildingNotFoundError:
        return {"status": "needs_calibration", "reason": "building footprint unavailable"}


@app.get("/api/stores/{store_id}/georeference")
def api_get_georeference(store_id: str):
    """Saved control points for a store."""
    try:
        store_service.get_store(store_id)
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")

    try:
        georef = georeference.load_georeference(store_id)
    except georeference.GeoreferenceNotFoundError:
        return {"status": "needs_calibration", "reason": "no control points saved yet"}

    result = georef.model_dump()
    if georef.svg is not None and georef.transform is not None:
        layout = layout_service.get_raw_layout(store_id)
        result["svg_reference_corners"] = georeference.svg_reference_corners(
            georef.transform, layout.anchor, georef.svg.width, georef.svg.height
        )
    return result


@app.post("/api/stores/{store_id}/georeference")
def api_save_georeference(store_id: str, body: GeoreferenceFile):
    """Save control points for a store (does not itself change the applied
    calibration - use /calibrate, or POST /auto-align's suggested transform,
    to actually apply a fitted transform)."""
    try:
        store_service.get_store(store_id)
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")

    if body.store_id != store_id:
        raise HTTPException(status_code=422, detail="georeference.store_id does not match URL store_id")

    georeference.save_georeference(store_id, body)

    result: dict = {"status": "ok", "control_points": [cp.model_dump() for cp in body.control_points]}

    layout = layout_service.get_raw_layout(store_id)

    if len(body.control_points) >= 2:
        fit = georeference.fit_similarity_from_control_points(body.control_points, layout.anchor)
        result["fitted_transform"] = fit

    if body.svg is not None:
        corner_points = georeference.corners_to_control_points(body.corners, body.svg.width, body.svg.height)
        if len(corner_points) >= 2:
            svg_fit = georeference.fit_similarity_from_control_points(corner_points, layout.anchor)
            result["svg_fitted_transform"] = svg_fit

    return result


@app.post("/api/stores/{store_id}/auto-align")
def api_auto_align(store_id: str):
    """Compute (but do not save) an automatic floor-plan-to-building
    alignment: bounding-box match against the real building footprint,
    refined by IoU-maximizing coordinate descent. Returns a `needs_calibration`
    status if no building footprint is on file - no coordinates are ever
    invented."""
    try:
        store_service.get_store(store_id)
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")

    if not georeference.building_exists(store_id):
        return {"status": "needs_calibration", "reason": "building footprint unavailable"}

    layout = layout_service.get_raw_layout(store_id)
    building = georeference.load_building(store_id)

    initial = georeference.calculate_initial_transform(building, layout)
    optimized = georeference.optimize_transform(initial, building, layout)

    transform = Transform(
        scale=layout.transform.scale,
        scale_x=optimized["scale_x"],
        scale_y=optimized["scale_y"],
        rotation_degrees=optimized["rotation_degrees"],
        offset_x=optimized["offset_x"],
        offset_y=optimized["offset_y"],
    )
    error_report = georeference.calculate_alignment_error(building, layout, transform)

    result = {
        "status": "ok",
        "anchor": {"latitude": layout.anchor.latitude, "longitude": layout.anchor.longitude},
        "transform": transform.model_dump(),
        "alignment_error_m": error_report["alignment_error_m"],
        "building_width_m": error_report["building_width_m"],
        "building_height_m": error_report["building_height_m"],
        "floor_plan_width_m": error_report["floor_plan_width_m"],
        "floor_plan_height_m": error_report["floor_plan_height_m"],
        "iou": error_report["iou"],
    }

    # If this store has an SVG floor plan registered, also auto-align it
    # against the same building - it has its own independent pixel scale/
    # aspect ratio, so it needs its own transform.
    try:
        georef = georeference.load_georeference(store_id)
    except georeference.GeoreferenceNotFoundError:
        georef = None

    if georef is not None and georef.svg is not None:
        svg_optimized = georeference.calculate_initial_svg_transform(
            building, layout.anchor, georef.svg.width, georef.svg.height
        )
        svg_transform = Transform(
            scale=1.0,
            scale_x=svg_optimized["scale_x"],
            scale_y=svg_optimized["scale_y"],
            rotation_degrees=svg_optimized["rotation_degrees"],
            offset_x=svg_optimized["offset_x"],
            offset_y=svg_optimized["offset_y"],
        )
        result["svg_transform"] = svg_transform.model_dump()
        result["svg_iou"] = svg_optimized["iou"]
        result["svg_reference_corners"] = georeference.svg_reference_corners(
            svg_transform, layout.anchor, georef.svg.width, georef.svg.height
        )

    return result


@app.get("/api/stores/{store_id}/alignment-report")
def api_alignment_report(store_id: str):
    """Alignment quality of the CURRENTLY SAVED calibration against the real
    building footprint."""
    try:
        store_service.get_store(store_id)
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")

    if not georeference.building_exists(store_id):
        return {"status": "needs_calibration", "reason": "building footprint unavailable"}

    layout = layout_service.get_raw_layout(store_id)
    building = georeference.load_building(store_id)
    error_report = georeference.calculate_alignment_error(building, layout)

    return {
        "store_id": store_id,
        "alignment_error_m": error_report["alignment_error_m"],
        "building_area_m2": error_report["building_area_m2"],
        "floor_plan_area_m2": error_report["floor_plan_area_m2"],
        "scale_x": error_report["scale_x"],
        "scale_y": error_report["scale_y"],
        "rotation_degrees": error_report["rotation_degrees"],
        "iou": error_report["iou"],
    }


@app.get("/api/stores/{store_id}/floorplan")
def api_get_floorplan(store_id: str):
    """The uploaded, authoritative SVG floor-plan for a store - preserved as
    vector data. Returns a `needs_calibration` status if no SVG is
    registered for this store yet."""
    try:
        store_service.get_store(store_id)
    except InvalidStoreIdError:
        raise HTTPException(status_code=400, detail="Invalid store_id")
    except StoreNotFoundError:
        raise HTTPException(status_code=404, detail="Store not found")

    try:
        georef = georeference.load_georeference(store_id)
    except georeference.GeoreferenceNotFoundError:
        return {"status": "needs_calibration", "reason": "no SVG floor plan registered"}

    if georef.svg is None:
        return {"status": "needs_calibration", "reason": "no SVG floor plan registered"}

    result = {
        "store_id": store_id,
        "type": "svg",
        "file": f"/static/layout-images/{georef.svg.file}",
        "width": georef.svg.width,
        "height": georef.svg.height,
        "opacity": georef.svg_opacity,
    }

    if georef.transform is not None:
        layout = layout_service.get_raw_layout(store_id)
        result["transform"] = georef.transform.model_dump()
        result["reference_corners"] = georeference.svg_reference_corners(
            georef.transform, layout.anchor, georef.svg.width, georef.svg.height
        )

    return result


# ---------------------------------------------------------------------------
# Static assets: uploaded floor-plan images (SVG, preserved as vector data -
# mounted BEFORE the frontend catch-all below so /static/... resolves here).
# ---------------------------------------------------------------------------

app.mount("/static/layout-images", StaticFiles(directory=str(LAYOUT_IMAGES_DIR)), name="layout-images")


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
