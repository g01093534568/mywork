-- ============================================================
-- 조직도 반영 (2026-09-02 조직도 기준)
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
--
-- 무엇을 하는가:
--   조직도의 본부장·팀·시설을 users 테이블에 '조직 항목'으로 만들고 상하 관계를 잇는다.
--
-- 조직 항목이란:
--   패스워드를 64자 비-16진 문자열로 채워 로그인이 원천적으로 불가능한 행.
--   verify_login은 (해시 일치) 또는 (평문 일치 AND LENGTH < 64)로만 통과하는데,
--   64자이면서 sha-256 출력(16진)일 수 없는 값이라 두 경로 모두 성립하지 않는다.
--   나중에 그 팀에 사람이 생기면 패스워드만 바꿔 넣으면 바로 로그인 계정이 된다.
--
-- 사원번호는 900001부터 자리표시자로 매긴다 (로그인에 쓰이지 않음).
--
-- 안전장치:
--   · 이미 있는 시설명은 새로 만들지 않고 parent_facility만 맞춘다
--   · 여러 번 실행해도 결과가 같다
--   · 기존 계정의 성명·패스워드·권한은 건드리지 않는다
--
-- 되돌리려면: 아래 DELETE 한 줄 (맨 아래 주석 참고)
-- ============================================================

DO $$
DECLARE
  rec      RECORD;
  seq      INT := 900001;
  v_nologin TEXT := repeat('x', 64);   -- 로그인 불가 표식
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      -- (시설명, 상위 조직)
      ('이사장',                    NULL),
      ('안전감사팀',                '이사장'),
      ('본부장',                    '이사장'),

      ('기획전략팀',                '본부장'),
      ('경영혁신팀',                '본부장'),

      ('시설관리팀',                '본부장'),
      ('운동장 및 체육시설',        '시설관리팀'),
      ('수변공원',                  '시설관리팀'),

      ('체육청소년팀',              '본부장'),
      ('온산문화체육센터',          '체육청소년팀'),
      ('울주군국민체육센터',        '체육청소년팀'),
      ('울주종합체육센터',          '체육청소년팀'),
      ('울주서부청소년수련관',      '체육청소년팀'),
      ('울주남부청소년수련관',      '체육청소년팀'),
      ('울주중부청소년수련관',      '체육청소년팀'),

      ('시네마야영장팀',            '본부장'),
      ('울주군립야영장',            '시네마야영장팀'),
      ('간월재휴게소',              '시네마야영장팀'),
      ('울주군특산품판매장',        '시네마야영장팀'),

      ('주차관리팀',                '본부장'),
      ('공영주차장',                '주차관리팀'),
      ('공중화장실',                '주차관리팀'),
      ('종량제봉투',                '주차관리팀'),

      -- 울주군립야영장 하부 (이미 있는 계정들 — 관계만 재확인)
      ('울주군립야영장(달빛)',          '울주군립야영장'),
      ('울주군립야영장(등억)',          '울주군립야영장'),
      ('울주군립야영장(별빛)',          '울주군립야영장'),
      ('울주군립야영장(별빛, 확장)',    '울주군립야영장'),
      ('울주군립야영장(별빛, 주차장)',  '울주군립야영장'),
      ('대운산야영장',                  '울주군립야영장')
    ) AS t(name, parent)
  LOOP
    IF EXISTS (SELECT 1 FROM users WHERE 시설명 = rec.name) THEN
      -- 있는 계정은 상위 조직만 맞춘다 (성명·패스워드·권한은 그대로)
      UPDATE users SET parent_facility = rec.parent WHERE 시설명 = rec.name;
      RAISE NOTICE '기존 유지 · 상위 갱신: % → %', rec.name, COALESCE(rec.parent, '(최상위)');
    ELSE
      INSERT INTO users (시설명, 성명, 사원번호, 패스워드, role, parent_facility)
      VALUES (rec.name, '', lpad(seq::text, 6, '0'), v_nologin, 'user', rec.parent);
      seq := seq + 1;
      RAISE NOTICE '조직 항목 생성: % (상위 %)', rec.name, COALESCE(rec.parent, '(최상위)');
    END IF;
  END LOOP;
END $$;

-- 별개 시설(테스트 계정 포함)은 조직도 밖 — 상위를 비워 최상위로 둔다
UPDATE users SET parent_facility = NULL
 WHERE 시설명 IN ('성북구시설관리공단', '영월군시설관리공단', 'test', '관리자');

-- ── 확인: 계층 구조 ──
WITH RECURSIVE tree AS (
  SELECT 시설명, parent_facility, 0 AS depth, 시설명::text AS path
    FROM users WHERE parent_facility IS NULL OR parent_facility = ''
  UNION ALL
  SELECT u.시설명, u.parent_facility, t.depth + 1, t.path || ' > ' || u.시설명
    FROM users u JOIN tree t ON u.parent_facility = t.시설명
)
SELECT repeat('    ', depth) || 시설명 AS 조직도, depth AS 단계
  FROM tree ORDER BY path;

-- ── 되돌리기 ──
-- DELETE FROM users WHERE 패스워드 = repeat('x', 64);
