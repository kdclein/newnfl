// Cache-before-fetch + daily rate-limit budgeting for external API calls.
// Every external response is persisted to `api_cache` with a TTL; the frontend
// never calls providers directly (see BUILD_SPEC.md, principle #2).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface ProviderBudget {
  provider: string;   // 'fmp' | 'alpha_vantage' | 'finnhub'
  dailyLimit: number; // calls/day; pass a very large number for effectively-unlimited
}

/**
 * Returns cached data when it is still within its TTL, otherwise fetches from
 * `url`, stores the response, and returns it. Respects the provider's daily
 * quota: if the budget is exhausted, returns the stale cache (with a flag)
 * rather than failing — never fail silently (principle #3).
 */
export async function fetchWithCache(
  supabase: SupabaseClient,
  ticker: string | null,
  endpoint: string,
  url: string,
  ttlSeconds: number,
  budget: ProviderBudget,
): Promise<{ data: unknown; stale: boolean; fromCache: boolean }> {
  const { data: cached } = await supabase
    .from("api_cache")
    .select("data, fetched_at")
    .eq("ticker", ticker)
    .eq("endpoint", endpoint)
    .maybeSingle();

  if (cached) {
    const ageSec = (Date.now() - new Date(cached.fetched_at).getTime()) / 1000;
    if (ageSec < ttlSeconds) {
      return { data: cached.data, stale: false, fromCache: true };
    }
  }

  // Need a fresh fetch — check the daily quota first.
  const { data: allowed, error: quotaErr } = await supabase.rpc("consume_api_quota", {
    p_provider: budget.provider,
    p_daily_limit: budget.dailyLimit,
  });
  if (quotaErr) throw quotaErr;

  if (!allowed) {
    // Budget exhausted: serve stale cache if we have any, flagged as stale.
    if (cached) return { data: cached.data, stale: true, fromCache: true };
    throw new Error(`Rate limit exhausted for ${budget.provider} and no cached data for ${endpoint}`);
  }

  const res = await fetch(url);
  if (!res.ok) {
    if (cached) return { data: cached.data, stale: true, fromCache: true };
    throw new Error(`${budget.provider} fetch failed (${res.status}) for ${endpoint}`);
  }
  const data = await res.json();

  await supabase.from("api_cache").upsert(
    { ticker, endpoint, data, fetched_at: new Date().toISOString(), ttl_seconds: ttlSeconds },
    { onConflict: "ticker,endpoint" },
  );

  return { data, stale: false, fromCache: false };
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
