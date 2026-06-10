-- Phase 6b: fold earnings-yield-vs-bond into the cross-sectional pass.
-- The earnings-yield component compares each stock's earnings yield to the SAME
-- 10Y Treasury, so it is really a universe-relative metric. Computing it here
-- (from the stored earnings_yield column + the cached Treasury) fills all ~470
-- stocks instantly and keeps it correct every minute, instead of depending on
-- when each stock last hit refresh-stock. Treasury comes from the macro cache
-- row written by refresh-regime (FRED DGS10, quoted in percent).
create or replace function public.recompute_cross_sectional()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  changed int;
  t10 numeric;  -- 10Y Treasury as a decimal, e.g. 0.0456
begin
  select (data -> 'data' -> 0 ->> 'value')::numeric / 100
    into t10
    from api_cache where endpoint = 'av:treasury_10y' limit 1;

  with v as (
    select s.ticker, s.pe_ratio, s.fcf_yield, s.ev_ebitda, s.earnings_yield,
           s.component_detail, w.sector
    from value_scores s
    join watchlist w using (ticker)
    where s.component_detail is not null
  ),
  sec as (
    select sector, percentile_cont(0.5) within group (order by pe_ratio) as sec_med_pe
    from v
    where pe_ratio > 0 and sector is not null
    group by sector
  ),
  fcf as (  -- higher FCF yield => higher percentile (cheaper / better)
    select ticker, percent_rank() over (order by fcf_yield) as pctl
    from v where fcf_yield is not null
  ),
  ev as (   -- lower EV/EBITDA => higher percentile (cheaper / better)
    select ticker, 1 - percent_rank() over (order by ev_ebitda) as pctl
    from v where ev_ebitda is not null and ev_ebitda > 0
  ),
  calc as (
    select v.ticker, v.component_detail,
      sec.sec_med_pe,
      fcf.pctl as fcf_pctl,
      ev.pctl  as ev_pctl,
      -- P/E component score = linMap(premium, 0.30, -0.30, 10, 90), clamped [10,90].
      case
        when v.pe_ratio is null then null
        when sec.sec_med_pe is null or sec.sec_med_pe <= 0 then 50::numeric
        else greatest(10, least(90,
          10 + ((((v.pe_ratio - sec.sec_med_pe) / sec.sec_med_pe) - 0.30) / (-0.60)) * 80))
      end as pe_score,
      -- earnings-yield-vs-bond spread + piecewise score (matches scoring.ts).
      case when v.earnings_yield is not null and t10 is not null
           then v.earnings_yield - t10 end as ey_spread
    from v
    left join sec on sec.sector = v.sector
    left join fcf on fcf.ticker = v.ticker
    left join ev  on ev.ticker  = v.ticker
  ),
  scored as (
    select c.*,
      case
        when c.ey_spread is null then null
        when c.ey_spread > 0.03 then least(100, greatest(90, 90 + (c.ey_spread - 0.03) / 0.05 * 10))
        when c.ey_spread > 0.01 then least(90,  greatest(60, 60 + (c.ey_spread - 0.01) / 0.02 * 30))
        when c.ey_spread > 0     then least(60,  greatest(30, 30 + c.ey_spread / 0.01 * 30))
        else least(30, greatest(0, (c.ey_spread + 0.04) / 0.04 * 30))
      end as ey_score
    from calc c
  ),
  patched as (
    select c.ticker, c.sec_med_pe, c.fcf_pctl, c.ev_pctl, c.ey_spread,
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(c.component_detail,
                    '{pe_vs_sector,raw,sector_median_pe}', coalesce(to_jsonb(round(c.sec_med_pe::numeric, 4)), 'null'::jsonb)),
                  '{pe_vs_sector,score}', coalesce(to_jsonb(round(c.pe_score::numeric, 4)), 'null'::jsonb)),
                '{fcf_yield,raw,percentile}', coalesce(to_jsonb(round(c.fcf_pctl::numeric, 4)), 'null'::jsonb)),
              '{ev_ebitda,raw,peer_percentile}', coalesce(to_jsonb(round(c.ev_pctl::numeric, 4)), 'null'::jsonb)),
            '{earnings_yield,score}', coalesce(to_jsonb(round(c.ey_score::numeric, 4)), 'null'::jsonb)),
          '{earnings_yield,raw,treasury_10y}', coalesce(to_jsonb(round(t10::numeric, 6)), 'null'::jsonb)),
        '{earnings_yield,raw,spread}', coalesce(to_jsonb(round(c.ey_spread::numeric, 6)), 'null'::jsonb)
      ) as cd
    from scored c
  ),
  final as (
    select p.ticker, p.sec_med_pe, p.fcf_pctl, p.ev_pctl, p.ey_spread, p.cd,
      (
        select avg((p.cd -> k ->> 'score')::numeric)
        from unnest(array['earnings_yield','fcf_yield','pe_vs_sector','graham',
                          'ev_ebitda','dcf','dividend']) as k
        where (p.cd -> k ->> 'score') is not null
      ) as new_composite
    from patched p
  )
  update value_scores s
  set component_detail   = f.cd,
      pe_vs_sector_median = round(f.sec_med_pe::numeric, 4),
      fcf_yield_pctl      = round(f.fcf_pctl::numeric, 4),
      ev_ebitda_vs_peers  = round(f.ev_pctl::numeric, 4),
      treasury_10y        = round(t10::numeric, 6),
      ey_vs_bond_spread   = round(f.ey_spread::numeric, 6),
      composite_score     = round(f.new_composite::numeric, 4)
  from final f
  where s.ticker = f.ticker;

  get diagnostics changed = row_count;
  return changed;
end $$;

revoke all on function public.recompute_cross_sectional() from public, anon, authenticated;
grant execute on function public.recompute_cross_sectional() to service_role, postgres;
