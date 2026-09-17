// 로그인 토큰 — 서버가 로그인할 때 개인 JWT 를 발급하고, Supabase RLS 와 서버 함수가 그걸로 사람을 가린다.
//
// 왜 Supabase Auth 가 아닌가: 이 앱의 계정은 users 테이블(시설명·사원번호·비밀번호 해시)이고
// 로그인은 verify_login 이다. 그 결과로 Supabase 가 믿는 JWT 를 직접 만들어 준다.
//   role: 'authenticated'  → PostgREST 가 authenticated 역할로 쿼리한다
//   sub:  users.id         → RLS 에서 auth.uid() 로 읽는다 (개인 테이블 owner_id)
//   wl_role / wl_fac       → RLS 에서 auth.jwt()->>'wl_role' 로 읽는다
//
// 서명: 프로젝트의 Legacy JWT secret(HS256). 토큰 서명은 새 방식(ES256)이지만 비밀키를 꺼낼 수
// 없고, legacy secret 은 아직 검증에 쓰인다(anon 키가 HS256 인데 통한다).
//
// 켜지는 조건 (둘 다): SUPABASE_JWT_SECRET 환경변수 + DB 에 wl_auth_ready() 함수
// wl_auth_ready 는 supabase_auth_step1.sql 이 만든다 — authenticated 용 RLS 정책이 깔렸다는 표시다.
// 정책 없이 토큰부터 나가면 로그인한 사람에게 데이터가 하나도 안 보이므로 이 순서를 지킨다.

import crypto from 'node:crypto';

const SECRET = process.env.SUPABASE_JWT_SECRET || '';
const SB_URL = process.env.SUPABASE_URL || 'https://zbcnfixbkqtrjxvatvss.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export const TOKEN_TTL_SEC = 12 * 3600;

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest();

// DB 준비 여부 — 켜지면 계속 켜져 있으므로 true 는 캐시하고, false 는 1분마다 다시 본다
let ready = false, checkedAt = 0;
export async function authReady() {
  if (!SECRET || !SB_KEY) return false;
  if (ready || Date.now() - checkedAt < 60_000) return ready;
  checkedAt = Date.now();
  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/wl_auth_ready`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    ready = res.ok && (await res.json()) === true;
  } catch (_) { ready = false; }
  return ready;
}

export function signToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url({
    iss: 'worklog', aud: 'authenticated', role: 'authenticated',
    sub: user.id, iat: now, exp: now + TOKEN_TTL_SEC,
    wl_role: user.role || 'user', wl_fac: user.시설명 || '',
  });
  return { token: `${head}.${body}.${hmac(`${head}.${body}`).toString('base64url')}`, exp: now + TOKEN_TTL_SEC };
}

export function verifyToken(token) {
  if (!SECRET || typeof token !== 'string') return null;
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  const want = hmac(`${head}.${body}`);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.iss !== 'worklog' || !p.sub || !(p.exp > Date.now() / 1000)) return null;
    return p;
  } catch (_) { return null; }
}

// 서버 함수 입구. 인증이 켜져 있으면 토큰을 요구하고, 아니면(전환 전) 그냥 통과시킨다.
// 반환: 토큰 내용(켜짐) / {}(꺼짐) / null(거절 — 응답은 이미 보냄)
export async function requireUser(req, res) {
  if (!(await authReady())) return {};
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const payload = m && verifyToken(m[1]);
  if (!payload) {
    res.status(401).json({ ok: false, error: '로그인이 필요합니다 (다시 로그인해 주세요)' });
    return null;
  }
  return payload;
}
