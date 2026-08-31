-- ============================================================
-- 개인 데이터 계정별 분리 (owner_id)
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
--
-- 왜 필요한가:
--   사원번호는 유일하지 않다. 091111 하나를 8개 계정(관리자 + 울주군립야영장 계열 7곳)이,
--   111111을 2개 계정(성북구·영월군)이 나눠 쓴다. 그런데 할 일·업무일지·개인목표 등은
--   사원번호만으로 저장돼 있어, 같은 번호로 로그인하면 남의 목록이 그대로 보이고 수정도 된다.
--
-- 무엇을 하는가:
--   users.id(UUID)를 소유자 키로 삼는 owner_id 컬럼을 개인 테이블에 추가하고,
--   기존 행을 전부 관리자(강기호) 소유로 귀속시킨다.
--   ※ 현재 개인 데이터는 전부 사원번호 091111 소유이며, 그중 실사용 계정은 관리자뿐이다.
--
-- 되돌리려면: 각 테이블에서 owner_id 컬럼을 DROP 하면 이전 동작으로 돌아간다.
-- ============================================================

-- 관리자(강기호 / 시설명 '관리자') users.id
--   다른 환경에서 실행한다면 아래 SELECT로 값을 확인해 바꿔 넣을 것:
--   SELECT id, 사원번호, 성명, 시설명 FROM users WHERE 시설명 = '관리자';
DO $$
DECLARE
  v_owner UUID;
  t       TEXT;
BEGIN
  SELECT id INTO v_owner FROM users WHERE 시설명 = '관리자' AND 사원번호 = '091111' LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION '관리자 계정을 찾지 못했습니다 — users 테이블을 확인하세요';
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'todos', 'daily_logs', 'personal_goals', 'stocks',
    'funds', 'trades', 'annual_goals', 'exercises', 'books'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS owner_id UUID', t);
    EXECUTE format('UPDATE %I SET owner_id = %L WHERE owner_id IS NULL', t, v_owner);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (owner_id)', t || '_owner_idx', t);
    RAISE NOTICE '% → owner_id 적용 완료', t;
  END LOOP;
END $$;

-- ── vocab_progress: 사원번호가 PRIMARY KEY였다 → owner_id 기준으로 교체 ──
-- (사원번호가 유일하지 않으므로 PK로 쓸 수 없다)
DO $$
DECLARE v_owner UUID;
BEGIN
  SELECT id INTO v_owner FROM users WHERE 시설명 = '관리자' AND 사원번호 = '091111' LIMIT 1;

  ALTER TABLE vocab_progress ADD COLUMN IF NOT EXISTS owner_id UUID;
  UPDATE vocab_progress SET owner_id = v_owner WHERE owner_id IS NULL;

  -- owner_id가 비어 있는 행이 남아 있으면 NOT NULL 전환이 실패하므로 먼저 정리한다
  DELETE FROM vocab_progress WHERE owner_id IS NULL;

  ALTER TABLE vocab_progress ALTER COLUMN owner_id SET NOT NULL;
  ALTER TABLE vocab_progress DROP CONSTRAINT IF EXISTS vocab_progress_pkey;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vocab_progress_owner_pkey'
  ) THEN
    ALTER TABLE vocab_progress ADD CONSTRAINT vocab_progress_owner_pkey PRIMARY KEY (owner_id);
  END IF;
END $$;

-- ── 확인 ──
SELECT 'todos' AS 테이블, count(*) AS 전체, count(owner_id) AS owner_id_있음 FROM todos
UNION ALL SELECT 'daily_logs',     count(*), count(owner_id) FROM daily_logs
UNION ALL SELECT 'personal_goals', count(*), count(owner_id) FROM personal_goals
UNION ALL SELECT 'stocks',         count(*), count(owner_id) FROM stocks
UNION ALL SELECT 'funds',          count(*), count(owner_id) FROM funds
UNION ALL SELECT 'trades',         count(*), count(owner_id) FROM trades
UNION ALL SELECT 'annual_goals',   count(*), count(owner_id) FROM annual_goals
UNION ALL SELECT 'exercises',      count(*), count(owner_id) FROM exercises
UNION ALL SELECT 'books',          count(*), count(owner_id) FROM books
UNION ALL SELECT 'vocab_progress', count(*), count(owner_id) FROM vocab_progress;
