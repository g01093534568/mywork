-- ============================================================
-- 🧠 노트북 (NotebookLM 스타일) 테이블 생성 + RLS
-- Supabase 대시보드 > SQL Editor 에서 전체 실행
-- ============================================================

-- ① 노트북 (사용자별 자료 모음)
CREATE TABLE IF NOT EXISTS notebooks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  사원번호    TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notebooks_user ON notebooks (사원번호);

-- ② 노트북 소스 (업로드한 자료 본문)
CREATE TABLE IF NOT EXISTS notebook_sources (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  사원번호     TEXT NOT NULL,
  notebook_id  UUID NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  src_type     TEXT DEFAULT 'text',   -- text | file | pdf | url
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nbsrc_notebook ON notebook_sources (notebook_id);

-- ③ RLS 활성화 + anon 전체 허용 (앱의 기존 정책과 동일)
ALTER TABLE notebooks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notebook_sources  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all" ON notebooks        FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON notebook_sources FOR ALL TO anon USING (true) WITH CHECK (true);
