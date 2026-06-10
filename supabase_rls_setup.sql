-- ============================================================
-- Supabase RLS + 보안 설정
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- ============================================================

-- ① 모든 테이블 RLS 활성화
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_goals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE todos             ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_goals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_goals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades            ENABLE ROW LEVEL SECURITY;
ALTER TABLE annual_goals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE exercises         ENABLE ROW LEVEL SECURITY;
ALTER TABLE books             ENABLE ROW LEVEL SECURITY;
ALTER TABLE energy_records   ENABLE ROW LEVEL SECURITY;
ALTER TABLE energy_info      ENABLE ROW LEVEL SECURITY;

-- ② 일반 테이블 anon 전체 허용 정책 (앱 정상 동작 유지)
CREATE POLICY "anon_all" ON org_goals      FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON todos           FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON daily_logs     FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON personal_goals  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON facility_goals  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON stocks          FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON trades          FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON annual_goals   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON exercises       FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON books           FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON energy_records  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON energy_info    FOR ALL TO anon USING (true) WITH CHECK (true);

-- ③ users 테이블 개별 정책 (SELECT는 허용하되 패스워드 컬럼 차단)
CREATE POLICY "anon_select_users" ON users FOR SELECT TO anon USING (true);
CREATE POLICY "anon_insert_users" ON users FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_users" ON users FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_users" ON users FOR DELETE TO anon USING (true);

-- ④ anon 역할에서 패스워드 컬럼 SELECT 권한 제거 (REST API로 직접 조회 불가)
REVOKE SELECT (패스워드) ON users FROM anon;

-- ⑤ 로그인 검증 RPC 함수
--    SECURITY DEFINER: postgres 권한으로 실행되어 패스워드 컬럼 접근 가능
--    반환값에 패스워드 미포함 → 클라이언트에 절대 노출되지 않음
CREATE OR REPLACE FUNCTION verify_login(
  p_facility  TEXT,
  p_empno     TEXT,
  p_pw_hash   TEXT,
  p_pw_plain  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user RECORD;
BEGIN
  -- 해시 비밀번호로 먼저 시도
  SELECT id, 시설명, 사원번호, role, parent_facility
    INTO v_user
    FROM users
   WHERE 시설명   = p_facility
     AND 사원번호 = p_empno
     AND 패스워드 = p_pw_hash;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'id',              v_user.id,
      '시설명',          v_user.시설명,
      '사원번호',        v_user.사원번호,
      'role',            v_user.role,
      'parent_facility', v_user.parent_facility
    );
  END IF;

  -- 레거시 평문 비밀번호 시도 → 성공 시 해시로 자동 마이그레이션
  IF p_pw_plain IS NOT NULL THEN
    SELECT id, 시설명, 사원번호, role, parent_facility
      INTO v_user
      FROM users
     WHERE 시설명   = p_facility
       AND 사원번호 = p_empno
       AND 패스워드 = p_pw_plain
       AND LENGTH(패스워드) < 64;

    IF FOUND THEN
      UPDATE users SET 패스워드 = p_pw_hash WHERE id = v_user.id;
      RETURN jsonb_build_object(
        'id',              v_user.id,
        '시설명',          v_user.시설명,
        '사원번호',        v_user.사원번호,
        'role',            v_user.role,
        'parent_facility', v_user.parent_facility
      );
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

-- anon 역할에 함수 실행 권한 부여
GRANT EXECUTE ON FUNCTION verify_login TO anon;
