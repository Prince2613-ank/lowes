/* ==========================================================================
 * Lowe's Interactive Store Map - frontend application logic.
 *
 * Talks to the FastAPI backend for store directory + geo-transformed floor
 * layouts, renders them on a Leaflet map over OpenStreetMap tiles, and
 * provides a calibration mode that lets a user tune the per-store
 * anchor/scale/rotation/offset transform and save it back to the server.
 * ========================================================================== */

const DEFAULT_CENTER = [41.8140843218019, -72.71526758866406];
const DEFAULT_ZOOM = 18;

// Zoom thresholds driving progressive level-of-detail (see spec).
const ZOOM = {
    STORE_LEVEL: 18,
    DEPT_LABELS: 19,
    DEPT_LABELS_ALL: 20,
    AISLE_LABELS: 21,
    RACK_DETAIL: 22,
    MAX_DETAIL: 23,
};

const BASIC_INFO_ICONS = {
    returns: "↩",              // ↩
    restrooms: "🚻",       // 🚻
    checkouts: "💳",       // 💳
    store_pickup: "📦",    // 📦
    entrance_exit: "🚪",   // 🚪
    pickup_lockers: "🔐",  // 🔐
    pro_service_desk: "👷", // 👷
    customer_service_desk: "ℹ", // ℹ
};

const STORE_SERVICE_ICONS = {
    key_copying: "🔑",       // 🔑
    millwork_desk: "🛋",     // 🛋
    wood_cutting: "🪚",       // 🪚
    wire_cutting: "⚡",            // ⚡
    flooring_desk: "📐",      // 📐
    blind_cutting: "🪟",      // 🪟
    glass_cutting: "🕳",      // 🕳ish - pane
    carpet_cutting: "✂",          // ✂
    appliance_desk: "🔌",     // 🔌
    home_decor_desk: "🏠",    // 🏠
    chain_rope_cutting: "⛓",       // ⛓
    kitchen_design_desk: "🍽", // 🍽
};

function iconFor(category, markerType) {
    if (category === "basic_information") return BASIC_INFO_ICONS[markerType] || "ℹ";
    if (category === "store_service") return STORE_SERVICE_ICONS[markerType] || "🔧";
    return "•";
}

