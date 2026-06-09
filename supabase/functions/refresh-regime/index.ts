// Edge function: /refresh-regime
// Pulls macro indicators from Alpha Vantage (budget-limited to ~7 calls so the
// rest of AV's 25/day stays available for technicals), scores the environment,
// and writes the singleton `regime` row. Alpha Vantage is the tightest budget,
// so calls run SEQUENTIALLY and each response is cached for 24h.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, fetchWithCache, getSecret, json, sleep } from "../_shared/cache.ts";
import { computeRegime } from "../_shared/regime.ts";

const AV = "https://www.alphavantage.co";
const AV_BUDGET = { provider: "alpha_vantage", dailyLimit: 25 };
const DAY = 86400;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const avKey = await getSecret(supabase, "ALPHA_VANTAGE_API_KEY");
    if (!avKey) return json({ error: "ALPHA_VANTAGE_API_KEY not configured" }, 500);

    const endpoints: { key: string; fn: string }[] = [
      { key: "av:gdp", fn: "REAL_GDP&interval=quarterly" },
      { key: "av:unemployment", fn: "UNEMPLOYMENT" },
      { key: "av:cpi", fn: "CPI&interval=monthly" },
      { key: "av:fed_rate", fn: "FEDERAL_FUNDS_RATE&interval=daily" },
      { key: "av:treasury_10y", fn: "TREASURY_YIELD&interval=daily&maturity=10year" },
      { key: "av:treasury_2y", fn: "TREASURY_YIELD&interval=daily&maturity=2year" },
      { key: "av:nonfarm", fn: "NONFARM_PAYROLL" },
    ];

    const out: Record<string, unknown> = {};
    for (let i = 0; i < endpoints.length; i++) {
      const e = endpoints[i];
      const url = `${AV}/query?function=${e.fn}&apikey=${avKey}`;
      // Sequential + paced: AV free tier caps at ~1 request/second. Cache hits
      // skip the network, so only actual fetches need spacing.
      const r = await fetchWithCache(supabase, null, e.key, url, DAY, AV_BUDGET).catch(() => null);
      out[e.key] = r?.data ?? null;
      if (i < endpoints.length - 1 && !r?.fromCache) await sleep(1600);
    }

    const regime = computeRegime({
      gdp: out["av:gdp"] as never,
      unemployment: out["av:unemployment"] as never,
      cpi: out["av:cpi"] as never,
      fed_rate: out["av:fed_rate"] as never,
      treasury_10y: out["av:treasury_10y"] as never,
      treasury_2y: out["av:treasury_2y"] as never,
      nonfarm: out["av:nonfarm"] as never,
    });

    const { error } = await supabase.from("regime").upsert(
      { id: 1, ...regime, computed_at: new Date().toISOString() },
      { onConflict: "id" },
    );
    if (error) return json({ error: error.message }, 500);

    return json({
      composite_score: regime.composite_score,
      cycle_phase: regime.cycle_phase,
      recession_probability: regime.recession_probability,
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
