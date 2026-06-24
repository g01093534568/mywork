-- ============================================================
-- 차량 정보 관리(vehicle_info) — 설정 > 에너지 및 차량 관리 탭
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- (이미 존재하는 항목은 IF NOT EXISTS / 예외처리로 안전하게 건너뜀)
-- 권한: 시설명(facility_name) 기준 — 앱에서 role(admin/facility-admin/user)에
--       따라 facility_name 으로 필터링한다 (energy_info 와 동일 패턴)
-- ============================================================

-- ① 테이블 생성
CREATE TABLE IF NOT EXISTS vehicle_info (
  id             BIGSERIAL PRIMARY KEY,
  facility_name  TEXT NOT NULL,          -- 시설명
  vehicle_number TEXT NOT NULL,          -- 차량번호
  fuel           TEXT DEFAULT '',        -- 사용연료
  model_year     TEXT DEFAULT '',        -- 연식
  vehicle_type   TEXT DEFAULT '',        -- 종류(경승용차/소형승용차/중형승용차/대형승용차/중형승합차/대형승합차/소형화물차)
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- 같은 시설 + 같은 차량번호 중복 방지
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_info_facility_number_uniq
  ON vehicle_info (facility_name, vehicle_number);

-- ② RLS 활성화 + anon 전체 허용 (앱은 anon 키로 동작, 권한은 앱 레벨에서 필터)
ALTER TABLE vehicle_info ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'vehicle_info' AND policyname = 'anon_all'
  ) THEN
    CREATE POLICY "anon_all" ON vehicle_info
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;
