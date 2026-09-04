-- ============================================================
-- 인사관리 — 직원 인사정보 + 시설·직렬·직급별 정원
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- 여러 번 실행해도 안전하다.
--
-- ⚠️ 먼저 읽어주세요 — 이 표에는 민감한 개인정보가 들어갑니다
--   생년월일과 거주지 주소는 지금까지 다룬 데이터와 성격이 다릅니다.
--   이 앱은 아직 Supabase Auth 세션 없이 anon 키로만 동작하고, anon 키는
--   배포된 HTML 안에 그대로 들어 있습니다. 즉 지금 상태에서는
--   **앱 주소를 아는 사람이면 누구나 전 직원의 생년월일과 주소를 읽을 수 있습니다.**
--
--   화면에서는 관리자에게만 인사관리 탭을 보여주지만, 그건 UI 차원의 가림막일 뿐
--   데이터베이스 접근을 막지는 못합니다.
--
--   그래서 아래 두 가지를 권합니다:
--     1) 주민등록번호는 절대 넣지 마세요. 이 표에 칸 자체를 두지 않았습니다.
--     2) supabase_security_step1.sql 하단의 S-1 계획(로그인 시 사용자별 토큰 발급
--        → owner_id 기준 RLS)을 끝낸 뒤에 실제 직원 정보를 채우세요.
--        그 전까지는 시뮬레이션 검증용 가상 데이터로 쓰시길 권합니다.
--
-- 되돌리려면:
--   DROP TABLE IF EXISTS hr_employees;
--   DROP TABLE IF EXISTS hr_quota;
-- ============================================================


-- ── 직원 인사정보 ───────────────────────────────────────────
-- 평정·수상은 사람마다 여러 건이라 jsonb 배열로 담는다. 이 앱은 조회를 전부
-- 브라우저에서 하므로 별도 표로 쪼개는 것보다 한 번에 읽는 편이 단순하다.
CREATE TABLE IF NOT EXISTS hr_employees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  성명         text NOT NULL,
  생년월일      date,
  주소         text,
  직급         text,          -- 예: 5급, 6급, 7급 / 부장, 과장
  직렬         text,          -- 예: 행정, 시설, 전기, 토목, 운영
  시설명        text,          -- 지금 배치된 곳 (users.시설명 과 같은 이름을 쓴다)
  사원번호      text,
  입사일        date,
  평정         jsonb DEFAULT '[]'::jsonb,   -- [{연도, 기간, 점수, 등급, 비고}]
  수상         jsonb DEFAULT '[]'::jsonb,   -- [{일자, 수상명, 수여기관, 종류}]
  메모         text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- 배치 시뮬레이션이 "이 시설의 이 직렬" 단위로 사람을 세므로 그 조합으로 찾는다
CREATE INDEX IF NOT EXISTS hr_employees_place_idx ON hr_employees (시설명, 직렬, 직급);
CREATE INDEX IF NOT EXISTS hr_employees_name_idx  ON hr_employees (성명);


-- ── 정원 (시설 × 직렬 × 직급) ────────────────────────────────
-- 현원은 hr_employees 를 세어 구한다. 정원만 저장하고 과부족은 화면에서 계산한다 —
-- 현원을 따로 저장하면 두 값이 어긋나는 순간 어느 쪽이 맞는지 알 수 없게 된다.
CREATE TABLE IF NOT EXISTS hr_quota (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  시설명        text NOT NULL,
  직렬         text NOT NULL,
  직급         text NOT NULL,
  정원         int  NOT NULL DEFAULT 0,
  비고         text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE (시설명, 직렬, 직급)      -- 같은 조합이 두 줄 생기면 정원이 갈린다
);


-- ── 권한 ────────────────────────────────────────────────────
-- 지금 구조에서는 앱이 anon 키로 읽고 써야 하므로 다른 표와 같은 정책을 쓴다.
-- 위 경고대로, 이건 "잠갔다"는 뜻이 아니다. S-1 이 끝나면 아래 정책을
-- owner_id / 역할 기준으로 바꿔야 한다.
ALTER TABLE hr_employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_quota     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hr_employees_anon ON hr_employees;
CREATE POLICY hr_employees_anon ON hr_employees FOR ALL TO anon USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS hr_quota_anon ON hr_quota;
CREATE POLICY hr_quota_anon ON hr_quota FOR ALL TO anon USING (true) WITH CHECK (true);


-- ── 확인 ────────────────────────────────────────────────────
SELECT table_name AS 표, column_name AS 컬럼, data_type AS 타입
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name IN ('hr_employees','hr_quota')
 ORDER BY table_name, ordinal_position;
