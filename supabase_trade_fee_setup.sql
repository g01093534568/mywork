-- ============================================================
-- 매매기록(trades) — 매도 수수료(fee) 컬럼 추가
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- (이미 있으면 IF NOT EXISTS 로 안전하게 건너뜀)
-- ============================================================

ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee NUMERIC DEFAULT 0;  -- 매도 수수료(세금 포함, 원)

-- PostgREST 스키마 캐시 갱신 (새 컬럼 즉시 인식)
NOTIFY pgrst, 'reload schema';
