// Edge function: /refresh-regime
// Pulls macro indicators from FRED (Federal Reserve Economic Data, St. Louis
// Fed) — free, effectively unlimited, and the authoritative source — scores the
// macro environment, writes the singleton `regime` row, and caches the 10Y
// Treasury for the value scorer's earnings-yield-vs-bond spread.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, fetchWithCache, getSecret, json } from "../_shared/cache.ts";
import { computeRegime } from "../_shared/regime.ts";

const FRED = "https://api.stlouisfed.org/fred/series/observations";
// FRED's documented cap is generous (~120 req/min); 7 cached daily calls is nothing.
const FRED_BUDGET = { provider: "fred", dailyLimit: 1000 };
const DAY = 86400;

// FRED series id -> the RegimeRaw field the regime engine expects. `limit` is
// sized to the largest look-back each indicator needs (YoY windows + trend).
const SERIES = [
  { id: "GDPC1",    field: "gdp",          limit: 8 },  // real GDP, quarterly (YoY needs 5q)
  { id: "UNRATE",   field: "unemployment", limit: 8 },  // unemployment rate, monthly
  { id: "CPIAUCSL", field: "cpi",          limit: 16 }, // CPI, monthly (YoY needs 13m)
  { id: "FEDFUNDS", field: "fed_rate",     limit: 4 },  // fed funds rate, monthly
  { id: "DGS10",    field: "treasury_10y", limit: 12 }, // 10Y treasury, daily
  { id: "DGS2",     field: "treasury_2y",  limit: 12 }, // 2Y treasury, daily
  { id: "PAYEMS",   field: "nonfarm",      limit: 16 }, // nonfarm payrolls, monthly (YoY needs 13m)
] as const;

type AvSeries = { data: { date: string; value: string }[] };

// FRED returns { observations: [{ date, value }, ...] }, newest-first under
// sort_order=desc, with "." for missing prints. Drop the gaps and reshape to the
// { data: [{date,value}] } form regime.ts already consumes (originally Alpha Vantage).
function toSeries(raw: unknown): AvSeries {
  const obs = (raw as { observations?: { date: string; value: string }[] })?.observations ?? [];
  return { data: obs.filter((o) => o?.value && o.value !== ".") };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const key = await getSecret(supabase, "FRED_API_KEY");
    if (!key) return json({ error: "FRED_API_KEY not configured" }, 500);

    const raw: Record<string, AvSeries> = {};
    for (const s of SERIES) {
      const url = `${FRED}?series_id=${s.id}&api_key=${key}&file_type=json&sort_order=desc&limit=${s.limit}`;
      const r = await fetchWithCache(supabase, null, `fred:${s.id}`, url, DAY, FRED_BUDGET).catch(() => null);
      raw[s.field] = toSeries(r?.data);
    }

    const regime = computeRegime({
      gdp: raw.gdp, unemployment: raw.unemployment, cpi: raw.cpi,
      fed_rate: raw.fed_rate, treasury_10y: raw.treasury_10y,
      treasury_2y: raw.treasury_2y, nonfarm: raw.nonfarm,
    });

    const { error } = await supabase.from("regime").upsert(
      { id: 1, ...regime, computed_at: new Date().toISOString() },
      { onConflict: "id" },
    );
    if (error) return json({ error: error.message }, 500);

    // Compat: the value scorer reads the 10Y treasury from api_cache under the
    // legacy `av:treasury_10y` key, expecting a percent string at data[0].value.
    // DGS10 is already quoted in percent, so refresh-stock's parse is unchanged.
    await supabase.from("api_cache").upsert(
      { ticker: null, endpoint: "av:treasury_10y", data: raw.treasury_10y, fetched_at: new Date().toISOString(), ttl_seconds: DAY },
      { onConflict: "ticker,endpoint" },
    );

    return json({
      composite_score: regime.composite_score,
      cycle_phase: regime.cycle_phase,
      recession_probability: regime.recession_probability,
      treasury_10y: raw.treasury_10y.data[0]?.value ?? null,
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
