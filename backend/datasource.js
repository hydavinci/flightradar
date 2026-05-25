/**
 * Data source module - multi-source aircraft data aggregation
 * Sources: adsb.lol, opendata.adsb.fi, FR24 public feed
 */

// --- Circuit Breaker ---
class CircuitBreaker {
  constructor(name, { failThreshold = 3, cooldownMs = 60000 } = {}) {
    this.name = name;
    this.failCount = 0;
    this.failThreshold = failThreshold;
    this.cooldownMs = cooldownMs;
    this.openUntil = 0;
  }

  isOpen() {
    if (Date.now() < this.openUntil) return true;
    if (this.openUntil > 0 && Date.now() >= this.openUntil) {
      // Half-open: allow one attempt
      this.openUntil = 0;
      this.failCount = 0;
    }
    return false;
  }

  recordSuccess() { this.failCount = 0; }

  recordFailure() {
    this.failCount++;
    if (this.failCount >= this.failThreshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      console.warn(`[CircuitBreaker] ${this.name} opened for ${this.cooldownMs / 1000}s`);
    }
  }

  status() {
    return {
      name: this.name,
      state: this.isOpen() ? 'open' : 'closed',
      failCount: this.failCount,
      openUntil: this.openUntil > 0 ? new Date(this.openUntil).toISOString() : null
    };
  }
}

// Breakers per source
const breakers = {
  lol: new CircuitBreaker('adsb.lol'),
  fi: new CircuitBreaker('adsb.fi', { cooldownMs: 90000 }),
  fr24: new CircuitBreaker('fr24', { cooldownMs: 120000 })
};

// --- Fetchers ---

async function fetchAdsbLol(lat, lon, dist = 250) {
  if (breakers.lol.isOpen()) return [];
  try {
    const url = `https://api.adsb.lol/v2/lat/${lat.toFixed(2)}/lon/${lon.toFixed(2)}/dist/${Math.min(dist, 250)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    breakers.lol.recordSuccess();
    return parseAdsbFormat(data.ac || [], 'lol');
  } catch (e) {
    breakers.lol.recordFailure();
    throw e;
  }
}

async function fetchAdsbFi(lat, lon, dist = 250) {
  if (breakers.fi.isOpen()) return [];
  try {
    const url = `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(2)}/lon/${lon.toFixed(2)}/dist/${Math.min(dist, 250)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    breakers.fi.recordSuccess();
    return parseAdsbFormat(data.aircraft || data.ac || [], 'fi');
  } catch (e) {
    breakers.fi.recordFailure();
    throw e;
  }
}

async function fetchFR24(bounds) {
  if (breakers.fr24.isOpen()) return [];
  try {
    const { south, north, west, east } = bounds;
    const url = `https://data-cloud.flightradar24.com/zones/fcgi/feed.js?bounds=${north},${south},${east},${west}&faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=1&air=1`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FlightRadar/1.0)' }
    });
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    breakers.fr24.recordSuccess();
    return parseFR24(data);
  } catch (e) {
    breakers.fr24.recordFailure();
    throw e;
  }
}

// --- Parsers ---

function parseAdsbFormat(ac, source) {
  return ac
    .filter(a => a.lat != null && a.lon != null)
    .map(a => ({
      icao24: (a.hex || '').toLowerCase(),
      callsign: (a.flight || '').trim(),
      registration: a.r || '',
      type: a.t || '',
      country: a.flagcode || '',
      lat: a.lat,
      lon: a.lon,
      altitude: a.alt_baro === 'ground' ? 0 : (a.alt_baro || null),
      altGeom: a.alt_geom || null,
      onGround: a.alt_baro === 'ground',
      velocity: a.gs || null,
      heading: a.track || a.true_heading || null,
      verticalRate: a.baro_rate || a.geom_rate || null,
      squawk: a.squawk || '',
      category: a.category || '',
      seen: a.seen || 0,
      origin: '',
      destination: '',
      airline: '',
      _source: source
    }));
}

function parseFR24(data) {
  const results = [];
  for (const [key, val] of Object.entries(data)) {
    if (!Array.isArray(val) || val.length < 14) continue;
    // FR24 format: [icao, lat, lon, heading, alt, speed, squawk, radar, type, reg, timestamp, origin, dest, callsign, onGround, vertRate, callsign2, ?, airline]
    const icao = (val[0] || '').toLowerCase();
    if (!icao || !val[1] || !val[2]) continue;
    results.push({
      icao24: icao,
      callsign: (val[16] || val[13] || '').trim(),
      registration: val[9] || '',
      type: val[8] || '',
      country: '',
      lat: val[1],
      lon: val[2],
      altitude: val[4] || null,
      altGeom: null,
      onGround: val[14] === 1,
      velocity: val[5] || null,    // knots
      heading: val[3] || null,
      verticalRate: val[15] || null,
      squawk: val[6] || '',
      category: '',
      seen: 0,
      origin: val[11] || '',
      destination: val[12] || '',
      airline: val[18] || '',
      _source: 'fr24',
      _fr24Id: key
    });
  }
  return results;
}