function humanize(s) {
    if (!s) return "";
    return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ---------------------------------------------------------------------- */
/* SVG floor-plan overlay - a real Leaflet layer, not a fixed-position div. */
/*                                                                          */
/* The uploaded floor-plan SVG is kept as vector data (never rasterized)   */
/* and geographically anchored via three reference corners (top-left,     */
/* top-right, bottom-left in the SVG's own pixel space). Three points     */
/* fully determine a 2D affine placement (translation + rotation + scale, */
/* and shear if ever needed) - the same technique used by the standard    */
/* Leaflet.ImageOverlay.Rotated plugin, implemented directly here so no   */
/* extra script tag/CDN dependency is required.                          */
/* ---------------------------------------------------------------------- */

const SvgCornerOverlay = L.Layer.extend({
    initialize(svgElement, corners, options) {
        this._svgElement = svgElement;
        this._svgWidth = svgElement.width.baseVal.value || parseFloat(svgElement.getAttribute("width"));
        this._svgHeight = svgElement.height.baseVal.value || parseFloat(svgElement.getAttribute("height"));
        this.setCorners(corners, /* reset */ false);
        L.setOptions(this, options);
    },

    onAdd(map) {
        this._map = map;
        if (!this._container) {
            this._container = L.DomUtil.create("div", "svg-corner-overlay-container");
            this._container.appendChild(this._svgElement);
        }
        this._svgElement.style.position = "absolute";
        this._svgElement.style.left = "0";
        this._svgElement.style.top = "0";
        this._svgElement.style.transformOrigin = "0 0";
        this._svgElement.style.pointerEvents = "none";
        this._svgElement.style.opacity = this.options.opacity != null ? this.options.opacity : 1;
        map.getPane(this.options.pane || "overlayPane").appendChild(this._container);
        map.on("zoom move viewreset resize", this._reset, this);
        this._reset();
        return this;
    },

    onRemove(map) {
        L.DomUtil.remove(this._container);
        map.off("zoom move viewreset resize", this._reset, this);
    },

    setCorners(corners, reset = true) {
        this._topLeft = L.latLng(corners.top_left.latitude, corners.top_left.longitude);
        this._topRight = L.latLng(corners.top_right.latitude, corners.top_right.longitude);
        this._bottomLeft = L.latLng(corners.bottom_left.latitude, corners.bottom_left.longitude);
        if (reset) this._reset();
    },

    setOpacity(opacity) {
        this.options.opacity = opacity;
        if (this._svgElement) this._svgElement.style.opacity = opacity;
    },

    _reset() {
        if (!this._map || !this._topLeft) return;
        const map = this._map;
        const p0 = map.latLngToLayerPoint(this._topLeft);
        const p1 = map.latLngToLayerPoint(this._topRight);
        const p2 = map.latLngToLayerPoint(this._bottomLeft);

        const w0 = this._svgWidth;
        const h0 = this._svgHeight;

        // Affine matrix (a, b, c, d, e, f) mapping SVG-local (x, y) -> map
        // layer pixel (x', y'): x' = a*x + c*y + e ; y' = b*x + d*y + f
        // (CSS matrix() convention), solved from the 3 corner correspondences.
        const e = p0.x, f = p0.y;
        const a = (p1.x - e) / w0;
        const b = (p1.y - f) / w0;
        const c = (p2.x - e) / h0;
        const d = (p2.y - f) / h0;

        L.DomUtil.setPosition(this._container, new L.Point(0, 0));
        this._svgElement.style.width = `${w0}px`;
        this._svgElement.style.height = `${h0}px`;
        this._svgElement.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`;
    },
});

/* ---------------------------------------------------------------------- */
/* App state                                                              */
/* ---------------------------------------------------------------------- */

const state = {
    map: null,
    stores: [],
    currentStoreId: null,
    currentStore: null,
    rawLayout: null,       // populated when entering calibration mode
    calibrating: false,
    calValues: null,       // {anchor_latitude, anchor_longitude, scale, rotation_degrees, offset_x, offset_y}

    layers: {
        departments: null,
        deptLabels: null,
        aisles: null,
        aisleLabels: null,
        racks: null,
        rackLabels: null,
        markers: null,   // array of {layer, minZoom}
        storePin: null,
        preview: null,
        building: null,
        controlPoints: null,
        osmTile: null,
        satelliteTile: null,
        svgFloorplan: null,   // SvgCornerOverlay instance, or null if no SVG registered
    },

    building: null,       // raw building GeoJSON for the current store, or null if unavailable
    controlPoints: [],    // in-progress control point list while calibrating
    floorBounds: null,    // {minX, minY, maxX, maxY} of the current raw layout, computed client-side

    floorplan: null,       // {file, width, height, opacity, transform, reference_corners} or null
    svgCalValues: null,    // {scale, rotation_degrees, offset_x, offset_y, opacity} - SVG-specific calibration
};

/* ---------------------------------------------------------------------- */
/* Map bootstrap                                                          */
/* ---------------------------------------------------------------------- */

function initMap() {
    const map = L.map("map", { zoomControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

    // Base layers - OpenStreetMap (default) and Esri World Imagery satellite,
    // both public tile services requiring no API key. Only one is shown at a
    // time; toggled via the "Satellite basemap" checkbox in the layer panel.
    state.layers.osmTile = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 23,
        maxNativeZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    state.layers.satelliteTile = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        {
            maxZoom: 23,
            maxNativeZoom: 19,
            attribution: "Tiles &copy; Esri",
        }
    );

    // Building footprint (real-world GeoJSON) - drawn under the floor plan.
    state.layers.building = L.geoJSON(null, {
        style: buildingStyle,
        onEachFeature: onEachBuilding,
    }).addTo(map);

    state.layers.departments = L.geoJSON(null, { style: departmentStyle, onEachFeature: onEachDepartment }).addTo(map);
    state.layers.deptLabels = L.layerGroup().addTo(map);
    state.layers.aisles = L.geoJSON(null, { style: aisleStyle, onEachFeature: onEachAisle }).addTo(map);
    state.layers.aisleLabels = L.layerGroup().addTo(map);
    state.layers.racks = L.geoJSON(null, { style: rackStyle, onEachFeature: onEachRack }).addTo(map);
    state.layers.rackLabels = L.layerGroup().addTo(map);
    state.layers.markers = [];
    state.layers.markerGroup = L.layerGroup().addTo(map);
    state.layers.preview = L.layerGroup().addTo(map);
    state.layers.controlPoints = L.layerGroup(); // shown via the "Control points" checkbox

    map.on("zoomend", updateZoomVisibility);
    state.map = map;
}

/* ---------------------------------------------------------------------- */
/* Feature styling                                                        */
/* ---------------------------------------------------------------------- */

function departmentStyle() {
    return {
        color: "#BCDDF4",
        weight: 2,
        fillColor: "#9BCBEB",
        fillOpacity: 0.20,
    };
}

function aisleStyle() {
    return { color: "#6b7280", weight: 2, dashArray: "4,3", opacity: 0.9 };
}

function rackStyle() {
    return { color: "#9ca3af", weight: 1, fillColor: "#d1d5db", fillOpacity: 0.5 };
}

function buildingStyle() {
    return { color: "#ff0000", weight: 2, fill: false };
}

function onEachBuilding(feature, layer) {
    const props = feature.properties || {};
    layer.bindPopup(`<b>${props.type === "store_building" ? "Building footprint" : "Building"}</b>${
        props.source ? `Source: ${props.source}` : ""
    }`);
}

function onEachDepartment(feature, layer) {
    const name = feature.properties.label || feature.properties.name;
    layer.bindPopup(`<b>${name}</b>${feature.properties.category ? humanize(feature.properties.category) : ""}`);
    const center = layer.getBounds().getCenter();
    const label = L.marker(center, {
        interactive: false,
        icon: L.divIcon({ className: "dept-label", html: name, iconSize: null }),
    });
    label._minZoom = ZOOM.DEPT_LABELS;
    state.layers.deptLabels.addLayer(label);
}

function onEachAisle(feature, layer) {
    const name = feature.properties.label || feature.properties.name;
    layer.bindPopup(`<b>${name}</b>`);
    const center = layer.getBounds().getCenter();
    const label = L.marker(center, {
        interactive: false,
        icon: L.divIcon({ className: "aisle-label", html: name, iconSize: null }),
    });
    label._minZoom = ZOOM.AISLE_LABELS;
    state.layers.aisleLabels.addLayer(label);
}

function onEachRack(feature, layer) {
    const name = feature.properties.name || "Rack";
    const info = feature.properties.info || "";
    layer.bindPopup(`<b>${name}</b>${info}`);
    const center = layer.getBounds().getCenter();
    const label = L.marker(center, {
        interactive: false,
        icon: L.divIcon({ className: "rack-label", html: info || name, iconSize: null }),
    });
    label._minZoom = ZOOM.RACK_DETAIL;
    state.layers.rackLabels.addLayer(label);
}

function buildMarkerLayer(feature) {
    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties;
    const emoji = iconFor(props.category, props.marker_type);
    const marker = L.marker([lat, lon], {
        icon: L.divIcon({
            className: "",
            html: `<div class="marker-icon ${props.category}">${emoji}</div>`,
            iconSize: [26, 26],
            iconAnchor: [13, 13],
        }),
    });
    marker.bindPopup(`<b>${props.label || humanize(props.marker_type)}</b>${humanize(props.category)}`);
    return { layer: marker, minZoom: props.min_zoom || ZOOM.STORE_LEVEL };
}

/* ---------------------------------------------------------------------- */
/* Zoom-driven level of detail                                            */
/* ---------------------------------------------------------------------- */

function updateZoomVisibility() {
    if (!state.map) return;
    const zoom = state.map.getZoom();
    const map = state.map;

    setLayerGroupVisible(state.layers.deptLabels, map, zoom >= ZOOM.DEPT_LABELS);
    setLayerGroupVisible(state.layers.aisleLabels, map, zoom >= ZOOM.AISLE_LABELS);
    setLayerGroupVisible(state.layers.rackLabels, map, zoom >= ZOOM.RACK_DETAIL);

    // Aisle geometry itself becomes visible a level before its labels do,
    // and rack geometry a level before rack labels/info.
    setLayerVisible(state.layers.aisles, map, zoom >= ZOOM.DEPT_LABELS_ALL);
    setLayerVisible(state.layers.racks, map, zoom >= ZOOM.AISLE_LABELS);

    for (const { layer, minZoom } of state.layers.markers) {
        setLayerVisible(layer, map, zoom >= minZoom);
    }
}

function setLayerGroupVisible(group, map, visible) {
    if (visible && !map.hasLayer(group)) map.addLayer(group);
    if (!visible && map.hasLayer(group)) map.removeLayer(group);
}

function setLayerVisible(layer, map, visible) {
    if (!layer) return;
    if (visible && !map.hasLayer(layer)) map.addLayer(layer);
    if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
}

/* ---------------------------------------------------------------------- */
/* Loading store data                                                     */
/* ---------------------------------------------------------------------- */

async function fetchJSON(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}: ${body}`);
    }
    return res.json();
}

async function loadStores() {
    state.stores = await fetchJSON("/api/stores");
    const select = document.getElementById("store-select");
    select.innerHTML = "";
    for (const store of state.stores) {
        const opt = document.createElement("option");
        opt.value = store.store_id;
        opt.textContent = `${store.name} #${store.store_id}`;
        select.appendChild(opt);
    }
    select.addEventListener("change", () => loadStore(select.value));

    if (state.stores.length > 0) {
        select.value = state.stores[0].store_id;
        await loadStore(state.stores[0].store_id);
    }
}

function clearFeatureLayers() {
    state.layers.departments.clearLayers();
    state.layers.deptLabels.clearLayers();
    state.layers.aisles.clearLayers();
    state.layers.aisleLabels.clearLayers();
    state.layers.racks.clearLayers();
    state.layers.rackLabels.clearLayers();
    state.layers.markerGroup.clearLayers();
    state.layers.markers = [];
    state.layers.preview.clearLayers();
    state.layers.building.clearLayers();
    state.layers.controlPoints.clearLayers();
    if (state.layers.svgFloorplan) {
        state.map.removeLayer(state.layers.svgFloorplan);
        state.layers.svgFloorplan = null;
    }
}

/* ---------------------------------------------------------------------- */
/* SVG floor-plan overlay                                                 */
/* ---------------------------------------------------------------------- */

async function loadFloorplan(storeId) {
    state.floorplan = null;
    if (state.layers.svgFloorplan) {
        state.map.removeLayer(state.layers.svgFloorplan);
        state.layers.svgFloorplan = null;
    }

    let data;
    try {
        data = await fetchJSON(`/api/stores/${encodeURIComponent(storeId)}/floorplan`);
    } catch (err) {
        console.warn("Failed to load floor-plan info:", err);
        return;
    }
    if (data.status === "needs_calibration" || !data.reference_corners) {
        return; // No SVG registered (or not yet georeferenced) for this store.
    }
    state.floorplan = data;

    const svgText = await (await fetch(data.file)).text();
    const svgDoc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svgEl = svgDoc.documentElement;

    const layer = new SvgCornerOverlay(svgEl, data.reference_corners, { opacity: data.opacity });
    state.layers.svgFloorplan = layer;
    if (document.getElementById("layer-svg-floorplan").checked) {
        layer.addTo(state.map);
    }
}

/* ---------------------------------------------------------------------- */
/* Building footprint + alignment report                                 */
/* ---------------------------------------------------------------------- */

async function loadBuilding(storeId) {
    state.building = null;
    state.layers.building.clearLayers();
    try {
        const data = await fetchJSON(`/api/stores/${encodeURIComponent(storeId)}/building`);
        if (data.status === "needs_calibration") {
            return; // No building footprint on file - nothing to draw.
        }
        state.building = data;
        state.layers.building.addData(data);
    } catch (err) {
        console.warn("Failed to load building footprint:", err);
    }
}

function formatMetersOrDash(v) {
    return typeof v === "number" ? `${v.toFixed(1)} m` : "-";
}

async function refreshAlignmentReport(storeId) {
    try {
        const report = await fetchJSON(`/api/stores/${encodeURIComponent(storeId)}/alignment-report`);
        if (report.status === "needs_calibration") {
            document.getElementById("report-error").textContent = "needs building footprint";
            document.getElementById("report-building-area").textContent = "-";
            document.getElementById("report-floor-area").textContent = "-";
            document.getElementById("report-rotation").textContent = "-";
            document.getElementById("report-scale").textContent = "-";
            return;
        }
        document.getElementById("report-error").textContent = formatMetersOrDash(report.alignment_error_m);
        document.getElementById("report-building-area").textContent = `${report.building_area_m2.toFixed(1)} m²`;
        document.getElementById("report-floor-area").textContent = `${report.floor_plan_area_m2.toFixed(1)} m²`;
        document.getElementById("report-rotation").textContent = `${report.rotation_degrees.toFixed(1)}°`;
        document.getElementById("report-scale").textContent =
            `${report.scale_x.toFixed(3)} / ${report.scale_y.toFixed(3)}`;
    } catch (err) {
        console.warn("Failed to load alignment report:", err);
    }
}

async function loadStore(storeId) {
    if (state.calibrating) exitCalibration(false);

    const data = await fetchJSON(`/api/stores/${encodeURIComponent(storeId)}/map`);
    state.currentStoreId = storeId;
    state.currentStore = data.store;

    document.getElementById("store-meta").textContent = data.store.address;

    clearFeatureLayers();

    state.layers.departments.addData(data.layout.departments);
    state.layers.aisles.addData(data.layout.aisles);
    state.layers.racks.addData(data.layout.racks);

    for (const feature of data.layout.markers.features) {
        const { layer, minZoom } = buildMarkerLayer(feature);
        state.layers.markers.push({ layer, minZoom });
        state.layers.markerGroup.addLayer(layer);
    }

    if (state.layers.storePin) {
        state.map.removeLayer(state.layers.storePin);
    }
    const pin = L.marker([data.anchor.latitude, data.anchor.longitude], {
        icon: L.divIcon({
            className: "",
            html: `<div class="marker-icon store-pin">📍</div>`,
            iconSize: [34, 34],
            iconAnchor: [17, 17],
        }),
    }).addTo(state.map);
    pin.bindPopup(`<b>${data.store.name}</b>${data.store.address}`);
    pin.on("click", () => {
        state.map.setView([data.anchor.latitude, data.anchor.longitude], ZOOM.DEPT_LABELS);
    });
    state.layers.storePin = pin;

    state.map.setView([data.anchor.latitude, data.anchor.longitude], DEFAULT_ZOOM);
    updateZoomVisibility();

    await loadBuilding(storeId);
    await loadFloorplan(storeId);
    await refreshAlignmentReport(storeId);
}

/* ---------------------------------------------------------------------- */
/* Calibration mode                                                       */
/* ---------------------------------------------------------------------- */

const CAL_STEPS = {
    scale_x: 0.005,
    scale_y: 0.005,
    rotation: 1,
    offset_x: 0.5,
    offset_y: 0.5,
};

function computeFloorBounds(layout) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const depthByType = { Point: 0, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };

    function walk(node, depth) {
        if (depth === 0) {
            minX = Math.min(minX, node[0]); maxX = Math.max(maxX, node[0]);
            minY = Math.min(minY, node[1]); maxY = Math.max(maxY, node[1]);
            return;
        }
        for (const child of node) walk(child, depth - 1);
    }

    for (const key of ["departments", "aisles", "racks", "markers"]) {
        for (const item of layout[key] || []) {
            walk(item.geometry.coordinates, depthByType[item.geometry.type]);
        }
    }
    return { minX, minY, maxX, maxY };
}

