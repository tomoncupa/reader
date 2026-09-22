// Keeps a copy of the reader on the iPad so it opens with no signal.
// Answers from the copy at once and fetches a newer one for next time.
const C = 'reader-v2';
const FILES = ['./', 'index.html', 'manifest.json', 'icon-180.png', 'icon-512.png',
  'js/data.js', 'js/formats.js', 'js/sync.js', 'js/reader.js', 'js/library.js',
  'lib/mobi.js', 'lib/pdf.min.js', 'lib/pdf.worker.min.js'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const font = FONT_HOSTS.includes(u.hostname);
  if (u.origin !== location.origin && !font) return;
  e.respondWith(caches.open(C).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: !font });
    if (hit && font) return hit;
    const fresh = fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }).catch(() => hit);
    if (hit) { e.waitUntil(fresh); return hit; }
    return fresh;
  }));
});
