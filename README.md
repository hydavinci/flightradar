# ✈️ Flight Radar

Real-time global aircraft tracking website powered by free ADS-B community data sources.

**Live:** https://flightradar.graymammoth.com

---

## Features

- 🌍 Real-time tracking of ~6000+ aircraft
- 🗺️ WebGL rendering (MapLibre GL) — smooth 60fps zoom & pan
- 🎨 Altitude-based color coding (grey/green/cyan/purple/blue)
- 📍 Click aircraft for details (callsign, type, registration, altitude, speed, route)
- 🛤️ Flight trail display (Redis-persisted, ~20 min history)
- ✈️ Route arc (great circle) between origin and destination
- 📷 Aircraft photos (planespotters.net)
- 🔍 Search & filter (callsign, route, aircraft type, registration, airline)
- 🏗️ Search autocomplete (aircraft + airports)
- 🏢 Airport labels (1176 major airports, visible at zoom ≥ 5)
- 🌐 Multi-language (English / 中文 / 日本語)
- 🌙 Dark/Light theme switch (instant, no reload)
- 🏔️ 3D terrain view (optional)
- 📶 WebSocket real-time push + delta updates
- 📱 Mobile-friendly responsive design
- ⚡ Service Worker for offline tile caching

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Browser                           │
│  ┌──────────────┐  ┌─────────┐  ┌───────────────┐  │
│  │ MapLibre GL  │  │  i18n   │  │ Service Worker│  │
│  │  (WebGL)     │  │ EN/ZH/JA│  │ (tile cache)  │  │
│  └──────┬───────┘  └─────────┘  └───────────────┘  │
│         │ WebSocket / HTTP                          │
└─────────┼───────────────────────────────────────────┘
          │
┌─────────┼───────────────────────────────────────────┐
│  Nginx  │  (reverse proxy + SSL termination)        │
│  :80/:443 → 127.0.0.1:3001                         │
└─────────┼───────────────────────────────────────────┘
          │
┌─────────┼───────────────────────────────────────────┐
│  Node.js Backend (Express + WebSocket)              │
│         │                                           │
│  ┌──────┴──────┐   ┌──────────┐   ┌─────────────┐  │
│  │  server.js  │   │ cache.js │   │ trailStore  │  │
│  │ WS + REST   │   │ in-memory│   │   (Redis)   │  │
│  └──────┬──────┘   └──────────┘   └─────────────┘  │
│         │                                           │
│  ┌──────┴──────────────────────────────────┐        │
│  │         datasource.js                    │        │
│  │  ┌──────────┐ ┌────────┐ ┌───────────┐  │        │
│  │  │ adsb.lol │ │adsb.fi │ │    FR24   │  │        │
│  │  │ (Europe/ │ │ (Asia) │ │(Global+CN)│  │        │
│  │  │ Americas)│ │        │ │           │  │        │
│  │  └──────────┘ └────────┘ └───────────┘  │        │
│  │  + Circuit Breaker per source            │        │
│  └──────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────┘
          │
┌─────────┼───────────────────────────────────────────┐
│  Redis  │  (trail persistence, TTL 1h)              │
└─────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | MapLibre GL JS (WebGL), Vanilla JS, CSS |
| Backend | Node.js 22, Express, ws (WebSocket) |
| Data Sources | adsb.lol + opendata.adsb.fi + FR24 public feed |
| Cache | Redis (trails), In-memory (aircraft state) |
| Reverse Proxy | Nginx + Cloudflare (Proxied) |
| Process Manager | systemd |
| Compression | gzip (compression middleware) |
| Offline | Service Worker (tile + static asset cache) |

---

## Directory Structure

```
/home/Flightradar/
├── frontend/
│   ├── index.html          # Main page
│   ├── sw.js               # Service Worker
│   ├── css/
│   │   └── style.css       # Styles (dark/light themes)
│   ├── js/
│   │   ├── app.js          # Main app logic (map/WS/interaction)
│   │   └── i18n.js         # Multi-language + theme switching
│   └── data/
│       └── airports.json   # Major airports (1176 entries)
├── backend/
│   ├── package.json
│   ├── server.js           # Express + WebSocket server
│   ├── datasource.js       # Multi-source fetcher + Circuit Breaker
│   ├── cache.js            # In-memory cache + deduplication
│   └── trailStore.js       # Redis trail storage
├── nginx.conf.example      # Nginx config reference
└── README.md
```