function floorToLatLonApprox(x, y, transform, anchor) {
    // Client-side preview approximation (flat-earth / equirectangular).
    // The authoritative transform (AEQD via pyproj) lives server-side in
    // backend/transform.py and is what actually gets saved/rendered after
    // "Save Calibration" - this is only for live drag/adjust feedback.
    const mx = x * transform.scale_x;
    const my = y * transform.scale_y;
    const theta = (transform.rotation_degrees * Math.PI) / 180;
    const rx = mx * Math.cos(theta) - my * Math.sin(theta);
    const ry = mx * Math.sin(theta) + my * Math.cos(theta);
    const east = rx + transform.offset_x;
    const north = ry + transform.offset_y;

    const metersPerDegLat = 111320;
    const metersPerDegLon = 111320 * Math.cos((anchor.latitude * Math.PI) / 180);

    return [anchor.latitude + north / metersPerDegLat, anchor.longitude + east / metersPerDegLon];
}

function walkGeometryToLatLng(geometry, transform, anchor) {
    const conv = (pt) => floorToLatLonApprox(pt[0], pt[1], transform, anchor);
    switch (geometry.type) {
        case "Point":
            return conv(geometry.coordinates);
        case "LineString":
            return geometry.coordinates.map(conv);
        case "Polygon":
        case "MultiLineString":
            return geometry.coordinates.map((ring) => ring.map(conv));
        case "MultiPolygon":
            return geometry.coordinates.map((poly) => poly.map((ring) => ring.map(conv)));
        default:
            return null;
    }
}

