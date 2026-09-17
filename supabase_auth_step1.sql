-- ============================================================
-- 보안 2단계 - 1/2 : 로그인한 사람용 규칙 깔기 (기존 동작은 그대로)
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
--
-- 무엇을 하는가:
--   지금은 anon(공개 키)에게 모든 테이블이 열려 있다. 로그인 토큰(api/login.js 가 발급하는
--   개인 JWT)으로 접속하는 사람을 위한 규칙을 먼저 깐다.
--     개인 테이블 10개   → 본인 행(owner_id)만
--     에너지·차량         → 로그인한 사람 모두
--     목표·지식자료·계정  → 읽기는 모두, 쓰기는 역할별 (앱의 CAPS 와 같게)
--     인사정보            → 관리자만
--   anon 규칙은 아직 건드리지 않는다. 이 파일만 실행해서는 아무것도 막히지 않는다.
--
-- 순서 (반드시 이대로):
--   1) 이 파일 실행
--   2) Vercel 환경변수 SUPABASE_JWT_SECRET 추가 후 재배포
--        값: 대시보드 > Project Settings > JWT Keys > Legacy JWT Secret
--   3) 앱에 다시 로그인해 화면이 정상인지 확인 (이때부터 토큰으로 접속한다)
--   4) supabase_auth_step2.sql 실행 → anon 차단
--   되돌리기: supabase_auth_rollback.sql
--
-- wl_auth_ready() 는 "이 파일이 실행됐다"는 표시다. 서버는 이 함수가 있어야 토큰을 발급한다.
-- (규칙 없이 토큰부터 나가면 로그인한 사람에게 데이터가 하나도 안 보인다)
-- ============================================================


-- ── 0. 토큰에서 역할 읽기 ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wl_role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT coalesce(auth.jwt() ->> 'wl_role', '') $$;


-- ── 1. 개인 테이블: 본인 행만 ────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['todos','daily_logs','personal_goals','annual_goals','stocks',
                           'funds','trades','exercises','books','vocab_progress'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE NOTICE '테이블 없음(건너뜀): %', t; CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS wl_own ON public.%I', t);
    EXECUTE format('CREATE POLICY wl_own ON public.%I FOR ALL TO authenticated
                    USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())', t);
  END LOOP;
END $$;


-- ── 2. 함께 쓰는 테이블: 읽기 규칙 + 쓰기 규칙 ───────────────────
DO $$
DECLARE
  r record;
  pol text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      -- 테이블,             읽기 조건,                                   쓰기 조건
      ('energy_records',     'true',                                     'true'),
      ('energy_info',        'true',                                     'true'),
      ('vehicle_info',       'true',                                     'true'),
      ('facility_goals',     'true',                                     $q$public.wl_role() IN ('admin','facility-admin')$q$),
      ('knowledge_sources',  'true',                                     $q$public.wl_role() IN ('admin','facility-admin')$q$),
      ('org_goals',          'true',                                     $q$public.wl_role() = 'admin'$q$),
      ('hr_employees',       $q$public.wl_role() = 'admin'$q$,           $q$public.wl_role() = 'admin'$q$),
      ('hr_quota',           $q$public.wl_role() = 'admin'$q$,           $q$public.wl_role() = 'admin'$q$)
    ) AS v(tbl, read_rule, write_rule)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN RAISE NOTICE '테이블 없음(건너뜀): %', r.tbl; CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', r.tbl);
    FOREACH pol IN ARRAY ARRAY['wl_read','wl_insert','wl_update','wl_delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, r.tbl);
    END LOOP;
    EXECUTE format('CREATE POLICY wl_read   ON public.%I FOR SELECT TO authenticated USING (%s)', r.tbl, r.read_rule);
    EXECUTE format('CREATE POLICY wl_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)', r.tbl, r.write_rule);
    EXECUTE format('CREATE POLICY wl_update ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', r.tbl, r.write_rule, r.write_rule);
    EXECUTE format('CREATE POLICY wl_delete ON public.%I FOR DELETE TO authenticated USING (%s)', r.tbl, r.write_rule);
  END LOOP;
END $$;

-- 에너지 기록 id 를 새로 매기려면 시퀀스 권한도 필요하다
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;


-- ── 3. 계정(users) ────────────────────────────────────────────────
-- 읽기: 로그인한 사람 모두 (비밀번호 칸은 보안 1단계에서 이미 빠져 있다)
-- 쓰기: 관리자, 또는 시설관리자(에너지 시설 폼). 시설관리자는 관리자 계정을 만들거나 고칠 수 없다.
GRANT INSERT, UPDATE, DELETE ON public.users TO authenticated;
DROP POLICY IF EXISTS wl_read   ON public.users;
DROP POLICY IF EXISTS wl_insert ON public.users;
DROP POLICY IF EXISTS wl_update ON public.users;
DROP POLICY IF EXISTS wl_delete ON public.users;
CREATE POLICY wl_read   ON public.users FOR SELECT TO authenticated USING (true);
CREATE POLICY wl_insert ON public.users FOR INSERT TO authenticated
  WITH CHECK (public.wl_role() = 'admin' OR (public.wl_role() = 'facility-admin' AND role <> 'admin'));
CREATE POLICY wl_update ON public.users FOR UPDATE TO authenticated
  USING      (public.wl_role() = 'admin' OR (public.wl_role() = 'facility-admin' AND role <> 'admin'))
  WITH CHECK (public.wl_role() = 'admin' OR (public.wl_role() = 'facility-admin' AND role <> 'admin'));
CREATE POLICY wl_delete ON public.users FOR DELETE TO authenticated
  USING (public.wl_role() = 'admin' OR (public.wl_role() = 'facility-admin' AND role <> 'admin'));


-- ── 4. 함수 ───────────────────────────────────────────────────────
-- 푸시 알림 구독 등록·해제 (앱이 부른다)
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN ('save_push_subscription','delete_push_subscription') LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
  END LOOP;
END $$;

-- 준비 표시 — 서버만 부른다
CREATE OR REPLACE FUNCTION public.wl_auth_ready() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.wl_auth_ready() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wl_auth_ready() TO service_role;


-- ── 5. 확인 ───────────────────────────────────────────────────────
-- wl_ 로 시작하는 정책이 테이블마다 보여야 한다 (개인 테이블은 wl_own 하나, 나머지는 네 개)
SELECT tablename AS 테이블, string_agg(policyname || '(' || array_to_string(roles, ',') || ')', ', ' ORDER BY policyname) AS 정책
  FROM pg_policies WHERE schemaname = 'public'
 GROUP BY tablename ORDER BY tablename;
