/* ==========================================================================
 * Lowe's Interactive Store Map - frontend application logic.
 *
 * Talks to the FastAPI backend for the store directory, renders the raw
 * Lowes_*.geojson floor plan on a Leaflet map over OpenStreetMap tiles, and
 * provides a Debug panel that live-transforms (move/rotate/scale) that
 * GeoJSON and lets you copy/download the result.
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

const GEOJSON_FILES = {
    departments: "/static/geojson/Lowes_depertment.geojson",
    departmentLines: "/static/geojson/Lowes_depertment_line.geojson",
    departmentPoints: "/static/geojson/Lowes_depertment_point.geojson",
    aisles: "/static/geojson/Lowes_aisle.geojson",
    aisleLines: "/static/geojson/Lowes_aisle_line.geojson",
    aislePoints: "/static/geojson/Lowes_aisle_point.geojson",
    racks: "/static/geojson/Lowes_rack.geojson",
    rackLines: "/static/geojson/Lowes_rack_line.geojson",
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
/* App state                                                              */
/* ---------------------------------------------------------------------- */

const state = {
    map: null,
    stores: [],
    currentStoreId: null,
    currentStore: null,

    layers: {
        departments: null,
        deptLabels: null,
        aisles: null,
        aisleLabels: null,
        racks: null,
        departmentLines: null,
        aisleLines: null,
        rackLines: null,
        rackLabels: null,
        markers: null,   // array of {layer, minZoom}
        storePin: null,
        building: null,
        osmTile: null,
        satelliteTile: null,
        geojsonFloorplan: null,
    },

    building: null,       // raw building GeoJSON for the current store, or null if unavailable

    debug: {
        active: false,
        originals: null,    // pristine fetched GeoJSON for all 8 GEOJSON_FILES keys, keyed the same way
        anchor: null,       // {latitude, longitude} pivot for the live transform
        east: 0,            // cumulative move, meters
        north: 0,
        rotationDeg: 0,     // cumulative rotation, degrees
        scaleX: 1,          // cumulative scale, east-west
        scaleY: 1,          // cumulative scale, north-south
    },
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
    state.layers.departmentLines = L.geoJSON(null, { style: departmentLineStyle }).addTo(map);
    state.layers.aisleLines = L.geoJSON(null, { style: aisleLineStyle }).addTo(map);
    state.layers.rackLines = L.geoJSON(null, { style: rackLineStyle }).addTo(map);
    state.layers.rackLabels = L.layerGroup().addTo(map);
    state.layers.markers = [];
    state.layers.markerGroup = L.layerGroup().addTo(map);

    map.on("zoomend", updateZoomVisibility);
    state.map = map;
}

/* ---------------------------------------------------------------------- */
/* Feature styling                                                        */
/* ---------------------------------------------------------------------- */

function departmentStyle(feature) {
    return geoJsonStyle({ color: "#96A3BD", weight: 1, fillColor: "#D9E2F6", fillOpacity: 0.75 }, feature);
}

function aisleStyle(feature) {
    return geoJsonStyle({ color: "#BBBBBB", weight: 1, fillColor: "#DCDEE2", fillOpacity: 0.7 }, feature);
}

function rackStyle(feature) {
    return geoJsonStyle({ color: "#9ca3af", weight: 1, fillColor: "#DCDEE2", fillOpacity: 0.8 }, feature);
}

function departmentLineStyle(feature) {
    return geoJsonStyle({ color: "#6b7280", weight: 1.5, opacity: 0.95 }, feature);
}

function aisleLineStyle(feature) {
    return geoJsonStyle({ color: "#8b949e", weight: 1, opacity: 0.9 }, feature);
}

function rackLineStyle(feature) {
    return geoJsonStyle({ color: "#4b5563", weight: 0.8, opacity: 0.85 }, feature);
}

