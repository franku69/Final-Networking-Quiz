/* v7.1 migration only. No offline/standalone fallback for a monitored quiz. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key.indexOf('packet-quest-cs111-') === 0; }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.registration.unregister(); }));
});
