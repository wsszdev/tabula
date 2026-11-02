// TABULA service worker: repeat visits and revisited years load from disk, and work offline.
// Paths are relative to the worker's scope, so the site can live under any base path.
const STATIC = 'tabula-static-v2', DATA = 'tabula-data-v2', IMAGERY = 'tabula-imagery-v2', PHOTOS = 'tabula-photos-v2';
const LIMITS = { [DATA]: 4000, [IMAGERY]: 5000, [PHOTOS]: 600 };
const KNOWN = [STATIC, ...Object.keys(LIMITS)];
const SCOPE = self.registration.scope;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.add(SCOPE)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('tabula-') && !KNOWN.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const writes = {};
async function remember(name, request, response) {
  const cache = await caches.open(name);
  await cache.put(request, response);
  // Trimming is costly, so it runs once per 200 writes: oldest entries go first.
  writes[name] = (writes[name] ?? 0) + 1;
  if (writes[name] % 200 === 0 && LIMITS[name]) {
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - LIMITS[name])).map((k) => cache.delete(k)));
  }
}

async function cacheFirst(name, request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Opaque, partial and failed responses are not worth keeping.
  if (res.status === 200 && res.type !== 'opaque') remember(name, request, res.clone()).catch(() => {});
  return res;
}

async function staleWhileRevalidate(name, request, event) {
  const hit = await caches.match(request);
  const update = fetch(request).then((res) => {
    if (res.status === 200) remember(name, request, res.clone()).catch(() => {});
    return res;
  });
  if (hit) {
    event.waitUntil(update.catch(() => {}));
    return hit;
  }
  return update;
}

async function networkFirstPage(request) {
  try {
    const res = await fetch(request);
    if (res.ok) remember(STATIC, SCOPE, res.clone()).catch(() => {});
    return res;
  } catch {
    const hit = await caches.match(SCOPE);
    if (hit) return hit;
    throw new Error('offline and no cached page');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.hostname.endsWith('.wikimedia.org')) return event.respondWith(cacheFirst(PHOTOS, request));
  if (url.hostname === 'gibs.earthdata.nasa.gov') return event.respondWith(cacheFirst(IMAGERY, request));
  if (!url.href.startsWith(SCOPE)) return;
  const p = url.href.slice(SCOPE.length).split(/[?#]/)[0];
  if (request.mode === 'navigate') return event.respondWith(networkFirstPage(request));
  // Hashed bundles and glyphs never change.
  if (p.startsWith('assets/') || p.startsWith('glyphs/')) return event.respondWith(cacheFirst(STATIC, request));
  // Tile archives are read in byte ranges, which the Cache API cannot store; the HTTP cache handles them.
  if (p.endsWith('.pmtiles')) return;
  // Data files keep their names across rebuilds: answer from disk, refresh behind the scenes.
  if (p.startsWith('data/')) return event.respondWith(staleWhileRevalidate(DATA, request, event));
});
