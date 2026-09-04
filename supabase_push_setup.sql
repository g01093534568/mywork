-- ============================================================
-- 웹푸시 구독 저장소
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- 여러 번 실행해도 안전하다(이미 만들어져 있으면 그대로 둔다).
--
-- 무엇을 담는가:
--   브라우저마다 발급되는 푸시 주소(endpoint)와 암호화 키 한 쌍.
--   서버(api/cron/remind.js)가 이 표를 읽어 알림을 보낸다.
--   한 사람이 여러 기기를 쓰면 행이 여러 개 생긴다 — 정상이다.
--
-- 왜 앱이 표를 직접 만지지 않는가:
--   푸시 주소는 남이 볼 이유가 없다. 그런데 PostgreSQL 은
--   INSERT ... ON CONFLICT DO UPDATE 에도 SELECT 권한을 요구해서,
--   앱이 직접 upsert 하게 두면 결국 표 전체를 읽을 권한을 줘야 한다.
--   그래서 등록·해지를 함수 두 개로만 열어두고 표 권한은 모두 걷는다.
--
-- 되돌리려면:
--   DROP FUNCTION IF EXISTS public.save_push_subscription(text,uuid,text,text,text);
--   DROP FUNCTION IF EXISTS public.delete_push_subscription(text);
--   DROP TABLE IF EXISTS push_subscriptions;
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   text PRIMARY KEY,          -- 브라우저가 준 푸시 주소. 기기+브라우저마다 고유
  owner_id   uuid,                      -- users.id — 누구에게 보낼지
  사원번호    text,                      -- 사람이 표를 볼 때 알아보기 쉬우라고
  p256dh     text NOT NULL,             -- 구독 공개키 (본문 암호화용)
  auth       text NOT NULL,             -- 구독 인증 시크릿
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 크론이 "이 사람의 기기들"을 찾을 때 쓰는 길
CREATE INDEX IF NOT EXISTS push_subscriptions_owner_idx
  ON push_subscriptions (owner_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;


-- ── 등록 · 해지 함수 ────────────────────────────────────────
-- SECURITY DEFINER = 함수 소유자 권한으로 돈다. 그래서 호출자(anon)에게
-- 표 권한이 하나도 없어도 이 두 가지 동작만은 할 수 있다.
CREATE OR REPLACE FUNCTION public.save_push_subscription(
  p_endpoint text, p_owner_id uuid, p_empno text, p_p256dh text, p_auth text
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO push_subscriptions (endpoint, owner_id, 사원번호, p256dh, auth, updated_at)
  VALUES (p_endpoint, p_owner_id, p_empno, p_p256dh, p_auth, now())
  ON CONFLICT (endpoint) DO UPDATE
     SET owner_id = EXCLUDED.owner_id,
         사원번호  = EXCLUDED.사원번호,
         p256dh   = EXCLUDED.p256dh,
         auth     = EXCLUDED.auth,
         updated_at = now();
$$;

CREATE OR REPLACE FUNCTION public.delete_push_subscription(p_endpoint text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM push_subscriptions WHERE endpoint = p_endpoint;
$$;


-- ── 권한 ────────────────────────────────────────────────────
-- 표는 앱에서 아예 못 만진다. 함수 두 개만 열어준다.
REVOKE ALL ON push_subscriptions FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_push_subscription(text,uuid,text,text,text) TO anon;
GRANT EXECUTE ON FUNCTION public.delete_push_subscription(text) TO anon;

-- 이전 버전에서 만들어 둔 정책이 있으면 치운다(이제 필요 없다)
DROP POLICY IF EXISTS push_anon_write ON push_subscriptions;

-- 서버 크론은 service_role 키로 읽는다(권한 제한을 받지 않는다).


-- ── 확인 ────────────────────────────────────────────────────
-- (가) 표가 있는지
SELECT column_name AS 컬럼, data_type AS 타입
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='push_subscriptions'
 ORDER BY ordinal_position;

-- (나) 함수 두 개가 SECURITY DEFINER 로 만들어졌는지 — prosecdef 가 둘 다 true 여야 한다
SELECT p.proname AS 함수, p.prosecdef AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('save_push_subscription','delete_push_subscription');

-- (다) anon 이 표에 대한 권한을 갖고 있지 않아야 한다 — 결과가 0행이면 정상
SELECT privilege_type
  FROM information_schema.table_privileges
 WHERE table_schema='public' AND table_name='push_subscriptions' AND grantee='anon';
