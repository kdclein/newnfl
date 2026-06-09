// Edge function: /refresh-stock/:ticker
// Fetches fundamentals (FMP) + real-time price/insiders (Finnhub) through the
// TTL cache, computes Quality + Value scores, and writes them to Supabase.
// API keys live ONLY in this function's env — never shipped to the client.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, fetchWithCache, json } from "../_shared/cache.ts";
import { computeQualityScore, computeValueScore } from "../_shared/scoring.ts";

const FMP = "https://financialmodelingprep.com";
const FINNHUB = "https://finnhub.io";
const FMP_BUDGET = { provider: "fmp", dailyLimit: 250 };
const FH_BUDGET = { provider: "finnhub", dailyLimit: 50000 }; // 60/min ~ effectively unbounded daily
const DAY = 86400, WEEK = 604800;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const ticker = decodeURIComponent(new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "")
      .toUpperCase();
    if (!ticker || ticker === "REFRESH-STOCK") return json({ error: "ticker required" }, 400);

    const fmpKey = Deno.env.get("FMP_API_KEY");
    const fhKey = Deno.env.get("FINNHUB_API_KEY");
    if (!fmpKey) return json({ error: "FMP_API_KEY not configured" }, 500);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const fmp = (path: string) => `${FMP}${path}${path.includes("?") ? "&" : "?"}apikey=${fmpKey}`;
    const get = (endpoint: string, url: string, ttl: number, budget = FMP_BUDGET) =>
      fetchWithCache(supabase, ticker, endpoint, url, ttl, budget).then((r) => r.data).catch(() => null);

    // Fundamentals (FMP) — fetched in parallel, each cached independently.
    const [income, balance, cashflow, metrics, ratios, score, dcf, profile, esg, insiders] = await Promise.all([
      get("fmp:income", fmp(`/api/v3/income-statement/${ticker}?period=annual&limit=10`), DAY),
      get("fmp:balance", fmp(`/api/v3/balance-sheet-statement/${ticker}?period=annual&limit=10`), DAY),
      get("fmp:cashflow", fmp(`/api/v3/cash-flow-statement/${ticker}?period=annual&limit=10`), DAY),
      get("fmp:metrics", fmp(`/api/v3/key-metrics/${ticker}?period=annual&limit=10`), DAY),
      get("fmp:ratios", fmp(`/api/v3/financial-ratios/${ticker}?period=annual&limit=10`), DAY),
      get("fmp:score", fmp(`/api/v3/score?symbol=${ticker}`), DAY),
      get("fmp:dcf", fmp(`/api/v3/discounted-cash-flow/${ticker}`), DAY),
      get("fmp:profile", fmp(`/api/v3/profile/${ticker}`), DAY),
      fhKey ? get("fh:esg", `${FINNHUB}/api/v1/stock/esg?symbol=${ticker}&token=${fhKey}`, WEEK, FH_BUDGET) : null,
      fhKey ? get("fh:insiders", `${FINNHUB}/api/v1/stock/insider-transactions?symbol=${ticker}&token=${fhKey}`, DAY, FH_BUDGET) : null,
    ]);

    // Real-time price (Finnhub quote, short TTL) — fall back to FMP profile price.
    let price: number | undefined;
    if (fhKey) {
      const quote = await get("fh:quote", `${FINNHUB}/api/v1/quote?symbol=${ticker}&token=${fhKey}`, 60, FH_BUDGET) as
        { c?: number } | null;
      if (quote && typeof quote.c === "number" && quote.c > 0) price = quote.c;
    }

    // Latest 10Y treasury yield from the regime refresh cache (decimal).
    const { data: t10row } = await supabase.from("api_cache").select("data").eq("endpoint", "av:treasury_10y").maybeSingle();
    const t10raw = (t10row?.data as { data?: { value: string }[] } | undefined)?.data?.[0]?.value;
    const treasury10y = t10raw ? parseFloat(t10raw) / 100 : undefined;

    const quality = computeQualityScore({
      income, balance, cashflow, metrics, ratios, score,
      insiders: insiders as { data?: Record<string, unknown>[] } ?? undefined,
    });
    const value = computeValueScore({ income, metrics, ratios, dcf, profile, price, treasury10y });

    const now = new Date().toISOString();
    const errors: string[] = [];
    const q = await supabase.from("quality_scores").upsert({ ticker, ...quality, computed_at: now }, { onConflict: "ticker" });
    if (q.error) errors.push(`quality: ${q.error.message}`);
    const v = await supabase.from("value_scores").upsert({ ticker, ...value, computed_at: now }, { onConflict: "ticker" });
    if (v.error) errors.push(`value: ${v.error.message}`);
    await supabase.from("watchlist").update({ last_refreshed: now }).eq("ticker", ticker);

    // Refresh adaptive quadrant boundaries now that this ticker changed.
    await supabase.rpc("recompute_universe_stats");

    if (errors.length) return json({ ticker, errors }, 500);
    return json({
      ticker,
      quality: { composite: quality.composite_score, confidence: quality.confidence },
      value: { composite: value.composite_score, price: value.price },
      esg_available: !!esg,
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
