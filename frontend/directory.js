/* Nationwide directory. Reuses the existing Leaflet layers, labels and controls. */
const directory = { cache: new Map(), generation: 0, limit: 100, bounds: null, extras: [], location: null };
const el = id => document.getElementById(id);
const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });

function collectLayers(value, path = '', out = []) {
    if (!value || typeof value !== 'object') return out;
    if (value.type === 'FeatureCollection') out.push([path, value]);
    else Object.entries(value).forEach(([key, child]) => collectLayers(child, `${path}/${key}`, out));
    return out;
}

function groupLayers(value) {
    const grouped = Object.fromEntries(FLOORPLAN_LAYER_KEYS.map(key => [key, emptyCollection()]));
    const extra = emptyCollection();
    const layers = collectLayers(value);
    if (!layers.length) throw new Error('Malformed map: no FeatureCollections');
    for (const [name, fc] of layers) {
        if (!Array.isArray(fc.features)) throw new Error('Malformed map features');
        for (const feature of fc.features) {
            if (feature.type !== 'Feature') throw new Error('Malformed GeoJSON feature');
            if (!feature.geometry || feature.geometry.coordinates?.length === 0) continue;
            const type = feature.geometry.type;
            const category = `${name} ${feature.properties?.kind || ''}`.toLowerCase();
            const family = /department|depertment/.test(category) ? 'department' : /aisle/.test(category) ? 'aisle' : /rack/.test(category) ? 'rack' : null;
            const suffix = /Point$/.test(type) ? 'Points' : /LineString$/.test(type) ? 'Lines' : 's';
            const key = family ? family + suffix : '';
            const safeFeature = { ...feature, properties: Object.fromEntries(Object.entries(feature.properties || {}).map(([k,v]) =>
                [k, typeof v === 'string' ? v.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) : v])) };
            if (grouped[key] && type !== 'MultiPoint') grouped[key].features.push(safeFeature);
            else extra.features.push(feature);
        }
    }
    return { grouped, extra };
}

function clearExtras() {
    for (const layer of directory.extras) state.map.removeLayer(layer);
    directory.extras = [];
    if (directory.control) { directory.control.remove(); directory.control = null; }
}

function options(id, values, selected = '') {
    const select = el(id);
    const first = select.options[0].text;
    select.replaceChildren(new Option(first, ''));
    [...new Set(values.filter(Boolean))].sort().forEach(v => select.add(new Option(v, v)));
    select.value = selected;
}

function matchingStores() {
    const query = el('store-search').value.toLowerCase().trim();
    return state.stores.filter(s => (!el('state-filter').value || s.state === el('state-filter').value)
        && (!el('city-filter').value || s.city === el('city-filter').value)
        && [s.name, s.store_id, s.city, s.state, s.zip, s.address].join(' ').toLowerCase().includes(query));
}

function renderDirectory() {
    const stores = matchingStores();
    el('result-count').textContent = `${stores.length.toLocaleString()} stores`;
    const fragment = document.createDocumentFragment();
    for (const s of stores.slice(0, directory.limit)) {
        const button = document.createElement('button');
        button.className = 'store-result';
        button.dataset.storeId = s.store_id;
        button.setAttribute('aria-pressed', String(s.store_id === state.currentStoreId));
        const title = document.createElement('strong'); title.textContent = s.name;
        const subtitle = document.createElement('span'); subtitle.textContent = `${s.city || ''}, ${s.state || ''} · #${s.store_id}`;
        const status = document.createElement('small'); status.textContent = s.map_file ? 'Indoor map available' : 'Map data unavailable';
        button.append(title, subtitle, status);
        button.addEventListener('click', () => loadStore(s.store_id));
        fragment.append(button);
    }
    el('store-list').replaceChildren(fragment);
    el('more-stores').hidden = stores.length <= directory.limit;
}

