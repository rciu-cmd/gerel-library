// Gerel service worker.
//
// Chrome will not offer to install a site unless a service worker is
// registered AND it answers fetch events. An empty worker registers fine and
// the Install item never appears, which is exactly what was happening.
//
// Kept books live in a separate cache written by the page itself
// (gerel-books-v1); this worker only serves them back when there is no
// signal, and keeps a copy of the shell so the library opens offline.

// v2 (3 Oct): the September worker stored speech/index.json in v1, and this
// one reads speech/ from the cache first — so a phone that ever ran the old
// worker kept September's voice list for ever, and every phrase added since
// was silent. A new name makes activate() delete v1 and everything in it.
const SHELL = 'gerel-shell-v2';
const BOOKS = 'gerel-books-v1';
// 2 Nov: the interface's voice clips and the covers are kept as they are met,
// so moving around answers from the phone instead of the network.
const VOICE = 'gerel-voice-v1';
const COVERS = 'gerel-covers-v1';
// After this long the phone's own copy of the page is shown, and the download
// carries on to replace it for next time.
const SLOW_MS = 3000;

// The Rotary tile left the screens on 3 Oct; the club and district logos at
// the foot of the first screen are kept instead, so it is whole with no signal.
const SHELL_FILES = [
  '/', '/index.html', '/catalog.json', '/jszip.min.js',
  '/logos/rotary-d3450.png', '/logos/rotary-ikh-urgoo.png',
  '/logos/rotary-taipei-passport.png', '/logos/rotary-d3522.png',
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
      .filter(k => ![SHELL, BOOKS, VOICE, COVERS].includes(k))
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

  // Covers can be redrawn — all of them were on 2 Oct — so a kept copy is
  // shown at once AND the cover is asked for again behind it, bringing the
  // copy up to date for the next look. (Served from the cache alone, a kept
  // book showed its old cover for ever; asked for first, every shelf waited
  // on the network for pictures it already had.)
  if (/\/covers\//.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreVary: true });
      const fresh = fetch(req).then(async res => {
        if (res && res.ok) {
          const a = res.clone(), b = res.clone();
          (await caches.open(COVERS)).put(req, a).catch(() => {});
          const kept = await caches.open(BOOKS);
          if (await kept.match(req, { ignoreVary: true })) kept.put(req, b).catch(() => {});
        }
        return res;
      }).catch(() => null);
      if (hit) { e.waitUntil(fresh); return hit; }
      return (await fresh) || new Response('', { status: 504 });
    })());
    return;
  }

  // The interface's own voice. A clip's name is a hash of what it says, so a
  // name never changes its sound and a kept clip is never out of date: kept
  // the first time it is heard, then played from the phone. Fetched whole
  // (without the player's Range header) so it can be kept.
  if (url.origin === location.origin && /^\/speech\/p[0-9a-f]+\.mp3$/.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req.url, { ignoreVary: true });
      if (hit) return partial(req, hit);
      try {
        const res = await fetch(req.url);
        if (res && res.status === 200) {
          const copy = res.clone();
          (await caches.open(VOICE)).put(req.url, copy).catch(() => {});
        }
        return partial(req, res);
      } catch (err) { return new Response('', { status: 504 }); }
    })());
    return;
  }

  // Audio and books a child has kept: cache first, because the whole point
  // is that they play with no connection. Not the lists (index.json): those
  // change, and are asked for first below like everything else.
  if (/\/(audio|books|braille|speech)\//.test(url.pathname) && !url.pathname.endsWith('.json')) {
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
  // page. This site's own files wait at most SLOW_MS (2 Nov): on a slow
  // connection the page waited as long as the network did, with a copy
  // already on the phone. The download carries on and replaces the copy.
  const same = url.origin === location.origin;
  const net = fetch(req).then(res => {
    if (res && res.ok && same) {
      const copy = res.clone();
      caches.open(SHELL).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  });
  if (same) {
    e.respondWith((async () => {
      const first = await Promise.race([net.catch(() => 'down'),
        new Promise(r => setTimeout(r, SLOW_MS, 'slow'))]);
      if (first !== 'slow' && first !== 'down') return first;
      const hit = await caches.match(req, { ignoreVary: true })
        || (req.mode === 'navigate' ? await caches.match('/index.html') : null);
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      if (first === 'down') return new Response('', { status: 504 });
      try { return await net; } catch (err) { return new Response('', { status: 504 }); }
    })());
    return;
  }
  e.respondWith((async () => {
    try {
      return await net;
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
