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
  '/', '/index.html', '/catalog.json', '/jszip.min.js', '/rotary-bg.webp',
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

// A media element asks for part of a file ("Range: bytes=…") whenever it
// seeks, but the cache holds whole files and hands back the whole file. For a
// short clip that hardly matters; an English book is one recording of up to
// half an hour per chapter, and resuming 20 minutes in, or skipping 30 s, would
// fail with no connection. So a cached answer to a Range request is cut to the
// part asked for. Blob.slice does not copy the file.
async function partial(req, res) {
  const range = req.headers.get('range');
  if (!range || !res || res.status !== 200) return res;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === '' && m[2] === '')) return res;
  const blob = await res.blob();
  const size = blob.size;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) {
    return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Audio and books a child has kept: cache first, because the whole point
  // is that they play with no connection.
  if (/\/(audio|books|braille|covers|speech)\//.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreVary: true });
      if (hit) return partial(req, hit);
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
      // Kept audio on audio.gerelnom.com lands here when there is no signal.
      const hit = await caches.match(req, { ignoreVary: true });
      if (hit) return partial(req, hit);
      if (req.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      return new Response('', { status: 504 });
    }
  })());
});
