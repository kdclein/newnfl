-- Phase 8: full macro dashboard (22+ indicators in 4 categories) + price history
-- accumulation for market-breadth indicators.

-- One row per indicator, written daily by the refresh-macro edge function.
create table if not exists public.macro_indicators (
  id          text primary key,     -- e.g. 'cape', 'vix', 'hy_oas'
  category    text not null,        -- valuation | sentiment | credit | labor
  label       text not null,
  value       numeric,              -- raw numeric value (null = unavailable)
  display     text,                 -- preformatted value, e.g. '34.8' or '192%'
  norm        text,                 -- historical norm, e.g. 'median 16.0 since 1881'
  percentile  numeric,              -- current value's percentile vs its history
  score       numeric,              -- 0-100 favorability for deploying capital
  signal      text,                 -- favorable | neutral | caution | warning | na
  explanation text,                 -- the analytical note shown in the UI
  history     jsonb,                -- small oldest-first array for sparklines
  sort_order  int,
  updated_at  timestamptz default now()
);

alter table public.macro_indicators enable row level security;
drop policy if exists macro_indicators_read on public.macro_indicators;
create policy macro_indicators_read on public.macro_indicators
  for select to anon, authenticated using (true);
grant select on public.macro_indicators to anon, authenticated;

-- Daily close snapshots (from our own quote data) so %-above-200/100-DMA
-- breadth can be computed once enough history accumulates. No free historical
-- backfill source is edge-reachable (Stooq blocked, Finnhub candles premium).
create table if not exists public.price_history (
  ticker text not null references public.watchlist(ticker) on delete cascade,
  d      date not null,
  price  numeric not null,
  primary key (ticker, d)
);
alter table public.price_history enable row level security;
-- service-role writes only; no public read needed (aggregates served via macro_indicators)

-- Breadth helper: % of stocks whose latest price is above their n-day moving
-- average, counting only tickers with >= 90% of the window populated.
create or replace function public.market_breadth(n int)
returns jsonb language sql stable security definer set search_path = public as $$
  with days as (select count(distinct d) as have from price_history),
  ma as (
    select ph.ticker, avg(ph.price) as avg_px, count(*) as cnt
    from price_history ph
    where ph.d > (select max(d) from price_history) - (n * 7 / 5 + 10)  -- calendar window ≈ n trading days
    group by ph.ticker
    having count(*) >= n * 9 / 10
  ),
  cmp as (
    select m.ticker, (v.price > m.avg_px) as above
    from ma m join value_scores v using (ticker)
    where v.price is not null
  )
  select jsonb_build_object(
    'days_available', (select have from days),
    'tickers', (select count(*) from cmp),
    'pct_above', (select round(100.0 * count(*) filter (where above) / nullif(count(*),0), 1) from cmp)
  );
$$;
revoke all on function public.market_breadth(int) from public, anon, authenticated;
grant execute on function public.market_breadth(int) to service_role, postgres;

-- Daily snapshot (weekdays, 21:15 UTC ≈ just after US close): record each
-- stock's latest known price.
create or replace function public.snapshot_prices()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into price_history (ticker, d, price)
  select ticker, current_date, price from value_scores where price is not null
  on conflict (ticker, d) do update set price = excluded.price;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.snapshot_prices() from public, anon, authenticated;
grant execute on function public.snapshot_prices() to service_role, postgres;

-- Cron: daily price snapshot; macro refresh repointed from refresh-regime to
-- refresh-macro (applied to the live project with the proper bearer).
select cron.schedule('newnfl-price-snapshot', '15 21 * * 1-5', $$select public.snapshot_prices()$$);
-- select cron.unschedule('newnfl-refresh-regime');
-- select cron.schedule('newnfl-refresh-macro', '35 9 * * *', $$select net.http_post(...refresh-macro...)$$);
