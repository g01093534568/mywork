const CACHE = 'worklog-v1';
const ASSETS = [
  '/',
  '/worklog-app.Html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Supabase·Gemini·Google API 요청은 캐시 안 함
  const url = e.request.url;
  if (url.includes('supabase.co') || url.includes('googleapis.com') ||
      url.includes('accounts.google.com') || url.includes('cdn.jsdelivr.net')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