function renderPreview() {
    const layout = state.rawLayout;
    const cal = state.calValues;
    if (!layout || !cal) return;

    state.layers.preview.clearLayers();
    const anchor = { latitude: cal.anchor_latitude, longitude: cal.anchor_longitude };
    const transform = {
        scale_x: cal.scale_x,
        scale_y: cal.scale_y,
        rotation_degrees: cal.rotation_degrees,
        offset_x: cal.offset_x,
        offset_y: cal.offset_y,
    };

    for (const dept of layout.departments) {
        const latlngs = walkGeometryToLatLng(dept.geometry, transform, anchor);
        L.polygon(latlngs, { color: "#BCDDF4", weight: 2, fillColor: "#9BCBEB", fillOpacity: 0.35 })
            .bindTooltip(dept.label || dept.name, { permanent: true, direction: "center", className: "dept-label" })
            .addTo(state.layers.preview);
    }
    for (const marker of layout.markers) {
        const [lat, lon] = walkGeometryToLatLng(marker.geometry, transform, anchor);
        const emoji = iconFor(marker.category, marker.marker_type);
        L.marker([lat, lon], {
            icon: L.divIcon({
                className: "",
                html: `<div class="marker-icon ${marker.category}">${emoji}</div>`,
                iconSize: [22, 22],
                iconAnchor: [11, 11],
            }),
        }).addTo(state.layers.preview);
    }
}

