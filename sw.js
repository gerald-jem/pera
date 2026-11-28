// Pera service worker: network first, cache as the offline fallback.
// Bump VERSION whenever app files change.
const VERSION = 'pera-v76';
// big files that rarely change (screenshot + PDF readers, fonts, Supabase): kept across app updates.
// Bump VENDOR only when something in vendor/ changes.
const VENDOR = 'pera-vendor-1';
const SHARE = 'pera-share';
const REMIND = 'pera-remind';   // upcoming reminders written by the app, plus which ones were already shown   // screenshots shared into Pera from other apps, until the app picks them up
const SHELL = ['./', 'index.html', 'style.css?v=76', 'money.js?v=76', 'app.js?v=76', 'config.js?v=76',
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
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== VENDOR && k !== SHARE && k !== REMIND).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Same-origin GETs: try the network, fall back to the cached copy when offline.
// Supabase requests are never touched.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Share → Pera (Android): keep the images, then open the app, which asks what they are
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData(), files = fd.getAll('shots').filter(f => f && f.size), c = await caches.open(SHARE);
        for (const k of await c.keys()) await c.delete(k);
        await Promise.all(files.map((f, k) => c.put(`shared/${k}`, new Response(f, {headers: {'content-type': f.type || 'image/png', 'x-name': encodeURIComponent(f.name || `shot-${k}.png`)}}))));
        return Response.redirect(`./?share=${files.length}`, 303);
      } catch { return Response.redirect('./?share=0', 303); }
    })());
    return;
  }
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

// Reminders: the phone wakes the service worker now and then (periodic background sync) and we show what's due
async function showDueReminders() {
  const c = await caches.open(REMIND), r = await c.match('reminders.json'); if (!r) return;
  const list = await r.json(), shownR = await c.match('shown.json'), shown = shownR ? await shownR.json() : [];
  const d = new Date(), today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const due = list.filter(x => x.date === today && !shown.includes(x.id));
  const done = [];
  for (const x of due) { try { await self.registration.showNotification(x.title, {body: x.body, tag: x.id, icon: 'icon-192.png', badge: 'icon-192.png', data: {url: './'}}); done.push(x.id); } catch { /* not allowed right now: try again next time */ } }
  if (done.length) await c.put('shown.json', new Response(JSON.stringify([...shown, ...done].slice(-200))));
}
self.addEventListener('periodicsync', e => { if (e.tag === 'pera-reminders') e.waitUntil(showDueReminders()); });
self.addEventListener('message', e => { if (e.data === 'check-reminders') e.waitUntil(showDueReminders()); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(ws => { const w = ws.find(x => 'focus' in x); return w ? w.focus() : self.clients.openWindow('./'); }));
});
