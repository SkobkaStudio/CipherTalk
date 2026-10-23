/* CipherTalk service worker: network-first для оболочки, API не кешируем. */
const CACHE = 'ciphertalk-v11';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/calls.js',
  '/chat-features.js',
  '/e2ee.js',
  '/i18n.js',
  '/icons.js',
  '/features.css',
  '/icons.css',
  '/motion.css',
  '/motion.js',
  '/layout.css',
  '/cursor.css',
  '/cursor.js',
  '/owner.css',
  '/manifest.json',
  '/icons/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
  );
});
