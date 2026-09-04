// 아침 브리핑 푸시 — 하루 한 번 Vercel Cron 이 부른다.
//
// 왜 할 일만 보내는가:
//   구글 캘린더 토큰은 사용자의 브라우저 sessionStorage 에만 있고 무음 갱신이 안 된다.
//   서버는 캘린더를 읽을 수 없다. 그래서 캘린더 일정 알림은 앱이 열려 있을 때
//   브라우저가 직접 띄우고(worklog-app.Html 의 _checkUpcoming), 서버는 Supabase 에
//   있는 할 일·마감만 보낸다.
//
// 필요한 환경변수:
//   CRON_SECRET                Vercel 이 크론 호출 시 Authorization 헤더로 보낸다
//   VAPID_PUBLIC_KEY           앱 HTML 의 VAPID_PUBLIC_KEY 와 같은 값이어야 한다
//   VAPID_PRIVATE_KEY          비밀. 노출되면 남이 우리 사용자에게 푸시를 보낼 수 있다
//   SUPABASE_URL               선택. 기본값은 앱이 쓰는 프로젝트
//   SUPABASE_SERVICE_ROLE_KEY  push_subscriptions 는 anon 이 읽지 못하게 막아 두었다
//
// 손으로 돌려보려면: vercel crons run /api/cron/remind

import webpush from 'web-push';

const SB_URL = process.env.SUPABASE_URL || 'https://zbcnfixbkqtrjxvatvss.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sb(path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}
async function sbDelete(path) {
  await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
}

// 서울 기준 오늘 — 서버는 UTC 로 돌아서 그냥 new Date() 를 쓰면 날짜가 하루 어긋난다
function seoulToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) {
    return res.status(500).json({ ok: false, error: 'VAPID 키가 설정되지 않았습니다' });
  }
  if (!SB_KEY) {
    return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY 가 없습니다' });
  }

  webpush.setVapidDetails(
    'mailto:g01093534568@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  const today = seoulToday();
  let sent = 0, cleaned = 0, skipped = 0;

  try {
    const subs = await sb('push_subscriptions?select=*');
    if (!subs.length) return res.status(200).json({ ok: true, sent: 0, note: '구독한 기기가 없습니다' });

    // 사람마다 한 번만 집계하고, 그 사람의 모든 기기에 같은 내용을 보낸다
    const byOwner = new Map();
    for (const s of subs) {
      if (!s.owner_id) continue;
      if (!byOwner.has(s.owner_id)) byOwner.set(s.owner_id, []);
      byOwner.get(s.owner_id).push(s);
    }

    for (const [ownerId, devices] of byOwner) {
      const todos = await sb(
        `todos?owner_id=eq.${ownerId}&status=neq.done&select=title,due_date,start_date,is_recurring`,
      );
      const dueToday = todos.filter(t => t.due_date === today);
      const overdue  = todos.filter(t => t.due_date && t.due_date < today);
      // 오늘 시작했거나 이미 시작한 것 — 앱의 '오늘 할 일'과 같은 기준
      const active   = todos.filter(t => t.is_recurring || !t.start_date || t.start_date <= today);

      // 보낼 게 없으면 보내지 않는다. 매일 아침 "할 일 0건" 알림은 알림을 끄게 만든다.
      if (!dueToday.length && !overdue.length && !active.length) { skipped++; continue; }

      const bits = [];
      if (active.length)   bits.push(`오늘 할 일 ${active.length}건`);
      if (dueToday.length) bits.push(`오늘 마감 ${dueToday.length}건`);
      if (overdue.length)  bits.push(`기한 지남 ${overdue.length}건`);
      const head = (dueToday[0] || overdue[0] || active[0])?.title || '';

      const payload = JSON.stringify({
        title: '오늘의 브리핑',
        body: `${bits.join(' · ')}${head ? `\n${head}` : ''}`,
        tag: `brief:${today}`,
        url: '/',
      });

      for (const d of devices) {
        try {
          await webpush.sendNotification(
            { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
            payload,
          );
          sent++;
        } catch (e) {
          // 404/410 = 구독이 죽었다(앱 삭제·브라우저 데이터 정리). 지워야 계속 재시도하지 않는다.
          if (e.statusCode === 404 || e.statusCode === 410) {
            await sbDelete(`push_subscriptions?endpoint=eq.${encodeURIComponent(d.endpoint)}`);
            cleaned++;
          } else {
            console.error('[push]', e.statusCode, e.body || e.message);
          }
        }
      }
    }

    return res.status(200).json({ ok: true, date: today, sent, cleaned, skipped });
  } catch (e) {
    console.error('[cron/remind]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
