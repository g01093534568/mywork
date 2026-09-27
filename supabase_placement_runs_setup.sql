-- ============================================================
-- 인사배치 시뮬레이션 — 실행 결과 저장(배치안)
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- 여러 번 실행해도 안전합니다.
--
-- 무엇을 담는가:
--   시뮬레이션을 돌린 한 판을 그대로 얼려 둡니다. 무게(거주지·이전근무·유임·평정)와
--   그때 나온 배치·미배치·빈자리를 한 덩어리 jsonb 로 넣습니다. 정원이나 명부가 나중에
--   바뀌어도 저장한 배치안은 그대로 남아, 안끼리 견주어 볼 수 있습니다.
--
-- 왜 표 하나에 jsonb 한 덩어리인가:
--   배치안은 되짚어 보는 기록이지 조회 대상이 아닙니다. 사람·자리를 행으로 쪼개면
--   표 셋이 필요하고, 그때의 명부와 정원까지 함께 얼려야 해서 되살리기가 어렵습니다.
--
-- 되돌리려면:
--   DROP TABLE public.hr_placement_runs;
-- ============================================================

CREATE TABLE IF NOT EXISTS public.hr_placement_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  이름        TEXT NOT NULL,                    -- 사람이 알아볼 배치안 이름
  실행일시    TIMESTAMPTZ DEFAULT now(),        -- 시뮬레이션을 돌린 시각
  무게        JSONB DEFAULT '{}'::jsonb,        -- {dist,hist,stay,eval}
  요약        JSONB DEFAULT '{}'::jsonb,        -- {배치,미배치,빈자리}
  내용        JSONB DEFAULT '{}'::jsonb,        -- 배치·미배치·빈자리 스냅샷
  작성자      TEXT,                             -- 저장한 사람 사원번호(감사용)
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_place_runs_when ON public.hr_placement_runs (실행일시 DESC);

-- ── 권한 ────────────────────────────────────────────────────
-- 인사정보라 인사관리 권한(admin)만 읽고 씁니다 — hr_employees·hr_quota 와 같은 규칙.
-- ⚠️ 새로 만든 표는 anon 에 권한이 없습니다(supabase_auth_step2.sql 에서 회수).
--    로그인 토큰(authenticated)으로만 보이므로 아래 정책을 빠뜨리면 앱에서 안 보입니다.
ALTER TABLE public.hr_placement_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_placement_runs TO authenticated;

DROP POLICY IF EXISTS wl_read   ON public.hr_placement_runs;
DROP POLICY IF EXISTS wl_insert ON public.hr_placement_runs;
DROP POLICY IF EXISTS wl_update ON public.hr_placement_runs;
DROP POLICY IF EXISTS wl_delete ON public.hr_placement_runs;

CREATE POLICY wl_read   ON public.hr_placement_runs FOR SELECT TO authenticated
  USING (public.wl_role() = 'admin');
CREATE POLICY wl_insert ON public.hr_placement_runs FOR INSERT TO authenticated
  WITH CHECK (public.wl_role() = 'admin');
CREATE POLICY wl_update ON public.hr_placement_runs FOR UPDATE TO authenticated
  USING (public.wl_role() = 'admin') WITH CHECK (public.wl_role() = 'admin');
CREATE POLICY wl_delete ON public.hr_placement_runs FOR DELETE TO authenticated
  USING (public.wl_role() = 'admin');

-- 토큰 로그인을 아직 켜지 않은 환경(예전 anon 방식)에서도 쓰려면 아래 두 줄을 함께 실행하세요.
-- 지금 운영 환경은 토큰 로그인이라 필요 없습니다.
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_placement_runs TO anon;
--   CREATE POLICY anon_all ON public.hr_placement_runs FOR ALL TO anon USING (true) WITH CHECK (true);


-- ── 확인 ────────────────────────────────────────────────────
-- (가) 표가 생겼는지
SELECT column_name AS 컬럼, data_type AS 타입
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'hr_placement_runs'
 ORDER BY ordinal_position;

-- (나) 정책이 걸렸는지
SELECT policyname AS 정책, cmd AS 동작, roles AS 역할
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'hr_placement_runs'
 ORDER BY policyname;
