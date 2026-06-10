// Edge function: /backfill-sectors
// Fills in GICS-style sectors for watchlist names that have none (the small-cap
// universe came from Nasdaq's screener, which carries no sector). Pulls Finnhub's
// company profile, maps its industry taxonomy onto the same 11 GICS sectors the
// large-cap universe uses, and writes it back so small-caps join the sector view.
// Processes a small batch per call, paced under Finnhub's 60 req/min ceiling, and
// is driven by an every-minute cron until the null-sector backlog is gone.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, fetchWithCache, getSecret, json, sleep } from "../_shared/cache.ts";

const FINNHUB = "https://finnhub.io";
const FH_BUDGET = { provider: "finnhub", dailyLimit: 50000 };
const WEEK = 604800;
const BATCH = 10;

// deno-lint-ignore no-explicit-any
type Any = any;

// Map Finnhub's `finnhubIndustry` onto the 11 GICS sectors. Keyword-based so it
// tolerates spacing/variant labels; order matters (most-specific buckets first).
function toGics(industry: string): string | null {
  const s = industry.toLowerCase();
  if (!s) return null;
  const has = (...xs: string[]) => xs.some((x) => s.includes(x));
  if (has("real estate", "reit")) return "Real Estate";
  if (has("bank", "insur", "financ", "capital market", "asset manage", "holding compan", "mortgage", "brokerage", "fund")) return "Financials";
  if (has("pharma", "biotech", "health", "life science", "medical", "drug", "therapeut")) return "Health Care";
  if (has("semiconduct", "software", "it services", "hardware", "electronic equip", "technology")) return "Information Technology";
  if (has("telecom", "communications", "media", "entertainment", "publishing", "internet")) return "Communication Services";
  if (has("oil", "gas", "energy", "coal", "petroleum", "drilling")) return "Energy";
  if (has("utilit")) return "Utilities";
  if (has("chemical", "metal", "mining", "paper", "forest", "packaging", "steel", "gold", "aluminum", "copper")) return "Materials";
  if (has("beverage", "food", "tobacco", "household product", "personal product", "consumer products", "grocery", "staple", "agricultur")) return "Consumer Staples";
  if (has("aerospace", "airline", "machinery", "industrial", "logistic", "transport", "marine", "rail", "building", "distribution", "trading compan", "commercial services", "professional services", "electrical equipment", "construction", "engineering", "defense")) return "Industrials";
  if (has("auto", "retail", "apparel", "textile", "luxury", "hotel", "restaurant", "leisure", "consumer service", "homebuild", "durables", "gaming", "casino", "commerce", "education")) return "Consumer Discretionary";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const key = await getSecret(supabase, "FINNHUB_API_KEY");
    if (!key) return json({ error: "FINNHUB_API_KEY not configured" }, 500);

    const { data: rows } = await supabase.from("watchlist").select("ticker").is("sector", null).limit(BATCH);
    const tickers = (rows ?? []).map((r: Any) => r.ticker as string);

    let updated = 0, skipped = 0;
    for (const ticker of tickers) {
      const url = `${FINNHUB}/api/v1/stock/profile2?symbol=${ticker}&token=${key}`;
      const resp = await fetchWithCache(supabase, ticker, "fh:profile", url, WEEK, FH_BUDGET).catch(() => null);
      if (!resp) { skipped++; continue; } // transient (rate limit / 5xx) — retry next run
      const ind = (resp.data as Any)?.finnhubIndustry;
      // 200 with an empty body means Finnhub has no profile -> "Unknown" so we
      // don't loop on it forever; a real industry maps to GICS (or "Unknown").
      const sector = toGics(String(ind ?? "")) ?? "Unknown";
      await supabase.from("watchlist").update({ sector }).eq("ticker", ticker);
      updated++;
      await sleep(150);
    }

    const { count: remaining } = await supabase.from("watchlist")
      .select("ticker", { count: "exact", head: true }).is("sector", null);

    return json({ processed: tickers.length, updated, skipped, remaining: remaining ?? 0 });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
