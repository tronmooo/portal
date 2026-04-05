// Self-destructing service worker — unregisters itself and clears all caches
// Portol is a data-driven app that must never serve stale cached content
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names => Promise.all(names.map(name => caches.delete(name))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.claim())
  );
});

// Pass all requests through to network — no caching
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