function updateCalDisplay() {
    document.getElementById("val-scale_x").textContent = state.calValues.scale_x.toFixed(3);
    document.getElementById("val-scale_y").textContent = state.calValues.scale_y.toFixed(3);
    document.getElementById("val-rotation").textContent = `${Math.round(state.calValues.rotation_degrees)}°`;
    document.getElementById("val-offset_x").textContent = state.calValues.offset_x.toFixed(1);
    document.getElementById("val-offset_y").textContent = state.calValues.offset_y.toFixed(1);
}

/* ---------------------------------------------------------------------- */
/* SVG floor-plan calibration                                            */
/* ---------------------------------------------------------------------- */

function updateSvgCalDisplay() {
    if (!state.svgCalValues) return;
    document.getElementById("svg-val-scale").textContent = state.svgCalValues.scale.toFixed(3);
    document.getElementById("svg-val-rotation").textContent = `${Math.round(state.svgCalValues.rotation_degrees)}°`;
    document.getElementById("svg-val-offset_x").textContent = state.svgCalValues.offset_x.toFixed(1);
    document.getElementById("svg-val-offset_y").textContent = state.svgCalValues.offset_y.toFixed(1);
    document.getElementById("svg-opacity").value = state.svgCalValues.opacity;
}

function svgReferenceCornersApprox(cal, anchor, width, height) {
    // Same flat-earth preview approximation used for the GeoJSON preview
    // (floorToLatLonApprox) - live calibration feedback only. The
    // authoritative AEQD corners come from the server after saving.
    const transform = {
        scale_x: cal.scale, scale_y: cal.scale,
        rotation_degrees: cal.rotation_degrees, offset_x: cal.offset_x, offset_y: cal.offset_y,
    };
    const toPoint = ([lat, lon]) => ({ latitude: lat, longitude: lon });
    return {
        top_left: toPoint(floorToLatLonApprox(0, 0, transform, anchor)),
        top_right: toPoint(floorToLatLonApprox(width, 0, transform, anchor)),
        bottom_left: toPoint(floorToLatLonApprox(0, height, transform, anchor)),
    };
}

function renderSvgPreview() {
    if (!state.layers.svgFloorplan || !state.floorplan || !state.svgCalValues) return;
    const anchor = { latitude: state.rawLayout.anchor.latitude, longitude: state.rawLayout.anchor.longitude };
    const corners = svgReferenceCornersApprox(state.svgCalValues, anchor, state.floorplan.width, state.floorplan.height);
    state.layers.svgFloorplan.setCorners(corners);
    state.layers.svgFloorplan.setOpacity(state.svgCalValues.opacity);
}

