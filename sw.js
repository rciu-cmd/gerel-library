// Гэрэл — service worker
//
// Two jobs. It keeps the library itself available with no connection, and it
// serves any book a child has chosen to keep from the cache rather than the
// network — which is what makes an hour on a bus with no signal work.

const SHELL = 'gerel-shell-v1';
const BOOKS = 'gerel-books-v1';        // written by the page, read here

// The parts of the library that must work before anything is downloaded.
const SHELL_FILES = [
  './',
  './index.html',
  './catalog.json',
  './blocklist.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL)
      // A missing optional file should not stop the whole install.
      .then(c => Promise.allSettled(SHELL_FILES.map(f => c.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== BOOKS).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // A kept book always comes from the cache: it is already on the device, and
  // fetching it again would spend a child's data for nothing.
  if (/\.(mp3|jpg|jpeg|png)$/i.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).catch(() => hit))
    );
    return;
  }

  // The catalogue and the speech manifest change, so ask first and fall back
  // to the cache when there is no signal.
  if (/(catalog|users|index)\.json$/.test(url.pathname) ||
      url.pathname.endsWith('/') || url.pathname.endsWith('index.html')) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
