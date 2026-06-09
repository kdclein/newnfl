# SIGNAL FORGE — Build Specification

## What This Is

Signal Forge is a three-axis investment analysis platform that separates **Business Quality** (price-independent) from **Valuation** (price-dependent) from **Market Regime** (macro environment) to identify investment opportunities. It plots stocks on a Quality × Value scatter quadrant, overlays macro regime context, and lets users drill into every metric with historical trends.

This spec is the complete blueprint. Build it phase by phase.

-----

## Accounts to Create (do these first)

### Data Provider APIs (all free, no credit card)

1. **Financial Modeling Prep (FMP)** — PRIMARY data source
- Sign up: <https://site.financialmodelingprep.com/developer/docs>
- Enter email, verify, get API key from dashboard
- Free tier: 250 requests/day, 500MB bandwidth/30 days
- Provides: 30yr financial statements, key metrics, ratios, Piotroski Score, Altman Z-Score, DCF, screener, analyst estimates, insider trades, ESG, executive data, sector performance
- Auth: append `?apikey=YOUR_KEY` to every request
1. **Finnhub** — Real-time + alternative data
- Sign up: <https://finnhub.io/register>
- Free tier: 60 requests/minute
- Provides: Real-time quotes, WebSocket streaming, ESG scores, news + sentiment, insider transactions, earnings quality, social sentiment, company news
- Auth: append `&token=YOUR_KEY` to requests
1. **Alpha Vantage** — Technical indicators + economic data
- Sign up: <https://www.alphavantage.co/support/#api-key>
- Free tier: 25 requests/day
- Provides: 50+ technical indicators (RSI, MACD, Bollinger, SMA, EMA, ADX, OBV, ATR), 20yr+ daily OHLCV, economic indicators (GDP, unemployment, CPI, Treasury yields, Fed funds rate)
- Auth: append `&apikey=YOUR_KEY` to requests

### Infrastructure (already has accounts)

1. **GitHub** — Source control. Create repo `signal-forge`.
1. **Supabase** — Postgres database + edge functions for caching/scheduling.
1. **Netlify** — Static site hosting with CI/CD from GitHub.

### Environment Variables

Store all keys as env vars, never in code:

```
FMP_API_KEY=
FINNHUB_API_KEY=
ALPHA_VANTAGE_API_KEY=
SUPABASE_URL=
SUPABASE_ANON_KEY=
```

-----

## Tech Stack

|Layer     |Technology                       |Why                                                    |
|----------|---------------------------------|-------------------------------------------------------|
|Frontend  |React + Vite                     |Fast builds, artifact-compatible                       |
|Styling   |Tailwind CSS                     |Utility classes, dark theme                            |
|Charts    |Recharts                         |React-native charting, lightweight                     |
|Database  |Supabase (Postgres)              |Free tier, row-level security, edge functions          |
|Caching   |Supabase tables                  |Cache API responses with TTL to stay within rate limits|
|Scheduling|Supabase edge functions + pg_cron|Daily data refresh within API budgets                  |
|Hosting   |Netlify                          |Free tier, auto-deploy from GitHub                     |
|Fonts     |IBM Plex Mono + DM Sans          |From Google Fonts CDN                                  |

-----

## Architecture

```
┌─────────────────────────────────────────────┐
│  NETLIFY (static React app)                 │
│  └── React SPA with client-side routing     │
├─────────────────────────────────────────────┤
│  SUPABASE                                   │
│  ├── Postgres tables (cached data + scores) │
│  ├── Edge functions (API orchestrator)      │
│  │   ├── /api/refresh-stock/:ticker         │
│  │   ├── /api/refresh-regime                │
│  │   └── /api/score/:ticker                 │
│  └── pg_cron (daily batch refresh)          │
├─────────────────────────────────────────────┤
│  EXTERNAL APIs                              │
│  ├── FMP (fundamentals, scores, screener)   │
│  ├── Finnhub (real-time, ESG, news)         │
│  └── Alpha Vantage (technicals, econ data)  │
└─────────────────────────────────────────────┘
```

### Data Flow

1. **Supabase edge function** calls external APIs, computes scores, writes to Postgres
1. **React frontend** reads from Supabase (fast, no rate limit concerns)
1. **pg_cron job** refreshes watchlist stocks daily at market close (4:30 PM ET)
1. **User-triggered refresh** calls edge function on-demand for single ticker

### Rate Limit Budget (daily)

