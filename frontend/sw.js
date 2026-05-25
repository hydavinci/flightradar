const CACHE_NAME = 'flightradar-v1';
const TILE_CACHE = 'flightradar-tiles-v2';
const STATIC_CACHE = 'flightradar-static-v2';

// Static assets to pre-cache
const STATIC_ASSETS = [
  '/',
  '/css/style.css',
  '/js/app.js',
  '/js/i18n.js'
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== TILE_CACHE && k !== STATIC_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Map tiles: cache-first (tiles rarely change)
  if (url.hostname.includes('basemaps.cartocdn.com') ||
      url.hostname.includes('tile.openstreetmap.org') ||
      url.hostname.includes('tiles.mapbox.com')) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // MapLibre GL JS / CSS from CDN: cache-first
  if (url.hostname === 'unpkg.com') {
    event.respondWith(cacheFirst(event.request, STATIC_CACHE));
    return;
  }

  // API calls: network-only (real-time data)
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
    return; // Let it pass through
  }

  // Static assets: stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }
});

// Cache-first for tiles (with size limit)
async function tileStrategy(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(TILE_CACHE);
      // Limit tile cache to ~200MB (evict oldest when full)
      cache.put(request, response.clone());
      trimCache(TILE_CACHE, 2000); // max 2000 tiles
    }
    return response;
  } catch (e) {
    // Offline: return cached or blank
    return cached || new Response('', { status: 503 });
  }
}

// Cache-first
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

// Stale-while-revalidate
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      const cache = caches.open(STATIC_CACHE);
      cache.then(c => c.put(request, response.clone()));
    }
    return response;
  }).catch(() => cached);

  return cached || fetchPromise;
}

// Trim cache to maxItems
async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    // Delete oldest entries
    const toDelete = keys.slice(0, keys.length - maxItems);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}
