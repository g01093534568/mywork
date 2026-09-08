-- ============================================================
-- 인사배치 시뮬레이션 — 시설 위치 + 사전 배치
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- 여러 번 실행해도 안전합니다.
--
-- 무엇이 필요한가:
--   1) 시설마다 주소 — 통근 거리를 가늠하려면 시설이 어디 있는지 알아야 합니다.
--   2) 사람마다 사전 배치 — "이 사람은 여기 관장" 같은 관리자의 결정을 붙박아 두고,
--      나머지만 자동으로 채웁니다.
--
-- 되돌리려면:
--   ALTER TABLE users DROP COLUMN 시설주소;
--   ALTER TABLE hr_employees DROP COLUMN 배치고정;
-- ============================================================


-- ── 1. 시설 주소 ────────────────────────────────────────────
-- 조직도는 users 표가 겸하고 있어 여기에 붙입니다.
-- 좌표는 두지 않습니다 — 직원 주소에 좌표가 없어 실거리를 어차피 계산할 수 없고,
-- 배치에서는 주소의 행정구역(시·도 / 시·군·구 / 읍·면·동)이 얼마나 겹치는지만 봅니다.
ALTER TABLE users ADD COLUMN IF NOT EXISTS 시설주소 text;

-- ⚠️ 이 줄을 빠뜨리면 값은 저장돼도 앱에서 읽히지 않습니다.
--    supabase_security_step1.sql 에서 users 를 통째 읽지 못하게 막고 필요한 칸만
--    열어 두었기 때문에, 새로 만든 칸도 따로 열어 줘야 합니다.
GRANT SELECT (시설주소) ON public.users TO anon;
GRANT SELECT (시설주소) ON public.users TO authenticated;


-- ── 2. 사전 배치 ────────────────────────────────────────────
-- {"시설명":"울주군립야영장","역할":"관장"} 한 덩어리만 담습니다.
-- 표를 따로 만들지 않은 이유: 사람당 한 건뿐이고, 조회를 전부 브라우저에서 하므로
-- 명부를 읽을 때 같이 딸려오는 편이 단순합니다.
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS 배치고정 jsonb DEFAULT '{}'::jsonb;


-- ── 확인 ────────────────────────────────────────────────────
-- (가) 칸이 생겼는지
SELECT table_name AS 표, column_name AS 컬럼, data_type AS 타입
  FROM information_schema.columns
 WHERE table_schema='public'
   AND ((table_name='users' AND column_name='시설주소')
     OR (table_name='hr_employees' AND column_name IN ('배치고정','이동이력')))
 ORDER BY table_name, column_name;

-- (나) anon 이 새 칸을 읽을 수 있는지 — 시설주소 한 줄이 나와야 정상입니다
SELECT column_name AS 컬럼, privilege_type AS 권한
  FROM information_schema.column_privileges
 WHERE table_schema='public' AND table_name='users' AND grantee='anon'
   AND column_name='시설주소';
