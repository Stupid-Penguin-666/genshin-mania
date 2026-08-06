/* One-time recovery worker: removes the PWA worker/cache from the reverted build. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
    .then(() => self.registration.unregister()));
});
