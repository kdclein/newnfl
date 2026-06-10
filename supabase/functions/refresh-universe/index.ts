// Edge function: /refresh-universe
// Seeds the ticker universe + index membership that powers the front-page
// toggles. The S&P 500 is fetched live (with GICS sector + SEC CIK) from a public
// dataset; the DJIA is a version-controlled constant; the Nasdaq-100 is pulled
// live from Nasdaq's own list-type API. New tickers not already in the watchlist
// are inserted (without clobbering existing rows' sectors) so the scoring cron
// picks them up.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, json } from "../_shared/cache.ts";

const SP500_CSV =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const NASDAQ100 = "https://api.nasdaq.com/api/quote/list-type/nasdaq100";
const UA = "Mozilla/5.0 (compatible; NEWNFL/1.0)";

// deno-lint-ignore no-explicit-any
type Any = any;

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
const cleanSym = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");

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
      const ticker = cleanSym(f[iSym] ?? "");
      if (!ticker) continue;
      watchRows.push({
        ticker,
        name: (f[iName] ?? "").trim() || null,
        sector: (f[iSector] ?? "").trim() || null,
        cik: f[iCik] ? pad10(f[iCik]) : null,
      });
      sp500Members.push({ ticker, index_name: "sp500" });
    }

    const w = await supabase.from("watchlist").upsert(watchRows, { onConflict: "ticker" });
    if (w.error) return json({ error: `watchlist upsert: ${w.error.message}` }, 500);
    const m = await supabase.from("index_membership")
      .upsert(sp500Members, { onConflict: "ticker,index_name", ignoreDuplicates: true });
    if (m.error) return json({ error: `sp500 membership: ${m.error.message}` }, 500);

    // ---- DJIA (static; all are S&P 500 members) ----
    const djiaMembers = DJIA.map((ticker) => ({ ticker, index_name: "djia" }));
    const d = await supabase.from("index_membership")
      .upsert(djiaMembers, { onConflict: "ticker,index_name", ignoreDuplicates: true });
    if (d.error) return json({ error: `djia membership: ${d.error.message}` }, 500);

    // ---- Nasdaq-100 (live, from Nasdaq's list-type API) ----
    let nasdaq100Count = 0, nasdaqNew = 0;
    try {
      const nr = await fetch(NASDAQ100, { headers: { "User-Agent": UA, "Accept": "application/json" } });
      if (nr.ok) {
        const body = await nr.json() as Any;
        const rows = (body?.data?.data?.rows ?? []) as Any[];
        const { data: existing } = await supabase.from("watchlist").select("ticker");
        const have = new Set((existing ?? []).map((r: Any) => r.ticker));

        const members: { ticker: string; index_name: string }[] = [];
        const newRows: Record<string, unknown>[] = [];
        for (const row of rows) {
          const ticker = cleanSym(String(row?.symbol ?? ""));
          if (!ticker) continue;
          members.push({ ticker, index_name: "nasdaq100" });
          if (!have.has(ticker)) {
            // Nasdaq's feed has no GICS sector, so leave it null for the few
            // Nasdaq-100 names not already in the S&P 500; scoring works by symbol.
            const name = row?.companyName
              ? String(row.companyName).replace(/ Common Stock$/i, "").replace(/ Class [A-Z].*$/i, "").trim()
              : null;
            newRows.push({ ticker, name: name || null, sector: null });
            have.add(ticker);
          }
        }
        nasdaq100Count = members.length;
        nasdaqNew = newRows.length;
        if (newRows.length) {
          const nw = await supabase.from("watchlist").upsert(newRows, { onConflict: "ticker", ignoreDuplicates: true });
          if (nw.error) return json({ error: `nasdaq100 watchlist: ${nw.error.message}` }, 500);
        }
        const nm = await supabase.from("index_membership")
          .upsert(members, { onConflict: "ticker,index_name", ignoreDuplicates: true });
        if (nm.error) return json({ error: `nasdaq100 membership: ${nm.error.message}` }, 500);
      }
    } catch (e) {
      // Non-fatal: keep S&P/DJIA seeding even if Nasdaq's API hiccups.
      return json({ sp500: sp500Members.length, djia: DJIA.length, nasdaq100_error: String(e) }, 200);
    }

    // ---- Small Caps (Russell-2000-style: US small-caps by market cap) ----
    // No free Russell 2000 constituent feed is reachable, so we build an honest
    // small-cap universe from Nasdaq's screener: all US-listed names filtered to
    // the small-cap band ($300M–$3B), capped at the ~1,000 largest (most liquid,
    // best fundamentals coverage). Labeled "Small Caps", not "Russell 2000".
    let smallcapCount = 0, smallcapNew = 0;
    const SC_MIN = 3e8, SC_MAX = 3e9, SC_CAP = 1000;
    try {
      const sr = await fetch(
        "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0",
        { headers: { "User-Agent": UA, "Accept": "application/json" } },
      );
      if (sr.ok) {
        const body = await sr.json() as Any;
        const rows = (body?.data?.table?.rows ?? []) as Any[];
        const band: { ticker: string; name: string | null; mc: number }[] = [];
        for (const row of rows) {
          const ticker = cleanSym(String(row?.symbol ?? ""));
          if (!/^[A-Z]{1,5}$/.test(ticker)) continue; // skip warrants/units/preferreds
          const mc = parseFloat(String(row?.marketCap ?? "").replace(/[$,]/g, ""));
          if (!Number.isFinite(mc) || mc < SC_MIN || mc > SC_MAX) continue;
          band.push({ ticker, name: row?.name ? String(row.name).trim() : null, mc });
        }
        band.sort((a, b) => b.mc - a.mc);
        const picked = band.slice(0, SC_CAP);

        const { data: existing } = await supabase.from("watchlist").select("ticker");
        const have = new Set((existing ?? []).map((r: Any) => r.ticker));
        const members: { ticker: string; index_name: string }[] = [];
        const newRows: Record<string, unknown>[] = [];
        for (const p of picked) {
          members.push({ ticker: p.ticker, index_name: "smallcap" });
          if (!have.has(p.ticker)) {
            newRows.push({ ticker: p.ticker, name: p.name, sector: null, market_cap: p.mc });
            have.add(p.ticker);
          }
        }
        smallcapCount = members.length;
        smallcapNew = newRows.length;
        // Insert in chunks to stay well under request limits.
        for (let i = 0; i < newRows.length; i += 500) {
          const nw = await supabase.from("watchlist").upsert(newRows.slice(i, i + 500), { onConflict: "ticker", ignoreDuplicates: true });
          if (nw.error) return json({ error: `smallcap watchlist: ${nw.error.message}` }, 500);
        }
        for (let i = 0; i < members.length; i += 500) {
          const sm = await supabase.from("index_membership").upsert(members.slice(i, i + 500), { onConflict: "ticker,index_name", ignoreDuplicates: true });
          if (sm.error) return json({ error: `smallcap membership: ${sm.error.message}` }, 500);
        }
      }
    } catch (e) {
      return json({ sp500: sp500Members.length, djia: DJIA.length, nasdaq100: nasdaq100Count, smallcap_error: String(e) }, 200);
    }

    return json({
      sp500: sp500Members.length,
      djia: DJIA.length,
      nasdaq100: nasdaq100Count,
      nasdaq100_new_tickers: nasdaqNew,
      smallcap: smallcapCount,
      smallcap_new_tickers: smallcapNew,
      watchlist_upserted: watchRows.length,
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
