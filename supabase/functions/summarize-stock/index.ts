// Edge function: /summarize-stock  (POST { ticker })
// Generates a plain-language, decision-oriented summary of one stock: what the
// company does, the markets it competes in, why its signal is BUY/WATCH/AVOID/
// SELL (tied to its actual quality & value scores), and a digest of recent news.
// Lazy + cached: returns the stored row if it's fresh, otherwise calls Claude
// (Haiku) once, persists, and returns it. All inputs come from our own DB +
// Finnhub company-news; the model never sees raw provider keys.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, fetchWithCache, getSecret, json } from "../_shared/cache.ts";

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const FINNHUB = "https://finnhub.io";
const FH_BUDGET = { provider: "finnhub", dailyLimit: 50000 };
const MODEL = "claude-haiku-4-5";
const TTL_HOURS = 24;       // regenerate (refresh news) at most once a day
const NEWS_DAYS = 14;       // look-back window for company news
const NEWS_MAX = 6;         // headlines handed to the model

// deno-lint-ignore no-explicit-any
type Any = any;

const SIGNALS: Record<string, string> = {
  BUY: "Quality Bargain", WATCH: "Quality Premium",
  AVOID: "Value Trap", SELL: "Expensive Junk",
};

function classify(q: number | null, v: number | null, qMed: number, vMed: number): string | null {
  if (q == null || v == null) return null;
  const hiQ = q >= qMed, hiV = v >= vMed;
  if (hiQ && hiV) return "BUY";
  if (hiQ && !hiV) return "WATCH";
  if (!hiQ && hiV) return "AVOID";
  return "SELL";
}