// --- Region definitions ---

const REGIONS = {
  // adsb.lol regions (Europe/Americas/Middle East)
  lol: [
    { lat: 50, lon: 10, dist: 250, label: 'Europe Central' },
    { lat: 55, lon: -3, dist: 250, label: 'UK/North Europe' },
    { lat: 40, lon: -74, dist: 250, label: 'US East' },
    { lat: 34, lon: -118, dist: 250, label: 'US West' },
    { lat: 25, lon: 55, dist: 200, label: 'Middle East' },
  ],
  // adsb.fi regions (Asia)
  fi: [
    { lat: 35, lon: 140, dist: 250, label: 'Japan' },
    { lat: 25, lon: 122, dist: 200, label: 'Taiwan' },
    { lat: 22, lon: 114, dist: 200, label: 'South China/HK' },
    { lat: 13, lon: 100, dist: 200, label: 'Southeast Asia' },
    { lat: 1, lon: 104, dist: 200, label: 'Singapore' },
  ],
  // FR24 regions (bounding boxes, especially China)
  fr24: [
    { south: 20, north: 35, west: 100, east: 125, label: 'China South/Central' },
    { south: 35, north: 50, west: 75, east: 125, label: 'China North/West' },
    { south: 20, north: 45, west: 125, east: 145, label: 'Korea/Japan East' },
    { south: -10, north: 10, west: 95, east: 140, label: 'Indonesia' },
    { south: 10, north: 30, west: 65, east: 95, label: 'India' },
  ]
};

// --- Parallel fetch all sources ---

async function fetchAllSources() {
  const results = [];

  // Run all three source groups in parallel
  const [lolResults, fiResults, fr24Results] = await Promise.allSettled([
    fetchSourceGroup('lol'),
    fetchSourceGroup('fi'),
    fetchSourceGroupFR24()
  ]);

  if (lolResults.status === 'fulfilled') results.push(...lolResults.value);
  if (fiResults.status === 'fulfilled') results.push(...fiResults.value);
  if (fr24Results.status === 'fulfilled') results.push(...fr24Results.value);

  return results;
}

async function fetchSourceGroup(source) {
  const regions = REGIONS[source];
  const fetcher = source === 'fi' ? fetchAdsbFi : fetchAdsbLol;
  const allFlights = [];

  for (const region of regions) {
    try {
      const flights = await fetcher(region.lat, region.lon, region.dist);
      allFlights.push(...flights);
    } catch (e) {
      // Already handled by circuit breaker
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return allFlights;
}

async function fetchSourceGroupFR24() {
  const regions = REGIONS.fr24;
  const allFlights = [];

  for (const bounds of regions) {
    try {
      const flights = await fetchFR24(bounds);
      allFlights.push(...flights);
    } catch (e) {
      // Already handled by circuit breaker
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return allFlights;
}

// --- Viewport-based fetch for client requests ---

async function fetchForViewport(lat, lon, dist) {
  const results = [];
  
  // Determine which source is best for this region
  const isAsia = lon >= 60 && lon <= 150;
  const isEurope = lon >= -15 && lon <= 45;
  const isAmericas = lon >= -140 && lon <= -30;

  const fetches = [];
  if (isAsia) {
    fetches.push(fetchAdsbFi(lat, lon, dist).catch(() => []));
    // FR24 covers Asia well
    fetches.push(fetchFR24({
      south: lat - dist / 60,
      north: lat + dist / 60,
      west: lon - dist / 60,
      east: lon + dist / 60
    }).catch(() => []));
  }
  if (isEurope || isAmericas) {
    fetches.push(fetchAdsbLol(lat, lon, dist).catch(() => []));
  }
  if (!isAsia && !isEurope && !isAmericas) {
    fetches.push(fetchAdsbLol(lat, lon, dist).catch(() => []));
    fetches.push(fetchAdsbFi(lat, lon, dist).catch(() => []));
  }

  const settled = await Promise.allSettled(fetches);
  for (const r of settled) {
    if (r.status === 'fulfilled') results.push(...r.value);
  }
  return results;
}

export {
  fetchAllSources,
  fetchForViewport,
  breakers,
  REGIONS
};
