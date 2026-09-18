import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { installPhotoRoutes, thumbnailPath } from './photos.js';

async function fixture(t, mock) {
  const app = express();
  installPhotoRoutes(app, mock);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const photo = { thumbnail_large: { src: 'https://t.plnspttrs.net/21594/1892726_1dce329ebf_280.jpg' }, photographer: 'Stefano R.', link: 'https://www.planespotters.net/photo/1892726/test?utm_source=api' };

test('thumbnail allowlist rejects other origins, credentials and path tricks', () => {
  assert.equal(thumbnailPath(photo.thumbnail_large.src), '/21594/1892726_1dce329ebf_280.jpg');
  for (const bad of ['http://t.plnspttrs.net/1/a.jpg', 'https://evil.test/1/a.jpg', 'https://t.plnspttrs.net@localhost/1/a.jpg', 'https://x@t.plnspttrs.net/1/a.jpg', 'https://t.plnspttrs.net/1/a.svg', 'https://t.plnspttrs.net/1/a.jpg?url=x']) assert.equal(thumbnailPath(bad), null);
});

test('metadata is normalized, cached and concurrent requests deduplicated', async t => {
  let calls = 0;
  const base = await fixture(t, async (url, options) => {
    calls++;
    assert.match(url, /\/hex\/78096a$/);
    assert.match(options.headers['User-Agent'], /FlightRadar/);
    assert.equal(options.redirect, 'error');
    return Response.json({ photos: [photo] });
  });
  const results = await Promise.all([1, 2, 3].map(() => fetch(`${base}/api/photos/78096A`).then(r => r.json())));
  assert.equal(calls, 1);
  assert.equal(results[0].photos[0].sources[0], '/api/photo-image/21594/1892726_1dce329ebf_280.jpg');
  assert.equal(results[0].photos[0].photographer, 'Stefano R.');
});

test('registration fallback and empty results', async t => {
  const urls = [];
  const base = await fixture(t, async url => {
    urls.push(url);
    return Response.json({ photos: url.includes('/reg/') ? [photo] : [] });
  });
  const data = await (await fetch(`${base}/api/photos/78096a?reg=B-6867`)).json();
  assert.equal(data.photos.length, 1);
  assert.match(urls[1], /\/reg\/B-6867$/);
  assert.deepEqual(await (await fetch(`${base}/api/photos/000000`)).json(), { photos: [] });
});

test('invalid identifiers rejected without upstream access', async t => {
  const base = await fixture(t, () => { throw new Error('Must not call'); });
  for (const path of ['/api/photos/invalid', '/api/photos/78096a?reg=http%3A%2F%2Flocalhost', '/api/photo-image/abc/a.jpg', '/api/photo-image/1/a.svg']) assert.equal((await fetch(base + path)).status, 400);
});

test('image proxy caches and returns bytes with safe headers', async t => {
  let calls = 0;
  const base = await fixture(t, async url => {
    calls++;
    assert.equal(url, photo.thumbnail_large.src);
    return new Response(Buffer.from([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } });
  });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${base}/api/photo-image/21594/1892726_1dce329ebf_280.jpg`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await response.arrayBuffer()).byteLength, 4);
  }
  assert.equal(calls, 1);
});

test('upstream errors, non-images and oversized bodies are not cached', async t => {
  let mode = 'error';
  const base = await fixture(t, async () => {
    if (mode === 'error') return new Response('', { status: 429 });
    if (mode === 'html') return new Response('<html>', { headers: { 'content-type': 'text/html' } });
    return new Response(Buffer.alloc(512 * 1024 + 1), { headers: { 'content-type': 'image/jpeg' } });
  });
  assert.equal((await fetch(`${base}/api/photos/78096a`)).status, 502);
  for (mode of ['error', 'html', 'large']) {
    const res = await fetch(`${base}/api/photo-image/1/a.jpg`);
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});
