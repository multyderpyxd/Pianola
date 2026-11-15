// Service worker: funciona sin conexión y recibe archivos MIDI compartidos desde otras apps.
const VERSION = 'pianola-1.1.0';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/midi.js',
  './js/ble.js',
  './js/player.js',
  './js/library.js',
  './js/demo.js',
  './js/online.js',
  './js/icons.js',
  './js/clock-worker.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './fonts/instrument-serif-latin-400-normal.woff2',
  './fonts/geist-latin-400-normal.woff2',
  './fonts/geist-latin-500-normal.woff2',
  './fonts/geist-latin-600-normal.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))  // saltar la caché HTTP de GitHub Pages
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION && k !== 'pianola-inbox').map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share')) {
    e.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  if (url.origin !== location.origin) return;

  // Mostrar al instante lo que hay en caché y actualizarlo por detrás.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    return (await network) || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
  })());
});

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('midi').filter(f => f && typeof f !== 'string');
    const inbox = await caches.open('pianola-inbox');
    let i = 0;
    for (const f of files) {
      await inbox.put(
        new Request(`./inbox/${Date.now()}-${i++}`),
        new Response(f, { headers: { 'x-name': encodeURIComponent(f.name || 'compartido.mid') } }),
      );
    }
  } catch (err) {
    console.warn('share', err);
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}