|Provider              |Budget                       |Allocation                                      |
|----------------------|-----------------------------|------------------------------------------------|
|FMP (250/day)         |~10 calls per stock deep-dive|25 full analyses/day, rest for screener/macro   |
|Finnhub (60/min)      |Effectively unlimited        |Real-time quotes, news, ESG, insider data       |
|Alpha Vantage (25/day)|~3 calls per stock           |Technical indicators for top 8 watchlist tickers|

### Caching TTL Strategy

|Data Type                |TTL     |Rationale                                       |
|-------------------------|--------|------------------------------------------------|
|Real-time quotes         |1 minute|Finnhub is generous, keep fresh                 |
|Financial statements     |24 hours|Only change quarterly                           |
|Key metrics / ratios     |24 hours|Derived from statements                         |
|Piotroski / Altman scores|24 hours|FMP computes server-side                        |
|Technical indicators     |4 hours |Intraday recalc not critical for daily framework|
|Economic indicators      |24 hours|GDP, unemployment, etc. update monthly/quarterly|
|ESG scores               |7 days  |Change slowly                                   |
|News / sentiment         |1 hour  |Freshness matters for sentiment                 |
|Insider transactions     |24 hours|Filed with delay anyway                         |

-----

## Database Schema (Supabase Postgres)

```sql
-- Watchlist of tickers the user tracks
CREATE TABLE watchlist (
  ticker TEXT PRIMARY KEY,
  name TEXT,
  sector TEXT,
  industry TEXT,
  added_at TIMESTAMPTZ DEFAULT now(),
  last_refreshed TIMESTAMPTZ
);

-- Cached raw API responses
CREATE TABLE api_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ticker TEXT,
  endpoint TEXT NOT NULL,        -- e.g. 'fmp:income-statement', 'av:rsi'
  data JSONB NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  ttl_seconds INT DEFAULT 86400,
  UNIQUE(ticker, endpoint)
);

-- Computed quality scores (price-independent axis)
CREATE TABLE quality_scores (
  ticker TEXT PRIMARY KEY REFERENCES watchlist(ticker),
  composite_score NUMERIC,       -- 0-100
  piotroski_score INT,           -- 0-9 (from FMP)
  piotroski_sub JSONB,           -- {roa: true, ocf: true, ...} 9 criteria
  altman_z NUMERIC,              -- raw Z-Score (from FMP)
  altman_zone TEXT,              -- 'safe', 'grey', 'distress'
  roic_current NUMERIC,
  roic_10yr_avg NUMERIC,
  roic_trend NUMERIC,            -- slope of 10yr regression
  earnings_quality NUMERIC,      -- OCF/NI ratio
  accrual_ratio NUMERIC,
  revenue_cv NUMERIC,            -- coefficient of variation (10yr)
  management_score NUMERIC,      -- 0-100 composite
  moat_score NUMERIC,            -- 0-100 competitive position
  confidence TEXT,               -- 'high', 'medium', 'low'
  component_detail JSONB,        -- full breakdown with weights
  history_10yr JSONB,            -- {year: {piotroski, altman, roic, ...}}
  computed_at TIMESTAMPTZ DEFAULT now()
);

-- Computed value scores (price-dependent axis)
CREATE TABLE value_scores (
  ticker TEXT PRIMARY KEY REFERENCES watchlist(ticker),
  composite_score NUMERIC,       -- 0-100
  earnings_yield NUMERIC,
  treasury_10y NUMERIC,
  ey_vs_bond_spread NUMERIC,
  fcf_yield NUMERIC,
  fcf_yield_pctl NUMERIC,        -- percentile in universe
  pe_ratio NUMERIC,
  pe_vs_sector_median NUMERIC,
  graham_number NUMERIC,
  price NUMERIC,
  margin_of_safety NUMERIC,      -- (intrinsic - price) / intrinsic
  ev_ebitda NUMERIC,
  ev_ebitda_vs_peers NUMERIC,
  dcf_intrinsic NUMERIC,
  dividend_yield NUMERIC,
  div_yield_vs_history NUMERIC,
  component_detail JSONB,
  history_10yr JSONB,
  computed_at TIMESTAMPTZ DEFAULT now()
);

-- Market regime indicators (global, not per-stock)
CREATE TABLE regime (
  id INT DEFAULT 1 PRIMARY KEY,  -- singleton row
  composite_score NUMERIC,        -- 0-100
  cycle_phase TEXT,               -- 'early_expansion', 'mid_expansion', 'late_expansion', 'contraction'
  recession_probability NUMERIC,
  indicators JSONB,               -- full indicator detail
  history JSONB,                  -- 10yr history per indicator
  computed_at TIMESTAMPTZ DEFAULT now()
);

-- Precomputed universe rankings for adaptive boundaries
CREATE TABLE universe_stats (
  id INT DEFAULT 1 PRIMARY KEY,
  quality_median NUMERIC,
  value_median NUMERIC,
  quality_p25 NUMERIC,
  quality_p75 NUMERIC,
  value_p25 NUMERIC,
  value_p75 NUMERIC,
  stock_count INT,
  computed_at TIMESTAMPTZ DEFAULT now()
);

-- Factor valuation spreads
CREATE TABLE factor_spreads (
  factor_name TEXT PRIMARY KEY,  -- 'quality', 'value', 'momentum', 'low_vol'
  spread_percentile NUMERIC,
  is_widening BOOLEAN,
  expected_premium TEXT,
  detail TEXT,
  computed_at TIMESTAMPTZ DEFAULT now()
);
```

