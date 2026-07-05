const CACHE = 'shopping-list-cache-v21'; // bump this when you deploy changes
const ASSETS = [
  './',
  './index.html',
  './404.html',
  './styles.css',
  './app.js',
  './supabase-config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Install: pre-cache static assets
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Activate: clear old caches and take control
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k === CACHE ? null : caches.delete(k))))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for HTML/JS; cache-first for others; never cache Supabase API calls
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Never intercept Supabase API traffic
  if (url.hostname.endsWith('.supabase.co')) {
    return; // let it hit network directly
  }

  // Network-first for app shell & code to avoid stale JS
  const isCode = req.destination === 'document' || req.destination === 'script';
  if (isCode) {
    e.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return resp;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for static assets (images, css, icons)
  e.respondWith(
    caches.match(req).then((resp) => resp || fetch(req).then((net) => {
      const copy = net.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return net;
    }))
  );
});
