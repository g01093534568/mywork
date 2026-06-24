-- 펀드(funds) 테이블 — 보유 펀드 현황 카드용
-- Supabase SQL Editor에서 1회 실행하세요.

create table if not exists public.funds (
  id          text primary key,
  사원번호     text not null,
  name        text not null,           -- 펀드명
  fund_type   text default '',         -- 펀드유형 (예: 주식형, 채권형, ELS 등)
  principal   numeric default 0,       -- 투자원금 (원)
  valuation   numeric default 0,       -- 평가금액 (원)
  start_date  date,                    -- 가입일
  memo        text default '',
  created_at  timestamptz default now()
);

create index if not exists funds_사원번호_idx on public.funds (사원번호);

-- 실시간 구독 활성화 (기존 stocks/trades와 동일)
alter publication supabase_realtime add table public.funds;