-----

## The Three-Axis Scoring Framework

### Axis 1: Quality Score (0-100) — Price-Independent

“Is this a great business regardless of what the market charges?”

|Component                |Weight (Equal)|Weight (IC)|Data Source  |Endpoint                                                                      |
|-------------------------|--------------|-----------|-------------|------------------------------------------------------------------------------|
|Piotroski F-Score        |14.3%         |18.2%      |FMP          |`/api/v3/score?symbol={ticker}`                                               |
|Altman Z-Score           |14.3%         |10.8%      |FMP          |`/api/v3/score?symbol={ticker}`                                               |
|ROIC Consistency (10yr)  |14.3%         |19.4%      |FMP          |`/api/v3/key-metrics/{ticker}?period=annual&limit=10`                         |
|Earnings Quality (OCF/NI)|14.3%         |15.6%      |FMP          |`/api/v3/cash-flow-statement/{ticker}` + `/api/v3/income-statement/{ticker}`  |
|Revenue Stability (CV)   |14.3%         |8.4%       |FMP          |`/api/v3/income-statement/{ticker}?period=annual&limit=10`                    |
|Management Quality       |14.3%         |11.2%      |FMP + Finnhub|`/api/v3/key-executives/{ticker}` + Finnhub `/stock/insider-transactions`     |
|Competitive Position     |14.3%         |16.4%      |FMP          |`/api/v3/financial-ratios/{ticker}?period=annual&limit=10` (margin durability)|

**Scoring rules for each component:**

- **Piotroski (0-9 → 0-100):** Score = (F-Score / 9) × 100. FMP returns this directly.
- **Altman Z (→ 0-100):** Z > 3.0 = 85+, 1.8-3.0 = 40-85 (linear), < 1.8 = 0-40 (linear). FMP returns raw Z.
- **ROIC Consistency:** Score based on (a) current ROIC vs estimated WACC spread, (b) % of years ROIC exceeded WACC over 10yr, (c) trend direction. Compute from FMP key-metrics.
- **Earnings Quality:** OCF/NI ratio > 1.2 = high quality. Score = min(100, ratio × 60). Compute from FMP statements.
- **Revenue Stability:** CV = σ/μ over 10yr revenue. CV < 0.10 = 95+, 0.10-0.20 = 70-95, 0.20-0.40 = 40-70, > 0.40 = below 40.
- **Management Quality:** Composite of insider net buy/sell ratio, executive tenure, goodwill/assets ratio. Most subjective — confidence = low.
- **Competitive Position:** 10yr gross margin trend (positive slope = moat holding), R&D/revenue ratio, asset turnover stability.

**Start with equal weights. Shift to IC-weights after backtesting with historical data.**

### Axis 2: Value Score (0-100) — Price-Dependent

“What am I paying per unit of quality?”

|Component                    |Weight (Equal)|Weight (IC)|Data Source|Endpoint                                                     |
|-----------------------------|--------------|-----------|-----------|-------------------------------------------------------------|
|Earnings Yield vs 10Y Bond   |14.3%         |20.1%      |FMP + AV   |FMP `/api/v3/key-metrics/{ticker}` + AV `TREASURY_YIELD`     |
|FCF Yield (Universe Pctl)    |14.3%         |18.8%      |FMP        |`/api/v3/key-metrics/{ticker}`                               |
|P/E vs Sector Median         |14.3%         |14.2%      |FMP        |`/api/v3/key-metrics/{ticker}` + `/api/v3/sector-performance`|
|Graham Number                |14.3%         |8.6%       |FMP        |Compute from EPS × BVPS: `√(22.5 × EPS × BVPS)`              |
|EV/EBITDA vs Peers           |14.3%         |16.4%      |FMP        |`/api/v3/enterprise-values/{ticker}` + screener              |
|DCF Intrinsic Value          |14.3%         |12.8%      |FMP        |`/api/v3/discounted-cash-flow/{ticker}`                      |
|Dividend Yield vs Own History|14.3%         |9.1%       |FMP        |`/api/v3/historical/dividends/{ticker}`                      |

