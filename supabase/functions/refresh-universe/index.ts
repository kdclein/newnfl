// Edge function: /refresh-universe
// Seeds the ticker universe + index membership that powers the front-page
// toggles. The frequently-rebalanced S&P 500 is fetched live (with GICS sector
// + SEC CIK) from a public dataset; the small, rarely-changing DJIA / Nasdaq-100
// lists are kept as version-controlled constants here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, json } from "../_shared/cache.ts";

const SP500_CSV =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

// Dow Jones Industrial Average — 30 components (all also in the S&P 500).
const DJIA = [
  "AAPL", "AMGN", "AXP", "AMZN", "BA", "CAT", "CRM", "CSCO", "CVX", "DIS",
  "GS", "HD", "HON", "IBM", "JNJ", "JPM", "KO", "MCD", "MMM", "MRK",
  "MSFT", "NKE", "NVDA", "PG", "SHW", "TRV", "UNH", "V", "VZ", "WMT",
];

/** Parse one CSV line, honoring double-quoted fields that contain commas. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const pad10 = (cik: string) => cik.replace(/\D/g, "").padStart(10, "0");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ---- S&P 500 (live) -> watchlist + membership ----
    const res = await fetch(SP500_CSV, { headers: { "User-Agent": "NEWNFL/1.0" } });
    if (!res.ok) return json({ error: `S&P 500 source fetch failed (${res.status})` }, 502);
    const lines = (await res.text()).trim().split("\n");
    const header = parseCsvLine(lines[0]);
    const col = (name: string) => header.findIndex((h) => h.trim() === name);
    const iSym = col("Symbol"), iName = col("Security"), iSector = col("GICS Sector"), iCik = col("CIK");

    const watchRows: Record<string, unknown>[] = [];
    const sp500Members: { ticker: string; index_name: string }[] = [];
    for (let i = 1; i < lines.length; i++) {
      const f = parseCsvLine(lines[i]);
      const ticker = (f[iSym] ?? "").trim().toUpperCase();
      if (!ticker) continue;
      watchRows.push({
        ticker,
        name: (f[iName] ?? "").trim() || null,
        sector: (f[iSector] ?? "").trim() || null,
        cik: f[iCik] ? pad10(f[iCik]) : null,
      });
      sp500Members.push({ ticker, index_name: "sp500" });
    }

    // Upsert watchlist (leaves scores / last_refreshed untouched) + membership.
    const w = await supabase.from("watchlist").upsert(watchRows, { onConflict: "ticker" });
    if (w.error) return json({ error: `watchlist upsert: ${w.error.message}` }, 500);
    const m = await supabase.from("index_membership")
      .upsert(sp500Members, { onConflict: "ticker,index_name", ignoreDuplicates: true });
    if (m.error) return json({ error: `sp500 membership: ${m.error.message}` }, 500);

    // ---- DJIA (static; all are S&P 500 members so already in watchlist) ----
    const djiaMembers = DJIA.map((ticker) => ({ ticker, index_name: "djia" }));
    const d = await supabase.from("index_membership")
      .upsert(djiaMembers, { onConflict: "ticker,index_name", ignoreDuplicates: true });
    if (d.error) return json({ error: `djia membership: ${d.error.message}` }, 500);

    return json({
      sp500: sp500Members.length,
      djia: DJIA.length,
      watchlist_upserted: watchRows.length,
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
