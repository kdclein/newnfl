-- Phase 5 automation: pg_cron backfills + maintains the universe.
-- enqueue_stale_refreshes fires score refreshes for the N stalest tickers via
-- pg_net, paced under Finnhub's 60 req/min (~4 calls/stock x 10 = 40/min). The
-- every-minute job backfills all ~503 names in ~50 min, then keeps them fresh.
create extension if not exists pg_cron;

create or replace function public.enqueue_stale_refreshes(n int default 10)
returns int language plpgsql security definer set search_path = public, net as $$
declare r record; cnt int := 0;
begin
  for r in
    select ticker from public.watchlist order by last_refreshed asc nulls first limit n
  loop
    perform net.http_post(
      url := 'https://vhnbugglrpxwuzjfuzph.supabase.co/functions/v1/refresh-stock/' || r.ticker,
      headers := jsonb_build_object('Content-Type','application/json',
        'Authorization','Bearer ' || '<ANON_KEY>'),
      body := '{}'::jsonb, timeout_milliseconds := 60000);
    update public.watchlist set last_refreshed = now() where ticker = r.ticker;
    cnt := cnt + 1;
  end loop;
  return cnt;
end $$;

revoke all on function public.enqueue_stale_refreshes(int) from public, anon, authenticated;
grant execute on function public.enqueue_stale_refreshes(int) to service_role, postgres;

-- select cron.schedule('newnfl-refresh-stocks', '* * * * *', $$select public.enqueue_stale_refreshes(10)$$);
-- select cron.schedule('newnfl-refresh-regime', '35 9 * * *', $$select net.http_post(...refresh-regime...)$$);
-- (the anon bearer is injected at deploy time; schedules are applied to the live project)
