const CACHE = 'storyroute-v2.6.0';
const ASSETS = [
  '/',
  '/index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
];

// Install — cache core assets
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Fetch — serve from cache, fall back to network
self.addEventListener('fetch', e => {
  // Never cache API calls
  if (e.request.url.includes('/api/') || e.request.url.includes('nominatim') || e.request.url.includes('groq')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