// The boot handler in app.js resolves these functions after this script loads.
async function loadStores() {
    const response = await fetchJSON('/api/catalog/stores');
    state.stores = response.stores;
    options('state-filter', state.stores.map(s => s.state));
    options('city-filter', state.stores.map(s => s.city));
    el('store-search').addEventListener('input', () => { directory.limit = 100; renderDirectory(); });
    el('state-filter').addEventListener('change', () => {
        options('city-filter', state.stores.filter(s => !el('state-filter').value || s.state === el('state-filter').value).map(s => s.city));
        directory.limit = 100; renderDirectory();
    });
    el('city-filter').addEventListener('change', () => { directory.limit = 100; renderDirectory(); });
    el('more-stores').addEventListener('click', () => { directory.limit += 100; renderDirectory(); });
    el('view-location').onclick = () => directory.location && state.map.setView(directory.location, 18);
    el('view-indoor').onclick = () => directory.bounds?.isValid() && state.map.fitBounds(directory.bounds.pad(0.12), { maxZoom: 20 });
    renderDirectory();
    try {
        const report = await fetchJSON('/api/catalog/report');
        el('catalog-status').textContent = report.discovery_error ? 'Nationwide discovery is incomplete. Showing saved stores.' : response.message || '';
    } catch (error) { console.warn(error); }
    if (state.stores.length) await loadStore(state.stores[0].store_id);
};

async function loadStore(storeId) {
    const generation = ++directory.generation;
    const store = state.stores.find(s => s.store_id === storeId);
    if (!store) return;
    state.currentStoreId = storeId; state.currentStore = store;
    clearFeatureLayers(); clearExtras();
    if (state.layers.storePin) { state.map.removeLayer(state.layers.storePin); state.layers.storePin = null; }
    directory.bounds = null; directory.location = null;
    el('view-indoor').hidden = true; el('view-location').hidden = true;
    el('selected-name').textContent = `${store.name} · #${store.store_id}`;
    el('selected-address').textContent = store.address || 'Address unavailable';
    el('map-status').textContent = 'Loading store map…';
    renderDirectory();
    if (Number.isFinite(store.latitude) && Number.isFinite(store.longitude)) {
        directory.location = [store.latitude, store.longitude];
        state.map.setView(directory.location, DEFAULT_ZOOM);
        const popup = document.createElement('div'); popup.textContent = `${store.name} — ${store.address}`;
        state.layers.storePin = L.marker(directory.location).addTo(state.map).bindPopup(popup);
        el('view-location').hidden = false;
    } else {
        state.map.setView([39.5, -98.35], 4);
    }
    try {
        if (!store.map_file) { el('map-status').textContent = 'Store map unavailable'; return; }
        let data = directory.cache.get(storeId);
        if (!data) {
            data = await fetchJSON(`/api/catalog/stores/${encodeURIComponent(storeId)}/map`);
            directory.cache.set(storeId, data);
            if (directory.cache.size > 5) directory.cache.delete(directory.cache.keys().next().value);
        }
        if (generation !== directory.generation) return;
        const { grouped, extra } = groupLayers(data);
        renderGeoJsonFloorplanData(grouped);
        if (extra.features.length) {
            const layer = L.geoJSON(extra, { onEachFeature: (f, l) => {
                const text = document.createElement('span'); text.textContent = f.properties?.name || f.properties?.label || 'Map feature'; l.bindPopup(text);
            }}).addTo(state.map);
            directory.extras.push(layer);
            directory.control = L.control.layers({}, { 'Additional map features': layer }, { collapsed: false }).addTo(state.map);
        }
        const bounds = L.featureGroup([state.layers.departments, state.layers.aisles, state.layers.racks, state.layers.departmentLines,
            state.layers.aisleLines, state.layers.rackLines, ...state.layers.markerGroup.getLayers(), ...directory.extras]).getBounds();
        directory.bounds = bounds;
        el('view-indoor').hidden = !bounds.isValid();
        const mismatch = bounds.isValid() && directory.location && bounds.getCenter().distanceTo(directory.location) > 2000;
        if (bounds.isValid() && !mismatch) state.map.fitBounds(bounds.pad(0.12), { maxZoom: ZOOM.DEPT_LABELS });
        el('map-status').textContent = mismatch ? 'Indoor data uses different source coordinates. Select Indoor map to view it separately.' :
            store.map_status === 'failed' ? 'Saved map shown; latest refresh failed.' : 'Indoor map ready';
        updateZoomVisibility();
    } catch (error) {
        if (generation !== directory.generation) return;
        clearFeatureLayers(); clearExtras();
        el('map-status').textContent = 'Store map unavailable';
        console.error(`Map ${storeId}:`, error);
    }
};
