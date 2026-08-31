-- ============================================================
-- 할 일 시간대(time_range) 저장
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
--
-- 왜 필요한가:
--   할 일 모달에는 이미 '시작 시간 / 종료 시간' 칸이 있고 목록에도 🕐 로 표시되지만,
--   todos 테이블에 시간 컬럼이 없어 저장되지 않았다 — 입력해도 새로고침하면 사라진다.
--
-- 형식: daily_logs.time_range 와 동일한 텍스트 ('09:00~10:30', 시작만이면 '09:00')
-- 되돌리려면: ALTER TABLE todos DROP COLUMN time_range;
-- ============================================================

ALTER TABLE todos ADD COLUMN IF NOT EXISTS time_range TEXT;

-- 확인
SELECT count(*) AS 전체_할일, count(time_range) AS 시간_입력됨 FROM todos;
