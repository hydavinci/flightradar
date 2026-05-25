import express from 'express';
import compression from 'compression';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAllSources, fetchForViewport, breakers } from './datasource.js';
import cache from './cache.js';
import trailStore from './trailStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(compression());
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// --- Static files ---
app.use(express.static(path.join(__dirname, '../frontend'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// --- API Routes ---
app.get('/api/flights', (req, res) => {
  const data = cache.getAll();
  const etag = `"${data.timestamp}"`;
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  res.set('ETag', etag);
  res.set('Cache-Control', 'public, max-age=5');
  res.json(data);
});

app.get('/api/trail/:icao24', async (req, res) => {
  // Try Redis first, fallback to in-memory
  try {
    const trail = await trailStore.getTrail(req.params.icao24);
    if (trail.length > 0) {
      return res.json({ icao24: req.params.icao24, trail });
    }
  } catch (e) {}
  // Fallback to in-memory cache
  const trail = cache.getTrail(req.params.icao24);
  res.json({ icao24: req.params.icao24, trail });
});

// Great circle arc between two points
app.get('/api/arc', (req, res) => {
  const { lat1, lon1, lat2, lon2, points = 60 } = req.query;
  if (!lat1 || !lon1 || !lat2 || !lon2) {
    return res.status(400).json({ error: 'Need lat1, lon1, lat2, lon2' });
  }
  const arc = computeGreatCircle(+lat1, +lon1, +lat2, +lon2, +points);
  res.json({ arc });
});

function computeGreatCircle(lat1, lon1, lat2, lon2, numPoints) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const coords = [];
  const φ1 = toRad(lat1), λ1 = toRad(lon1);
  const φ2 = toRad(lat2), λ2 = toRad(lon2);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
  ));
  if (d < 0.0001) return [[lon1, lat1], [lon2, lat2]];
  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    coords.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return coords;
}

app.get('/api/health', async (req, res) => {
  const stats = cache.getStats();
  const redisOk = await trailStore.isHealthy();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    ...stats,
    redis: redisOk ? 'connected' : 'disconnected',
    breakers: Object.values(breakers).map(b => b.status()),
    wsClients: wss.clients.size
  });
});

// --- WebSocket ---
const WS_PING_INTERVAL = 30000;

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws._hasFull = false;

  // Send current data immediately (full)
  const data = cache.getAll();
  if (data.count > 0) {
    ws.send(JSON.stringify({ type: 'full', ...data }));
    ws._hasFull = true;
  }

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'viewport') {
        ws._viewport = {
          lat: parsed.lat,
          lon: parsed.lon,
          dist: Math.min(parsed.dist || 250, 250)
        };
      }
    } catch (e) {}
  });
});

// WS heartbeat - detect dead connections
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);

wss.on('close', () => clearInterval(pingInterval));

// --- Broadcast ---
let lastBroadcastData = null;
let lastBroadcastMap = new Map(); // icao24 -> {lat, lon, heading, altitude}

function broadcast(data) {
  const fullMsg = JSON.stringify({ type: 'full', ...data });

  // Compute delta
  const newMap = new Map();
  const changed = [];
  const removed = [];

  for (const ac of data.aircraft) {
    newMap.set(ac.icao24, ac);
    const prev = lastBroadcastMap.get(ac.icao24);
    if (!prev ||
        Math.abs(ac.lat - prev.lat) > 0.0005 ||
        Math.abs(ac.lon - prev.lon) > 0.0005 ||
        ac.altitude !== prev.altitude ||
        Math.abs((ac.heading || 0) - (prev.heading || 0)) > 3) {
      changed.push(ac);
    }
  }

  for (const [icao] of lastBroadcastMap) {
    if (!newMap.has(icao)) removed.push(icao);
  }

  lastBroadcastMap = newMap;
  lastBroadcastData = data;

  // Send delta if smaller than full
  const delta = { type: 'delta', changed, removed, timestamp: data.timestamp, count: data.count };
  const deltaMsg = JSON.stringify(delta);

  wss.clients.forEach(client => {
    if (client.readyState !== 1) return;
    // First message or delta too large -> send full
    if (!client._hasFull) {
      client.send(fullMsg);
      client._hasFull = true;
    } else {
      client.send(deltaMsg);
    }
  });
}

// --- Data fetching loop (non-overlapping) ---
let fetchCount = 0;
let isFetching = false;

async function fetchLoop() {
  if (isFetching) return;
  isFetching = true;
  const startTime = Date.now();
  fetchCount++;

  try {
    const flights = await fetchAllSources();
    cache.update(flights);

    // Batch write trails to Redis (only for aircraft with valid positions)
    const trailUpdates = flights
      .filter(f => f.lat && f.lon && f.icao24)
      .map(f => ({ icao24: f.icao24, lat: f.lat, lon: f.lon, alt: f.altitude || 0, ts: Date.now() }));
    trailStore.appendBatch(trailUpdates).catch(e =>
      console.error('[TrailStore] Batch write error:', e.message)
    );

    // Also fetch for connected client viewports
    const viewportFetches = [];
    for (const client of wss.clients) {
      if (client._viewport && client.readyState === 1) {
        const vp = client._viewport;
        // Only fetch if viewport is outside default regions
        viewportFetches.push(
          fetchForViewport(vp.lat, vp.lon, vp.dist)
            .then(extra => cache.update(extra))
            .catch(() => {})
        );
        client._viewport = null; // Reset - will be sent again on next move
      }
    }
    if (viewportFetches.length > 0) {
      await Promise.allSettled(viewportFetches);
    }

    const data = cache.getAll();
    broadcast(data);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const stats = cache.getStats();
    console.log(
      `[${new Date().toISOString()}] #${fetchCount} | ${data.count} aircraft ` +
      `(lol:${stats.bySource.lol} fi:${stats.bySource.fi} fr24:${stats.bySource.fr24}) | ${elapsed}s`
    );
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Fetch loop error:`, err.message);
  } finally {
    isFetching = false;
    // Schedule next fetch 5s after completion
    setTimeout(fetchLoop, 5000);
  }
}

// Start first fetch
fetchLoop();

// --- Server start ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`✈️  Flight Radar v2 running on http://127.0.0.1:${PORT}`);
  console.log(`   Sources: adsb.lol + adsb.fi + FR24`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  clearInterval(pingInterval);
  wss.clients.forEach(ws => ws.close());
  server.close(() => process.exit(0));
});
