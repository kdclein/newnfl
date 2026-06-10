-- Phase 6: cross-sectional (relative-value) pass.
-- The per-stock value scorer (computeValueScore) deliberately defers three
-- metrics that can only be known once the *whole universe* is scored:
--   * sector-median P/E  -> pe_vs_sector_median (+ component score, which the
--     per-stock pass leaves neutral at 50 when no sector median is available)
--   * FCF-yield percentile -> fcf_yield_pctl
--   * EV/EBITDA peer percentile -> ev_ebitda_vs_peers
-- This function computes them across value_scores, patches each component_detail
-- JSONB, recomputes the P/E component score and the value composite (equal
-- weights => mean of present component scores, matching scoring.ts), and writes
-- everything back. Pure SQL, no external calls; cheap enough to run after every
-- stock refresh.
create or replace function public.recompute_cross_sectional()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare changed int;
begin
  with v as (
    select s.ticker, s.pe_ratio, s.fcf_yield, s.ev_ebitda, s.component_detail, w.sector
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
      -- P/E component score = linMap(premium, 0.30, -0.30, 10, 90), clamped [10,90],
      -- where premium = (pe - sectorMedianPE)/sectorMedianPE. Discount => high score.
      case
        when v.pe_ratio is null then null
        when sec.sec_med_pe is null or sec.sec_med_pe <= 0 then 50::numeric
        else greatest(10, least(90,
          10 + ((((v.pe_ratio - sec.sec_med_pe) / sec.sec_med_pe) - 0.30) / (-0.60)) * 80))
      end as pe_score
    from v
    left join sec on sec.sector = v.sector
    left join fcf on fcf.ticker = v.ticker
    left join ev  on ev.ticker  = v.ticker
  ),
  patched as (
    select c.ticker, c.sec_med_pe, c.fcf_pctl, c.ev_pctl,
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(c.component_detail,
              '{pe_vs_sector,raw,sector_median_pe}', coalesce(to_jsonb(round(c.sec_med_pe::numeric, 4)), 'null'::jsonb)),
            '{pe_vs_sector,score}', coalesce(to_jsonb(round(c.pe_score::numeric, 4)), 'null'::jsonb)),
          '{fcf_yield,raw,percentile}', coalesce(to_jsonb(round(c.fcf_pctl::numeric, 4)), 'null'::jsonb)),
        '{ev_ebitda,raw,peer_percentile}', coalesce(to_jsonb(round(c.ev_pctl::numeric, 4)), 'null'::jsonb)
      ) as cd
    from calc c
  ),
  final as (
    select p.ticker, p.sec_med_pe, p.fcf_pctl, p.ev_pctl, p.cd,
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
      composite_score     = round(f.new_composite::numeric, 4)
  from final f
  where s.ticker = f.ticker;

  get diagnostics changed = row_count;
  return changed;
end $$;

revoke all on function public.recompute_cross_sectional() from public, anon, authenticated;
grant execute on function public.recompute_cross_sectional() to service_role, postgres;

-- Keep relative-value metrics fresh: every-minute refreshes re-null a stock's
-- cross-sectional fields, so recompute the whole universe each minute (cheap,
-- pure SQL). Decoupled from refresh-stock so it survives without a redeploy.
select cron.schedule('newnfl-cross-sectional', '* * * * *',
  $$select public.recompute_cross_sectional()$$);
