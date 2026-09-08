-- ============================================================
-- 인사관리 — 최근 인사이동 시설
-- Supabase 대시보드 > SQL Editor 에서 실행 (한 줄이면 끝납니다)
-- 여러 번 실행해도 안전합니다.
--
-- 무엇을 담는가:
--   그 직원이 현소속 이전에 근무한 시설을 최근 순으로 최대 5개.
--   ["문화체육센터", "본부"] 처럼 이름만 순서대로 들어갑니다.
--   0번이 가장 최근입니다(화면의 1번).
--
-- 왜 별도 표가 아니라 jsonb 인가:
--   이 앱은 조회를 전부 브라우저에서 합니다. 사람마다 최대 5칸뿐이라
--   표를 하나 더 만들어 join 하는 것보다 한 번에 읽는 편이 단순합니다.
--   발령일자까지 관리하게 되면 그때 별도 표로 옮기는 편이 낫습니다.
--
-- 되돌리려면:
--   ALTER TABLE hr_employees DROP COLUMN 이동이력;
-- ============================================================

ALTER TABLE hr_employees
  ADD COLUMN IF NOT EXISTS 이동이력 jsonb DEFAULT '[]'::jsonb;


-- ── 확인 ────────────────────────────────────────────────────
SELECT column_name AS 컬럼, data_type AS 타입, column_default AS 기본값
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='hr_employees' AND column_name='이동이력';
