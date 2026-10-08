// Network first, so updates always show; cache is only a fallback when offline.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open('diaa-v1').then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => {
    if (l.length) { l[0].focus(); if (e.action) l[0].postMessage(e.action); } else clients.openWindow('./');
  }));
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || 'whatsappDIaa', { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag || 'msg', renotify: true, requireInteraction: !!d.call, vibrate: d.call ? [300, 150, 300, 150, 300] : [120] }));
});
