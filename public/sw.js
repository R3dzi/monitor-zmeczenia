/*
 * Service Worker – wyłącznie powłoka aplikacji (offline).
 *
 * Zasady bezpieczeństwa:
 *  - obsługuje tylko żądania GET do WŁASNEGO origin; żądania do GitHub API
 *    (cross-origin) w ogóle go nie dotyczą – nie są przechwytywane ani cache'owane,
 *    więc nagłówek Authorization nigdy nie trafia do Cache Storage,
 *  - nie przechowuje żadnych danych użytkownika ani tokenu.
 */
const CACHE = 'monitor-zmeczenia-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin: nie ruszamy

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const isNavigation = request.mode === 'navigate';
      const cached = await cache.match(request, { ignoreSearch: true });

      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        // stale-while-revalidate: natychmiast z cache, aktualizacja w tle
        network.catch(() => null);
        return cached;
      }
      const response = await network;
      if (response) return response;
      if (isNavigation) {
        const shell = (await cache.match('./index.html')) || (await cache.match('./'));
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }),
  );
});
