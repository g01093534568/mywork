-- ============================================================
-- 인사배치 시뮬레이션 — 시설 위치 + 사전 배치
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- 여러 번 실행해도 안전합니다.
--
-- 무엇이 필요한가:
--   1) 시설마다 위치(주소·좌표) — 통근 거리를 보려면 시설이 어디 있는지 알아야 합니다.
--   2) 사람마다 사전 배치 — "이 사람은 여기 관장" 같은 관리자의 결정을 붙박아 두고,
--      나머지만 자동으로 채웁니다.
--
-- 되돌리려면:
--   ALTER TABLE users DROP COLUMN 시설주소, DROP COLUMN 위도, DROP COLUMN 경도;
--   ALTER TABLE hr_employees DROP COLUMN 배치고정;
-- ============================================================


-- ── 1. 시설 위치 ────────────────────────────────────────────
-- 조직도는 users 표가 겸하고 있어 여기에 붙입니다.
-- 좌표는 선택입니다. 비워 두면 주소의 행정구역(읍·면·동)으로만 가늠합니다.
ALTER TABLE users ADD COLUMN IF NOT EXISTS 시설주소 text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS 위도 double precision;
ALTER TABLE users ADD COLUMN IF NOT EXISTS 경도 double precision;

-- ⚠️ 이 줄을 빠뜨리면 값은 저장돼도 앱에서 읽히지 않습니다.
--    supabase_security_step1.sql 에서 users 를 통째 읽지 못하게 막고 필요한 칸만
--    열어 두었기 때문에, 새로 만든 칸도 따로 열어 줘야 합니다.
GRANT SELECT (시설주소, 위도, 경도) ON public.users TO anon;
GRANT SELECT (시설주소, 위도, 경도) ON public.users TO authenticated;


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
   AND ((table_name='users' AND column_name IN ('시설주소','위도','경도'))
     OR (table_name='hr_employees' AND column_name IN ('배치고정','이동이력')))
 ORDER BY table_name, column_name;

-- (나) anon 이 새 칸을 읽을 수 있는지 — 세 줄(시설주소·위도·경도)이 나와야 정상입니다
SELECT column_name AS 컬럼, privilege_type AS 권한
  FROM information_schema.column_privileges
 WHERE table_schema='public' AND table_name='users' AND grantee='anon'
   AND column_name IN ('시설주소','위도','경도')
 ORDER BY column_name;
