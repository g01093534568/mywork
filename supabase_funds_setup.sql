-- ============================================================
-- 펀드(funds) 테이블 — 보유 펀드 현황 카드용
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- (이미 존재하는 항목은 IF NOT EXISTS / 예외처리로 안전하게 건너뜀)
-- ============================================================

-- ① 테이블 생성
CREATE TABLE IF NOT EXISTS funds (
  id          TEXT PRIMARY KEY,
  사원번호     TEXT NOT NULL,
  name        TEXT NOT NULL,           -- 펀드명
  fund_type   TEXT DEFAULT '',         -- 펀드유형 (예: 주식형, 채권형, ELS 등)
  principal   NUMERIC DEFAULT 0,       -- 투자원금 (원)
  valuation   NUMERIC DEFAULT 0,       -- 평가금액 (원)
  start_date  DATE,                    -- 가입일
  memo        TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS funds_사원번호_idx ON funds (사원번호);

-- ② RLS 활성화 + anon 전체 허용 (앱은 anon 키로 동작 — 이 정책이 없으면 저장 실패)
ALTER TABLE funds ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'funds' AND policyname = 'anon_all'
  ) THEN
    CREATE POLICY "anon_all" ON funds
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ③ Realtime 발행에 테이블 추가 (폰↔PC 실시간 동기화)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE funds;
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- 이미 등록됨
  WHEN undefined_object THEN NULL;  -- supabase_realtime 발행이 없는 환경
END $$;

-- ④ 변경 행 전체가 Realtime 페이로드에 실리도록 보장
ALTER TABLE funds REPLICA IDENTITY FULL;

-- ⑤ PostgREST 스키마 캐시 갱신 (새 테이블 즉시 인식)
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- 확인용 (선택):
--   SELECT * FROM pg_policies WHERE tablename='funds';  → anon_all 1행
-- ============================================================
