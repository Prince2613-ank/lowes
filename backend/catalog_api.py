"""Nationwide read API, independent of legacy local-coordinate calibration."""
import json
import os
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from backend.config import DATA_DIR
from backend.store_service import validate_store_id, InvalidStoreIdError

router = APIRouter(prefix="/api/catalog")


def root():
    return Path(os.getenv("LOWES_OUTPUT", str(DATA_DIR))).resolve()


def index():
    path = root() / "stores-index.json"
    if not path.exists():
        return {"stores": [], "message": "Run python scripts/run_pipeline.py to build the catalog"}
    return json.loads(path.read_text(encoding="utf-8"))


@router.get("/stores")
def stores():
    return index()


@router.get("/stores/{store_id}/map")
def store_map(store_id: str):
    try:
        validate_store_id(store_id)
    except InvalidStoreIdError:
        raise HTTPException(400, "Invalid store ID")
    entry = next((e for e in index()["stores"] if e["store_id"] == store_id), None)
    if entry is None:
        raise HTTPException(404, "Store not found")
    if not entry.get("map_file"):
        raise HTTPException(404, "Store map unavailable")
    path = (root() / entry["map_file"]).resolve()
    if root() not in path.parents or not path.is_file():
        raise HTTPException(404, "Store map unavailable")
    return FileResponse(path, media_type="application/geo+json")


@router.get("/report")
def report():
    path = root() / "pipeline-report.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"message": "Pipeline has not run"}