---

## Data Sources

| Source | Type | Coverage | Notes |
|--------|------|----------|-------|
| **adsb.lol** | Free API | Europe/Americas | No key required, no rate limit |
| **opendata.adsb.fi** | Free API | Asia (Japan/HK/Taiwan/SEA) | Rate limited |
| **FR24 public feed** | Unofficial | Global (incl. China) | Includes origin/destination/airline; may be blocked |

Data updates every ~10 seconds. All three sources fetch in parallel with independent circuit breakers.

---

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/flights` | GET | All tracked aircraft (supports ETag) |
| `/api/trail/:icao24` | GET | Historical trail for an aircraft |
| `/api/arc` | GET | Great circle arc between two points |
| `/api/health` | GET | Service health (sources/Redis/WS clients) |
| `/ws` | WebSocket | Real-time push (full + delta incremental) |

### WebSocket Protocol

**On connection (full state):**
```json
{ "type": "full", "aircraft": [...], "count": 6000, "timestamp": 1234567890 }
```

**Subsequent updates (delta):**
```json
{ "type": "delta", "changed": [...], "removed": ["icao1", "icao2"], "count": 6000, "timestamp": 1234567890 }
```

**Client viewport update:**
```json
{ "type": "viewport", "lat": 30, "lon": 110, "dist": 250 }
```

---

## Deployment

### Prerequisites

- Node.js 18+
- Nginx
- Redis
- Domain + DNS (Cloudflare recommended)

### 1. Install Dependencies

```bash
cd /home/Flightradar/backend
npm install
```

### 2. Install Redis

```bash
sudo apt install redis-server -y
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

### 3. Create systemd Service

```bash
sudo tee /etc/systemd/system/flight-radar.service << 'EOF'
[Unit]
Description=Flight Radar Server
After=network.target redis-server.service

[Service]
Type=simple
User=your-user
WorkingDirectory=/home/Flightradar/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3001
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable flight-radar
sudo systemctl start flight-radar
```

### 4. Configure Nginx

```bash
# See nginx.conf.example for reference
sudo cp nginx.conf.example /etc/nginx/sites-available/flight-radar
# Edit server_name to your domain
sudo ln -sf /etc/nginx/sites-available/flight-radar /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. DNS Setup

Point your subdomain to the server IP:

- **Cloudflare Proxied**: Auto HTTPS; requires origin self-signed cert on port 443
- **DNS Only**: Use certbot for Let's Encrypt certificate

---

## Operations

```bash
# Service status
sudo systemctl status flight-radar

# Live logs
sudo journalctl -u flight-radar -f

# Restart
sudo systemctl restart flight-radar

# Health check
curl http://127.0.0.1:3001/api/health

# Redis status
redis-cli INFO keyspace
redis-cli DBSIZE
```

---

## Performance

| Metric | Value |
|--------|-------|
| Aircraft count | ~6000 |
| Update interval | ~10 seconds |
| API response (gzipped) | ~250 KB |
| WS delta message | ~30-80 KB |
| Memory usage | ~180 MB |
| Redis keys | ~6000 (trail:*) |
| First load | ~2s |
| Subsequent loads (SW cached) | <1s |

---

## Customization

### Modify Data Regions

Edit `REGIONS` in `backend/datasource.js`:

```js
const REGIONS = {
  lol: [
    { lat: 50, lon: 10, dist: 250, label: 'Europe Central' },
    // Add more regions...
  ],
  fi: [...],
  fr24: [
    { south: 20, north: 35, west: 100, east: 125, label: 'China South' },
    // Add more regions...
  ]
};
```

### Add New Language

Add a new key to the `LANG` object in `frontend/js/i18n.js`.

### Modify Altitude Colors

Edit `PLANE_COLORS` and `getPlaneImageName` in `frontend/js/app.js`.

---

## Notes

- **FR24 public feed** is unofficial and may be rate-limited or blocked at any time
- **adsb.fi** has rate limits (429 if too fast); backend uses 800ms delay between requests
- ADS-B coverage depends on ground receiver distribution; inland China has weak coverage
- Service Worker caches static assets; users may need hard refresh after new deployments

---

## License

Personal project. Data sources have their own terms of use.
