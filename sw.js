// Gerel service worker.
//
// Chrome will not offer to install a site unless a service worker is
// registered AND it answers fetch events. An empty worker registers fine and
// the Install item never appears, which is exactly what was happening.
//
// Kept books live in a separate cache written by the page itself
// (gerel-books-v1); this worker only serves them back when there is no
// signal, and keeps a copy of the shell so the library opens offline.

const SHELL = 'gerel-shell-v1';
const BOOKS = 'gerel-books-v1';

const SHELL_FILES = [
  '/', '/index.html', '/catalog.json',
  '/logo.png', '/icon-192.png', '/icon-512.png', '/favicon.ico'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // One at a time: a single 404 would reject addAll and leave the whole
    // worker uninstalled, which is a silly way to lose offline support.
    await Promise.all(SHELL_FILES.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== SHELL && k !== BOOKS)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Audio and books a child has kept: cache first, because the whole point
  // is that they play with no connection.
  if (/\/(audio|books|braille|covers|speech)\//.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreVary: true });
      if (hit) return hit;
      try { return await fetch(req); }
      catch (err) { return new Response('', { status: 504 }); }
    })());
    return;
  }

  // Everything else: network first, falling back to the cached shell, so a
  // fix always reaches the child but a dead connection does not blank the
  // page.
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok && url.origin === location.origin) {
        const c = await caches.open(SHELL);
        c.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreVary: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      return new Response('', { status: 504 });
    }
  })());
});