async function runSvgAutoAlign() {
    const statusEl = document.getElementById("svg-status");
    if (!state.floorplan) {
        statusEl.textContent = "No SVG floor plan registered for this store.";
        statusEl.className = "err";
        return;
    }
    try {
        const result = await fetchJSON(
            `/api/stores/${encodeURIComponent(state.currentStoreId)}/auto-align`,
            { method: "POST" }
        );
        if (result.status === "needs_calibration" || !result.svg_transform) {
            statusEl.textContent = `Auto align unavailable: ${result.reason || "no SVG registered"}`;
            statusEl.className = "err";
            return;
        }
        const t = result.svg_transform;
        state.svgCalValues.scale = t.scale_x != null ? t.scale_x : t.scale;
        state.svgCalValues.rotation_degrees = t.rotation_degrees;
        state.svgCalValues.offset_x = t.offset_x;
        state.svgCalValues.offset_y = t.offset_y;
        updateSvgCalDisplay();
        renderSvgPreview();

        statusEl.textContent = `Auto align: IoU ${result.svg_iou.toFixed(2)}. Review the overlay, then Save SVG Calibration.`;
        statusEl.className = "ok";
    } catch (err) {
        statusEl.textContent = `Auto align failed: ${err.message}`;
        statusEl.className = "err";
    }
}

