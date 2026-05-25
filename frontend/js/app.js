/**
 * Flight Radar v3 - MapLibre GL + WebGL rendering
 * Handles thousands of aircraft smoothly
 */

// --- Map Setup (MapLibre GL) ---
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      'tiles-dark': {
        type: 'raster',
        tiles: THEMES.dark.tiles,
        tileSize: 256,
        attribution: '© OSM © CARTO | Data: adsb.lol + adsb.fi + FR24'
      },
      'tiles-light': {
        type: 'raster',
        tiles: THEMES.light.tiles,
        tileSize: 256
      }
    },
    layers: [
      {
        id: 'dark-layer',
        type: 'raster',
        source: 'tiles-dark',
        minzoom: 0,
        maxzoom: 18,
        layout: { visibility: currentTheme === 'dark' ? 'visible' : 'none' },
        paint: { 'raster-fade-duration': 0 }
      },
      {
        id: 'light-layer',
        type: 'raster',
        source: 'tiles-light',
        minzoom: 0,
        maxzoom: 18,
        layout: { visibility: currentTheme === 'light' ? 'visible' : 'none' },
        paint: { 'raster-fade-duration': 0 }
      }
    ]
  },
  center: [110, 30],
  zoom: 3.5,
  minZoom: 2,
  maxZoom: 16,
  attributionControl: true
});

// --- State ---
let aircraft = [];
let aircraftMap = new Map();
let filteredAircraft = [];
let selectedIcao = null;
let wsConnected = false;
let filterText = '';
let airportsData = []; // [iata, name, city, lat, lon]

// --- Precomputed plane image for WebGL ---
const PLANE_IMG_SIZE = 48;
const PLANE_COLORS = {
  low: [76, 175, 80],       // green - ground to 5000ft
  mid: [0, 188, 212],       // cyan - 5000-25000ft
  high: [156, 39, 176],     // purple - 25000-35000ft
  cruise: [33, 150, 243],   // blue - 35000ft+
  selected: [255, 215, 0],   // bright gold
  ground: [158, 158, 158]   // grey
};

function getAltitudeColor(alt, onGround) {
  if (onGround) return PLANE_COLORS.ground;
  if (!alt || alt <= 0) return PLANE_COLORS.ground;
  if (alt < 5000) return PLANE_COLORS.low;
  if (alt < 25000) return PLANE_COLORS.mid;
  if (alt < 35000) return PLANE_COLORS.high;
  return PLANE_COLORS.cruise;
}

