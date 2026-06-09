-- NEWNFL core schema — three-axis scoring (Quality x Value x Regime).
-- Public-read on score tables; writes happen via the service role from edge
-- functions. Mirrors the remote project for version control.

create table if not exists public.watchlist (
  ticker text primary key, name text, sector text, industry text,
  added_at timestamptz not null default now(), last_refreshed timestamptz
);

create table if not exists public.api_cache (
  id uuid primary key default gen_random_uuid(),
  ticker text, endpoint text not null, data jsonb not null,
  fetched_at timestamptz not null default now(), ttl_seconds int not null default 86400,
  unique (ticker, endpoint)
);

create table if not exists public.quality_scores (
  ticker text primary key references public.watchlist(ticker) on delete cascade,
  composite_score numeric, piotroski_score int, piotroski_sub jsonb,
  altman_z numeric, altman_zone text, roic_current numeric, roic_10yr_avg numeric,
  roic_trend numeric, earnings_quality numeric, accrual_ratio numeric, revenue_cv numeric,
  management_score numeric, moat_score numeric, confidence text,
  component_detail jsonb, history_10yr jsonb, computed_at timestamptz not null default now()
);

create table if not exists public.value_scores (
  ticker text primary key references public.watchlist(ticker) on delete cascade,
  composite_score numeric, earnings_yield numeric, treasury_10y numeric, ey_vs_bond_spread numeric,
  fcf_yield numeric, fcf_yield_pctl numeric, pe_ratio numeric, pe_vs_sector_median numeric,
  graham_number numeric, price numeric, margin_of_safety numeric, ev_ebitda numeric,
  ev_ebitda_vs_peers numeric, dcf_intrinsic numeric, dividend_yield numeric, div_yield_vs_history numeric,
  component_detail jsonb, history_10yr jsonb, computed_at timestamptz not null default now()
);

create table if not exists public.regime (
  id int primary key default 1, composite_score numeric, cycle_phase text,
  recession_probability numeric, indicators jsonb, history jsonb,
  computed_at timestamptz not null default now(), constraint regime_singleton check (id = 1)
);

create table if not exists public.universe_stats (
  id int primary key default 1, quality_median numeric, value_median numeric,
  quality_p25 numeric, quality_p75 numeric, value_p25 numeric, value_p75 numeric,
  stock_count int, computed_at timestamptz not null default now(),
  constraint universe_stats_singleton check (id = 1)
);

create table if not exists public.factor_spreads (
  factor_name text primary key, spread_percentile numeric, is_widening boolean,
  expected_premium text, detail text, computed_at timestamptz not null default now()
);

create table if not exists public.api_usage (
  provider text not null, usage_date date not null default (now() at time zone 'utc')::date,
  call_count int not null default 0, primary key (provider, usage_date)
);

do $$
declare t text;
begin
  foreach t in array array[
    'watchlist','api_cache','quality_scores','value_scores',
    'regime','universe_stats','factor_spreads','api_usage'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists public_read on public.%I;', t);
    execute format('create policy public_read on public.%I for select using (true);', t);
  end loop;
end $$;
