-- Phase 7: AI-generated per-stock summaries (lazy, cached).
-- One row per ticker, written by the summarize-stock edge function (service role)
-- and read publicly. Regenerated when older than the function's TTL so the
-- "latest news" stays reasonably fresh without paying per view.
create table if not exists public.stock_summaries (
  ticker        text primary key references public.watchlist(ticker) on delete cascade,
  overview      text,        -- what the company does
  markets       text,        -- markets / competition it operates in
  signal        text,        -- BUY | WATCH | AVOID | SELL at generation time
  rationale     text,        -- why the signal, tied to the actual scores
  news_summary  text,        -- synthesis of recent headlines
  news          jsonb,       -- the source headlines used (audit / display)
  model         text,        -- model id that wrote it
  generated_at  timestamptz default now()
);

alter table public.stock_summaries enable row level security;

-- Public read; only the service role (edge function) writes.
drop policy if exists stock_summaries_read on public.stock_summaries;
create policy stock_summaries_read on public.stock_summaries
  for select to anon, authenticated using (true);

grant select on public.stock_summaries to anon, authenticated;
