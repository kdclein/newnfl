-- Index membership (many-to-many) powering the front-page index toggles, plus
-- SEC CIK + cached market cap on the watchlist for EDGAR lookups / Altman Z.
-- Seeded by the refresh-universe edge function (S&P 500 live + DJIA static).
create table if not exists public.index_membership (
  ticker      text not null,
  index_name  text not null,   -- 'sp500' | 'djia' | 'nasdaq100'
  added_at    timestamptz not null default now(),
  primary key (ticker, index_name)
);
create index if not exists index_membership_index_idx on public.index_membership (index_name);

alter table public.index_membership enable row level security;
drop policy if exists public_read on public.index_membership;
create policy public_read on public.index_membership for select using (true);

alter table public.watchlist add column if not exists cik text;
alter table public.watchlist add column if not exists market_cap numeric;
