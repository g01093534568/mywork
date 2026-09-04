-- ============================================================
-- 웹푸시 구독 저장소
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
--
-- 무엇을 담는가:
--   브라우저마다 발급되는 푸시 주소(endpoint)와 암호화 키 한 쌍.
--   서버(api/cron/remind.js)가 이 표를 읽어 알림을 보낸다.
--   한 사람이 여러 기기를 쓰면 행이 여러 개 생긴다 — 정상이다.
--
-- 되돌리려면: DROP TABLE push_subscriptions;
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

-- ── 권한 ────────────────────────────────────────────────────
-- 앱(anon)은 자기 구독을 등록·해지해야 하므로 쓰기가 필요하다.
-- 다만 남의 구독 주소를 긁어갈 이유는 없으므로 SELECT 는 주지 않는다.
-- 앱 코드도 이 표를 읽지 않는다(upsert / delete 만 한다).
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_anon_write ON push_subscriptions;
CREATE POLICY push_anon_write ON push_subscriptions
  FOR ALL TO anon USING (true) WITH CHECK (true);

REVOKE SELECT ON push_subscriptions FROM anon;
GRANT INSERT, UPDATE, DELETE ON push_subscriptions TO anon;
-- upsert(onConflict) 는 ON CONFLICT 를 쓰므로 SELECT 없이도 동작한다.

-- 서버 크론은 service_role 키로 읽는다(권한 제한을 받지 않는다).

-- ── 확인 ────────────────────────────────────────────────────
SELECT column_name AS 컬럼, data_type AS 타입
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='push_subscriptions'
 ORDER BY ordinal_position;
