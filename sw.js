/* Wasl service worker: app works offline after the first visit.
   - App pages: network first (so updates arrive), cached copy when offline.
   - Fonts, sound/sign models: cached after first use.
   - POST requests (AI, voice) are never cached. */
const SHELL = 'wasl-shell-v67';
const RUNTIME = 'wasl-rt-v1';
const SIGNS = 'wasl-signs-v1'; // sign-language clips: kept across app updates (a clip's file name changes when it is re-recorded)
const KEEP = [SHELL, RUNTIME, SIGNS, 'wasl-demo-v1', 'wasl-share'];
const FILES = ['./', 'index.html', 'privacy.html', 'counter.html', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'signs/s2v.js', 'signs/index.json'];
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net',
  'storage.googleapis.com', 'tfhub.dev'];

/* The most used signs (P1) are saved at install, so they play offline from the start. Best effort: never blocks the install. */
async function precacheSigns() {
  try {
    const m = await (await fetch('signs/index.json', { cache: 'no-cache' })).json();
    const c = await caches.open(SIGNS);
    const want = (m.signs || []).filter(s => s.pri === 'P1').flatMap(s => (s.clips || []).slice(0, 1).map(x => x.src));
    for (const src of want) { if (!(await c.match(src))) { try { const r = await fetch(src); if (r.ok) await c.put(src, r); } catch (e) {} } }
  } catch (e) {}
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => { precacheSigns(); return self.skipWaiting(); }));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('wasl-') && !KEEP.includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([fetch(req), timeout(5000)]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return cache.match('index.html');
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

/* Sign clips: from the phone once saved (other signs are saved the first time they play). */
async function signClip(req) {
  const c = await caches.open(SIGNS);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.status === 200) c.put(req, res.clone()).catch(() => {});
  return res;
}

/* WhatsApp replies shared to Wasl (text or a voice note) arrive here as a POST.
   Keep them in a small cache and open the app, which picks them up. */
async function takeShare(req) {
  try {
    const f = await req.formData();
    const c = await caches.open('wasl-share');
    const text = [f.get('title'), f.get('text'), f.get('url')].filter(x => typeof x === 'string' && x.trim()).join('\n');
    await c.put('/wasl-share/text', new Response(JSON.stringify({ text }), { headers: { 'Content-Type': 'application/json' } }));
    const a = f.getAll('audio').find(x => x && typeof x === 'object' && x.size);
    if (a) await c.put('/wasl-share/audio', new Response(a, { headers: { 'Content-Type': a.type || 'audio/ogg' } }));
    else await c.delete('/wasl-share/audio');
  } catch (err) {}
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) { e.respondWith(takeShare(req)); return; }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin && url.pathname.includes('/signs/clips/') && !req.headers.has('range')) { e.respondWith(signClip(req)); return; }
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req)); return; }
  if (RUNTIME_HOSTS.includes(url.hostname)) { e.respondWith(cacheFirst(req)); }
});