async function saveSvgCalibration() {
    const statusEl = document.getElementById("svg-status");
    if (!state.floorplan) {
        statusEl.textContent = "No SVG floor plan registered for this store.";
        statusEl.className = "err";
        return;
    }
    try {
        const existing = await fetchJSON(`/api/stores/${encodeURIComponent(state.currentStoreId)}/georeference`);
        const cal = state.svgCalValues;
        const body = {
            store_id: state.currentStoreId,
            source: existing.source || "manual",
            control_points: existing.control_points || [],
            svg: {
                file: state.floorplan.file.split("/").pop(),
                width: state.floorplan.width,
                height: state.floorplan.height,
            },
            transform: {
                scale: 1.0,
                scale_x: cal.scale,
                scale_y: cal.scale,
                rotation_degrees: cal.rotation_degrees,
                offset_x: cal.offset_x,
                offset_y: cal.offset_y,
            },
            svg_opacity: cal.opacity,
            corners: existing.corners || {},
        };
        await fetchJSON(`/api/stores/${encodeURIComponent(state.currentStoreId)}/georeference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        statusEl.textContent = "SVG calibration saved.";
        statusEl.className = "ok";
        await loadFloorplan(state.currentStoreId);
        if (document.getElementById("layer-svg-floorplan").checked && state.layers.svgFloorplan) {
            state.layers.svgFloorplan.addTo(state.map);
        }
    } catch (err) {
        statusEl.textContent = `Save failed: ${err.message}`;
        statusEl.className = "err";
    }
}

async function enterCalibration() {
    if (!state.currentStoreId) return;
    state.rawLayout = await fetchJSON(`/api/stores/${encodeURIComponent(state.currentStoreId)}/layout/raw`);
    state.floorBounds = computeFloorBounds(state.rawLayout);

    const t = state.rawLayout.transform;
    state.calValues = {
        anchor_latitude: state.rawLayout.anchor.latitude,
        anchor_longitude: state.rawLayout.anchor.longitude,
        scale: t.scale,
        scale_x: t.scale_x != null ? t.scale_x : t.scale,
        scale_y: t.scale_y != null ? t.scale_y : t.scale,
        rotation_degrees: t.rotation_degrees,
        offset_x: t.offset_x,
        offset_y: t.offset_y,
    };
    if (state.floorplan && state.floorplan.transform) {
        const st = state.floorplan.transform;
        state.svgCalValues = {
            scale: st.scale_x != null ? st.scale_x : st.scale,
            rotation_degrees: st.rotation_degrees,
            offset_x: st.offset_x,
            offset_y: st.offset_y,
            opacity: state.floorplan.opacity != null ? state.floorplan.opacity : 1.0,
        };
    } else {
        state.svgCalValues = { scale: 1.0, rotation_degrees: 0.0, offset_x: 0.0, offset_y: 0.0, opacity: 0.85 };
    }
    updateSvgCalDisplay();

    state.calibrating = true;

    setLayerGroupVisible(state.layers.departments, state.map, false);
    setLayerGroupVisible(state.layers.deptLabels, state.map, false);
    setLayerGroupVisible(state.layers.aisles, state.map, false);
    setLayerGroupVisible(state.layers.aisleLabels, state.map, false);
    setLayerGroupVisible(state.layers.racks, state.map, false);
    setLayerGroupVisible(state.layers.rackLabels, state.map, false);
    setLayerGroupVisible(state.layers.markerGroup, state.map, false);

    document.getElementById("calibration-panel").classList.add("open");
    document.getElementById("calibrate-toggle").classList.add("active");
    updateCalDisplay();
    renderPreview();
    await loadControlPoints();
}

function exitCalibration(reloadAfter = true) {
    state.calibrating = false;
    state.layers.preview.clearLayers();
    document.getElementById("calibration-panel").classList.remove("open");
    document.getElementById("calibrate-toggle").classList.remove("active");
    document.getElementById("cal-status").textContent = "";
    document.getElementById("cal-status").className = "";

    if (reloadAfter && state.currentStoreId) {
        updateZoomVisibility();
    } else {
        setLayerGroupVisible(state.layers.departments, state.map, true);
        setLayerGroupVisible(state.layers.markerGroup, state.map, true);
        updateZoomVisibility();
    }
}

async function saveCalibration() {
    const statusEl = document.getElementById("cal-status");
    try {
        const result = await fetchJSON(
            `/api/stores/${encodeURIComponent(state.currentStoreId)}/calibrate`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(state.calValues),
            }
        );
        statusEl.textContent = "Calibration saved.";
        statusEl.className = "ok";
        exitCalibration(false);
        await loadStore(state.currentStoreId);
    } catch (err) {
        statusEl.textContent = `Save failed: ${err.message}`;
        statusEl.className = "err";
    }
}

async function runAutoAlign() {
    const statusEl = document.getElementById("cal-status");
    try {
        const result = await fetchJSON(
            `/api/stores/${encodeURIComponent(state.currentStoreId)}/auto-align`,
            { method: "POST" }
        );
        if (result.status === "needs_calibration") {
            statusEl.textContent = `Auto align unavailable: ${result.reason}`;
            statusEl.className = "err";
            return;
        }
        const t = result.transform;
        state.calValues.scale_x = t.scale_x != null ? t.scale_x : t.scale;
        state.calValues.scale_y = t.scale_y != null ? t.scale_y : t.scale;
        state.calValues.rotation_degrees = t.rotation_degrees;
        state.calValues.offset_x = t.offset_x;
        state.calValues.offset_y = t.offset_y;
        updateCalDisplay();
        renderPreview();

        statusEl.textContent =
            `Auto align: error ${result.alignment_error_m.toFixed(1)} m, IoU ${result.iou.toFixed(2)}. ` +
            `Review the overlay, then Save Calibration.`;
        statusEl.className = "ok";
    } catch (err) {
        statusEl.textContent = `Auto align failed: ${err.message}`;
        statusEl.className = "err";
    }
}

function wireCalibrationControls() {
    document.getElementById("calibrate-toggle").addEventListener("click", () => {
        if (state.calibrating) {
            exitCalibration(false);
        } else {
            enterCalibration();
        }
    });

    document.querySelectorAll("[data-adjust]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const key = btn.dataset.adjust;
            const dir = Number(btn.dataset.dir);
            const field = key === "rotation" ? "rotation_degrees" : key;
            const step = CAL_STEPS[key];
            let next = state.calValues[field] + dir * step;
            if (field === "scale_x" || field === "scale_y") next = Math.max(0.001, next);
            state.calValues[field] = next;
            updateCalDisplay();
            renderPreview();
        });
    });

    document.getElementById("cal-save").addEventListener("click", saveCalibration);
    document.getElementById("cal-auto-align").addEventListener("click", runAutoAlign);

    document.getElementById("cp-add").addEventListener("click", addControlPointFromForm);
    document.getElementById("cp-save").addEventListener("click", saveControlPoints);

    const SVG_CAL_STEPS = { scale: 0.005, rotation: 1, offset_x: 0.5, offset_y: 0.5 };
    document.querySelectorAll("[data-svg-adjust]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const key = btn.dataset.svgAdjust;
            const dir = Number(btn.dataset.dir);
            const field = key === "rotation" ? "rotation_degrees" : key;
            let next = state.svgCalValues[field] + dir * SVG_CAL_STEPS[key];
            if (field === "scale") next = Math.max(0.001, next);
            state.svgCalValues[field] = next;
            updateSvgCalDisplay();
            renderSvgPreview();
        });
    });
    document.getElementById("svg-opacity").addEventListener("input", (e) => {
        state.svgCalValues.opacity = parseFloat(e.target.value);
        if (state.layers.svgFloorplan) state.layers.svgFloorplan.setOpacity(state.svgCalValues.opacity);
    });
    document.getElementById("svg-auto-align").addEventListener("click", runSvgAutoAlign);
    document.getElementById("svg-save").addEventListener("click", saveSvgCalibration);
    document.getElementById("layer-svg-floorplan").addEventListener("change", (e) => {
        if (!state.layers.svgFloorplan) return;
        setLayerVisible(state.layers.svgFloorplan, state.map, e.target.checked);
    });

    document.getElementById("layer-satellite").addEventListener("change", (e) => {
        setLayerVisible(state.layers.osmTile, state.map, !e.target.checked);
        setLayerVisible(state.layers.satelliteTile, state.map, e.target.checked);
    });
    document.getElementById("layer-building").addEventListener("change", (e) => {
        setLayerVisible(state.layers.building, state.map, e.target.checked);
    });
    document.getElementById("layer-floorplan").addEventListener("change", (e) => {
        const visible = e.target.checked;
        setLayerVisible(state.layers.departments, state.map, visible);
        setLayerVisible(state.layers.aisles, state.map, visible && state.map.getZoom() >= ZOOM.DEPT_LABELS_ALL);
        setLayerVisible(state.layers.racks, state.map, visible && state.map.getZoom() >= ZOOM.AISLE_LABELS);
        setLayerGroupVisible(state.layers.markerGroup, state.map, visible);
        if (!visible) {
            setLayerGroupVisible(state.layers.deptLabels, state.map, false);
            setLayerGroupVisible(state.layers.aisleLabels, state.map, false);
            setLayerGroupVisible(state.layers.rackLabels, state.map, false);
        } else {
            updateZoomVisibility();
        }
    });
    document.getElementById("layer-controlpoints").addEventListener("change", (e) => {
        setLayerVisible(state.layers.controlPoints, state.map, e.target.checked);
    });
}

/* ---------------------------------------------------------------------- */
/* Control point editor                                                  */
/* ---------------------------------------------------------------------- */

function floorCornerCoords(name) {
    const b = state.floorBounds;
    if (!b) return { x: 0, y: 0 };
    switch (name) {
        case "northwest": return { x: b.minX, y: b.minY };
        case "northeast": return { x: b.maxX, y: b.minY };
        case "southeast": return { x: b.maxX, y: b.maxY };
        case "southwest": return { x: b.minX, y: b.maxY };
        default: return { x: b.minX, y: b.minY };
    }
}

function renderControlPointMarkers() {
    state.layers.controlPoints.clearLayers();
    for (const cp of state.controlPoints) {
        L.marker([cp.geo.latitude, cp.geo.longitude], {
            icon: L.divIcon({
                className: "",
                html: `<div class="cp-marker">${cp.name.slice(0, 2).toUpperCase()}</div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10],
            }),
        })
            .bindPopup(`<b>${cp.name}</b>floor (${cp.floor.x}, ${cp.floor.y})`)
            .addTo(state.layers.controlPoints);
    }
}