function createPlaneImage(color, name, size) {
  size = size || PLANE_IMG_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const [r, g, b] = color;
  const s = size / 48; // scale factor

  ctx.translate(size / 2, size / 2);

  // Shadow
  ctx.shadowColor = `rgba(${r},${g},${b},0.4)`;
  ctx.shadowBlur = 4 * s;

  // Wings
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.beginPath();
  ctx.moveTo(0, -2 * s);
  ctx.lineTo(-18 * s, 6 * s);
  ctx.lineTo(-18 * s, 9 * s);
  ctx.lineTo(0, 5 * s);
  ctx.lineTo(18 * s, 9 * s);
  ctx.lineTo(18 * s, 6 * s);
  ctx.closePath();
  ctx.fill();

  ctx.shadowBlur = 0;

  // Fuselage
  const grad = ctx.createLinearGradient(-3 * s, 0, 3 * s, 0);
  grad.addColorStop(0, `rgba(${Math.max(0,r-30)},${Math.max(0,g-30)},${Math.max(0,b-30)},1)`);
  grad.addColorStop(0.4, `rgba(${Math.min(255,r+40)},${Math.min(255,g+40)},${Math.min(255,b+40)},1)`);
  grad.addColorStop(1, `rgba(${Math.max(0,r-30)},${Math.max(0,g-30)},${Math.max(0,b-30)},1)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, -20 * s);
  ctx.bezierCurveTo(3 * s, -14 * s, 3 * s, 8 * s, 2 * s, 17 * s);
  ctx.lineTo(0, 19 * s);
  ctx.lineTo(-2 * s, 17 * s);
  ctx.bezierCurveTo(-3 * s, 8 * s, -3 * s, -14 * s, 0, -20 * s);
  ctx.closePath();
  ctx.fill();

  // Tail
  ctx.fillStyle = `rgba(${Math.max(0,r-20)},${Math.max(0,g-20)},${Math.max(0,b-20)},1)`;
  ctx.beginPath();
  ctx.moveTo(0, 13 * s);
  ctx.lineTo(-8 * s, 19 * s);
  ctx.lineTo(-8 * s, 21 * s);
  ctx.lineTo(0, 17 * s);
  ctx.lineTo(8 * s, 21 * s);
  ctx.lineTo(8 * s, 19 * s);
  ctx.closePath();
  ctx.fill();

  // Highlight
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath();
  ctx.ellipse(-1 * s, -10 * s, 1.2 * s, 6 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

// --- Register plane images with map ---
function addPlaneImages() {
  const images = [
    { name: 'plane-low', color: PLANE_COLORS.low, size: PLANE_IMG_SIZE },
    { name: 'plane-mid', color: PLANE_COLORS.mid, size: PLANE_IMG_SIZE },
    { name: 'plane-high', color: PLANE_COLORS.high, size: PLANE_IMG_SIZE },
    { name: 'plane-cruise', color: PLANE_COLORS.cruise, size: PLANE_IMG_SIZE },
    { name: 'plane-selected', color: PLANE_COLORS.selected, size: 64 },
    { name: 'plane-ground', color: PLANE_COLORS.ground, size: PLANE_IMG_SIZE },
  ];

  for (const { name, color, size } of images) {
    if (map.hasImage(name)) map.removeImage(name);
    const canvas = createPlaneImage(color, name, size);
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, size, size);
    map.addImage(name, {
      width: size,
      height: size,
      data: new Uint8Array(imgData.data.buffer)
    });
  }
}

function getPlaneImageName(alt, onGround, isSelected) {
  if (isSelected) return 'plane-selected';
  if (onGround) return 'plane-ground';
  if (!alt || alt <= 0) return 'plane-ground';
  if (alt < 5000) return 'plane-low';
  if (alt < 25000) return 'plane-mid';
  if (alt < 35000) return 'plane-high';
  return 'plane-cruise';
}

// --- GeoJSON source for aircraft ---
function aircraftToGeoJSON(planes) {
  return {
    type: 'FeatureCollection',
    features: planes.filter(a => a.lat && a.lon).map(a => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [a.lon, a.lat]
      },
      properties: {
        icao24: a.icao24,
        callsign: a.callsign || '',
        heading: a.heading || 0,
        altitude: a.altitude || 0,
        onGround: a.onGround || false,
        icon: getPlaneImageName(a.altitude, a.onGround, a.icao24 === selectedIcao)
      }
    }))
  };
}

// --- Map loaded ---
map.on('load', () => {
  addPlaneImages();

  // Re-add images if they get lost (e.g. after style change)
  map.on('styleimagemissing', (e) => {
    if (e.id.startsWith('plane-')) {
      addPlaneImages();
    }
  });

  // Aircraft source
  map.addSource('aircraft', {
    type: 'geojson',
    data: aircraftToGeoJSON([])
  });

  // Aircraft layer
  map.addLayer({
    id: 'aircraft-layer',
    type: 'symbol',
    source: 'aircraft',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': [
        'interpolate', ['linear'], ['zoom'],
        2, 0.35,
        5, 0.5,
        8, 0.7,
        12, 0.9
      ],
      'icon-rotate': ['get', 'heading'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'text-field': ['step', ['zoom'], '', 7, ['get', 'callsign']],
      'text-font': ['Open Sans Regular'],
      'text-size': 10,
      'text-offset': [1.2, 0],
      'text-anchor': 'left',
      'text-optional': true
    },
    paint: {
      'text-color': 'rgba(200, 220, 255, 0.8)',
      'text-halo-color': 'rgba(0, 0, 0, 0.7)',
      'text-halo-width': 1
    }
  });

  // Trail layer
  map.addSource('trail', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });

  map.addLayer({
    id: 'trail-layer',
    type: 'line',
    source: 'trail',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#4fc3f7',
      'line-width': 2,
      'line-opacity': 0.6
    }
  }, 'aircraft-layer');

  // Click handler
  map.on('click', 'aircraft-layer', (e) => {
    if (e.features.length > 0) {
      const icao = e.features[0].properties.icao24;
      selectFlight(icao);
    }
  });

  // Click elsewhere to deselect
  map.on('click', (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ['aircraft-layer'] });
    if (features.length === 0) closeDetail();
  });

  // Cursor
  map.on('mouseenter', 'aircraft-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'aircraft-layer', () => { map.getCanvas().style.cursor = ''; });

  // --- Airport layer ---
  loadAirports();

  // --- Route arc layer ---
  map.addSource('route-arc', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  map.addLayer({
    id: 'route-arc-layer',
    type: 'line',
    source: 'route-arc',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ff9800',
      'line-width': 1.5,
      'line-opacity': 0.5,
      'line-dasharray': [4, 4]
    }
  }, 'trail-layer');

  // Start WebSocket
  connect();
});

// --- Update aircraft on map ---
function updateMap() {
  if (!map.getSource('aircraft')) return;

  filteredAircraft = aircraft.filter(matchesFilter);
  const geojson = aircraftToGeoJSON(filteredAircraft);
  map.getSource('aircraft').setData(geojson);

  document.getElementById('flight-count').textContent = filteredAircraft.length;
  document.getElementById('filter-stats').textContent =
    filterText ? `Showing ${filteredAircraft.length} of ${aircraft.length}` : '';
}

// --- Flight Detail ---
function selectFlight(icao24) {
  // Toggle: click again to deselect
  if (selectedIcao === icao24) {
    closeDetail();
    return;
  }
  selectedIcao = icao24;
  const f = aircraftMap.get(icao24);
  if (f) {
    showDetail(f);
    loadTrail(icao24);
  }
  updateMap();
}

function showDetail(f) {
  const panel = document.getElementById('flight-detail');
  panel.className = 'visible';
  panel.style.display = 'block';

  document.getElementById('detail-callsign').textContent = f.callsign || f.icao24.toUpperCase();
  document.getElementById('detail-subtitle').textContent =
    [f.type, f.registration, f.airline].filter(Boolean).join(' · ');
  document.getElementById('detail-icao').textContent = f.icao24.toUpperCase();
  document.getElementById('detail-type').textContent = f.type || '-';
  document.getElementById('detail-reg').textContent = f.registration || '-';
  document.getElementById('detail-country').textContent = f.country || '-';
  document.getElementById('detail-alt').textContent =
    f.altitude != null ? (f.onGround ? 'Ground' : `${f.altitude.toLocaleString()} ft`) : '-';
  document.getElementById('detail-speed').textContent =
    f.velocity ? `${Math.round(f.velocity)} kts (${Math.round(f.velocity * 1.852)} km/h)` : '-';
  document.getElementById('detail-heading').textContent =
    f.heading != null ? `${Math.round(f.heading)}°` : '-';
  document.getElementById('detail-vrate').textContent =
    f.verticalRate ? `${f.verticalRate > 0 ? '+' : ''}${f.verticalRate} ft/min` : '-';
  document.getElementById('detail-squawk').textContent = f.squawk || '-';
  document.getElementById('detail-route').textContent =
    (f.origin && f.destination) ? `${f.origin} → ${f.destination}` : '-';

  // Load plane photo
  loadPlanePhoto(f.icao24, f.registration);

  // Load route arc
  loadRouteArc(f.origin, f.destination);

  // Position: right of aircraft
  positionDetail(f);
}

function positionDetail(f) {
  if (!f || !f.lat || !f.lon) return;
  const panel = document.getElementById('flight-detail');
  const point = map.project([f.lon, f.lat]);
  const mapRect = map.getContainer().getBoundingClientRect();
  
  let left = point.x + 20;
  let top = point.y - 20;
  
  // Keep panel in view
  const panelW = 320, panelH = 280;
  if (left + panelW > mapRect.width) left = point.x - panelW - 20;
  if (top + panelH > mapRect.height) top = mapRect.height - panelH - 10;
  if (top < 10) top = 10;

  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

async function loadTrail(icao24) {
  try {
    const resp = await fetch(`/api/trail/${icao24}`);
    const data = await resp.json();
    if (data.trail && data.trail.length > 1) {
      const coords = data.trail.map(p => [p.lon, p.lat]);
      map.getSource('trail').setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords }
        }]
      });
    }
  } catch (e) {}
}

function closeDetail() {
  const panel = document.getElementById('flight-detail');
  panel.style.display = 'none';
  panel.className = '';
  selectedIcao = null;
  map.getSource('trail')?.setData({ type: 'FeatureCollection', features: [] });
  map.getSource('route-arc')?.setData({ type: 'FeatureCollection', features: [] });
  updateMap();
}

// Reposition on map move
map.on('move', () => {
  if (selectedIcao) {
    const f = aircraftMap.get(selectedIcao);
    if (f) positionDetail(f);
  }
});

// --- Filter ---
function matchesFilter(plane) {
  if (!filterText) return true;
  const q = filterText.toUpperCase();
  if (plane.callsign?.toUpperCase().includes(q)) return true;
  if (plane.registration?.toUpperCase().includes(q)) return true;
  if (plane.type?.toUpperCase().includes(q)) return true;
  if (plane.airline?.toUpperCase().includes(q)) return true;
  if (plane.origin?.toUpperCase().includes(q)) return true;
  if (plane.destination?.toUpperCase().includes(q)) return true;
  const route = `${plane.origin || ''}-${plane.destination || ''}`.toUpperCase();
  if (route.length > 1 && route.includes(q)) return true;
  return false;
}

function applyFilter() {
  filterText = document.getElementById('filter-input').value.trim();
  updateMap();

  // Show autocomplete suggestions
  const suggestions = getSearchSuggestions(filterText);
  showSuggestions(suggestions);

  if (filterText && filteredAircraft.length > 0 && filteredAircraft.length <= 10) {
    if (filteredAircraft.length === 1) {
      const a = filteredAircraft[0];
      map.flyTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), 7) });
      selectFlight(a.icao24);
    } else {
      const bounds = new maplibregl.LngLatBounds();
      filteredAircraft.forEach(a => bounds.extend([a.lon, a.lat]));
      map.fitBounds(bounds, { padding: 60 });
    }
  }
}

function clearFilter() {
  filterText = '';
  document.getElementById('filter-input').value = '';
  updateMap();
}

function toggleFilter() {
  const panel = document.getElementById('filter-panel');
  const body = document.getElementById('filter-body');
  body.classList.toggle('open');
  panel.classList.toggle('expanded', body.classList.contains('open'));
  if (body.classList.contains('open')) {
    document.getElementById('filter-input').focus();
  }
}

// --- WebSocket ---
let ws = null;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    wsConnected = true;
    document.getElementById('status-dot').classList.remove('disconnected');
    document.getElementById('status-text').textContent = 'Live';
    sendViewport();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'full') {
        aircraft = data.aircraft || [];
        aircraftMap = new Map(aircraft.map(a => [a.icao24, a]));
        updateMap();
        updateStatsBar();
      } else if (data.type === 'delta') {
        // Apply delta
        for (const ac of (data.changed || [])) {
          aircraftMap.set(ac.icao24, ac);
        }
        for (const icao of (data.removed || [])) {
          aircraftMap.delete(icao);
        }
        aircraft = Array.from(aircraftMap.values());
        updateMap();
        updateStatsBar();
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    wsConnected = false;
    document.getElementById('status-dot').classList.add('disconnected');
    document.getElementById('status-text').textContent = 'Reconnecting...';
    setTimeout(connect, 3000);
  };

  ws.onerror = () => ws.close();
}

function sendViewport() {
  if (ws && ws.readyState === 1) {
    const center = map.getCenter();
    const bounds = map.getBounds();
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const latDist = (ne.lat - sw.lat) * 60 / 2;
    const lonDist = (ne.lng - sw.lng) * Math.cos(center.lat * Math.PI / 180) * 60 / 2;
    const dist = Math.min(Math.round(Math.sqrt(latDist ** 2 + lonDist ** 2)), 250);
    ws.send(JSON.stringify({ type: 'viewport', lat: center.lat, lon: center.lng, dist }));
  }
}

map.on('moveend', () => {
  clearTimeout(window._vpTimer);
  window._vpTimer = setTimeout(sendViewport, 600);
});

// --- Stats bar (throttled) ---
let _statsTimer = null;
function updateStatsBar() {
  if (_statsTimer) return;
  _statsTimer = setTimeout(() => {
    _statsTimer = null;
    const bounds = map.getBounds();
    let inView = 0;
    for (const a of aircraft) {
      if (a.lat && a.lon && bounds.contains([a.lat, a.lon])) inView++;
    }
    const avgAlt = aircraft.reduce((sum, a) => sum + (a.altitude || 0), 0) / (aircraft.length || 1);
    document.getElementById('stats-content').textContent =
      `${aircraft.length} ${t('tracked')} · ${inView} ${t('inView')} · ${t('avgAlt')}: ${Math.round(avgAlt).toLocaleString()} ft`;
  }, 2000);
}

// --- Polling fallback ---
setInterval(async () => {
  if (wsConnected) return;
  try {
    const resp = await fetch('/api/flights');
    const data = await resp.json();
    if (data.aircraft?.length > 0) {
      aircraft = data.aircraft;
      aircraftMap = new Map(aircraft.map(a => [a.icao24, a]));
      updateMap();
      updateStatsBar();
    }
  } catch (e) {}
}, 15000);

// --- Expose globals ---
// --- Airport layer ---
async function loadAirports() {
  try {
    const resp = await fetch('/data/airports.json');
    airportsData = await resp.json();
    
    const geojson = {
      type: 'FeatureCollection',
      features: airportsData.map(a => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a[3], a[2] || a[3], a[3]][0] ? [a[4], a[3]] : [0,0] },
        properties: { iata: a[0], name: a[1], city: a[2] }
      })).filter(f => f.geometry.coordinates[0] && f.geometry.coordinates[1])
    };
    // Fix: airports format is [iata, name, city, lat, lon]
    geojson.features = airportsData.map(a => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a[4], a[3]] },
      properties: { iata: a[0], name: a[1], city: a[2] }
    }));

    map.addSource('airports', { type: 'geojson', data: geojson });
    map.addLayer({
      id: 'airports-layer',
      type: 'symbol',
      source: 'airports',
      minzoom: 5,
      layout: {
        'text-field': ['get', 'iata'],
        'text-font': ['Open Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 5, 9, 10, 12],
        'text-anchor': 'center',
        'text-allow-overlap': false,
        'icon-allow-overlap': false
      },
      paint: {
        'text-color': currentTheme === 'dark' ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)',
        'text-halo-color': currentTheme === 'dark' ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.8)',
        'text-halo-width': 1
      }
    }, 'aircraft-layer');
  } catch (e) {
    console.error('Failed to load airports:', e);
  }
}

// --- Route arc ---
async function loadRouteArc(origin, destination) {
  if (!origin || !destination || !airportsData.length) {
    map.getSource('route-arc')?.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  const orig = airportsData.find(a => a[0] === origin);
  const dest = airportsData.find(a => a[0] === destination);
  if (!orig || !dest) {
    map.getSource('route-arc')?.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  try {
    const resp = await fetch(`/api/arc?lat1=${orig[3]}&lon1=${orig[4]}&lat2=${dest[3]}&lon2=${dest[4]}`);
    const data = await resp.json();
    if (data.arc) {
      map.getSource('route-arc').setData({
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: data.arc }
        }]
      });
    }
  } catch (e) {}
}

// --- Search autocomplete ---
function getSearchSuggestions(query) {
  if (!query || query.length < 2) return [];
  const q = query.toUpperCase();
  const results = [];
  
  // Match aircraft
  for (const a of aircraft) {
    if (results.length >= 8) break;
    if (a.callsign?.toUpperCase().includes(q) ||
        a.registration?.toUpperCase().includes(q) ||
        a.type?.toUpperCase().includes(q)) {
      results.push({
        type: 'flight',
        label: `${a.callsign || a.icao24} ${a.type ? '(' + a.type + ')' : ''}`,
        sublabel: a.origin && a.destination ? `${a.origin} → ${a.destination}` : '',
        icao24: a.icao24
      });
    }
  }
  
  // Match airports
  for (const a of airportsData) {
    if (results.length >= 12) break;
    if (a[0].includes(q) || a[1].toUpperCase().includes(q) || (a[2] && a[2].toUpperCase().includes(q))) {
      results.push({
        type: 'airport',
        label: `${a[0]} - ${a[1]}`,
        sublabel: a[2] || '',
        lat: a[3], lon: a[4]
      });
    }
  }
  return results;
}

function showSuggestions(suggestions) {
  let container = document.getElementById('search-suggestions');
  if (!container) {
    container = document.createElement('div');
    container.id = 'search-suggestions';
    document.getElementById('filter-body').appendChild(container);
  }
  if (suggestions.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  container.innerHTML = suggestions.map((s, i) => `
    <div class="suggestion-item" onclick="selectSuggestion(${i})">
      <span class="suggestion-icon">${s.type === 'flight' ? '✈' : '🏢'}</span>
      <span class="suggestion-text">
        <span class="suggestion-label">${s.label}</span>
        ${s.sublabel ? `<span class="suggestion-sub">${s.sublabel}</span>` : ''}
      </span>
    </div>
  `).join('');
  window._suggestions = suggestions;
}

function selectSuggestion(index) {
  const s = window._suggestions[index];
  if (!s) return;
  if (s.type === 'flight') {
    selectFlight(s.icao24);
    const f = aircraftMap.get(s.icao24);
    if (f) map.flyTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 7) });
  } else if (s.type === 'airport') {
    map.flyTo({ center: [s.lon, s.lat], zoom: 10 });
  }
  document.getElementById('search-suggestions').style.display = 'none';
}

// --- Plane photo (planespotters.net) ---
async function loadPlanePhoto(icao24, reg) {
  const photoEl = document.getElementById('detail-photo');
  if (!photoEl) return;
  photoEl.innerHTML = '';
  try {
    const query = reg || icao24;
    const resp = await fetch(`https://api.planespotters.net/pub/photos/hex/${icao24}`, {
      headers: { 'User-Agent': 'FlightRadar/1.0 (https://flightradar.graymammoth.com)' }
    });
    const data = await resp.json();
    if (data.photos && data.photos.length > 0) {
      const photo = data.photos[0];
      photoEl.innerHTML = `<img src="${photo.thumbnail_large.src}" alt="${photo.photographer}" title="© ${photo.photographer}">`;
    }
  } catch (e) {}
}

// --- 3D terrain toggle ---
window.closeDetail = closeDetail;
window.toggleFilter = toggleFilter;
window.applyFilter = applyFilter;
window.clearFilter = clearFilter;
window.updateStatsBar = updateStatsBar;
window.selectSuggestion = selectSuggestion;

// Init language
updateUI();

// Register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
