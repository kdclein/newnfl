// Edge function: /refresh-macro
// Builds the full macro dashboard: 22+ indicators across four categories
// (Market Valuation, Sentiment & Positioning, Credit & Rates, Labor & Economy),
// each with current value, historical norm/percentile, a 0-100 favorability
// score, a signal classification, and an analytical explanation. Also writes
// the singleton `regime` row (composite, cycle phase, recession probability)
// and the 10Y-Treasury compat cache row the value scorer reads.
//
// Sources (all free): FRED (St. Louis Fed) for rates/credit/labor/economy,
// multpl.com for Shiller CAPE + S&P 500 P/E history, and self-computed
// aggregates from our own 503-stock universe (Buffett indicator, equity risk
// premium, market breadth). Proprietary series with no free feed (ISM PMI,
// Conference Board LEI & Consumer Confidence, AAII, CNN Fear/Greed, Fed dot
// plot) are replaced by documented, statistically defensible substitutes and
// labeled as such in their explanations.
//
// Recession probability is a published-model blend: the Estrella–Mishkin /
// NY-Fed probit on the 10Y−3M term spread, floored by the Sahm rule and
// nudged by high-yield credit stress.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, fetchWithCache, getSecret, json } from "../_shared/cache.ts";

const FRED = "https://api.stlouisfed.org/fred/series/observations";
const FRED_BUDGET = { provider: "fred", dailyLimit: 1000 };
const DAY = 86400;
const MACRO = "_macro";

// deno-lint-ignore no-explicit-any
type Any = any;
type Obs = { date: string; value: string };

// ---------- math helpers ----------
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
function linMap(x: number, a: number, b: number, ya: number, yb: number): number {
  if (b === a) return ya;
  return clamp(ya + ((x - a) / (b - a)) * (yb - ya), Math.min(ya, yb), Math.max(ya, yb));
}
// Abramowitz–Stegun erf approximation -> standard normal CDF.
function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
function percentile(current: number, hist: number[]): number | null {
  const v = hist.filter(isNum);
  if (v.length < 12) return null;
  const below = v.filter((x) => x < current).length;
  return Math.round((below / v.length) * 100);
}
const median = (xs: number[]) => {
  const v = xs.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const fmt = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? "—" : x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));

// ---------- FRED series helpers (newest-first arrays) ----------
function vals(obs: Obs[] | undefined): number[] {
  return (obs ?? []).map((o) => parseFloat(o.value)).filter(isNum);
}
const at = (xs: number[], i: number): number => (i < xs.length ? xs[i] : NaN);
const avgFirst = (xs: number[], n: number) => {
  const v = xs.slice(0, n).filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};
const yoyPct = (xs: number[], periods: number) => {
  const cur = at(xs, 0), prior = at(xs, periods);
  return isNum(cur) && isNum(prior) && prior !== 0 ? ((cur - prior) / Math.abs(prior)) * 100 : NaN;
};

