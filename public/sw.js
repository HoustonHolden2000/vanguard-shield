// Self-destruct: unregister this service worker and stop intercepting requests
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) {
  e.waitUntil(self.registration.unregister());
});
