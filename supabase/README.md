# NEWNFL — Supabase backend

Postgres schema + edge functions for the three-axis scoring engine
(Quality × Value × Regime). The frontend reads only from Supabase tables; the
edge functions are the only thing that talks to external data providers.

Project: `newnfl` (`vhnbugglrpxwuzjfuzph`, region `us-east-2`).

## Layout

```
supabase/
├── migrations/   # schema + RLS + helper functions (already applied to remote)
└── functions/
    ├── _shared/  # math, cache/rate-limit, scoring engine, regime engine
    ├── refresh-stock/   # GET /refresh-stock/:ticker  -> quality + value scores
    └── refresh-regime/  # GET /refresh-regime          -> macro regime row
```

## Status

- ✅ Schema, RLS, helper functions, and the 15-ticker watchlist are **applied to the remote project**.
- ✅ Both edge functions are **deployed and verified live** against the real providers.
- ✅ `refresh-stock/AAPL` produces a full decomposable Quality score (HIGH confidence,
  all 7 components) and a 6/7 Value score. The 7th Value component (earnings yield
  vs 10Y bond) fills in once `refresh-regime` has run.
- ⏳ `refresh-regime` is deployed but Alpha Vantage's 25/day free cap was exhausted
  during testing — it populates on the next quota reset / scheduled run.
- ⏳ `pg_cron` daily refresh (Phase 5) is not scheduled yet.

## Secrets

API keys must never reach the client bundle (BUILD_SPEC.md principle #1). The
functions resolve each key via `getSecret()`, which checks **two** stores in order:

1. An Edge Function **env var** of that name (Supabase-recommended), set with:
   ```bash
   supabase secrets set FMP_API_KEY=xxxxx FINNHUB_API_KEY=xxxxx ALPHA_VANTAGE_API_KEY=xxxxx
   ```
2. A **Supabase Vault** secret of that name (where the keys currently live), read
   server-side via the `get_vault_secret` RPC (service-role only).

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## Free-tier provider realities (discovered during integration)

The BUILD_SPEC was written against provider APIs that have since changed:

- **FMP** retired the `/api/v3/` endpoints (Aug 31 2025). The functions use the
  new **`/stable/`** API (`?symbol=TICKER`). Field names moved too: ROIC is
  `returnOnInvestedCapital`, EV/EBITDA is `evToEBITDA`, and P/E, dividend yield,
  book value and net-income-per-share now come from `/stable/ratios`.
- **FMP free tier caps history at `limit<=5`** (5 annual periods, not 10; `limit=10`
  returns 402 Premium). Trends/CV are computed over 5 years.
- FMP free also throttles parallel bursts, so its 8 endpoints are fetched
  **sequentially with light pacing**.
- **Alpha Vantage free** is 25 requests/day AND ~1 request/second. `refresh-regime`
  paces its 7 calls ~1.6s apart; the cache layer never stores throttle notices.

## Deploy the functions

```bash
supabase functions deploy refresh-stock
supabase functions deploy refresh-regime
```

Then smoke-test:

```bash
# Refresh macro regime first (populates the 10Y treasury used by Value scoring)
curl -s "$SUPABASE_URL/functions/v1/refresh-regime" -H "Authorization: Bearer $ANON_KEY"

# Then score a ticker
curl -s "$SUPABASE_URL/functions/v1/refresh-stock/AAPL" -H "Authorization: Bearer $ANON_KEY"
```

## Rate-limit budgets

The cache layer (`_shared/cache.ts`) checks `consume_api_quota()` before every
live fetch and serves stale cache when a budget is exhausted — it never fails
silently (principle #3).

| Provider       | Daily budget | Notes                                   |
|----------------|--------------|-----------------------------------------|
| FMP            | 250          | ~10 calls per full stock refresh        |
| Alpha Vantage  | 25           | regime uses ~7; rest for technicals     |
| Finnhub        | high         | 60/min; quotes, insiders, ESG, news     |

## Security note — function auth

`refresh-*` are currently expected to be invoked with the anon key (so the
frontend "Refresh" button and `pg_cron` can call them). The per-provider daily
quota is the primary guard against budget abuse. If you'd rather require a
signed-in user, set `verify_jwt = true` for these functions and call them with
the user session.

## Next (Phase 5)

- Schedule `pg_cron` to call `refresh-stock` for each watchlist ticker daily at
  4:30 PM ET, and `refresh-regime` once daily.
- Add `factor_spreads` population (currently an empty reference table).
