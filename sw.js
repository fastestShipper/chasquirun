// Service worker for Chasqui Run.
//
// Strategy is deliberately simple and conservative:
//
//   NAVIGATION  network first, cache as fallback. A player who is online
//               always gets the current build; a player on a train still
//               gets a playable game.
//   EVERYTHING  cache first, revalidate in the background. The heavy assets
//   ELSE        (three.js, textures, glTF models) never change within a
//               build, so serving them from cache is both faster and kinder
//               to a phone data plan.
//
// The score API is NEVER cached. A stale leaderboard is worse than none.
//
// Bump CACHE_VERSION on every deploy: it is what evicts the old build.

const CACHE_VERSION = 'chasqui-20260719-0745';

// The shell needed to boot and reach the title screen. Everything else is
// picked up lazily as the game requests it, so a failed precache of some
// optional asset can never block installation.
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './manifest.webmanifest',
  './lib/three.module.js',
  './src/main.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll is atomic: one 404 rejects the whole install. Add individually
      // and tolerate failures so a single missing file cannot brick the SW.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Same origin only: never interfere with anything external.
  if (url.origin !== self.location.origin) return;
  // The leaderboard must always be live.
  if (url.pathname.indexOf('/api/') !== -1) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          // Only cache real, complete responses. Opaque and error responses
          // would poison the cache with something unusable offline.
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
