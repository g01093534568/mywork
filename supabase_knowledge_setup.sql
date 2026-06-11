-- ============================================================
-- 📚 AI 지식자료 (전체 공용) 테이블 + RLS
-- 관리자 페이지에서 업로드 → 모든 사용자가 AI 어시스턴트로 활용
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- ============================================================

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  src_type     TEXT DEFAULT 'file',   -- file | pdf | url | text
  content      TEXT NOT NULL,
  uploaded_by  TEXT,                  -- 업로드한 관리자 사원번호 (감사용)
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge_sources (created_at);

-- RLS 활성화 + anon 전체 허용 (앱의 기존 정책과 동일)
ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON knowledge_sources FOR ALL TO anon USING (true) WITH CHECK (true);
