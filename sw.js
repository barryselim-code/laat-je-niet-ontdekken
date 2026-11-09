// Service worker: app-schil offline beschikbaar, data altijd live via Supabase.
const VERSIE = 'ljno-v11';
const SCHIL = ['./', 'index.html', 'app.css', 'app.js', 'config.js', 'lib/qrcode.js', 'manifest.webmanifest',
  'icons/logo-v4.svg', 'icons/logo-v4-32.png', 'icons/logo-v4-192.png', 'icons/logo-v4-512.png', 'icons/logo-v4-apple-touch.png', 'favicon.ico'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSIE).then((c) => c.addAll(SCHIL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSIE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('supabase.co') || url.pathname.includes('beheer')) return; // nooit cachen
  const vanMij = url.origin === location.origin;
  const cdn = /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (!vanMij && !cdn) return;
  // netwerk eerst (zodat updates direct binnenkomen), cache als terugval
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok || res.type === 'opaque') { const kopie = res.clone(); caches.open(VERSIE).then((c) => c.put(e.request, kopie)); }
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
