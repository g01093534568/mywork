// 로그인 — 비밀번호를 확인하고 개인 토큰(JWT)을 발급한다. 설명은 api/_lib/auth.js
//
//   GET  /api/login                              → { enabled }  토큰 로그인이 켜져 있는가
//   POST /api/login { facility, empno, pw }      → { ok, user, token, exp }
//   POST /api/login { refresh: true } + Bearer   → { ok, user, token, exp }  (열어 둔 앱의 연장)
//
// 켜지지 않았으면(비밀키 없음 또는 supabase_auth_step1.sql 미실행) 503 을 돌려주고,
// 앱은 예전처럼 브라우저에서 verify_login 을 직접 부른다.

import crypto from 'node:crypto';
import { authReady, signToken, verifyToken } from './_lib/auth.js';

const SB_URL = process.env.SUPABASE_URL || 'https://zbcnfixbkqtrjxvatvss.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sb(path, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// 같은 인스턴스 안에서만 세는 간단한 제한 — 대입 공격을 늦추는 정도
const fails = new Map();
const LIMIT = 10, WINDOW_MS = 10 * 60 * 1000;
function tooMany(key) {
  const f = fails.get(key);
  return f && Date.now() - f.at < WINDOW_MS && f.n >= LIMIT;
}
function noteFail(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.at > WINDOW_MS) fails.set(key, { n: 1, at: Date.now() });
  else f.n++;
}

const publicUser = (u) => ({ id: u.id, 시설명: u.시설명, 사원번호: u.사원번호, role: u.role, parent_facility: u.parent_facility ?? null });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const enabled = await authReady();
  if (req.method === 'GET') return res.status(200).json({ enabled });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST 만 받습니다' });
  if (!enabled) return res.status(503).json({ ok: false, enabled: false, error: '토큰 로그인이 아직 켜지지 않았습니다' });

  const body = req.body || {};
  try {
    if (body.refresh) {
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      const p = m && verifyToken(m[1]);
      if (!p) return res.status(401).json({ ok: false, error: '로그인이 만료되었습니다' });
      // 권한이 바뀌었을 수 있으니 계정을 다시 읽는다. 지워진 계정이면 연장하지 않는다.
      const rows = await sb(`users?select=id,시설명,사원번호,role,parent_facility&id=eq.${encodeURIComponent(p.sub)}`);
      if (!rows.length) return res.status(401).json({ ok: false, error: '계정을 찾을 수 없습니다' });
      return res.status(200).json({ ok: true, user: publicUser(rows[0]), ...signToken(rows[0]) });
    }

    const facility = String(body.facility || '').trim();
    const empno = String(body.empno || '').trim();
    const pw = String(body.pw || '');
    if (!facility || !/^\d{6}$/.test(empno) || !pw) {
      return res.status(400).json({ ok: false, error: '시설명, 사원번호(6자리), 패스워드를 입력해주세요' });
    }
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const key = `${ip}|${empno}`;
    if (tooMany(key)) return res.status(429).json({ ok: false, error: '로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도해 주세요' });

    // 앱과 같은 해시(SHA-256 hex). verify_login 은 예전 평문 비밀번호도 받아 준다.
    const hash = crypto.createHash('sha256').update(pw).digest('hex');
    const user = await sb('rpc/verify_login', { p_facility: facility, p_empno: empno, p_pw_hash: hash, p_pw_plain: pw });
    if (!user) {
      noteFail(key);
      return res.status(401).json({ ok: false, error: '입력 정보가 일치하지 않습니다' });
    }
    fails.delete(key);
    return res.status(200).json({ ok: true, user, ...signToken(user) });
  } catch (e) {
    console.error('login', e);
    return res.status(502).json({ ok: false, error: '로그인 서버 오류' });
  }
}
