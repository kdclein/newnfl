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
- ✅ Edge functions are **written and ready to deploy** — they need the three provider keys set as secrets first.
- ⏳ `pg_cron` daily refresh (Phase 5) is not scheduled yet.

## Secrets (set these before deploying functions)

API keys live ONLY in edge-function env — never in the client bundle
(BUILD_SPEC.md principle #1). Set them with the Supabase CLI:

```bash
supabase secrets set \
  FMP_API_KEY=xxxxx \
  FINNHUB_API_KEY=xxxxx \
  ALPHA_VANTAGE_API_KEY=xxxxx
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

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
