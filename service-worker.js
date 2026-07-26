// LCN Coach — service worker
// Bumps CACHE_NAME whenever you want clients to pick up fresh static assets.
const CACHE_NAME = 'lcn-coach-v3';

// Keep this list to the app "shell" only — never list API/chat endpoints here.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin GET requests. Anything to the Cloudflare Worker
  // (the coach/chat API) or any other origin should just go straight to the
  // network, untouched — never cache or intercept those.
  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (request.method !== 'GET' || !isSameOrigin) {
    return; // let the browser handle it normally
  }

  // Cache-first for the HTML shell, refreshed in the background.
  // Network-first meant every single launch sat waiting on the network
  // before rendering anything — on gym wifi or a weak signal that's the
  // lag you feel opening the app. Now the stored copy paints immediately
  // and a fresh one is fetched quietly for next time.
  // TRADE-OFF: after you push an update, clients see it on their SECOND
  // launch, not their first. Bump CACHE_NAME whenever you want to be sure
  // an important change lands.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => {
        const fromNetwork = fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
            return response;
          })
          .catch(() => cached);
        // First ever visit has nothing cached, so it falls through to the
        // network exactly as before.
        return cached || fromNetwork;
      })
    );
    return;
  }

  // Cache-first for static assets (icons, css, js, fonts).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});