**Scoring rules:**

- **EY vs Bond:** Spread = E/P minus 10Y yield. Spread > 3% = 90+, 1-3% = 60-90, 0-1% = 30-60, negative = 0-30.
- **FCF Yield Pctl:** Rank FCF yield across the watchlist universe. Top decile = 90+, bottom decile = 10.
- **P/E vs Sector:** Compute discount/premium to sector median. Discount > 30% = 90+, at parity = 50, premium > 30% = 10.
- **Graham Number:** margin_of_safety = (graham_number - price) / graham_number. Positive MOS = high score. *CAVEAT: breaks for low book value stocks. Reduce weight or cap contribution when BVPS < $5.*
- **EV/EBITDA:** Percentile rank vs peers from FMP screener.
- **DCF:** margin_of_safety = (dcf_value - price) / dcf_value. FMP provides DCF directly.
- **Div Yield vs History:** Current yield / 5yr avg yield. Ratio > 1.2 = attractive, < 0.8 = compressed.

### Axis 3: Regime Score (0-100) — Market-Wide

“Is now a favorable time to deploy capital?”

|Category           |Indicators                                                                        |Source                                                                     |
|-------------------|----------------------------------------------------------------------------------|---------------------------------------------------------------------------|
|Market Valuation   |Shiller CAPE (proxy from FMP), S&P Fwd P/E, Buffett Indicator, Equity Risk Premium|FMP + AV                                                                   |
|Credit & Monetary  |10Y-2Y spread, HY spread, Fed Funds, Fed balance sheet, Fed dot plot              |AV `TREASURY_YIELD`, FMP economic calendar                                 |
|Growth & Labor     |Real GDP, Unemployment, Nonfarm Payrolls, Core PCE, ISM PMI, LEI                  |AV economic endpoints: `REAL_GDP`, `UNEMPLOYMENT`, `NONFARM_PAYROLL`, `CPI`|
|Sentiment & Breadth|Fear/Greed (compute from VIX + breadth), VIX, % stocks > 200d MA, % > 100d MA     |Finnhub quote for VIX, FMP technical indicators for breadth                |

**Regime composite:** Equal-weight average across all indicators. Each indicator scored 0-100 based on its historical percentile (favorable conditions = high score, unfavorable = low).

**Cycle Phase Classification:**

- Early Expansion: PMI rising above 50, unemployment falling, yield curve steep, LEI turning positive
- Mid Expansion: PMI 52+, low unemployment, moderate spreads, steady growth
- Late Expansion: PMI peaking/declining, tight spreads, elevated CAPE, flattening curve
- Contraction: PMI < 50, rising unemployment, widening spreads, inverted curve

**Display this prominently but label with caveat:** “AQR research found very little support for macro-based factor timing. Regime describes the environment — it does not predict turns. Use to calibrate position sizing and margin-of-safety requirements.”

### Quadrant Classification

Boundaries are the **universe median** on each axis (adaptive):

```
quality_median = PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY quality_score)
                 FROM quality_scores WHERE ticker IN (SELECT ticker FROM watchlist)

value_median   = PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY value_score)
                 FROM value_scores WHERE ticker IN (SELECT ticker FROM watchlist)
```

|Quadrant       |Condition                |Signal                                 |
|---------------|-------------------------|---------------------------------------|
|Quality Bargain|Q ≥ median AND V ≥ median|**BUY** — above-median on both axes    |
|Value Trap     |Q < median AND V ≥ median|**AVOID** — cheap for a reason         |
|Quality Premium|Q ≥ median AND V < median|**WATCH** — great business, full price |
|Expensive Junk |Q < median AND V < median|**SELL** — no quality, no value cushion|

**Ranking metric:** Q × V / 100 = unified score. Both axes must be strong to rank high.

-----

## UI Specification

### Design Language

