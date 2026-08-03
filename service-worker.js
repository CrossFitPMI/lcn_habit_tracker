// LCN Coach — service worker
// Bump CACHE_NAME whenever you want clients to drop cached static assets.
const CACHE_NAME = 'lcn-coach-v4';

// How long to wait for a fresh index.html before giving up and using the
// cached copy. Long enough that a normal connection always wins; short
// enough that gym wifi or a dead signal never leaves anyone staring at
// a blank screen.
const HTML_NETWORK_TIMEOUT_MS = 2000;

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

  /* ── The HTML shell: network-first, but with a deadline ──────────────
     This used to be cache-first with a background refresh. That painted
     instantly, but it also meant every update landed on the client's
     SECOND launch rather than their first — so after a deploy you'd test
     the app, see yesterday's version, and go hunting for a bug that
     didn't exist. That cost hours.

     Straight network-first is the other extreme: on a weak signal every
     launch stalls waiting for the network before anything renders.

     So: race the network against a short timer. A normal connection
     answers in well under 2s and the client gets the current version
     immediately. A slow or dead one falls back to the cached copy, which
     is exactly the old behaviour. The cache is refreshed either way. */
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match('./index.html').then((cached) => {
          const network = fetch(request)
            .then((response) => {
              // Only cache real successes — a 404 or an error page cached
              // as the app shell would persist until the next CACHE_NAME bump.
              if (response && response.ok) {
                cache.put('./index.html', response.clone());
              }
              return response;
            });

          // Nothing cached (first ever visit) — nothing to fall back to,
          // so just wait for the network however long it takes.
          if (!cached) return network.catch(() => Response.error());

          const deadline = new Promise((resolve) =>
            setTimeout(() => resolve(cached), HTML_NETWORK_TIMEOUT_MS)
          );

          // Whichever comes first. If the network fails outright we don't
          // want to wait out the timer, so failure resolves to the cache too.
          return Promise.race([
            network.catch(() => cached),
            deadline
          ]);
        })
      )
    );
    return;
  }

  // Cache-first for static assets (icons, css, js, fonts). These only change
  // when CACHE_NAME changes, so there's nothing to be gained by checking.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