const num = (x: unknown) => (x == null ? null : Number(x));
const pct = (x: unknown, d = 1) => (x == null ? "n/a" : `${(Number(x) * 100).toFixed(d)}%`);
const fix = (x: unknown, d = 1) => (x == null ? "n/a" : Number(x).toFixed(d));

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overview: { type: "string" },
    markets: { type: "string" },
    signal_rationale: { type: "string" },
    news_summary: { type: "string" },
  },
  required: ["overview", "markets", "signal_rationale", "news_summary"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const body = await req.json().catch(() => ({}));
    const ticker = String(body?.ticker ?? "").trim().toUpperCase();
    if (!ticker) return json({ error: "ticker required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ---- Serve fresh cache ----
    const { data: cached } = await supabase.from("stock_summaries").select("*").eq("ticker", ticker).maybeSingle();
    if (cached?.generated_at) {
      const ageH = (Date.now() - new Date(cached.generated_at).getTime()) / 3.6e6;
      if (ageH < TTL_HOURS) return json({ ...cached, cached: true });
    }

    // ---- Gather inputs from our own tables ----
    const [w, q, v, us] = await Promise.all([
      supabase.from("watchlist").select("name,sector,industry").eq("ticker", ticker).maybeSingle(),
      supabase.from("quality_scores").select("*").eq("ticker", ticker).maybeSingle(),
      supabase.from("value_scores").select("*").eq("ticker", ticker).maybeSingle(),
      supabase.from("universe_stats").select("quality_median,value_median").maybeSingle(),
    ]);
    if (!w.data) return json({ error: `unknown ticker ${ticker}` }, 404);

    const qd = q.data, vd = v.data;
    const qComposite = num(qd?.composite_score), vComposite = num(vd?.composite_score);
    const qMed = num(us.data?.quality_median) ?? 50, vMed = num(us.data?.value_median) ?? 50;
    const signal = classify(qComposite, vComposite, qMed, vMed);

    // ---- Recent company news (cached, budgeted) ----
    const apiKey = await getSecret(supabase, "FINNHUB_API_KEY");
    let news: { headline: string; source: string; url: string; datetime: string }[] = [];
    if (apiKey) {
      const to = new Date(), from = new Date(Date.now() - NEWS_DAYS * 864e5);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const url = `${FINNHUB}/api/v1/company-news?symbol=${ticker}&from=${fmt(from)}&to=${fmt(to)}&token=${apiKey}`;
      const r = await fetchWithCache(supabase, ticker, "fh:news", url, 21600, FH_BUDGET).catch(() => null);
      const arr = (Array.isArray(r?.data) ? r!.data : []) as Any[];
      news = arr
        .filter((a) => a?.headline)
        .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
        .slice(0, NEWS_MAX)
        .map((a) => ({
          headline: String(a.headline), source: String(a.source ?? ""),
          url: String(a.url ?? ""), datetime: new Date((a.datetime ?? 0) * 1000).toISOString().slice(0, 10),
        }));
    }

    // ---- Build the model inputs ----
    const facts = [
      `Company: ${w.data.name ?? ticker} (${ticker})`,
      `Sector: ${w.data.sector ?? "n/a"}${w.data.industry ? ` · Industry: ${w.data.industry}` : ""}`,
      signal ? `Signal: ${signal} (${SIGNALS[signal]}) — quality ${Math.round(qComposite!)} vs universe median ${Math.round(qMed)}, value ${Math.round(vComposite!)} vs ${Math.round(vMed)}` : "Signal: not yet scored",
      `Quality score ${qComposite == null ? "n/a" : Math.round(qComposite)}/100 (confidence: ${qd?.confidence ?? "n/a"}). ` +
        `Piotroski ${qd?.piotroski_score ?? "n/a"}/9, Altman Z ${fix(qd?.altman_z)} (${qd?.altman_zone ?? "n/a"}), ` +
        `ROIC ${pct(qd?.roic_current)}, moat ${qd?.moat_score == null ? "n/a" : Math.round(Number(qd.moat_score))}/100.`,
      `Value score ${vComposite == null ? "n/a" : Math.round(vComposite)}/100. ` +
        `P/E ${fix(vd?.pe_ratio)} vs sector median ${fix(vd?.pe_vs_sector_median)}, FCF yield ${pct(vd?.fcf_yield)}, ` +
        `EV/EBITDA ${fix(vd?.ev_ebitda)}, earnings-yield-vs-10Y-bond spread ${pct(vd?.ey_vs_bond_spread)}, ` +
        `dividend yield ${pct(vd?.dividend_yield)}, DCF margin of safety ${vd?.margin_of_safety == null ? "n/a" : pct(vd.margin_of_safety, 0)}.`,
      news.length ? `Recent headlines:\n${news.map((n) => `- (${n.datetime}) ${n.headline} [${n.source}]`).join("\n")}` : "Recent headlines: none found.",
    ].join("\n");

    const system =
      "You are an equity-research assistant for NEWNFL, a tool that scores stocks on Quality (is it a great business?) " +
      "and Value (what am I paying per unit of quality?) and places them in a BUY/WATCH/AVOID/SELL quadrant. " +
      "Write concise, neutral, decision-oriented prose for a thoughtful retail investor. Use ONLY the supplied facts and " +
      "headlines — never invent figures, prices, or events. This is research, not investment advice. Return JSON only.\n\n" +
      "Fields:\n" +
      "- overview: 2-3 sentences on what the company actually does and how it makes money.\n" +
      "- markets: 1-2 sentences on the end-markets it serves and who it competes with.\n" +
      "- signal_rationale: 3-4 sentences explaining why the signal is what it is, explicitly tying to its quality and value " +
      "scores (e.g. high-quality but expensive => WATCH; cheap but weak => AVOID). Be balanced — name the main risk too. " +
      "If unscored, say so plainly.\n" +
      "- news_summary: 1-3 sentences synthesizing only the genuinely relevant recent headlines. If none are material, say " +
      "'No material company-specific news in the past two weeks.'";

    const anthropicKey = await getSecret(supabase, "ANTHROPIC_API_KEY");
    if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 503);

    const aiResp = await fetch(ANTHROPIC, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: facts }],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
    });
    if (!aiResp.ok) {
      const detail = await aiResp.text().catch(() => "");
      return json({ error: `Anthropic ${aiResp.status}`, detail: detail.slice(0, 300) }, 502);
    }
    const aiData = await aiResp.json();
    const text = (aiData?.content ?? []).find((b: Any) => b.type === "text")?.text ?? "{}";
    let parsed: Any = {};
    try { parsed = JSON.parse(text); } catch { /* leave empty */ }

    const row = {
      ticker,
      overview: parsed.overview ?? null,
      markets: parsed.markets ?? null,
      signal,
      rationale: parsed.signal_rationale ?? null,
      news_summary: parsed.news_summary ?? null,
      news,
      model: MODEL,
      generated_at: new Date().toISOString(),
    };
    const up = await supabase.from("stock_summaries").upsert(row, { onConflict: "ticker" });
    if (up.error) return json({ error: up.error.message }, 500);

    return json({ ...row, cached: false });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
