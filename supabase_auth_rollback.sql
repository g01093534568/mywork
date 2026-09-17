-- ============================================================
-- 보안 2단계 되돌리기 — 로그인이 안 되거나 화면이 비는 등 문제가 생겼을 때
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
--
-- 결과: step2 이전(공개 키로 동작하던) 상태로 돌아간다. 서버도 토큰 발급을 멈춘다
--       (wl_auth_ready 를 지우므로). 앱에 다시 로그인하면 예전 방식으로 들어간다.
-- step1 의 wl_ 정책은 남겨 두어도 해가 없다 — 다시 시도할 때 그대로 쓴다.
-- ============================================================

-- 1. 서버의 토큰 발급 중단
DROP FUNCTION IF EXISTS public.wl_auth_ready();

-- 2. anon 권한 되살리기 (푸시 구독 테이블은 원래도 막혀 있었다)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
REVOKE ALL ON public.push_subscriptions FROM anon;

-- users 는 비밀번호 칸을 뺀 칸만 읽게 (보안 1단계 상태)
REVOKE SELECT ON public.users FROM anon;
DO $$
BEGIN
  GRANT SELECT (id, 성명, 시설명, 사원번호, role, created_at, parent_facility, sort_order) ON public.users TO anon;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='시설주소') THEN
    GRANT SELECT (시설주소) ON public.users TO anon;
  END IF;
END $$;

-- 3. anon 정책 되살리기
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename NOT IN ('users', 'push_subscriptions') LOOP
    EXECUTE format('DROP POLICY IF EXISTS anon_all ON public.%I', r.tablename);
    EXECUTE format('CREATE POLICY anon_all ON public.%I FOR ALL TO anon USING (true) WITH CHECK (true)', r.tablename);
  END LOOP;
END $$;
DROP POLICY IF EXISTS anon_select_users ON public.users;
DROP POLICY IF EXISTS anon_insert_users ON public.users;
DROP POLICY IF EXISTS anon_update_users ON public.users;
DROP POLICY IF EXISTS anon_delete_users ON public.users;
CREATE POLICY anon_select_users ON public.users FOR SELECT TO anon USING (true);
CREATE POLICY anon_insert_users ON public.users FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_update_users ON public.users FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY anon_delete_users ON public.users FOR DELETE TO anon USING (true);

-- 4. 함수
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN ('verify_login','save_push_subscription','delete_push_subscription') LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', f.sig);
  END LOOP;
END $$;
