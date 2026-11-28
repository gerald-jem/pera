// Pera service worker: network first, cache as the offline fallback.
// Bump VERSION whenever app files change.
const VERSION = 'pera-v53';
// big files that rarely change (screenshot + PDF readers, fonts, Supabase): kept across app updates.
// Bump VENDOR only when something in vendor/ changes.
const VENDOR = 'pera-vendor-1';
const SHELL = ['./', 'index.html', 'style.css?v=53', 'app.js?v=53', 'config.js?v=53',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  // cache: 'reload' skips the browser's HTTP cache so we never store stale files
  e.waitUntil(Promise.all([
    caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'})))),
    caches.open(VENDOR).then(async c => { for (const u of ['vendor/supabase.js', 'vendor/fonts/inter-latin-400-normal.woff2', 'vendor/fonts/inter-latin-600-normal.woff2', 'vendor/fonts/literata-latin-opsz-normal.woff2']) if (!(await c.match(u))) await c.add(u).catch(() => {}); })
  ]));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== VENDOR).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Same-origin GETs: try the network, fall back to the cached copy when offline.
// Supabase requests are never touched.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {   // cache first: these files only change with a new VENDOR name
    e.respondWith(caches.open(VENDOR).then(async c => (await c.match(e.request, {ignoreSearch: true})) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const r = await fetch(e.request, {cache: 'no-cache'});
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch {
      return (await cache.match(e.request)) || (e.request.mode === 'navigate' ? cache.match('index.html') : Response.error());
    }
  })());
});
