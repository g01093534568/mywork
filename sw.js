// 서비스워커 — 오프라인 대비 + 배포 즉시 반영
//
// 지난 버전의 두 가지 문제:
//  1) 없는 파일(icon-192.png / icon-512.png)을 캐시 목록에 넣어뒀다. cache.addAll은
//     하나라도 실패하면 통째로 거부되므로 install이 계속 죽었고, 서비스워커가
//     활성화된 적이 없다(= 오프라인 기능이 동작한 적이 없다).
//  2) 모든 요청이 캐시 우선이었다. 1번을 고치면 이번엔 HTML이 캐시에 박혀
//     배포해도 옛 화면이 계속 보이게 된다. 그래서 화면은 네트워크 우선으로 바꾼다.

const CACHE = 'worklog-v2';   // 이 값을 올리면 옛 캐시는 activate에서 전부 지워진다

// 잘 바뀌지 않는 것만 미리 담는다. HTML은 넣지 않는다 — 항상 최신을 받아야 한다.
const ASSETS = ['/manifest.json', '/icon.svg'];

// 캐시하면 안 되는 곳 — 데이터·인증·외부 라이브러리
const BYPASS = ['supabase.co', 'googleapis.com', 'accounts.google.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll 대신 개별 add — 파일 하나가 없어져도 설치까지 실패하지 않게 한다
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── 웹푸시 ───────────────────────────────────────────────────
// 앱이 닫혀 있어도 서비스워커는 깨어나 알림을 띄운다.
// 서버(api/cron/remind.js)가 보낸 JSON: { title, body, tag, url }
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'WorkLog', {
    body: d.body || '',
    tag: d.tag || 'worklog',
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { url: d.url || '/' }
  }));
});

// 알림을 누르면 이미 열려 있는 탭으로 보내고, 없으면 새로 연다
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin)) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (BYPASS.some(h => req.url.includes(h))) return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;   // 다른 도메인은 건드리지 않는다
  if (url.pathname.startsWith('/api/')) return;      // 서버 함수 응답은 캐시 대상이 아니다

  const isDocument =
    req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.Html');

  if (isDocument) {
    // 네트워크 우선 — 배포한 내용이 바로 보여야 한다.
    // 받아온 사본은 남겨두었다가 오프라인일 때만 쓴다.
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/worklog-app.Html')))
    );
    return;
  }

  // 아이콘·매니페스트 같은 정적 파일만 캐시 우선
  e.respondWith(caches.match(req).then(cached => cached || fetch(req)));
});
