const CACHE = 'agenthub-shell-v10';
const ASSETS = ['./', './index.html', './styles.css?v=20260905-7', './app.js?v=20260905-7', './cloud-connection.js?v=20260905-7', './voice-engine.js?v=20260905-7', './voice-ui.js?v=20260905-7', './cloud-sync.js?v=20260905-7', './recovery-ui.js?v=20260905-7', './manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('agenthub-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const shell = ASSETS.some(asset => new URL(asset, self.location.href).href === url.href);
  if (!shell && event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && response.type === 'basic') { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())));
});