- **Palette:** Near-black background (#060610), Quality = teal (#5eead4), Value = indigo (#818cf8), Regime = amber (#f59e0b), Positive = emerald (#34d399), Negative = red (#f87171), Neutral = yellow (#fbbf24)
- **Typography:** IBM Plex Mono for data/numbers, DM Sans for headings/labels
- **Score display:** Ring component (SVG arc proportional to score, number in center)
- **Trend display:** Sparklines shown only in expanded/detail views, not inline
- **Cards:** Subtle glass-morphism, 7px border-radius, 1px borders at ~5% white opacity

### Pages / Views

#### 1. Map View (home)

- Regime banner (clickable → regime dashboard): phase name, score ring, recession %, cycle bar
- Quality × Value scatter plot with adaptive median boundary lines
- Selected stock summary card: ticker, name, signal (BUY/WATCH/AVOID/SELL), quadrant label, **Q×V score ring on the right side of the card** (prominent, its own ring)
- Three axis score rings below summary: Quality, Value, Regime
- Universe table sorted by Q×V product: columns = rank, ticker, Q ring, V ring, F-Score, Z-Score, ROIC, P/E, Signal pill, **Q×V ring as rightmost column** (its own circle, not text)

#### 2. Regime Dashboard

- Cycle phase visualization (4-phase bar with “you are here” marker)
- Caveat banner about weak statistical support for macro timing
- Indicator categories (Market Valuation, Credit & Monetary, Growth & Labor, Sentiment & Breadth)
- Each indicator: name, current value, percentile, score ring
- **Expandable:** click indicator → 10yr sparkline + detail text + min/avg/max

#### 3. Stock Deep Dive

- Ticker header with all three axis rings and signal
- **Quality Axis section:** each component as a card with score ring, current value
  - Expandable: 10yr sparkline, percentile distribution bar (P10/P25/P50/P75/P90), data source citation, statistical caveat
  - Piotroski card shows all 9 pass/fail criteria when expanded
- **Value Axis section:** same expandable card structure
- **Decision Synthesis card:** summarizes all three axes into prose recommendation with explicit reasoning

#### 4. Weighting Methodology (reference page)

- Table: component, equal weight, IC weight, Rank IC, ICIR, academic source
- For both Quality and Value axes
- Caveat: IC values need validation against user’s own universe

#### 5. Factor Spreads (reference page)

- Quality, Value, Momentum, Low-Vol factor spread cards
- Current percentile, widening/narrowing, expected premium
- Explanation of what spreads mean for forward factor returns

-----

## Build Phases

### Phase 1: Foundation

- [ ] Init Vite + React + Tailwind project
- [ ] Set up GitHub repo, Netlify auto-deploy
- [ ] Create Supabase project, run schema SQL
- [ ] Build Ring, Card, Pill, Bar, Spark UI components
- [ ] Build page routing (map, regime, stock, weights, spreads)
- [ ] Populate with mock data (use the data from the prototypes)
- [ ] Deploy to Netlify to confirm pipeline works

### Phase 2: Data Ingestion

- [ ] Build Supabase edge function: `/api/refresh-stock/:ticker`
  - Calls FMP for statements, metrics, ratios, scores, DCF, executives
  - Calls Finnhub for ESG, insider transactions, news
  - Writes raw responses to `api_cache` table with TTL
- [ ] Build edge function: `/api/refresh-regime`
  - Calls AV for economic indicators (GDP, unemployment, CPI, Treasury yields)
  - Calls FMP for market-level data
  - Calls Finnhub for VIX quote
- [ ] Implement cache-check-before-fetch logic (don’t re-fetch within TTL)
- [ ] Rate limiter: track daily FMP and AV call counts in a counter table

### Phase 3: Scoring Engine

- [ ] Build Quality scoring function (Supabase edge function or client-side)
  - Input: raw cached data. Output: quality_scores row.
  - Implement all 7 component scoring rules per spec above
  - Compute 10yr history arrays from annual statement data
- [ ] Build Value scoring function
  - Same pattern, 7 components
  - Requires current price (Finnhub real-time) + fundamentals (FMP cached)
- [ ] Build Regime scoring function
  - Process all economic indicators into 0-100 scores
  - Classify cycle phase from indicator constellation
- [ ] Compute universe stats (medians for adaptive boundaries)

### Phase 4: Frontend Integration

- [ ] Connect Map view to Supabase: fetch quality_scores + value_scores + regime
- [ ] Build live scatter plot from real scores
- [ ] Connect Stock deep dive to Supabase: fetch component details + history
- [ ] Build expandable cards with sparklines from history_10yr JSONB
- [ ] Connect Regime dashboard to Supabase
- [ ] Add “Refresh” button per stock (calls edge function, re-fetches)

### Phase 5: Automation + Polish

- [ ] Set up pg_cron job: daily refresh of all watchlist tickers at 4:30 PM ET
- [ ] Add watchlist management UI (add/remove tickers)
- [ ] Add ticker search (FMP symbol search endpoint)
- [ ] Add loading states, error handling, empty states
- [ ] Mobile responsive pass
- [ ] Add the statistical caveats and methodology notes throughout

-----

## Key API Endpoints Reference

### FMP (append `?apikey=KEY`)

```
GET /api/v3/income-statement/{ticker}?period=annual&limit=10
GET /api/v3/balance-sheet-statement/{ticker}?period=annual&limit=10
GET /api/v3/cash-flow-statement/{ticker}?period=annual&limit=10
GET /api/v3/key-metrics/{ticker}?period=annual&limit=10
GET /api/v3/financial-ratios/{ticker}?period=annual&limit=10
GET /api/v3/score?symbol={ticker}              # Piotroski + Altman
GET /api/v3/discounted-cash-flow/{ticker}       # DCF intrinsic value
GET /api/v3/enterprise-values/{ticker}?period=annual&limit=10
GET /api/v3/key-executives/{ticker}
GET /api/v3/stock-screener?marketCapMoreThan=1000000000&limit=100
GET /api/v3/historical/dividends/{ticker}
GET /api/v3/analyst-estimates/{ticker}
GET /api/v3/profile/{ticker}                    # company profile
```

### Finnhub (append `&token=KEY`)

```
GET /api/v1/quote?symbol={ticker}               # real-time price
GET /api/v1/stock/esg?symbol={ticker}            # ESG scores
GET /api/v1/stock/insider-transactions?symbol={ticker}
GET /api/v1/company-news?symbol={ticker}&from=YYYY-MM-DD&to=YYYY-MM-DD
GET /api/v1/stock/social-sentiment?symbol={ticker}
GET /api/v1/stock/recommendation?symbol={ticker}
WebSocket wss://ws.finnhub.io                    # real-time streaming
```

### Alpha Vantage (append `&apikey=KEY`)

```
GET /query?function=TREASURY_YIELD&interval=daily&maturity=10year
GET /query?function=REAL_GDP&interval=quarterly
GET /query?function=UNEMPLOYMENT
GET /query?function=NONFARM_PAYROLL
GET /query?function=CPI&interval=monthly
GET /query?function=FEDERAL_FUNDS_RATE&interval=daily
GET /query?function=RSI&symbol={ticker}&interval=daily&time_period=14&series_type=close
GET /query?function=MACD&symbol={ticker}&interval=daily&series_type=close
GET /query?function=BBANDS&symbol={ticker}&interval=daily&time_period=20&series_type=close
GET /query?function=TIME_SERIES_DAILY_ADJUSTED&symbol={ticker}&outputsize=full
```

-----

## Non-Negotiable Principles

1. **Never store API keys in code.** Environment variables only.
1. **Cache everything.** Every API response goes to Supabase with a TTL. The frontend reads from cache, not APIs directly.
1. **Respect rate limits.** Track daily call counts. If FMP budget is exhausted, show cached data with staleness indicator — never fail silently.
1. **Show the work.** Every score must be decomposable — the user must be able to click through to see exactly which data produced which number.
1. **Be honest about uncertainty.** Statistical caveats are part of the UI, not an afterthought. Label regime timing as weak evidence. Label management quality as low confidence. Show percentile ranges, not just point estimates.
1. **Adaptive boundaries.** Quadrant boundaries are universe medians, recomputed whenever the watchlist changes. Never hardcode 50/50.
1. **Equal weights first.** Start with equal weighting across all components. IC-weighting is the target but requires validated backtesting data.
1. **Graham Number caveat.** When BVPS < $5, cap the Graham Number component’s contribution or flag it as unreliable. It structurally breaks for capital-light companies.

-----

## Supabase Edge Function Templates

### /api/refresh-stock/:ticker

```typescript
// Pseudocode — implement as Supabase Edge Function (Deno)
import { createClient } from '@supabase/supabase-js'

const FMP = 'https://financialmodelingprep.com'
const FINNHUB = 'https://finnhub.io'
const fmpKey = Deno.env.get('FMP_API_KEY')
const fhKey = Deno.env.get('FINNHUB_API_KEY')

async function fetchWithCache(supabase, ticker, endpoint, url, ttlSeconds) {
  // Check cache first
  const { data: cached } = await supabase
    .from('api_cache')
    .select('data, fetched_at')
    .eq('ticker', ticker)
    .eq('endpoint', endpoint)
    .single()

  if (cached) {
    const age = (Date.now() - new Date(cached.fetched_at).getTime()) / 1000
    if (age < ttlSeconds) return cached.data  // still fresh
  }

  // Fetch from API
  const res = await fetch(url)
  const data = await res.json()

  // Upsert to cache
  await supabase.from('api_cache').upsert({
    ticker, endpoint, data, fetched_at: new Date().toISOString(), ttl_seconds: ttlSeconds
  }, { onConflict: 'ticker,endpoint' })

  return data
}

Deno.serve(async (req) => {
  const ticker = new URL(req.url).pathname.split('/').pop()
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  )

  // Fetch all data sources (parallel where possible)
  const [income, balance, cashflow, metrics, ratios, scores, dcf, profile, esg, insiders] =
    await Promise.all([
      fetchWithCache(supabase, ticker, 'fmp:income', `${FMP}/api/v3/income-statement/${ticker}?period=annual&limit=10&apikey=${fmpKey}`, 86400),
      fetchWithCache(supabase, ticker, 'fmp:balance', `${FMP}/api/v3/balance-sheet-statement/${ticker}?period=annual&limit=10&apikey=${fmpKey}`, 86400),
      fetchWithCache(supabase, ticker, 'fmp:cashflow', `${FMP}/api/v3/cash-flow-statement/${ticker}?period=annual&limit=10&apikey=${fmpKey}`, 86400),
      fetchWithCache(supabase, ticker, 'fmp:metrics', `${FMP}/api/v3/key-metrics/${ticker}?period=annual&limit=10&apikey=${fmpKey}`, 86400),
      fetchWithCache(supabase, ticker, 'fmp:ratios', `${FMP}/api/v3/financial-ratios/${ticker}?period=annual&limit=10&apikey=${fmpKey}`, 86400),
      fetchWithCache(supabase, ticker, 'fmp:scores', `${FMP}/api/v3/score?symbol=${ticker}&apikey=${fmpKey}`, 86400),
      fetchWithCache(supabase, ticker, 'fmp:dcf', `${FMP}/api/v3/discounted-cash-flow/${ticker}?apikey=${fmpKey}`, 86400),
      fetchWithCache(supabase, ticker, 'fmp:profile', `${FMP}/api/v3/profile/${ticker}?apikey=${fmpKey}`, 86400),
      fetchWithCache(supabase, ticker, 'fh:esg', `${FINNHUB}/api/v1/stock/esg?symbol=${ticker}&token=${fhKey}`, 604800),
      fetchWithCache(supabase, ticker, 'fh:insiders', `${FINNHUB}/api/v1/stock/insider-transactions?symbol=${ticker}&token=${fhKey}`, 86400),
    ])

  // Compute quality + value scores from raw data
  // (implement scoring functions per the framework spec above)
  const qualityScore = computeQualityScore(income, balance, cashflow, metrics, ratios, scores, insiders)
  const valueScore = computeValueScore(metrics, dcf, profile)

  // Write computed scores to Supabase
  await supabase.from('quality_scores').upsert({ ticker, ...qualityScore }, { onConflict: 'ticker' })
  await supabase.from('value_scores').upsert({ ticker, ...valueScore }, { onConflict: 'ticker' })

  return new Response(JSON.stringify({ ticker, quality: qualityScore, value: valueScore }))
})
```

### /api/refresh-regime

```typescript
// Calls Alpha Vantage economic endpoints + Finnhub for VIX
// Budget: ~8-10 AV calls (reserve rest for technical indicators)
const AV = 'https://www.alphavantage.co'
const avKey = Deno.env.get('ALPHA_VANTAGE_API_KEY')

const endpoints = [
  { key: 'gdp', url: `${AV}/query?function=REAL_GDP&interval=quarterly&apikey=${avKey}` },
  { key: 'unemployment', url: `${AV}/query?function=UNEMPLOYMENT&apikey=${avKey}` },
  { key: 'cpi', url: `${AV}/query?function=CPI&interval=monthly&apikey=${avKey}` },
  { key: 'fed_rate', url: `${AV}/query?function=FEDERAL_FUNDS_RATE&interval=daily&apikey=${avKey}` },
  { key: 'treasury_10y', url: `${AV}/query?function=TREASURY_YIELD&interval=daily&maturity=10year&apikey=${avKey}` },
  { key: 'treasury_2y', url: `${AV}/query?function=TREASURY_YIELD&interval=daily&maturity=2year&apikey=${avKey}` },
  { key: 'nonfarm', url: `${AV}/query?function=NONFARM_PAYROLL&apikey=${avKey}` },
]
// Note: call these SEQUENTIALLY with delays to stay within AV rate limits
```

-----

## Netlify Configuration

```toml
# netlify.toml at repo root
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "20"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

Set env vars in Netlify dashboard (Site settings → Environment variables):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

The frontend ONLY talks to Supabase. API keys for FMP/Finnhub/AV live in Supabase edge function env vars, never exposed to the client.

-----

## Supabase Row-Level Security

```sql
-- Public read for all data tables (scores are not sensitive)
ALTER TABLE quality_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON quality_scores FOR SELECT USING (true);

ALTER TABLE value_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON value_scores FOR SELECT USING (true);

ALTER TABLE regime ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON regime FOR SELECT USING (true);

ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON watchlist FOR SELECT USING (true);

ALTER TABLE api_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON api_cache FOR SELECT USING (true);

-- Edge functions use service_role key, bypassing RLS for writes
```

-----

## Project Structure

```
signal-forge/
├── netlify.toml
├── package.json
├── vite.config.js
├── tailwind.config.js
├── .env.local                    # local dev only, gitignored
├── src/
│   ├── main.jsx
│   ├── App.jsx                   # router
│   ├── lib/
│   │   ├── supabase.js           # Supabase client init
│   │   ├── scoring.js            # quality + value scoring functions
│   │   └── regime.js             # regime scoring + cycle classification
│   ├── components/
│   │   ├── Ring.jsx              # score ring (SVG arc + number)
│   │   ├── Spark.jsx             # linear sparkline for detail views
│   │   ├── Card.jsx              # glass-morphism card wrapper
│   │   ├── Pill.jsx              # colored label pill
│   │   ├── Bar.jsx               # horizontal progress bar
│   │   ├── Nav.jsx               # breadcrumb navigation
│   │   └── QuadrantChart.jsx     # Q×V scatter plot with adaptive boundaries
│   ├── pages/
│   │   ├── MapView.jsx           # home — scatter + table + regime banner
│   │   ├── RegimeView.jsx        # full macro dashboard
│   │   ├── StockView.jsx         # deep dive — quality + value axes
│   │   ├── WeightsView.jsx       # IC weighting methodology reference
│   │   └── SpreadsView.jsx       # factor valuation spreads reference
│   └── hooks/
│       ├── useWatchlist.js       # fetch watchlist + scores from Supabase
│       ├── useStock.js           # fetch single stock detail
│       └── useRegime.js          # fetch regime data
├── supabase/
│   ├── migrations/
│   │   └── 001_schema.sql        # all CREATE TABLE statements from above
│   └── functions/
│       ├── refresh-stock/
│       │   └── index.ts          # edge function: fetch + score single ticker
│       └── refresh-regime/
│           └── index.ts          # edge function: fetch + score macro data
└── README.md
```

-----

## Initial Watchlist (seed data)

Start with these 15 tickers to populate the universe:

```sql
INSERT INTO watchlist (ticker, name, sector) VALUES
  ('AAPL', 'Apple Inc.', 'Technology'),
  ('MSFT', 'Microsoft Corp.', 'Technology'),
  ('BRK.B', 'Berkshire Hathaway', 'Financials'),
  ('JNJ', 'Johnson & Johnson', 'Healthcare'),
  ('JPM', 'JPMorgan Chase', 'Financials'),
  ('NVDA', 'Nvidia Corp.', 'Technology'),
  ('PFE', 'Pfizer Inc.', 'Healthcare'),
  ('T', 'AT&T Inc.', 'Telecom'),
  ('KO', 'Coca-Cola Co.', 'Consumer Staples'),
  ('UNH', 'UnitedHealth Group', 'Healthcare'),
  ('INTC', 'Intel Corp.', 'Technology'),
  ('CVX', 'Chevron Corp.', 'Energy'),
  ('COST', 'Costco Wholesale', 'Consumer Staples'),
  ('ABBV', 'AbbVie Inc.', 'Healthcare'),
  ('LOW', 'Lowe''s Companies', 'Consumer Discretionary');
```

This set spans sectors, includes quality compounders (AAPL, MSFT, COST), classic value (BRK.B, JNJ, CVX), potential value traps (PFE, T, INTC), and growth premiums (NVDA) — giving the quadrant chart real spread across all four zones.

-----

## Reference Prototype

The file `signal-forge-v1-5.jsx` is the interactive React prototype with mock data that demonstrates the exact UI, component patterns, and interaction model. Use it as the visual reference — the code patterns are directly reusable for the Ring, Card, Pill, Bar, Spark, Nav, and QuadrantChart components.