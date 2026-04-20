const CACHE = 'realverdict-v56';
const ASSETS = [
  './',
  './index.html',
  './css/tokens.css',
  './css/main.css',
  './css/tokens.css',
  './css/main.css',
  './js/main.js',
  './js/app.js',
  './js/constants.js',
  './js/math.js',
  './vendor/chart.umd.min.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).catch(() => cached))
  );
});
