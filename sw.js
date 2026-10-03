// Network first, so updates always show; cache is only a fallback when offline.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open('diaa-v1').then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
