// Edge function: /refresh-stock/:ticker
// Primary (free) pipeline: Finnhub financials-reported (statements -> self-
// computed Piotroski / Altman / DCF / ROIC) + Finnhub metric (valuation ratios)
// + Finnhub quote (real-time price). FMP is the fallback when Finnhub has no
// statements. All keys stay server-side (env or Vault) — never client-shipped.
// (SEC EDGAR was the original statements source but is blocked from edge egress.)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, fetchWithCache, getSecret, json, sleep } from "../_shared/cache.ts";
import { computeQualityScore, computeValueScore } from "../_shared/scoring.ts";
import { parseFinnhubStatements } from "../_shared/finnhubStatements.ts";
import { computeAltman, computeDCF, computePiotroski, computeRoicSeries } from "../_shared/fundamentals.ts";
import { parseFinnhubMetric } from "../_shared/finnhub.ts";
import { isFiniteNum } from "../_shared/math.ts";

const FMP = "https://financialmodelingprep.com";
const FINNHUB = "https://finnhub.io";
const FMP_BUDGET = { provider: "fmp", dailyLimit: 250 };
const FH_BUDGET = { provider: "finnhub", dailyLimit: 50000 };
const DAY = 86400, WEEK = 604800;

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const ticker = decodeURIComponent(new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "")
      .toUpperCase();
    if (!ticker || ticker === "REFRESH-STOCK") return json({ error: "ticker required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const fhKey = await getSecret(supabase, "FINNHUB_API_KEY");
    const fmpKey = await getSecret(supabase, "FMP_API_KEY");

    const get = (endpoint: string, url: string, ttl: number, budget = FH_BUDGET) =>
      fetchWithCache(supabase, ticker, endpoint, url, ttl, budget).then((r) => r.data).catch(() => null);

    const { data: wl } = await supabase.from("watchlist").select("cik, sector").eq("ticker", ticker).maybeSingle();
    const cik = wl?.cik as string | undefined;
    // Altman Z and FCF-based DCF are not meaningful for banks / REITs (no working
    // capital, OCF distorted by loan & deposit flows) — exclude rather than distort.
    const isFinancial = wl?.sector === "Financials" || wl?.sector === "Real Estate";

    // ---- Finnhub: valuation metrics, statements, insiders, real-time price ----
    let metricResp: Any = null, financialsResp: Any = null, insiders: Any = null, price: number | undefined;
    if (fhKey) {
      metricResp = await get("fh:metric", `${FINNHUB}/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${fhKey}`, DAY);
      financialsResp = await get("fh:financials", `${FINNHUB}/api/v1/stock/financials-reported?symbol=${ticker}&freq=annual&token=${fhKey}`, WEEK);
      insiders = await get("fh:insiders", `${FINNHUB}/api/v1/stock/insider-transactions?symbol=${ticker}&token=${fhKey}`, DAY);
      const quote = await get("fh:quote", `${FINNHUB}/api/v1/quote?symbol=${ticker}&token=${fhKey}`, 60) as { c?: number } | null;
      if (quote && typeof quote.c === "number" && quote.c > 0) price = quote.c;
    }
    const fh = parseFinnhubMetric(metricResp);

    // 10Y treasury (decimal) from the regime cache, for earnings-yield-vs-bond.
    const { data: t10row } = await supabase.from("api_cache").select("data").eq("endpoint", "av:treasury_10y").maybeSingle();
    const t10raw = (t10row?.data as { data?: { value: string }[] } | undefined)?.data?.[0]?.value;
    const treasury10y = t10raw ? parseFloat(t10raw) / 100 : undefined;

    // ---- Statements from Finnhub financials-reported -> self-computed scores ----
    const records = parseFinnhubStatements(financialsResp);

    let income: Any[], balance: Any[], cashflow: Any[], metrics: Any[], ratios: Any[], score: Any[], dcf: Any[];
    let source = "finnhub";

    if (records.length >= 2) {
      income = records.map((r) => ({
        revenue: r.revenue, netIncome: r.netIncome,
        grossProfit: isFiniteNum(r.grossProfit) ? r.grossProfit
          : (isFiniteNum(r.revenue) && isFiniteNum(r.costOfRevenue) ? r.revenue - r.costOfRevenue : undefined),
        eps: isFiniteNum(r.netIncome) && isFiniteNum(r.shares) && r.shares! > 0 ? r.netIncome! / r.shares! : undefined,
      }));
      balance = records.map((r) => ({ totalAssets: r.assets, goodwill: isFiniteNum(r.goodwill) ? r.goodwill : 0 }));
      cashflow = records.map((r) => ({ operatingCashFlow: r.ocf }));

      const roic = computeRoicSeries(records);
      metrics = records.map((_, i) => ({ returnOnInvestedCapital: isFiniteNum(roic[i]) ? roic[i] : undefined } as Any));
      metrics[0].earningsYield = fh.earningsYield;
      metrics[0].freeCashFlowYield = fh.fcfYield;
      metrics[0].evToEBITDA = fh.evEbitda;

      ratios = [{
        priceToEarningsRatio: fh.peTTM, dividendYield: fh.dividendYield,
        bookValuePerShare: fh.bookValuePerShare, netIncomePerShare: income[0]?.eps,
      }];

      // Market cap from Finnhub; shares from statements, else derived (mktcap/price).
      const marketCap = isFiniteNum(fh.marketCap) ? fh.marketCap
        : (isFiniteNum(price) && isFiniteNum(records[0]?.shares) ? price! * records[0].shares! : NaN);
      const shares0 = isFiniteNum(records[0]?.shares) ? records[0].shares
        : (isFiniteNum(marketCap) && isFiniteNum(price) && price! > 0 ? marketCap! / price! : NaN);
      const pio = computePiotroski(records);
      const altman = isFinancial ? null : computeAltman(records[0], isFiniteNum(marketCap) ? marketCap! : NaN);
      score = [{ piotroskiScore: pio?.score, altmanZScore: altman, piotroskiScoreDetail: pio?.detail ?? null }];
      const dcfVal = isFinancial ? null : computeDCF(records, isFiniteNum(shares0) ? shares0! : NaN);
      dcf = [{ dcf: dcfVal, "Stock Price": price }];

      if (isFiniteNum(marketCap)) {
        await supabase.from("watchlist").update({ market_cap: marketCap }).eq("ticker", ticker);
      }
    } else if (fmpKey) {
      // ---- Fallback: FMP /stable for statements + scores + DCF ----
      source = "fmp";
      const fmp = (p: string) => `${FMP}/stable/${p}${p.includes("?") ? "&" : "?"}apikey=${fmpKey}`;
      const endpoints: [string, string][] = [
        ["fmp:income", `income-statement?symbol=${ticker}&period=annual&limit=5`],
        ["fmp:balance", `balance-sheet-statement?symbol=${ticker}&period=annual&limit=5`],
        ["fmp:cashflow", `cash-flow-statement?symbol=${ticker}&period=annual&limit=5`],
        ["fmp:metrics", `key-metrics?symbol=${ticker}&period=annual&limit=5`],
        ["fmp:ratios", `ratios?symbol=${ticker}&period=annual&limit=5`],
        ["fmp:score", `financial-scores?symbol=${ticker}`],
        ["fmp:dcf", `discounted-cash-flow?symbol=${ticker}`],
      ];
      const fd: Record<string, Any> = {};
      for (let i = 0; i < endpoints.length; i++) {
        fd[endpoints[i][0]] = await get(endpoints[i][0], fmp(endpoints[i][1]), DAY, FMP_BUDGET);
        if (i < endpoints.length - 1) await sleep(300);
      }
      income = fd["fmp:income"] ?? []; balance = fd["fmp:balance"] ?? []; cashflow = fd["fmp:cashflow"] ?? [];
      metrics = fd["fmp:metrics"] ?? []; ratios = fd["fmp:ratios"] ?? [];
      score = fd["fmp:score"] ?? []; dcf = fd["fmp:dcf"] ?? [];
    } else {
      return json({ error: `no data source for ${ticker} (no SEC CIK and no FMP key)` }, 502);
    }

    const quality = computeQualityScore({ income, balance, cashflow, metrics, ratios, score, insiders: insiders ?? undefined });
    const value = computeValueScore({ income, metrics, ratios, dcf, profile: [{ price }], price, treasury10y });

    const now = new Date().toISOString();
    const errors: string[] = [];
    const q = await supabase.from("quality_scores").upsert({ ticker, ...quality, computed_at: now }, { onConflict: "ticker" });
    if (q.error) errors.push(`quality: ${q.error.message}`);
    const v = await supabase.from("value_scores").upsert({ ticker, ...value, computed_at: now }, { onConflict: "ticker" });
    if (v.error) errors.push(`value: ${v.error.message}`);
    await supabase.from("watchlist").update({ last_refreshed: now }).eq("ticker", ticker);
    // Relative-value metrics (sector P/E, FCF/EV percentiles) need the whole
    // universe, so recompute them across all stocks before the medians.
    await supabase.rpc("recompute_cross_sectional");
    await supabase.rpc("recompute_universe_stats");

    if (errors.length) return json({ ticker, errors }, 500);
    return json({
      ticker, source, years: records.length,
      quality: { composite: quality.composite_score, confidence: quality.confidence },
      value: { composite: value.composite_score, price: value.price },
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
