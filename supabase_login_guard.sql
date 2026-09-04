-- ============================================================
-- 로그인 함수 점검 — 빈 사원번호·빈 비밀번호로 통과되는 구멍 막기
--
-- 무엇이 문제인가:
--   verify_login 이 빈 값끼리를 "일치"로 봅니다. 사원번호와 비밀번호를 모두
--   비운 채 호출하면, 그런 행이 있을 경우 그 계정으로 로그인됩니다.
--
--     POST /rest/v1/rpc/verify_login
--     {"p_facility":"어떤조직","p_empno":"","p_pw_hash":"","p_pw_plain":""}
--     → {"id":"...","role":"user","시설명":"어떤조직", ...}     ← 통과
--
--   로그인 화면은 사원번호 6자리를 요구하지만, 그 검사는 브라우저에서만 합니다.
--   REST 로 함수를 직접 부르면 그냥 지나갑니다.
--
-- 지금 당장 뚫려 있는 계정은 없습니다(사원번호가 빈 행 0건, 확인함).
-- 다만 조직도 관리에서 만든 조직은 사원번호가 비어 있으므로, 누군가 그 행의
-- 비밀번호를 빈 값으로 바꾸는 순간 열립니다. 그 전에 막아두는 게 맞습니다.
--
-- ── 먼저 이것만 실행해서 결과를 알려주세요 ──────────────────
-- 함수 본문을 모르고 덮어쓰면 전 직원이 로그인하지 못하게 됩니다.
-- 아래 두 줄을 SQL Editor 에서 실행하고, 나온 내용을 그대로 전달해 주시면
-- 그 정의에 맞춰 안전한 교체본을 만들어 드리겠습니다.
-- ============================================================

SELECT p.oid::regprocedure AS 시그니처,
       pg_get_function_result(p.oid) AS 반환형,
       p.prosecdef AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'verify_login';

SELECT pg_get_functiondef(p.oid) AS 정의
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'verify_login';


-- ============================================================
-- 참고 — 고칠 방향
--
--   함수 맨 앞에 이 한 줄을 넣으면 됩니다:
--     IF coalesce(p_empno,'') = '' OR coalesce(p_pw_plain,'') = '' THEN
--       RETURN NULL;
--     END IF;
--
--   비밀번호 비교도 빈 값이 통과하지 않도록, 저장된 패스워드가 비어 있으면
--   무조건 실패하게 합니다:
--     AND coalesce(u.패스워드,'') <> ''
--
--   위 두 가지를 적용한 교체본을 정의를 받은 뒤 만들어 드립니다.
--   (교체 후에는 반드시 실제 계정으로 로그인이 되는지 확인하세요.)
-- ============================================================
