// Service worker: app-schil offline beschikbaar, data altijd live via Supabase.
const VERSIE = 'ljno-v19';
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

// W4/W5: pushmeldingen bij Betrapt!, ook als het scherm op slot zit
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { tekst: e.data && e.data.text() }; }
  const patroon = d.soort === 'betrap' ? [350, 120, 350] : [600, 150, 600, 150, 600];
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const zichtbaar = cs.find((c) => c.visibilityState === 'visible');
    if (zichtbaar) { zichtbaar.postMessage({ soort: 'tril', patroon }); return; } // app is open: alleen trillen
    return self.registration.showNotification(d.titel || 'Betrapt!', {
      body: d.tekst || '', tag: d.tag || 'betrapt', renotify: true, vibrate: patroon,
      icon: 'icons/logo-v4-192.png', badge: 'icons/logo-v4-192.png', requireInteraction: d.soort !== 'betrap',
      data: { url: self.registration.scope },
    });
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow((e.notification.data && e.notification.data.url) || './'))));
});
