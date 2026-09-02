-- ============================================================
-- 조직 순서 저장 (sort_order)
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
--
-- 왜 필요한가:
--   지금은 형제 조직이 가나다순으로만 나온다. 조직도 원본 순서
--   (기획전략팀 → 경영혁신팀 → 시설관리팀 → 체육청소년팀 → 시네마야영장팀 → 주차관리팀)
--   를 지키려면 순서를 담을 칸이 있어야 하고, 드래그로 바꾼 순서도 여기에 저장된다.
--
-- 되돌리려면: ALTER TABLE users DROP COLUMN sort_order;
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS sort_order INT;

-- ── 초기값: 같은 상위끼리 묶어 지금 보이는 순서(가나다순) 그대로 번호를 매긴다 ──
--    이렇게 해두면 이 SQL을 실행해도 화면 순서가 그대로여서 놀랄 일이 없다.
WITH numbered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY COALESCE(parent_facility, '')
           ORDER BY 시설명
         ) - 1 AS n
    FROM users
)
UPDATE users u SET sort_order = numbered.n
  FROM numbered
 WHERE u.id = numbered.id;

-- ── 조직도 원본 순서로 팀 배치 (가나다순과 다르다) ──
UPDATE users SET sort_order = v.n
  FROM (VALUES
    ('기획전략팀',   0),
    ('경영혁신팀',   1),
    ('시설관리팀',   2),
    ('체육청소년팀', 3),
    ('시네마야영장팀', 4),
    ('주차관리팀',   5)
  ) AS v(name, n)
 WHERE users.시설명 = v.name AND users.parent_facility = '본부장';

-- 이사장 아래: 본부장을 먼저, 안전감사팀을 뒤에
UPDATE users SET sort_order = CASE 시설명 WHEN '본부장' THEN 0 ELSE 1 END
 WHERE parent_facility = '이사장';

-- ── 확인 ──
SELECT COALESCE(parent_facility, '(최상위)') AS 상위조직,
       sort_order AS 순서,
       시설명
  FROM users
 ORDER BY COALESCE(parent_facility, ''), sort_order, 시설명;
