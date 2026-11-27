// Pera service worker: network first, cache as the offline fallback.
// Bump VERSION whenever app files change.
const VERSION = 'pera-v13';
const SHELL = ['./', 'index.html', 'style.css?v=13', 'app.js?v=13', 'config.js?v=13', 'vendor/supabase.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  // cache: 'reload' skips the browser's HTTP cache so we never store stale files
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: 'reload'})))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Same-origin GETs: try the network, fall back to the cached copy when offline.
// Supabase requests are never touched.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
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
