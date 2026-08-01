/* =============================================================================
   Sekolah Siaga Panas — service worker
   Cache-first for the app shell and fonts, network-first with cache fallback
   for weather. Offline is a feature, not an error state.
   ========================================================================== */

/* Bump this to ship an update: it renames both caches, and the old ones are
   deleted on activate. */
var VERSION = 'v3';
var SHELL_CACHE = 'ssp-shell-' + VERSION;
var DATA_CACHE = 'ssp-data-' + VERSION;

var SHELL = [
  '.',
  'index.html',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'assets/logo/Sekolah%20Siaga%20Panas%20LOGO.png',
  'assets/fonts/archivo-narrow-latin.woff2',
  'assets/fonts/archivo-narrow-latin-ext.woff2'
];

/* Hosts whose GET responses are worth keeping as an offline fallback. */
var DATA_HOSTS = ['bmkg-restapi.vercel.app', 'api.open-meteo.com'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_CACHE && k !== DATA_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/**
 * Replays a cached body with a marker header.
 *
 * The page must be able to tell a live reading from a resurrected one, or it
 * would stamp stale data with the current time and present it as fresh. Custom
 * headers on a cross-origin response are normally stripped by CORS, but this
 * Response is constructed here in the worker, so the page reads it as a
 * same-origin response and the header survives.
 */
function markCached(res) {
  return res.blob().then(function (body) {
    var headers = new Headers();
    var ct = res.headers.get('Content-Type');
    if (ct) headers.set('Content-Type', ct);
    headers.set('X-SSP-From-Cache', '1');
    return new Response(body, { status: 200, statusText: 'OK', headers: headers });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* ------------------------------------------------- weather: network-first */
  if (DATA_HOSTS.indexOf(url.hostname) !== -1) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(DATA_CACHE).then(function (c) {
            c.put(req, copy).catch(function () { /* quota — not fatal */ });
          });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return markCached(hit);
          // Let the app's own error handling produce a message in Indonesian
          // rather than surfacing a browser network error page.
          return new Response(
            JSON.stringify({ error: 'offline', message: 'Tidak ada koneksi.' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        });
      })
    );
    return;
  }

  /* Anything else cross-origin (e.g. reverse geocoding, used once at setup)
     goes straight to the network and is never cached. */
  if (url.origin !== self.location.origin) return;

  /* ---------------------------------------------------- shell: cache-first */
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) {
            c.put(req, copy).catch(function () {});
          });
        }
        return res;
      }).catch(function () {
        // A navigation with a cold network still has to render something.
        if (req.mode === 'navigate') {
          return caches.match('index.html').then(function (page) {
            return page || Response.error();
          });
        }
        return Response.error();
      });
    })
  );
});
