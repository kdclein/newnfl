-- Service-role-only helper functions: daily rate-limit quota + adaptive
-- universe boundaries. EXECUTE is revoked from anon/authenticated so these
-- never appear on the public API surface.

create or replace function public.consume_api_quota(p_provider text, p_daily_limit int)
returns boolean language plpgsql security definer set search_path = public as $$
declare current_count int;
begin
  insert into public.api_usage (provider, call_count) values (p_provider, 1)
  on conflict (provider, usage_date)
    do update set call_count = public.api_usage.call_count + 1
  returning call_count into current_count;

  if current_count > p_daily_limit then
    update public.api_usage set call_count = call_count - 1
      where provider = p_provider and usage_date = (now() at time zone 'utc')::date;
    return false;
  end if;
  return true;
end $$;

create or replace function public.recompute_universe_stats()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.universe_stats (
    id, quality_median, value_median, quality_p25, quality_p75,
    value_p25, value_p75, stock_count, computed_at)
  select 1,
    percentile_cont(0.5)  within group (order by q.composite_score),
    percentile_cont(0.5)  within group (order by v.composite_score),
    percentile_cont(0.25) within group (order by q.composite_score),
    percentile_cont(0.75) within group (order by q.composite_score),
    percentile_cont(0.25) within group (order by v.composite_score),
    percentile_cont(0.75) within group (order by v.composite_score),
    count(*), now()
  from public.quality_scores q
  join public.value_scores v on v.ticker = q.ticker
  where q.ticker in (select ticker from public.watchlist)
  on conflict (id) do update set
    quality_median = excluded.quality_median, value_median = excluded.value_median,
    quality_p25 = excluded.quality_p25, quality_p75 = excluded.quality_p75,
    value_p25 = excluded.value_p25, value_p75 = excluded.value_p75,
    stock_count = excluded.stock_count, computed_at = excluded.computed_at;
end $$;

revoke all on function public.consume_api_quota(text, int)   from public, anon, authenticated;
revoke all on function public.recompute_universe_stats()     from public, anon, authenticated;
grant execute on function public.consume_api_quota(text, int) to service_role;
grant execute on function public.recompute_universe_stats()   to service_role;
