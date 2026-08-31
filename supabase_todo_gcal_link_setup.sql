-- ============================================================
-- 할 일 ↔ 구글 캘린더 일정 연결
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
--
-- 왜 필요한가:
--   '업무' 캘린더 일정을 할 일로 옮길 때 어떤 일정에서 왔는지를 기억해 두어야,
--   나중에 할 일을 고쳤을 때 캘린더 쪽도 같이 고칠 수 있다.
--
-- 되돌리려면:
--   ALTER TABLE todos DROP COLUMN gcal_event_id, DROP COLUMN gcal_cal_id;
-- ============================================================

ALTER TABLE todos ADD COLUMN IF NOT EXISTS gcal_event_id TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS gcal_cal_id   TEXT;

-- 확인
SELECT count(*) AS 전체_할일, count(gcal_event_id) AS 캘린더_연결됨 FROM todos;
