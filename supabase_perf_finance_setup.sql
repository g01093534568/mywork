-- ============================================================
-- 경영실적 — 사업수입·지출 (업무 → 경영실적 입력 → 2. 사업수입 / 3. 지출)
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- 여러 번 실행해도 안전합니다.
--
-- 무엇을 담는가:
--   시설별·연도별 사업수입(revenue)과 지출(expense) 금액(원).
--   사업수입은 2012년부터 매월(month = 1~12).
--   지출은 2012~2025년 연 단위 한 칸(month = 0), 2026년부터 매월(month = 1~12).
--
-- 누가 쓰는가:
--   본사관리자(admin)는 전 시설, 그 밖에는 자기 시설(시설관리자는 자기 + 하위 조직)만.
--   앱의 화면 제한과 같은 규칙을 DB 정책으로도 막는다.
--
-- 되돌리려면:
--   DROP TABLE public.perf_finance;  DROP FUNCTION public.wl_can_fac(text);
-- ============================================================

CREATE TABLE IF NOT EXISTS public.perf_finance (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  시설명      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('revenue', 'expense')),
  year        INT  NOT NULL CHECK (year BETWEEN 2012 AND 2100),
  month       INT  NOT NULL DEFAULT 0,
  amount      BIGINT NOT NULL,
  updated_by  TEXT,                                 -- 저장한 계정 시설명(감사용)
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (시설명, kind, year, month)
);

-- 입력 단위 — 사업수입은 늘 월별, 지출은 2025년까지 연간 한 칸·2026년부터 월별
-- (처음 버전은 두 구분 모두 2025년까지 연간이었다. 다시 실행하면 새 규칙으로 바뀐다)
ALTER TABLE public.perf_finance DROP CONSTRAINT IF EXISTS perf_finance_period;
ALTER TABLE public.perf_finance ADD CONSTRAINT perf_finance_period CHECK (
  (kind = 'revenue' AND month BETWEEN 1 AND 12)
  OR (kind = 'expense' AND ((year <= 2025 AND month = 0) OR (year >= 2026 AND month BETWEEN 1 AND 12))));
CREATE INDEX IF NOT EXISTS idx_perf_finance_kind_year ON public.perf_finance (kind, year);

-- 금액 대신 시설 상태 — 사업수입 칸에 '무수익시설' · '위탁 전' · '위탁 종료' 를 적을 수 있다.
-- 한 칸에는 금액이나 상태 중 하나만 들어간다.
ALTER TABLE public.perf_finance ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE public.perf_finance ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE public.perf_finance DROP CONSTRAINT IF EXISTS perf_finance_note;
ALTER TABLE public.perf_finance ADD CONSTRAINT perf_finance_note CHECK (
  (note IS NULL AND amount IS NOT NULL)
  OR (amount IS NULL AND kind = 'revenue' AND note IN ('무수익시설', '위탁 전', '위탁 종료')));

-- ── 시설 범위 ───────────────────────────────────────────────
-- 토큰의 wl_fac(로그인 시설)과 그 하위 조직(재귀)이면 true. admin 은 전부.
-- users 는 RLS 가 걸려 있어 정책 안에서 그대로 읽으면 막힐 수 있으므로 SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.wl_can_fac(name TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.wl_role() = 'admin' OR EXISTS (
    WITH RECURSIVE sub AS (
      SELECT coalesce(auth.jwt() ->> 'wl_fac', '') AS n
      UNION
      SELECT u.시설명 FROM public.users u JOIN sub s ON u.parent_facility = s.n
    )
    SELECT 1 FROM sub WHERE sub.n = name AND sub.n <> ''
  )
$$;
REVOKE ALL ON FUNCTION public.wl_can_fac(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wl_can_fac(TEXT) TO authenticated;

-- ── 권한 ────────────────────────────────────────────────────
-- ⚠️ 새로 만든 표는 anon 에 권한이 없습니다(supabase_auth_step2.sql 에서 회수).
--    로그인 토큰(authenticated)으로만 보이므로 아래 정책을 빠뜨리면 앱에서 안 보입니다.
ALTER TABLE public.perf_finance ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.perf_finance TO authenticated;

DROP POLICY IF EXISTS wl_read   ON public.perf_finance;
DROP POLICY IF EXISTS wl_insert ON public.perf_finance;
DROP POLICY IF EXISTS wl_update ON public.perf_finance;
DROP POLICY IF EXISTS wl_delete ON public.perf_finance;

CREATE POLICY wl_read   ON public.perf_finance FOR SELECT TO authenticated
  USING (public.wl_can_fac(시설명));
CREATE POLICY wl_insert ON public.perf_finance FOR INSERT TO authenticated
  WITH CHECK (public.wl_can_fac(시설명));
CREATE POLICY wl_update ON public.perf_finance FOR UPDATE TO authenticated
  USING (public.wl_can_fac(시설명)) WITH CHECK (public.wl_can_fac(시설명));
CREATE POLICY wl_delete ON public.perf_finance FOR DELETE TO authenticated
  USING (public.wl_can_fac(시설명));

-- ── 확인 ────────────────────────────────────────────────────
SELECT policyname AS 정책, cmd AS 동작, roles AS 역할
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'perf_finance'
 ORDER BY policyname;