function sigOf(score: number | null): string {
  if (score == null || !Number.isFinite(score)) return "na";
  if (score >= 65) return "favorable";
  if (score >= 40) return "neutral";
  if (score >= 20) return "caution";
  return "warning";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const key = await getSecret(supabase, "FRED_API_KEY");
    if (!key) return json({ error: "FRED_API_KEY not configured" }, 500);

    // ---------- fetch all FRED series (cached 24h each) ----------
    const F = (id: string, p: string) =>
      `${FRED}?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc${p}`;
    const series: Record<string, [string, string]> = {
      vix_d: ["VIXCLS", "&limit=10"],
      vix_m: ["VIXCLS", "&frequency=m&aggregation_method=avg&limit=120"],
      ig_d: ["BAMLC0A0CM", "&limit=10"],
      ig_m: ["BAMLC0A0CM", "&frequency=m&aggregation_method=avg&limit=120"],
      hy_d: ["BAMLH0A0HYM2", "&limit=10"],
      hy_m: ["BAMLH0A0HYM2", "&frequency=m&aggregation_method=avg&limit=120"],
      t10y3m_m: ["T10Y3M", "&frequency=m&aggregation_method=avg&limit=24"],
      dgs10: ["DGS10", "&limit=12"],
      dgs2: ["DGS2", "&limit=12"],
      fedfunds: ["FEDFUNDS", "&limit=120"],
      walcl: ["WALCL", "&limit=260"],
      unrate: ["UNRATE", "&limit=180"],
      payems: ["PAYEMS", "&limit=180"],
      icsa: ["ICSA", "&limit=260"],
      jtsjol: ["JTSJOL", "&limit=120"],
      unemploy: ["UNEMPLOY", "&limit=120"],
      gdpc1: ["GDPC1", "&limit=41"],
      gdp_nom: ["GDP", "&limit=8"],
      pce: ["PCEPILFE", "&limit=120"],
      cpi: ["CPIAUCSL", "&limit=120"],
      philly: ["GACDFSA066MSFRBPHI", "&limit=120"],
      umich: ["UMCSENT", "&limit=240"],
      permit: ["PERMIT", "&limit=120"],
    };
    const fetched: Record<string, number[]> = {};
    const names = Object.keys(series);
    for (let i = 0; i < names.length; i += 6) {
      await Promise.all(names.slice(i, i + 6).map(async (n) => {
        const [id, p] = series[n];
        const r = await fetchWithCache(supabase, MACRO, `fredm:${n}`, F(id, p), DAY, FRED_BUDGET).catch(() => null);
        fetched[n] = vals((r?.data as Any)?.observations);
      }));
    }
    const S = fetched;

    // ---------- multpl.com: Shiller CAPE + S&P 500 P/E (current + yearly history) ----------
    async function multpl(path: string): Promise<number[]> {
      try {
        const res = await fetch(`https://www.multpl.com/${path}`, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; NEWNFL/1.0)" },
        });
        if (!res.ok) return [];
        const html = await res.text();
        // Value cells are plain <td> with an &#x2002; (en-space) entity before
        // the number: <td>\n&#x2002;\n41.54\n</td>
        return [...html.matchAll(/&#x2002;\s*(-?[0-9][0-9.,]*)/g)]
          .map((m) => parseFloat(m[1].replace(/,/g, ""))).filter(isNum);
      } catch { return []; }
    }
    const [capeNow, capeHist, peNow, peHist] = await Promise.all([
      multpl("shiller-pe/table/by-month"), multpl("shiller-pe/table/by-year"),
      multpl("s-p-500-pe-ratio/table/by-month"), multpl("s-p-500-pe-ratio/table/by-year"),
    ]);

    // ---------- self-computed universe aggregates ----------
    const [{ data: wl }, { data: vsRows }] = await Promise.all([
      supabase.from("watchlist").select("ticker,market_cap"),
      supabase.from("value_scores").select("ticker,pe_ratio"),
    ]);
    const peMap = new Map((vsRows ?? []).map((r: Any) => [r.ticker, Number(r.pe_ratio)]));
    let mcapTotal = 0, mcapWithPe = 0, earnings = 0;
    for (const w of (wl ?? []) as Any[]) {
      const mc = Number(w.market_cap);
      if (!isNum(mc) || mc <= 0) continue;
      mcapTotal += mc;
      const pe = peMap.get(w.ticker);
      if (isNum(pe) && pe > 0) { mcapWithPe += mc; earnings += mc / pe; }
    }
    const aggPe = earnings > 0 ? mcapWithPe / earnings : NaN;        // cap-weighted trailing P/E
    const aggEy = isNum(aggPe) && aggPe > 0 ? 100 / aggPe : NaN;     // earnings yield, %
    const gdpNomB = at(S.gdp_nom, 0);                                 // $ billions
    const buffett = isNum(gdpNomB) && gdpNomB > 0 ? (mcapTotal / (gdpNomB * 1e9)) * 100 : NaN; // %

    // ---------- breadth (accumulating from daily snapshots) ----------
    const b200 = (await supabase.rpc("market_breadth", { n: 200 })).data as Any;
    const b100 = (await supabase.rpc("market_breadth", { n: 100 })).data as Any;
    const daysHave = Number(b200?.days_available ?? 0);

    // ---------- core derived values ----------
    const dgs10 = at(S.dgs10, 0), dgs2 = at(S.dgs2, 0);
    const curve = isNum(dgs10) && isNum(dgs2) ? dgs10 - dgs2 : NaN;            // pp
    const t10y3m = at(S.t10y3m_m, 0);                                          // monthly avg, pp
    const vix = at(S.vix_d, 0), ig = at(S.ig_d, 0), hy = at(S.hy_d, 0);
    const ff = at(S.fedfunds, 0);
    const erp = isNum(aggEy) && isNum(dgs10) ? aggEy - dgs10 : NaN;            // %
    const cape = capeNow[0], pe = peNow[0];
    const unrate = at(S.unrate, 0);
    const sahm3m = avgFirst(S.unrate, 3);
    let sahmLow = Infinity;
    for (let k = 1; k <= 12; k++) {
      const a = (at(S.unrate, k) + at(S.unrate, k + 1) + at(S.unrate, k + 2)) / 3;
      if (isNum(a)) sahmLow = Math.min(sahmLow, a);
    }
    const sahmGap = isNum(sahm3m) && Number.isFinite(sahmLow) ? sahm3m - sahmLow : NaN;
    const payroll3m = (at(S.payems, 0) - at(S.payems, 3)) / 3;                 // thousands/mo
    const claims4w = avgFirst(S.icsa, 4);
    const claimsYoY = ((claims4w - (at(S.icsa, 52) + at(S.icsa, 53) + at(S.icsa, 54) + at(S.icsa, 55)) / 4) /
      ((at(S.icsa, 52) + at(S.icsa, 53) + at(S.icsa, 54) + at(S.icsa, 55)) / 4)) * 100;
    const jolts = at(S.jtsjol, 0) / at(S.unemploy, 0);                          // openings per unemployed
    const gdpYoY = yoyPct(S.gdpc1, 4);
    const pceYoY = yoyPct(S.pce, 12);
    const cpiYoY = yoyPct(S.cpi, 12);
    const philly = at(S.philly, 0);
    const umich = at(S.umich, 0);
    const permitYoY = yoyPct(S.permit, 12);
    const bsNow = at(S.walcl, 0), bs26w = at(S.walcl, 26);
    const bsChg26w = isNum(bsNow) && isNum(bs26w) ? ((bsNow - bs26w) / bs26w) * 100 : NaN;
    const policyGap = isNum(dgs2) && isNum(ff) ? dgs2 - ff : NaN;               // 2Y − FF, pp

    // percentiles vs each series' own history
    const vixPctl = isNum(vix) ? percentile(vix, S.vix_m) : null;
    const igPctl = isNum(ig) ? percentile(ig, S.ig_m) : null;
    const hyPctl = isNum(hy) ? percentile(hy, S.hy_m) : null;
    const capePctl = isNum(cape) ? percentile(cape, capeHist) : null;
    const pePctl = isNum(pe) ? percentile(pe, peHist) : null;
    const claimsPctl = isNum(claims4w) ? percentile(claims4w, S.icsa) : null;
    const umichPctl = isNum(umich) ? percentile(umich, S.umich) : null;

    // ---------- scores ----------
    const sCape = capePctl != null ? 100 - capePctl : (isNum(cape) ? linMap(cape, 10, 40, 90, 10) : null);
    const sPe = pePctl != null ? 100 - pePctl : (isNum(pe) ? linMap(pe, 10, 30, 90, 10) : null);
    const sBuffett = isNum(buffett) ? linMap(buffett, 70, 160, 80, 10) : null;
    const sErp = isNum(erp) ? linMap(erp, -1, 4, 15, 85) : null;
    const sVix = vixPctl != null ? 100 - vixPctl : null;
    const sIg = igPctl != null ? 100 - igPctl : null;
    const sHy = hyPctl != null ? 100 - hyPctl : null;
    const sFf = isNum(ff) ? linMap(ff, 0, 6, 80, 25) : null;
    const sCurve = isNum(curve) ? linMap(curve, -1, 2, 10, 90) : null;
    const sBs = isNum(bsChg26w) ? linMap(bsChg26w, -6, 6, 35, 75) : null;
    const sPolicy = isNum(policyGap) ? 60 - Math.min(Math.abs(policyGap), 2) * 12 : null;
    const sUnrate = isNum(sahmGap) && sahmGap >= 0.5 ? 10 : (isNum(unrate) ? linMap(unrate, 6.5, 3.5, 20, 85) : null);
    const sPayroll = isNum(payroll3m) ? linMap(payroll3m, -100, 300, 15, 85) : null;
    const sClaims = claimsPctl != null ? 100 - claimsPctl : null;
    const sJolts = isNum(jolts) ? linMap(jolts, 0.5, 1.6, 30, 85) : null;
    const sGdp = isNum(gdpYoY) ? linMap(gdpYoY, -2, 4, 10, 90) : null;
    const sPce = isNum(pceYoY) ? clamp(100 - (Math.abs(pceYoY - 2) / 4) * 100) : null;
    const sCpi = isNum(cpiYoY) ? clamp(100 - (Math.abs(cpiYoY - 2) / 4) * 100) : null;
    const sPhilly = isNum(philly) ? linMap(philly, -30, 30, 20, 80) : null;
    const sUmich = umichPctl != null ? linMap(umichPctl, 0, 100, 25, 75) : null;
    const sPermit = isNum(permitYoY) ? linMap(permitYoY, -20, 20, 20, 80) : null;

    // breadth (only when enough history)
    const br200 = b200?.pct_above != null ? Number(b200.pct_above) : null;
    const br100 = b100?.pct_above != null ? Number(b100.pct_above) : null;
    const sBr200 = br200 != null ? linMap(br200, 20, 80, 25, 80) : null;
    const sBr100 = br100 != null ? linMap(br100, 20, 80, 25, 80) : null;

    // Sentiment composite (our Fear/Greed substitute): average of available
    // greed-side components — complacent vol, tight credit, broad participation.
    const greedParts = [
      vixPctl != null ? 100 - vixPctl : null,
      hyPctl != null ? 100 - hyPctl : null,
      br200,
    ].filter((x): x is number => x != null);
    const greed = greedParts.length ? greedParts.reduce((a, b) => a + b, 0) / greedParts.length : null;
    const greedLabel = greed == null ? "—" : greed >= 75 ? "Extreme Greed" : greed >= 60 ? "Greed" : greed >= 40 ? "Neutral" : greed >= 25 ? "Fear" : "Extreme Fear";
    const sGreed = greed != null ? 100 - greed : null; // fear = opportunity for deploying capital

    // Leading composite (LEI substitute): average of forward-looking member scores.
    const leadParts = [sCurve, sClaims, sPermit, sUmich, sPhilly, sHy].filter((x): x is number => x != null);
    const leading = leadParts.length >= 4 ? leadParts.reduce((a, b) => a + b, 0) / leadParts.length : null;

    // ---------- recession probability (documented blend) ----------
    // NY-Fed / Estrella–Mishkin probit on the 10Y−3M monthly-average spread.
    let recession = isNum(t10y3m) ? normCdf(-0.5333 - 0.633 * t10y3m) : 0.15;
    if (isNum(hy)) { if (hy > 8) recession += 0.20; else if (hy > 6) recession += 0.10; }
    if (isNum(sahmGap) && sahmGap >= 0.5) recession = Math.max(recession, 0.70);
    recession = Math.min(Math.max(recession, 0.02), 0.95);

    // ---------- cycle phase ----------
    const inverted = isNum(curve) && curve < 0;
    const claimsRising = isNum(claimsYoY) && claimsYoY > 15;
    const unempRising = isNum(sahmGap) && sahmGap >= 0.2;
    let cycle = "mid_expansion";
    if ((isNum(sahmGap) && sahmGap >= 0.5) || (isNum(gdpYoY) && gdpYoY < 0 && isNum(payroll3m) && payroll3m < 0)) cycle = "contraction";
    else if (inverted || claimsRising || unempRising || (hyPctl != null && hyPctl > 80)) cycle = "late_expansion";
    else if (isNum(gdpYoY) && gdpYoY > 0 && isNum(unrate) && unrate > 5 && isNum(payroll3m) && payroll3m > 150) cycle = "early_expansion";

    // ---------- assemble indicator rows ----------
    const hist = (xs: number[], n = 24) => xs.slice(0, n).reverse(); // oldest-first sparkline
    const breadthNote = (n: number) =>
      `Computed from our own daily price snapshots across the S&P 500 universe; no free historical feed exists, so this fills in as history accumulates (${daysHave}/${n} trading days so far).`;

    type Row = {
      id: string; category: string; label: string; value: number | null; display: string;
      norm: string | null; percentile: number | null; score: number | null; signal: string;
      explanation: string; history: number[] | null; sort_order: number;
    };
    const rows: Row[] = [
      // ---- Market Valuation ----
      {
        id: "cape", category: "valuation", label: "Shiller CAPE", value: cape ?? null,
        display: fmt(cape, 1), norm: capeHist.length ? `median ${fmt(median(capeHist), 1)} since 1871` : "~17 long-run",
        percentile: capePctl, score: sCape, signal: sigOf(sCape),
        explanation: `Price vs 10-year average inflation-adjusted earnings (source: multpl.com). At ${fmt(cape, 1)}${capePctl != null ? `, the ${capePctl}th percentile of history` : ""} — levels this elevated have historically preceded below-average long-run returns, though CAPE has near-zero power as a short-term timing tool.`,
        history: capeNow.slice(0, 24).reverse(), sort_order: 1,
      },
      {
        id: "spx_pe", category: "valuation", label: "S&P 500 P/E (trailing)", value: pe ?? null,
        display: `${fmt(pe, 1)}×`, norm: peHist.length ? `median ${fmt(median(peHist), 1)} since 1871` : "~16 long-run",
        percentile: pePctl, score: sPe, signal: sigOf(sPe),
        explanation: `Trailing twelve-month P/E of the index (forward P/E needs licensed analyst estimates, so the trailing multiple stands in). Our own cap-weighted universe P/E computes to ${fmt(aggPe, 1)}× as a cross-check. Higher multiples mean more of the future is already paid for.`,
        history: peNow.slice(0, 24).reverse(), sort_order: 2,
      },
      {
        id: "buffett", category: "valuation", label: "Buffett Indicator", value: isNum(buffett) ? buffett : null,
        display: `${fmt(buffett, 0)}%`, norm: "~80–100% historically 'fair'", percentile: null,
        score: sBuffett, signal: sigOf(sBuffett),
        explanation: `S&P 500 total market cap (self-computed from our universe: $${fmt(mcapTotal / 1e12, 1)}T) over nominal GDP ($${fmt(gdpNomB / 1000, 1)}T). The classic version uses the broader Wilshire 5000 (S&P 500 ≈ 80% of it), so add roughly a quarter for the all-market figure. Far above ~100% signals equities are large relative to the economy that feeds their earnings.`,
        history: null, sort_order: 3,
      },
      {
        id: "erp", category: "valuation", label: "Equity Risk Premium", value: isNum(erp) ? erp : null,
        display: `${fmt(erp, 1)}%`, norm: "~3% long-run average", percentile: null,
        score: sErp, signal: sigOf(sErp),
        explanation: `Universe earnings yield (${fmt(aggEy, 1)}%) minus the 10-year Treasury (${fmt(dgs10, 2)}%): the extra compensation for owning stocks over bonds. Near zero or negative, investors are paid almost nothing for equity risk — historically associated with weak subsequent relative returns.`,
        history: null, sort_order: 4,
      },
      // ---- Sentiment & Positioning ----
      {
        id: "sentiment", category: "sentiment", label: "Sentiment Composite", value: greed,
        display: greed == null ? "—" : `${Math.round(greed)} · ${greedLabel}`, norm: "50 = neutral", percentile: null,
        score: sGreed, signal: sigOf(sGreed),
        explanation: `Our Fear/Greed substitute (CNN's index is proprietary): the average of volatility complacency (inverted VIX percentile), credit complacency (inverted high-yield-spread percentile)${br200 != null ? ", and market breadth" : " — breadth joins once price history accumulates"}. Extremes are contrarian: greed marks complacency near tops, fear marks opportunity.`,
        history: null, sort_order: 10,
      },
      {
        id: "vix", category: "sentiment", label: "VIX", value: isNum(vix) ? vix : null,
        display: fmt(vix, 1), norm: `10y median ${fmt(median(S.vix_m), 1)}`, percentile: vixPctl,
        score: sVix, signal: sigOf(sVix),
        explanation: `30-day implied volatility of S&P 500 options${vixPctl != null ? ` — currently the ${vixPctl}th percentile of the past decade` : ""}. Low readings signal calm (and sometimes complacency that precedes volatility spikes); sustained readings above ~25 mark genuine stress regimes.`,
        history: hist(S.vix_m), sort_order: 11,
      },
      {
        id: "aaii", category: "sentiment", label: "AAII Bull–Bear Spread", value: null,
        display: "n/a", norm: "≈ +6.5pp long-run", percentile: null, score: null, signal: "na",
        explanation: "The AAII retail-investor survey is proprietary with no free programmatic feed, so it is shown as unavailable rather than approximated — the Sentiment Composite above covers this category with measurable substitutes.",
        history: null, sort_order: 12,
      },
      {
        id: "breadth200", category: "sentiment", label: "% above 200-day MA", value: br200,
        display: br200 != null ? `${fmt(br200, 0)}%` : `accumulating`, norm: "~55–75% in healthy uptrends",
        percentile: null, score: sBr200, signal: sigOf(sBr200),
        explanation: `Share of S&P 500 members trading above their 200-day moving average — broad participation confirms a trend, narrow leadership warns of fragility. ${breadthNote(200)}`,
        history: null, sort_order: 13,
      },
      {
        id: "breadth100", category: "sentiment", label: "% above 100-day MA", value: br100,
        display: br100 != null ? `${fmt(br100, 0)}%` : `accumulating`, norm: "~55–75% in healthy uptrends",
        percentile: null, score: sBr100, signal: sigOf(sBr100),
        explanation: `Shorter-window breadth, more responsive to recent rotation. ${breadthNote(100)}`,
        history: null, sort_order: 14,
      },
      // ---- Credit & Rates ----
      {
        id: "fed_funds", category: "credit", label: "Fed Funds Rate", value: isNum(ff) ? ff : null,
        display: `${fmt(ff, 2)}%`, norm: `10y median ${fmt(median(S.fedfunds), 2)}%`, percentile: percentile(ff, S.fedfunds),
        score: sFf, signal: sigOf(sFf),
        explanation: `The policy rate — the price of money for the whole system. Higher levels tighten financial conditions with a lag of roughly 12–18 months; the level matters less than the direction and how long it stays restrictive relative to inflation.`,
        history: hist(S.fedfunds), sort_order: 20,
      },
      {
        id: "curve_10y2y", category: "credit", label: "10Y–2Y Spread", value: isNum(curve) ? curve : null,
        display: `${curve >= 0 ? "+" : ""}${fmt(curve, 2)}pp`, norm: "+0.9pp long-run average", percentile: null,
        score: sCurve, signal: sigOf(sCurve),
        explanation: `The classic recession herald: inversion (negative) has preceded every US recession since the 1960s, but the dangerous window is often the re-steepening *after* inversion, as cuts get priced ahead of a slowdown. ${inverted ? "Currently inverted." : "Currently un-inverted — watch whether that came from easing expectations (bull steepening) or growth optimism."}`,
        history: null, sort_order: 21,
      },
      {
        id: "ig_oas", category: "credit", label: "IG Corporate Spread", value: isNum(ig) ? ig : null,
        display: `${fmt(ig, 2)}pp`, norm: `10y median ${fmt(median(S.ig_m), 2)}pp`, percentile: igPctl,
        score: sIg, signal: sigOf(sIg),
        explanation: `Investment-grade option-adjusted spread (ICE BofA) — the extra yield demanded to lend to strong corporates${igPctl != null ? `, now the ${igPctl}th percentile of the decade` : ""}. Tight spreads mean abundant credit (and little margin for error); rapid widening is one of the most reliable early stress signals.`,
        history: hist(S.ig_m), sort_order: 22,
      },
      {
        id: "hy_oas", category: "credit", label: "HY Corporate Spread", value: isNum(hy) ? hy : null,
        display: `${fmt(hy, 2)}pp`, norm: `10y median ${fmt(median(S.hy_m), 2)}pp`, percentile: hyPctl,
        score: sHy, signal: sigOf(sHy),
        explanation: `High-yield option-adjusted spread — the market's live read on default risk${hyPctl != null ? ` (${hyPctl}th percentile)` : ""}. Below ~3pp credit is priced for perfection; above ~6pp stress is real and feeds the recession-probability model directly.`,
        history: hist(S.hy_m), sort_order: 23,
      },
      {
        id: "fed_bs", category: "credit", label: "Fed Balance Sheet", value: isNum(bsNow) ? bsNow / 1e6 : null,
        display: `$${fmt(bsNow / 1e6, 1)}T`, norm: `${bsChg26w >= 0 ? "+" : ""}${fmt(bsChg26w, 1)}% vs 26w ago`, percentile: null,
        score: sBs, signal: sigOf(sBs),
        explanation: `Total Fed assets (WALCL). ${isNum(bsChg26w) && bsChg26w < -0.5 ? "Shrinking — quantitative tightening is draining reserve liquidity, a persistent headwind for risk assets." : isNum(bsChg26w) && bsChg26w > 0.5 ? "Expanding — liquidity injection is a tailwind for risk assets." : "Roughly flat — neither QT drag nor QE support dominates."} Direction matters more than level.`,
        history: hist(S.walcl, 52), sort_order: 24,
      },
      {
        id: "policy_path", category: "credit", label: "Market-Implied Policy Path", value: isNum(policyGap) ? policyGap : null,
        display: `${policyGap >= 0 ? "+" : ""}${fmt(policyGap, 2)}pp`, norm: "≈0 = policy seen as stable", percentile: null,
        score: sPolicy, signal: sigOf(sPolicy),
        explanation: `2-year Treasury minus the funds rate — the bond market's verdict on where policy is heading (the Fed's dot plot has no machine-readable feed, so this market-implied read substitutes). Deeply negative means heavy cuts are priced in, which is supportive only if the economy holds up while they arrive.`,
        history: null, sort_order: 25,
      },
      // ---- Labor & Economy ----
      {
        id: "unemployment", category: "labor", label: "Unemployment Rate", value: isNum(unrate) ? unrate : null,
        display: `${fmt(unrate, 1)}%`, norm: `Sahm gap ${isNum(sahmGap) ? `+${fmt(sahmGap, 2)}pp` : "—"} (trigger 0.50)`, percentile: percentile(unrate, S.unrate),
        score: sUnrate, signal: sigOf(sUnrate),
        explanation: `Low unemployment supports spending, but the *change* is the signal: the Sahm rule (3-month average rising ≥0.50pp above its 12-month low) has flagged every recession since 1970 with no false positives. ${isNum(sahmGap) && sahmGap >= 0.5 ? "TRIGGERED — historically this has meant recession is already underway." : `Currently +${fmt(sahmGap, 2)}pp — ${isNum(sahmGap) && sahmGap >= 0.2 ? "drifting toward" : "well below"} the trigger.`}`,
        history: hist(S.unrate), sort_order: 30,
      },
      {
        id: "payrolls", category: "labor", label: "Nonfarm Payrolls", value: isNum(payroll3m) ? payroll3m : null,
        display: `${payroll3m >= 0 ? "+" : ""}${fmt(payroll3m, 0)}k/mo`, norm: "~150k ≈ breakeven with labor-force growth", percentile: null,
        score: sPayroll, signal: sigOf(sPayroll),
        explanation: `Three-month average monthly job creation. Above ~150k the labor market is genuinely adding slack-absorbing jobs; sustained sub-50k prints historically precede rising unemployment, and negative prints all but confirm contraction.`,
        history: null, sort_order: 31,
      },
      {
        id: "claims", category: "labor", label: "Initial Jobless Claims", value: isNum(claims4w) ? claims4w / 1000 : null,
        display: `${fmt(claims4w / 1000, 0)}k`, norm: `5y median ${fmt(median(S.icsa) / 1000, 0)}k`, percentile: claimsPctl,
        score: sClaims, signal: sigOf(sClaims),
        explanation: `Four-week average of new unemployment filings — the highest-frequency labor signal there is (weekly, ~5-day lag). Layoffs lead hiring freezes; a sustained rise of ~15–20% year-over-year (currently ${isNum(claimsYoY) ? `${claimsYoY >= 0 ? "+" : ""}${fmt(claimsYoY, 0)}%` : "—"}) is an early deterioration tell.`,
        history: hist(S.icsa, 52), sort_order: 32,
      },
      {
        id: "jolts", category: "labor", label: "JOLTS Openings / Unemployed", value: isNum(jolts) ? jolts : null,
        display: `${fmt(jolts, 2)}×`, norm: "~1.0–1.2× balanced", percentile: null,
        score: sJolts, signal: sigOf(sJolts),
        explanation: `Job openings per unemployed worker — the cleanest read on labor-market tightness. Above ~1.2 workers have leverage (wage pressure, sticky services inflation); below ~0.8 slack is building and unemployment usually follows the openings down.`,
        history: null, sort_order: 33,
      },
      {
        id: "gdp", category: "labor", label: "Real GDP Growth", value: isNum(gdpYoY) ? gdpYoY : null,
        display: `${gdpYoY >= 0 ? "+" : ""}${fmt(gdpYoY, 1)}%`, norm: "~2% trend", percentile: null,
        score: sGdp, signal: sigOf(sGdp),
        explanation: `Year-over-year real output growth. Above ~2% trend the expansion has cushion; the quarterly path matters less than whether growth is broadening (investment + consumption) or narrowing to a single engine. Heavily revised and lagged — confirmation, not foresight.`,
        history: hist(S.gdpc1, 20), sort_order: 34,
      },
      {
        id: "core_pce", category: "labor", label: "Core PCE Inflation", value: isNum(pceYoY) ? pceYoY : null,
        display: `${fmt(pceYoY, 1)}%`, norm: "2% Fed target", percentile: null,
        score: sPce, signal: sigOf(sPce),
        explanation: `The Fed's preferred inflation gauge (ex food & energy). Distance from 2% in either direction is what keeps policy restrictive — at ${fmt(pceYoY, 1)}%, ${isNum(pceYoY) && Math.abs(pceYoY - 2) < 0.5 ? "close enough to target to permit easing" : pceYoY > 2 ? "still above target, limiting how fast the Fed can cut" : "below target, inviting accommodation"}.`,
        history: null, sort_order: 35,
      },
      {
        id: "cpi", category: "labor", label: "CPI Inflation", value: isNum(cpiYoY) ? cpiYoY : null,
        display: `${fmt(cpiYoY, 1)}%`, norm: "~2% target zone", percentile: null,
        score: sCpi, signal: sigOf(sCpi),
        explanation: `Headline consumer prices year-over-year — what households actually feel, and the input to real-income math. Runs hotter and noisier than core PCE; the spread between them is mostly energy and shelter timing.`,
        history: hist(S.cpi), sort_order: 36,
      },
      {
        id: "phil_fed", category: "labor", label: "Philly Fed Mfg Index", value: isNum(philly) ? philly : null,
        display: fmt(philly, 1), norm: "0 = expansion/contraction line", percentile: percentile(philly, S.philly),
        score: sPhilly, signal: sigOf(sPhilly),
        explanation: `Regional manufacturing diffusion survey, standing in for ISM PMI (which is proprietary). Positive = expanding activity. Manufacturing is only ~10% of GDP but turns earlier than services, which is why these surveys punch above their weight as cycle signals.`,
        history: hist(S.philly), sort_order: 37,
      },
      {
        id: "consumer", category: "labor", label: "Consumer Sentiment (UMich)", value: isNum(umich) ? umich : null,
        display: fmt(umich, 1), norm: `20y median ${fmt(median(S.umich), 1)}`, percentile: umichPctl,
        score: sUmich, signal: sigOf(sUmich),
        explanation: `University of Michigan survey (the Conference Board's Consumer Confidence is proprietary; the two track closely). Depressed sentiment with resilient spending is common late-cycle; the danger sign is sentiment and spending rolling over together.`,
        history: hist(S.umich), sort_order: 38,
      },
      {
        id: "leading", category: "labor", label: "Leading Composite", value: leading,
        display: leading == null ? "—" : `${fmt(leading, 0)}/100`, norm: "50 = neutral outlook", percentile: null,
        score: leading, signal: sigOf(leading),
        explanation: `Our LEI substitute (the Conference Board index is proprietary): the average favorability of six forward-looking components — yield curve, jobless claims, building permits (${isNum(permitYoY) ? `${permitYoY >= 0 ? "+" : ""}${fmt(permitYoY, 0)}% YoY` : "—"}), consumer sentiment, Philly Fed, and high-yield spreads. Persistent readings below ~40 have the same interpretation as a falling LEI: deteriorating forward momentum.`,
        history: null, sort_order: 39,
      },
    ];

    const up = await supabase.from("macro_indicators").upsert(
      rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: "id" });
    if (up.error) return json({ error: `macro upsert: ${up.error.message}` }, 500);

    // ---------- regime row (banner) + category scores ----------
    const catScore = (cat: string) => {
      const xs = rows.filter((r) => r.category === cat && r.score != null).map((r) => r.score!) as number[];
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };
    const cats = {
      valuation: catScore("valuation"), sentiment: catScore("sentiment"),
      credit: catScore("credit"), labor: catScore("labor"),
    };
    const present = Object.values(cats).filter((x): x is number => x != null);
    const composite = present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;

    const { error: regErr } = await supabase.from("regime").upsert({
      id: 1,
      composite_score: composite,
      cycle_phase: cycle,
      recession_probability: Math.round(recession * 100) / 100,
      indicators: {
        categories: cats,
        recession_model: {
          probit_10y3m: Math.round(normCdf(-0.5333 - 0.633 * (isNum(t10y3m) ? t10y3m : 0)) * 100) / 100,
          sahm_gap: isNum(sahmGap) ? Math.round(sahmGap * 100) / 100 : null,
          hy_oas: isNum(hy) ? hy : null,
        },
      },
      history: {},
      computed_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (regErr) return json({ error: `regime upsert: ${regErr.message}` }, 500);

    // Compat: value scorer reads the 10Y under the legacy key (percent string at data[0].value).
    await supabase.from("api_cache").upsert({
      ticker: MACRO, endpoint: "av:treasury_10y",
      data: { data: [{ date: new Date().toISOString().slice(0, 10), value: String(dgs10) }] },
      fetched_at: new Date().toISOString(), ttl_seconds: DAY,
    }, { onConflict: "ticker,endpoint" });

    return json({
      indicators: rows.length,
      with_value: rows.filter((r) => r.value != null).length,
      composite: composite != null ? Math.round(composite) : null,
      cycle_phase: cycle,
      recession_probability: Math.round(recession * 100) / 100,
      categories: cats,
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
