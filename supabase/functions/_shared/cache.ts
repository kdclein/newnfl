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

  // Providers return HTTP 200 with an error/throttle note (Alpha Vantage
  // "Information"/"Note", FMP "Error Message"). Never cache those — caching a
  // rate-limit notice would poison this endpoint for the whole TTL window.
  if (looksLikeProviderError(data)) {
    if (cached) return { data: cached.data, stale: true, fromCache: true };
    throw new Error(`${budget.provider} returned a throttle/error note for ${endpoint}`);
  }

  await supabase.from("api_cache").upsert(
    { ticker, endpoint, data, fetched_at: new Date().toISOString(), ttl_seconds: ttlSeconds },
    { onConflict: "ticker,endpoint" },
  );

  return { data, stale: false, fromCache: false };
}

/**
 * Resolve an API key. Prefers an Edge Function env var (the Supabase-recommended
 * store) and falls back to a Vault secret of the same name via the service-role
 * `get_vault_secret` RPC. This lets the keys live in either place.
 */
export async function getSecret(supabase: SupabaseClient, name: string): Promise<string | null> {
  const env = Deno.env.get(name);
  if (env) return env;
  const { data, error } = await supabase.rpc("get_vault_secret", { p_name: name });
  if (error) return null;
  return (data as string | null) ?? null;
}

/** Detects the HTTP-200 error/throttle payloads that FMP and Alpha Vantage return. */
export function looksLikeProviderError(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const o = data as Record<string, unknown>;
  return "Information" in o || "Note" in o || "Error Message" in o ||
    ("error" in o && Object.keys(o).length <= 2);
}

/** Sleep helper for pacing rate-limited sequential calls. */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