function geoJsonStyle(defaults, feature = null) {
    const props = feature?.properties || {};
    const fillOpacity = props.opacity != null ? Number(props.opacity) : defaults.fillOpacity;
    return {
        color: props.stroke || defaults.color,
        weight: Number(props["stroke-width"]) || defaults.weight,
        opacity: defaults.opacity != null ? defaults.opacity : 1,
        fillColor: props.fill || defaults.fillColor,
        fillOpacity: Number.isFinite(fillOpacity) ? fillOpacity : defaults.fillOpacity,
    };
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
    const name = feature.properties.label || feature.properties.name || feature.properties.poi_name || "Department";
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
    const name = feature.properties.label || feature.properties.name || "Aisle";
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
    const name = feature.properties.label || feature.properties.name || "Rack";
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

function buildGeoJsonPointLayer(feature) {
    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties || {};
    const label = props.poi_name || props.name || props.label || "";
    if (props.icon_id || props.poi_name) {
        const category = props.profile === "STORE SERVICES" ? "store_service" : "basic_information";
        const markerType = normalizeIconId(props.icon_id || props.sub_category);
        const emoji = iconFor(category, markerType);
        const marker = L.marker([lat, lon], {
            icon: L.divIcon({
                className: "",
                html: `<div class="marker-icon ${category}">${emoji}</div>`,
                iconSize: [26, 26],
                iconAnchor: [13, 13],
            }),
        });
        marker.bindPopup(`<b>${label || humanize(markerType)}</b>${props.profile ? humanize(props.profile.toLowerCase()) : ""}`);
        return { layer: marker, minZoom: ZOOM.STORE_LEVEL };
    }

    return {
        layer: L.marker([lat, lon], {
            interactive: false,
            icon: L.divIcon({ className: "aisle-label", html: label, iconSize: null }),
        }),
        minZoom: ZOOM.DEPT_LABELS,
    };
}

function normalizeIconId(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/pick_up/g, "pickup")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

/* ---------------------------------------------------------------------- */
/* Zoom-driven level of detail                                            */
/* ---------------------------------------------------------------------- */

function updateZoomVisibility() {
    if (!state.map) return;
    const zoom = state.map.getZoom();
    const map = state.map;
    const floorVisible = document.getElementById("layer-floorplan").checked;
    const outlinesVisible = document.getElementById("layer-outlines").checked;

    setLayerGroupVisible(state.layers.deptLabels, map, floorVisible && zoom >= ZOOM.DEPT_LABELS);
    setLayerGroupVisible(state.layers.aisleLabels, map, floorVisible && zoom >= ZOOM.AISLE_LABELS);
    setLayerGroupVisible(state.layers.rackLabels, map, floorVisible && zoom >= ZOOM.RACK_DETAIL);

    // Aisle geometry itself becomes visible a level before its labels do,
    // and rack geometry a level before rack labels/info.
    setLayerVisible(state.layers.departments, map, floorVisible);
    setLayerVisible(state.layers.aisles, map, floorVisible && zoom >= ZOOM.DEPT_LABELS_ALL);
    setLayerVisible(state.layers.racks, map, floorVisible && zoom >= ZOOM.AISLE_LABELS);
    setLayerVisible(state.layers.departmentLines, map, outlinesVisible);
    setLayerVisible(state.layers.aisleLines, map, outlinesVisible && zoom >= ZOOM.DEPT_LABELS_ALL);
    setLayerVisible(state.layers.rackLines, map, outlinesVisible && zoom >= ZOOM.AISLE_LABELS);

    for (const { layer, minZoom } of state.layers.markers) {
        setLayerVisible(layer, map, floorVisible && zoom >= minZoom);
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
    state.layers.departmentLines.clearLayers();
    state.layers.aisleLines.clearLayers();
    state.layers.rackLines.clearLayers();
    state.layers.rackLabels.clearLayers();
    state.layers.markerGroup.clearLayers();
    state.layers.markers = [];
    state.layers.building.clearLayers();
}

async function loadGeoJsonFloorplan() {
    const data = {};
    await Promise.all(Object.entries(GEOJSON_FILES).map(async ([key, url]) => {
        data[key] = await fetchJSON(url);
    }));

    // Keep a pristine copy + the pivot anchor for the live Debug panel
    // (see wireDebugControls / renderDebugGeoJson below) - independent of
    // whatever the currently-rendered (possibly debug-transformed) state is.
    state.debug.originals = JSON.parse(JSON.stringify(data));
    state.debug.anchor = state.currentStore
        ? { latitude: state.currentStore.latitude, longitude: state.currentStore.longitude }
        : null;
    state.debug.east = 0;
    state.debug.north = 0;
    state.debug.rotationDeg = 0;
    state.debug.scaleX = 1;
    state.debug.scaleY = 1;
    updateDebugReadout();

    renderGeoJsonFloorplanData(data);

    return data;
}

function renderGeoJsonFloorplanData(data) {
    state.layers.departments.clearLayers();
    state.layers.departmentLines.clearLayers();
    state.layers.aisles.clearLayers();
    state.layers.aisleLines.clearLayers();
    state.layers.racks.clearLayers();
    state.layers.rackLines.clearLayers();
    state.layers.deptLabels.clearLayers();
    state.layers.aisleLabels.clearLayers();
    state.layers.markerGroup.clearLayers();
    state.layers.markers = [];

    state.layers.departments.addData(data.departments);
    state.layers.departmentLines.addData(data.departmentLines);
    state.layers.aisles.addData(data.aisles);
    state.layers.aisleLines.addData(data.aisleLines);
    state.layers.racks.addData(data.racks);
    state.layers.rackLines.addData(data.rackLines);

    for (const feature of data.departmentPoints.features || []) {
        const point = buildGeoJsonPointLayer(feature);
        if (feature.properties?.poi_name || feature.properties?.icon_id) {
            state.layers.markers.push(point);
            state.layers.markerGroup.addLayer(point.layer);
        } else {
            point.layer._minZoom = ZOOM.DEPT_LABELS;
            state.layers.deptLabels.addLayer(point.layer);
        }
    }

    for (const feature of data.aislePoints.features || []) {
        const point = buildGeoJsonPointLayer(feature);
        point.layer._minZoom = ZOOM.AISLE_LABELS;
        state.layers.aisleLabels.addLayer(point.layer);
    }
}

/* ---------------------------------------------------------------------- */
/* Debug panel: live move/rotate/scale of the raw GeoJSON floor plan      */
/* ---------------------------------------------------------------------- */

function debugMetersPerDeg(anchor) {
    return {
        lat: 111320,
        lon: 111320 * Math.cos((anchor.latitude * Math.PI) / 180),
    };
}

function debugTransformLonLat(lon, lat) {
    const anchor = state.debug.anchor;
    const mpd = debugMetersPerDeg(anchor);
    let east = (lon - anchor.longitude) * mpd.lon;
    let north = (lat - anchor.latitude) * mpd.lat;

    // scale (independently per axis), then rotate about the anchor, then translate
    east *= state.debug.scaleX;
    north *= state.debug.scaleY;
    const theta = (state.debug.rotationDeg * Math.PI) / 180;
    const rEast = east * Math.cos(theta) - north * Math.sin(theta);
    const rNorth = east * Math.sin(theta) + north * Math.cos(theta);
    east = rEast + state.debug.east;
    north = rNorth + state.debug.north;

    return [anchor.longitude + east / mpd.lon, anchor.latitude + north / mpd.lat];
}

function debugTransformCoords(coords) {
    if (typeof coords[0] === "number") {
        return debugTransformLonLat(coords[0], coords[1]);
    }
    return coords.map(debugTransformCoords);
}

function debugTransformFeatureCollection(fc) {
    const clone = JSON.parse(JSON.stringify(fc));
    for (const feature of clone.features || []) {
        if (feature.geometry && feature.geometry.coordinates) {
            feature.geometry.coordinates = debugTransformCoords(feature.geometry.coordinates);
        }
    }
    return clone;
}

function debugCurrentDataset(key) {
    return debugTransformFeatureCollection(state.debug.originals[key]);
}

function debugCurrentAllDatasets() {
    const out = {};
    for (const key of Object.keys(GEOJSON_FILES)) out[key] = debugCurrentDataset(key);
    return out;
}

function renderDebugGeoJson() {
    if (!state.debug.originals || !state.debug.anchor) return;
    renderGeoJsonFloorplanData(debugCurrentAllDatasets());
}

function updateDebugReadout() {
    document.getElementById("dbg-east").textContent = `${state.debug.east.toFixed(2)} m`;
    document.getElementById("dbg-north").textContent = `${state.debug.north.toFixed(2)} m`;
    document.getElementById("dbg-rotation").textContent = `${state.debug.rotationDeg.toFixed(1)}°`;
    document.getElementById("dbg-scale-x").textContent = state.debug.scaleX.toFixed(3);
    document.getElementById("dbg-scale-y").textContent = state.debug.scaleY.toFixed(3);
}

function debugSetStatus(msg, isErr) {
    const el = document.getElementById("dbg-status");
    el.textContent = msg;
    el.className = isErr ? "err" : "";
}

function debugFilenameFor(key) {
    return GEOJSON_FILES[key].split("/").pop();
}

function debugDownload(filename, content) {
    const blob = new Blob([content], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function wireDebugControls() {
    const toggle = document.getElementById("debug-toggle");
    const panel = document.getElementById("debug-panel");

    toggle.addEventListener("click", () => {
        state.debug.active = !state.debug.active;
        toggle.classList.toggle("active", state.debug.active);
        panel.classList.toggle("open", state.debug.active);
    });

    const moveStepEl = document.getElementById("dbg-move-step");
    const rotateStepEl = document.getElementById("dbg-rotate-step");
    const scaleStepEl = document.getElementById("dbg-scale-step");

    function afterAdjust() {
        updateDebugReadout();
        renderDebugGeoJson();
    }

    document.getElementById("dbg-move-n").addEventListener("click", () => {
        state.debug.north += Number(moveStepEl.value) || 0;
        afterAdjust();
    });
    document.getElementById("dbg-move-s").addEventListener("click", () => {
        state.debug.north -= Number(moveStepEl.value) || 0;
        afterAdjust();
    });
    document.getElementById("dbg-move-e").addEventListener("click", () => {
        state.debug.east += Number(moveStepEl.value) || 0;
        afterAdjust();
    });
    document.getElementById("dbg-move-w").addEventListener("click", () => {
        state.debug.east -= Number(moveStepEl.value) || 0;
        afterAdjust();
    });
    document.getElementById("dbg-move-reset").addEventListener("click", () => {
        state.debug.east = 0;
        state.debug.north = 0;
        afterAdjust();
    });

    document.getElementById("dbg-rotate-cw").addEventListener("click", () => {
        state.debug.rotationDeg = (state.debug.rotationDeg + (Number(rotateStepEl.value) || 0)) % 360;
        afterAdjust();
    });
    document.getElementById("dbg-rotate-ccw").addEventListener("click", () => {
        state.debug.rotationDeg = (state.debug.rotationDeg - (Number(rotateStepEl.value) || 0) + 360) % 360;
        afterAdjust();
    });

    document.getElementById("dbg-scale-x-up").addEventListener("click", () => {
        state.debug.scaleX += Number(scaleStepEl.value) || 0;
        afterAdjust();
    });
    document.getElementById("dbg-scale-x-down").addEventListener("click", () => {
        state.debug.scaleX = Math.max(0.01, state.debug.scaleX - (Number(scaleStepEl.value) || 0));
        afterAdjust();
    });
    document.getElementById("dbg-scale-y-up").addEventListener("click", () => {
        state.debug.scaleY += Number(scaleStepEl.value) || 0;
        afterAdjust();
    });
    document.getElementById("dbg-scale-y-down").addEventListener("click", () => {
        state.debug.scaleY = Math.max(0.01, state.debug.scaleY - (Number(scaleStepEl.value) || 0));
        afterAdjust();
    });

    document.getElementById("dbg-reset-all").addEventListener("click", () => {
        state.debug.east = 0;
        state.debug.north = 0;
        state.debug.rotationDeg = 0;
        state.debug.scaleX = 1;
        state.debug.scaleY = 1;
        afterAdjust();
        debugSetStatus("Reset to original.");
    });

    document.getElementById("dbg-copy").addEventListener("click", async () => {
        const key = document.getElementById("dbg-dataset").value;
        if (!state.debug.originals) {
            debugSetStatus("No GeoJSON loaded yet.", true);
            return;
        }
        const text = JSON.stringify(debugCurrentDataset(key));
        try {
            await navigator.clipboard.writeText(text);
            debugSetStatus(`Copied ${debugFilenameFor(key)} (${text.length.toLocaleString()} chars) to clipboard.`);
        } catch (err) {
            debugSetStatus(`Clipboard copy failed: ${err.message}`, true);
        }
    });

    document.getElementById("dbg-download").addEventListener("click", () => {
        const key = document.getElementById("dbg-dataset").value;
        if (!state.debug.originals) {
            debugSetStatus("No GeoJSON loaded yet.", true);
            return;
        }
        const filename = debugFilenameFor(key);
        debugDownload(filename, JSON.stringify(debugCurrentDataset(key)));
        debugSetStatus(`Downloaded ${filename}. Save it over the original in the project root to persist.`);
    });

    document.getElementById("dbg-copy-all").addEventListener("click", async () => {
        if (!state.debug.originals) {
            debugSetStatus("No GeoJSON loaded yet.", true);
            return;
        }
        const bundle = {};
        for (const key of Object.keys(GEOJSON_FILES)) {
            bundle[debugFilenameFor(key)] = debugCurrentDataset(key);
        }
        const text = JSON.stringify(bundle);
        try {
            await navigator.clipboard.writeText(text);
            debugSetStatus(`Copied all 8 files as one JSON bundle (${text.length.toLocaleString()} chars).`);
        } catch (err) {
            debugSetStatus(`Clipboard copy failed: ${err.message}`, true);
        }
    });
}

/* ---------------------------------------------------------------------- */
/* Building footprint                                                     */
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

async function loadStore(storeId) {
    const data = await fetchJSON(`/api/stores/${encodeURIComponent(storeId)}/map`);
    state.currentStoreId = storeId;
    state.currentStore = data.store;

    document.getElementById("store-meta").textContent = data.store.address;

    clearFeatureLayers();

    await loadGeoJsonFloorplan();

    const geoJsonBounds = L.featureGroup([
        state.layers.departments,
        state.layers.aisles,
        state.layers.racks,
        state.layers.departmentLines,
        state.layers.aisleLines,
        state.layers.rackLines,
    ]).getBounds();
    if (geoJsonBounds.isValid()) {
        state.map.fitBounds(geoJsonBounds.pad(0.12), { maxZoom: ZOOM.DEPT_LABELS });
    } else {
        state.map.setView([data.anchor.latitude, data.anchor.longitude], DEFAULT_ZOOM);
    }

    if (state.layers.storePin) {
        state.map.removeLayer(state.layers.storePin);
    }
    const pinLatLng = geoJsonBounds.isValid()
        ? geoJsonBounds.getCenter()
        : L.latLng(data.anchor.latitude, data.anchor.longitude);
    const pin = L.marker(pinLatLng, {
        icon: L.divIcon({
            className: "",
            html: `<div class="marker-icon store-pin">S</div>`,
            iconSize: [34, 34],
            iconAnchor: [17, 17],
        }),
    }).addTo(state.map);
    pin.bindPopup(`<b>${data.store.name}</b>${data.store.address}`);
    pin.on("click", () => {
        state.map.setView(pinLatLng, ZOOM.DEPT_LABELS);
    });
    state.layers.storePin = pin;

    updateZoomVisibility();

    await loadBuilding(storeId);
}

/* ---------------------------------------------------------------------- */
/* Layer panel checkboxes                                                 */
/* ---------------------------------------------------------------------- */

function wireLayerControls() {
    document.getElementById("layer-outlines").addEventListener("change", (e) => {
        const visible = e.target.checked;
        setLayerVisible(state.layers.departmentLines, state.map, visible);
        setLayerVisible(state.layers.aisleLines, state.map, visible && state.map.getZoom() >= ZOOM.DEPT_LABELS_ALL);
        setLayerVisible(state.layers.rackLines, state.map, visible && state.map.getZoom() >= ZOOM.AISLE_LABELS);
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
}

/* ---------------------------------------------------------------------- */
/* Boot                                                                    */
/* ---------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", async () => {
    initMap();
    wireLayerControls();
    wireDebugControls();
    try {
        await loadStores();
    } catch (err) {
        console.error("Failed to load stores:", err);
        document.getElementById("store-meta").textContent = "Failed to load store directory.";
    }
});
