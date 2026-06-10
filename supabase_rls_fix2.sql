-- ============================================================
-- 패스워드 컬럼 차단 보완 (supabase_rls_setup.sql 실행 후 추가 실행)
-- ============================================================
-- REVOKE on column 단독으로는 테이블 레벨 SELECT 권한을 무시함
-- 해결: 테이블 레벨 SELECT 제거 → 안전한 컬럼만 개별 GRANT

REVOKE SELECT ON users FROM anon;

GRANT SELECT (id, 시설명, 사원번호, role, created_at, parent_facility) ON users TO anon;
