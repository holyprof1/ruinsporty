const CACHE = 'slippilot-v3';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))));
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
