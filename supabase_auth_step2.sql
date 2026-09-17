-- ============================================================
-- 보안 2단계 - 2/2 : 공개 키(anon) 차단
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
--
-- 실행 전에 반드시:
--   supabase_auth_step1.sql 실행 → SUPABASE_JWT_SECRET 설정·재배포 → 앱에 다시 로그인해 정상 확인
--   (앱 주소로 GET /api/login 을 열어 {"enabled":true} 가 나와야 한다)
--
-- 무엇을 하는가:
--   anon 에 걸린 정책·권한을 모두 걷는다. 이 뒤로는 사이트에 박힌 공개 키만으로는
--   어떤 테이블도 읽거나 쓸 수 없다. 로그인 함수(verify_login)도 서버만 부른다.
--   매월 10일 처리·아침 알림·MCP 서버는 service_role 키를 쓰므로 영향이 없다.
--
-- 이 파일을 실행하면, 토큰 없이 열려 있던 앱 창은 데이터가 비어 보인다 — 다시 로그인하면 된다.
-- 되돌리기: supabase_auth_rollback.sql
-- ============================================================


-- ── 1. anon(과 모두에게 열린 public) 정책 삭제 ─────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies
            WHERE schemaname = 'public' AND roles && ARRAY['anon','public']::name[] LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    RAISE NOTICE '삭제: %.%', r.tablename, r.policyname;
  END LOOP;
END $$;


-- ── 2. 모든 테이블 RLS 켜기 (꺼져 있으면 권한만으로 열린다) ─────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;


-- ── 3. anon 권한 회수 (앞으로 만들 테이블 포함) ──────────────────────
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;


-- ── 4. 함수 ───────────────────────────────────────────────────────
DO $$
DECLARE f record;
BEGIN
  -- 로그인 확인은 서버(api/login.js)만
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'verify_login' LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
  -- 푸시 구독은 로그인한 사람만
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN ('save_push_subscription','delete_push_subscription') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f.sig);
  END LOOP;
END $$;


-- ── 5. 확인 ───────────────────────────────────────────────────────
-- (가) anon 이 쓸 수 있는 테이블 — 비어 있어야 한다
SELECT table_name AS anon_권한이_남은_테이블, string_agg(DISTINCT privilege_type, ',') AS 권한
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND grantee = 'anon'
 GROUP BY table_name;

-- (나) anon 이 부를 수 있는 함수 — 앱이 쓰는 것은 하나도 없어야 한다
SELECT p.proname AS anon_실행_가능_함수
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND has_function_privilege('anon', p.oid, 'EXECUTE')
   AND p.proname IN ('verify_login','save_push_subscription','delete_push_subscription','wl_auth_ready');

-- (다) RLS 가 꺼진 테이블 — 비어 있어야 한다
SELECT tablename AS rls_꺼진_테이블 FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity;