function renderControlPointList() {
    const list = document.getElementById("cp-list");
    list.innerHTML = "";
    for (const cp of state.controlPoints) {
        const li = document.createElement("li");
        li.innerHTML = `<span>${cp.name}: ${cp.geo.latitude.toFixed(5)}, ${cp.geo.longitude.toFixed(5)}</span>`;
        const removeBtn = document.createElement("button");
        removeBtn.textContent = "✕";
        removeBtn.addEventListener("click", () => {
            state.controlPoints = state.controlPoints.filter((p) => p.name !== cp.name);
            renderControlPointList();
            renderControlPointMarkers();
        });
        li.appendChild(removeBtn);
        list.appendChild(li);
    }
}

async function loadControlPoints() {
    state.controlPoints = [];
    try {
        const data = await fetchJSON(`/api/stores/${encodeURIComponent(state.currentStoreId)}/georeference`);
        if (data.status !== "needs_calibration" && Array.isArray(data.control_points)) {
            state.controlPoints = data.control_points;
        }
    } catch (err) {
        console.warn("Failed to load control points:", err);
    }
    renderControlPointList();
    renderControlPointMarkers();
}

function addControlPointFromForm() {
    const name = document.getElementById("cp-floor-point").value;
    const lat = parseFloat(document.getElementById("cp-lat").value);
    const lon = parseFloat(document.getElementById("cp-lon").value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        document.getElementById("cp-status").textContent = "Enter a valid latitude and longitude.";
        document.getElementById("cp-status").className = "err";
        return;
    }
    const floor = floorCornerCoords(name);
    state.controlPoints = state.controlPoints.filter((p) => p.name !== name);
    state.controlPoints.push({ name, floor, geo: { latitude: lat, longitude: lon } });
    renderControlPointList();
    renderControlPointMarkers();
    document.getElementById("cp-status").textContent = "";
}

async function saveControlPoints() {
    const statusEl = document.getElementById("cp-status");
    try {
        const result = await fetchJSON(
            `/api/stores/${encodeURIComponent(state.currentStoreId)}/georeference`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    store_id: state.currentStoreId,
                    source: "manual",
                    control_points: state.controlPoints,
                }),
            }
        );
        if (result.fitted_transform) {
            const t = result.fitted_transform;
            state.calValues.scale_x = t.scale_x;
            state.calValues.scale_y = t.scale_y;
            state.calValues.rotation_degrees = t.rotation_degrees;
            state.calValues.offset_x = t.offset_x;
            state.calValues.offset_y = t.offset_y;
            updateCalDisplay();
            renderPreview();
            statusEl.textContent = `Saved. Fitted transform applied (rms ${t.rms_error_m.toFixed(2)} m) - review, then Save Calibration.`;
        } else {
            statusEl.textContent = "Control points saved. Add at least 2 to compute a fitted transform.";
        }
        statusEl.className = "ok";
    } catch (err) {
        statusEl.textContent = `Save failed: ${err.message}`;
        statusEl.className = "err";
    }
}

/* ---------------------------------------------------------------------- */
/* Boot                                                                    */
/* ---------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", async () => {
    initMap();
    wireCalibrationControls();
    try {
        await loadStores();
    } catch (err) {
        console.error("Failed to load stores:", err);
        document.getElementById("store-meta").textContent = "Failed to load store directory.";
    }
});
