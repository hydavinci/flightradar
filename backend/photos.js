// Restricted same-origin access to public Planespotters thumbnails.
// No caller-supplied upstream URLs; redirects are rejected to prevent SSRF.
const API = 'https://api.planespotters.net/pub/photos';
const IMAGE_ORIGIN = 'https://t.plnspttrs.net';
const UA = 'FlightRadar/1.0 (+https://flightradar.graymammoth.com)';
const IMAGE_PATH = /^\/[0-9]+\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/;

export function thumbnailPath(value) {
  try {
    const url = new URL(value);
    return url.origin === IMAGE_ORIGIN && !url.username && !url.password && !url.search && IMAGE_PATH.test(url.pathname) ? url.pathname : null;
  } catch { return null; }
}

export function installPhotoRoutes(app, upstreamFetch = fetch) {
  const cache = new Map();
  const pending = new Map();
  // Bounded memory, short-lived metadata and at most 32 concurrent upstream jobs.
  async function cached(key, ttl, loader) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 32) throw new Error('Photo service busy');
    const job = loader().then(value => {
      cache.set(key, { value, expires: Date.now() + ttl });
      while (cache.size > 128) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  async function request(url) {
    const response = await upstreamFetch(url, {
      headers: { 'User-Agent': UA }, redirect: 'error', signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`Photo upstream ${response.status}`);
    return response;
  }

  app.get('/api/photos/:icao24', async (req, res) => {
    const hex = req.params.icao24.toLowerCase();
    const reg = typeof req.query.reg === 'string' ? req.query.reg.toUpperCase() : '';
    if (!/^[0-9a-f]{6}$/.test(hex) || (reg && !/^[A-Z0-9-]{1,16}$/.test(reg))) {
      return res.status(400).json({ error: 'Invalid aircraft identifier' });
    }
    try {
      const result = await cached(`meta:${hex}:${reg}`, 15 * 60_000, async () => {
        let data = await (await request(`${API}/hex/${hex}`)).json();
        if (!data.photos?.length && reg) data = await (await request(`${API}/reg/${encodeURIComponent(reg)}`)).json();
        const photos = (Array.isArray(data.photos) ? data.photos : []).slice(0, 5).flatMap(photo => {
          const paths = [...new Set([photo.thumbnail_large?.src, photo.thumbnail?.src].map(thumbnailPath).filter(Boolean))];
          if (!paths.length) return [];
          let link = 'https://www.planespotters.net';
          try {
            const url = new URL(photo.link);
            if (url.origin === link && !url.username && !url.password) link = url.href;
          } catch {}
          return [{ sources: paths.map(p => `/api/photo-image${p}`), photographer: String(photo.photographer || 'Planespotters.net').slice(0, 200), link }];
        });
        return { photos };
      });
      res.set('Cache-Control', 'public, max-age=900').json(result);
    } catch {
      res.set('Cache-Control', 'no-store').status(502).json({ error: 'Photos temporarily unavailable' });
    }
  });

  app.get('/api/photo-image/:directory/:file', async (req, res) => {
    const imagePath = `/${req.params.directory}/${req.params.file}`;
    if (!IMAGE_PATH.test(imagePath)) return res.status(400).send('Invalid photo path');
    try {
      const image = await cached(`image:${imagePath}`, 60 * 60_000, async () => {
        const response = await request(`${IMAGE_ORIGIN}${imagePath}`);
        const type = response.headers.get('content-type')?.split(';')[0];
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new Error('Not an image');
        const chunks = [];
        let size = 0;
        // Bound even chunked responses; never buffer an unbounded upstream body.
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 512 * 1024) throw new Error('Photo too large');
          chunks.push(chunk);
        }
        if (!size) throw new Error('Empty image');
        return { type, body: Buffer.concat(chunks) };
      });
      res.set({ 'Content-Type': image.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=3600' }).send(image.body);
    } catch {
      res.set('Cache-Control', 'no-store').status(502).send('Photo temporarily unavailable');
    }
  });
}
