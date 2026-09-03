-- ============================================================
-- 보안 1단계 — 비밀번호 해시 노출 차단
-- Supabase 대시보드 > SQL Editor 에서 위에서부터 순서대로 실행
--
-- 무엇을 막는가:
--   anon 키는 배포된 HTML에 들어 있어 누구나 볼 수 있다. 지금은 그 키로
--   users 테이블을 통째로 읽을 수 있고, 거기에 패스워드 해시가 함께 딸려 나온다.
--   해시는 솔트 없는 SHA-256 이고 사원번호가 6자리 숫자라, 해시 하나를 되돌리는 데
--   사실상 시간이 들지 않는다. 이 파일은 그 컬럼만 읽지 못하게 만든다.
--
-- 왜 REVOKE SELECT (패스워드) 만으로는 안 되는가:
--   PostgreSQL은 테이블 단위 SELECT 권한이 있으면 모든 컬럼을 덮는다. 컬럼 하나를
--   빼는 REVOKE 는 효과가 없다. 테이블 권한을 걷고 필요한 컬럼만 다시 주어야 한다.
--
-- 앱이 실제로 읽는 컬럼(아래 GRANT 목록)은 코드에서 확인한 것이다:
--   worklog-app.Html  DB.getUsers / _getManagedFacilityNames / _emFacilitiesQuery 등
--   api/mcp/[secret].js  id,사원번호,성명,시설명,role
--   어디에도 select('*') 는 없다. 패스워드를 SELECT 하는 곳도 없다.
-- ============================================================


-- ── 1. 로그인 함수를 먼저 SECURITY DEFINER 로 ────────────────────────
-- verify_login 은 패스워드를 대조해야 한다. 지금 그게 되는 이유는 anon 이
-- 패스워드를 읽을 수 있어서다. 2번에서 그 권한을 걷으므로, 함수가 호출자 권한으로
-- 도는 상태라면 로그인이 막힌다. 함수 소유자 권한으로 돌게 먼저 바꾼다.
-- 인자 목록을 몰라도 되도록 이름으로 찾아 바꾼다.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'verify_login'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', f.sig);
    RAISE NOTICE 'SECURITY DEFINER 로 변경: %', f.sig;
  END LOOP;
END $$;

-- 확인: prosecdef 가 true 여야 한다. false 면 2번을 실행하지 말 것.
SELECT p.proname, p.prosecdef AS security_definer, p.oid::regprocedure AS 시그니처
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'verify_login';


-- ── 2. users 는 필요한 컬럼만 읽게 ──────────────────────────────────
-- 여기서 빠진 컬럼(패스워드)은 REST로 조회할 수 없게 된다.
REVOKE SELECT ON public.users FROM anon;
GRANT  SELECT (id, 성명, 시설명, 사원번호, role, created_at, parent_facility, sort_order)
       ON public.users TO anon;

-- authenticated 역할은 지금 쓰이지 않지만 같은 구멍이 남지 않게 맞춰 둔다.
REVOKE SELECT ON public.users FROM authenticated;
GRANT  SELECT (id, 성명, 시설명, 사원번호, role, created_at, parent_facility, sort_order)
       ON public.users TO authenticated;

-- 쓰기 권한은 그대로 둔다. 앱의 시설 추가·수정이 패스워드를 저장해야 하고,
-- supabase-js 는 저장 후 되읽지 않으므로(return=minimal) SELECT 권한이 필요 없다.


-- ── 3. 확인 ────────────────────────────────────────────────────────
-- (가) anon 이 가진 users 컬럼 권한 — 패스워드에 SELECT 가 없어야 한다
SELECT column_name AS 컬럼, privilege_type AS 권한
  FROM information_schema.column_privileges
 WHERE table_schema = 'public' AND table_name = 'users' AND grantee = 'anon'
 ORDER BY column_name, privilege_type;

-- (나) 실제로 막혔는지 — 아래 curl 을 터미널에서 실행한다.
--      패스워드 조회는 실패(42501 permission denied)하고, 이름 조회는 성공해야 한다.
--
--   KEY='<앱 HTML 의 anon 키>'
--   B="https://zbcnfixbkqtrjxvatvss.supabase.co/rest/v1/users"
--   curl -s "$B?select=패스워드&limit=1"  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
--   curl -s "$B?select=시설명&limit=1"    -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
--
-- (다) 로그인이 되는지 반드시 확인한다. 안 되면 아래 되돌리기를 실행할 것.


-- ── 되돌리기 ───────────────────────────────────────────────────────
-- 로그인이나 화면이 깨지면 이 한 줄로 원상복구된다.
--   GRANT SELECT ON public.users TO anon, authenticated;
-- (1번의 SECURITY DEFINER 는 되돌릴 필요가 없다. 그대로 두는 편이 안전하다.)


-- ============================================================
-- 아직 남은 것 — 이 파일로 해결되지 않는다
--
--   개인 데이터(todos·daily_logs·personal_goals·stocks·trades·funds·
--   books·exercises·vocab_progress)는 여전히 anon 키로 전부 읽고 쓸 수 있다.
--
--   지금 앱은 Supabase Auth 세션 없이 anon 키만으로 동작한다. 그래서 데이터베이스
--   입장에서는 접속자가 누구인지 알 방법이 없고, auth.uid() 는 항상 NULL 이다.
--   owner_id 로 거르는 RLS 정책을 걸면 앱 자신도 아무것도 못 읽게 된다.
--
--   해결하려면 로그인 시 사용자별 토큰을 발급해 그 토큰으로 접속해야 한다:
--     1) 공유 계정 정리 — 사원번호 091111 을 8개 계정이 나눠 쓰고 있다.
--        계정이 사람과 1:1이 되어야 그 다음이 성립한다.
--     2) verify_login 이 owner_id 클레임을 담은 JWT 를 돌려주도록 확장
--     3) 앱이 로그인 후 그 토큰으로 Supabase 클라이언트를 다시 만들고,
--        실시간 구독에도 같은 토큰을 물린다
--     4) 개인 테이블 정책을 owner_id = 토큰의 클레임 으로 교체
--
--   순서를 지키지 않고 4번만 먼저 걸면 전 직원이 앱에 못 들어간다.
-- ============================================================
