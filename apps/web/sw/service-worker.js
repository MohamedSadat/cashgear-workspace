// The web app's service worker, so the app starts with no network once it has been opened online
// (Phase 3). vite.config.ts writes it into the build as /sw.js, with this build's own files in
// PRECACHE and a cache named after them; src/main.tsx registers it in a production web build only
// (never in the desktop app, never on Vite's dev server). Its rules:
//
// - Only the build's own files are kept, all of them, fetched when this worker installs. Nothing
//   from another origin is touched or kept: the API, Blob Storage's signed URLs and everything else
//   go to the network as if there were no worker. Same-origin requests for anything else too.
// - A navigation gets the app's page from the cache (every route is in the hash), else the network.
// - A new build's worker waits until no page uses the old one (no skipWaiting): a running page
//   keeps the files it started with, its lazy chunks included, and the new build is what the next
//   start gets. The very first worker takes the page that registered it at once, since no other
//   worker served it, so that page's lazy chunks come from the cache too.
// - Activating, it deletes older builds' caches.

/** Replaced by the build: `cgw-shell-` and a hash of the build's files. */
const CACHE = 'cgw-shell-dev';
/** Replaced by the build: every file of the build, relative to the worker's scope. */
const PRECACHE = /* precache */ [];
const PREFIX = 'cgw-shell-';

const scope = new URL(self.registration.scope);
const urls = PRECACHE.map((path) => new URL(path, scope).href);
const known = new Set(urls);
const SHELL = new URL('index.html', scope).href;

async function cached(url) {
  const cache = await caches.open(CACHE);
  return cache.match(url);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(urls.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const older = (await caches.keys()).filter(
        (name) => name.startsWith(PREFIX) && name !== CACHE,
      );
      await Promise.all(older.map((name) => caches.delete(name)));
      if (!older.length) await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(cached(SHELL).then((response) => response ?? fetch(request)));
    return;
  }
  const file = url.origin + url.pathname;
  if (!known.has(file)) return;
  event.respondWith(cached(file).then((response) => response ?? fetch(request)));
});
