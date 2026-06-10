// Edge function: /summarize-stock  (POST { ticker })
// Generates a plain-language, decision-oriented dossier for one stock:
//   • Overview / markets / BUY-WATCH-AVOID-SELL rationale (tied to its scores)
//   • Recent-news digest
//   • Management intel: real named insiders from SEC Form 4 (holdings + net
//     activity), five scored management-quality signals, and a candid AI
//     assessment built only from those facts.
//   • Sentiment: StockTwits bull/bear + message volume + watchers with a trend
//     arrow, news-NLP read, and LLM-extracted trending topics. Reddit and
//     Twitter/X have no free programmatic feed and are labeled as such.
// Lazy + cached (24h): one Claude (Haiku) call per stock per day. All inputs
// come from our own DB, Finnhub, and StockTwits; the model never sees keys.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS, fetchWithCache, getSecret, json } from "../_shared/cache.ts";

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const FINNHUB = "https://finnhub.io";
const FH_BUDGET = { provider: "finnhub", dailyLimit: 50000 };
const ST_BUDGET = { provider: "stocktwits", dailyLimit: 5000 };
const MODEL = "claude-haiku-4-5";
const TTL_HOURS = 24;
const NEWS_DAYS = 14;
const NEWS_MAX = 6;

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
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
function linMap(x: number, a: number, b: number, ya: number, yb: number): number {
  if (b === a) return ya;
  return clamp(ya + ((x - a) / (b - a)) * (yb - ya), Math.min(ya, yb), Math.max(ya, yb));
}
const sigOf = (s: number | null) => (s == null || !Number.isFinite(s) ? "na" : s >= 65 ? "favorable" : s >= 40 ? "neutral" : s >= 20 ? "caution" : "warning");
const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

// ---- Five management-quality signals, derived from data we already compute ----
function mgmtSignals(qd: Any) {
  const cd = qd?.component_detail || {};
  const sub = qd?.piotroski_sub || {};
  const comp = (k: string) => cd[k] || {};
  const raw = (k: string) => (cd[k]?.raw) || {};
  const cscore = (k: string) => (comp(k).score == null ? null : Math.round(Number(comp(k).score)));
  const m = raw("management"), r = raw("roic"), e = raw("earnings_quality");
  const noDil = sub.noDilution;
  const dilScore = typeof noDil === "boolean" ? (noDil ? 80 : 35) : null;
  const out = [
    {
      id: "insider", label: "Insider Conviction",
      score: m.insider_net_ratio == null ? null : Math.round(linMap(Number(m.insider_net_ratio), -1, 1, 20, 90)),
      value: m.insider_net_ratio == null ? "n/a"
        : `net ${Number(m.insider_net_ratio) >= 0 ? "buying" : "selling"} (${(Number(m.insider_net_ratio) * 100).toFixed(0)}%)`,
      note: "Net insider buying vs selling across recent SEC Form 4 filings — buying signals conviction; routine option-driven selling is a weaker tell.",
    },
    {
      id: "capital_alloc", label: "Capital Allocation",
      score: m.goodwill_to_assets == null ? null : Math.round(linMap(Number(m.goodwill_to_assets), 0.4, 0, 40, 85)),
      value: m.goodwill_to_assets == null ? "n/a" : `goodwill ${(Number(m.goodwill_to_assets) * 100).toFixed(0)}% of assets`,
      note: "How much of the balance sheet is acquisition goodwill — heavy goodwill flags an acquisitive strategy that often overpays.",
    },
    {
      id: "capital_efficiency", label: "Capital Efficiency",
      score: cscore("roic"),
      value: r.roic_current == null ? "n/a" : `ROIC ${(Number(r.roic_current) * 100).toFixed(1)}% (10y ${(Number(r.roic_10yr_avg) * 100).toFixed(1)}%)`,
      note: "Does management earn more than its cost of capital, durably? The clearest objective read on capital-allocation skill.",
    },
    {
      id: "reporting", label: "Reporting Integrity",
      score: cscore("earnings_quality"),
      value: e.ocf_ni_ratio == null ? "n/a" : `OCF/NI ${Number(e.ocf_ni_ratio).toFixed(2)}×, accruals ${(Number(e.accrual_ratio) * 100).toFixed(1)}%`,
      note: "Are reported earnings backed by cash? Cash flow above net income and low accruals indicate conservative, trustworthy accounting.",
    },
    {
      id: "dilution", label: "Shareholder Dilution",
      score: dilScore,
      value: typeof noDil === "boolean" ? (noDil ? "no dilution" : "diluting shareholders") : "n/a",
      note: "Is the share count stable/shrinking, or creeping up and diluting owners? A direct read on whether management treats shareholders as partners.",
    },
  ];
  return out.map((x) => ({ ...x, signal: sigOf(x.score) }));
}

// ---- Named insider roster from cached SEC Form 4 data ----
function insiderRoster(insidersData: Any) {
  const items = (insidersData?.data ?? []) as Any[];
  const cutoff = Date.now() - 365 * 864e5;
  const byName = new Map<string, { name: string; shares: number; net: number; last: string }>();
  for (const it of items) {
    const name = String(it?.name ?? "").trim();
    if (!name) continue;
    const tdate = String(it?.transactionDate || it?.filingDate || "");
    const rec = byName.get(name) ?? { name, shares: 0, net: 0, last: "" };
    if (!rec.last || tdate > rec.last) { rec.last = tdate; const sh = Number(it.share); if (Number.isFinite(sh)) rec.shares = sh; }
    const tms = tdate ? Date.parse(tdate) : NaN;
    const ch = Number(it.change);
    if (Number.isFinite(tms) && tms >= cutoff && Number.isFinite(ch)) rec.net += ch;
    byName.set(name, rec);
  }
  return [...byName.values()]
    .filter((r) => r.shares > 0 || r.net !== 0)
    .sort((a, b) => b.shares - a.shares)
    .slice(0, 6)
    .map((r) => ({ name: titleCase(r.name), shares: Math.round(r.shares), net_1y: Math.round(r.net), last: r.last || null }));
}

// ---- StockTwits sentiment ----
async function stocktwits(supabase: Any, ticker: string) {
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`;
  const r = await fetchWithCache(supabase, ticker, "st:stream", url, 21600, ST_BUDGET).catch(() => null);
  const d = r?.data as Any;
  if (!d?.messages) return null;
  const msgs = d.messages as Any[];
  let bull = 0, bear = 0;
  const bodies: string[] = [];
  for (const msg of msgs) {
    const s = msg?.entities?.sentiment?.basic;
    if (s === "Bullish") bull++;
    else if (s === "Bearish") bear++;
    if (msg?.body) bodies.push(String(msg.body).replace(/\s+/g, " ").slice(0, 180));
  }
  const labeled = bull + bear;
  return {
    watchers: Number(d.symbol?.watchlist_count ?? 0),
    messages: msgs.length,
    bullish: bull, bearish: bear, labeled,
    bull_pct: labeled ? Math.round((bull / labeled) * 100) : null,
    bodies: bodies.slice(0, 12),
  };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overview: { type: "string" },
    markets: { type: "string" },
    signal_rationale: { type: "string" },
    news_summary: { type: "string" },
    management_assessment: { type: "string" },
    sentiment_summary: { type: "string" },
    topics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { topic: { type: "string" }, sentiment: { type: "string" } },
        required: ["topic", "sentiment"],
      },
    },
  },
  required: ["overview", "markets", "signal_rationale", "news_summary", "management_assessment", "sentiment_summary", "topics"],
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

    const { data: cached } = await supabase.from("stock_summaries").select("*").eq("ticker", ticker).maybeSingle();
    if (cached?.generated_at) {
      const ageH = (Date.now() - new Date(cached.generated_at).getTime()) / 3.6e6;
      if (ageH < TTL_HOURS) return json({ ...cached, cached: true });
    }

    const [w, q, v, us, ins] = await Promise.all([
      supabase.from("watchlist").select("name,sector,industry").eq("ticker", ticker).maybeSingle(),
      supabase.from("quality_scores").select("*").eq("ticker", ticker).maybeSingle(),
      supabase.from("value_scores").select("*").eq("ticker", ticker).maybeSingle(),
      supabase.from("universe_stats").select("quality_median,value_median").maybeSingle(),
      supabase.from("api_cache").select("data").eq("ticker", ticker).eq("endpoint", "fh:insiders").maybeSingle(),
    ]);
    if (!w.data) return json({ error: `unknown ticker ${ticker}` }, 404);

    const qd = q.data, vd = v.data;
    const qComposite = num(qd?.composite_score), vComposite = num(vd?.composite_score);
    const qMed = num(us.data?.quality_median) ?? 50, vMed = num(us.data?.value_median) ?? 50;
    const signal = classify(qComposite, vComposite, qMed, vMed);

    // ---- Management ----
    const signals = mgmtSignals(qd);
    const insiders = insiderRoster(ins.data?.data);

    // ---- Recent company news ----
    const apiKey = await getSecret(supabase, "FINNHUB_API_KEY");
    let news: { headline: string; source: string; url: string; datetime: string }[] = [];
    if (apiKey) {
      const to = new Date(), from = new Date(Date.now() - NEWS_DAYS * 864e5);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const url = `${FINNHUB}/api/v1/company-news?symbol=${ticker}&from=${fmt(from)}&to=${fmt(to)}&token=${apiKey}`;
      const r = await fetchWithCache(supabase, ticker, "fh:news", url, 21600, FH_BUDGET).catch(() => null);
      const arr = (Array.isArray(r?.data) ? r!.data : []) as Any[];
      news = arr.filter((a) => a?.headline)
        .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0))
        .slice(0, NEWS_MAX)
        .map((a) => ({
          headline: String(a.headline), source: String(a.source ?? ""),
          url: String(a.url ?? ""), datetime: new Date((a.datetime ?? 0) * 1000).toISOString().slice(0, 10),
        }));
    }

    // ---- StockTwits + trend vs last snapshot ----
    const st = await stocktwits(supabase, ticker);
    const prevSt = (cached?.sentiment as Any)?.stocktwits;
    const trend = (cur: number | null | undefined, prev: number | null | undefined) =>
      cur == null || prev == null ? "flat" : cur > prev * 1.03 ? "up" : cur < prev * 0.97 ? "down" : "flat";

    // ---- Model inputs ----
    const facts = [
      `Company: ${w.data.name ?? ticker} (${ticker})`,
      `Sector: ${w.data.sector ?? "n/a"}${w.data.industry ? ` · Industry: ${w.data.industry}` : ""}`,
      signal ? `Signal: ${signal} (${SIGNALS[signal]}) — quality ${Math.round(qComposite!)} vs median ${Math.round(qMed)}, value ${Math.round(vComposite!)} vs ${Math.round(vMed)}` : "Signal: not yet scored",
      `Quality ${qComposite == null ? "n/a" : Math.round(qComposite)}/100 (conf ${qd?.confidence ?? "n/a"}). Piotroski ${qd?.piotroski_score ?? "n/a"}/9, Altman Z ${fix(qd?.altman_z)} (${qd?.altman_zone ?? "n/a"}), ROIC ${pct(qd?.roic_current)}, moat ${qd?.moat_score == null ? "n/a" : Math.round(Number(qd.moat_score))}/100.`,
      `Value ${vComposite == null ? "n/a" : Math.round(vComposite)}/100. P/E ${fix(vd?.pe_ratio)} vs sector ${fix(vd?.pe_vs_sector_median)}, FCF yield ${pct(vd?.fcf_yield)}, EV/EBITDA ${fix(vd?.ev_ebitda)}, EY-vs-bond ${pct(vd?.ey_vs_bond_spread)}, dividend ${pct(vd?.dividend_yield)}, DCF MoS ${vd?.margin_of_safety == null ? "n/a" : pct(vd.margin_of_safety, 0)}.`,
      "",
      "MANAGEMENT QUALITY SIGNALS (0-100, higher = better):",
      ...signals.map((s) => `- ${s.label}: ${s.score ?? "n/a"} — ${s.value}`),
      insiders.length ? `Named insiders (SEC Form 4; shares held, net change last 12mo):\n${insiders.map((i) => `- ${i.name}: ${i.shares.toLocaleString()} shares, net ${i.net_1y >= 0 ? "+" : ""}${i.net_1y.toLocaleString()} (last ${i.last ?? "n/a"})`).join("\n")}` : "Named insiders: none in recent filings.",
      "",
      st ? `STOCKTWITS (retail): ${st.messages} recent messages, ${st.labeled} sentiment-tagged → ${st.bullish} bullish / ${st.bearish} bearish (${st.bull_pct ?? "n/a"}% bullish); ${st.watchers.toLocaleString()} watchers.` : "StockTwits: unavailable.",
      st?.bodies?.length ? `Sample retail messages:\n${st.bodies.map((b) => `- ${b}`).join("\n")}` : "",
      news.length ? `Recent headlines:\n${news.map((n) => `- (${n.datetime}) ${n.headline} [${n.source}]`).join("\n")}` : "Recent headlines: none found.",
    ].join("\n");

    const system =
      "You are an equity-research assistant for NEWNFL, which scores stocks on Quality and Value and places them in a " +
      "BUY/WATCH/AVOID/SELL quadrant. Write concise, neutral, decision-oriented prose for a thoughtful retail investor. " +
      "Use ONLY the supplied facts — never invent figures, prices, names, or events. Research, not investment advice. Return JSON only.\n\n" +
      "Fields:\n" +
      "- overview: 2-3 sentences on what the company does and how it makes money.\n" +
      "- markets: 1-2 sentences on its end-markets and main competitors.\n" +
      "- signal_rationale: 3-4 sentences on why the signal is what it is, tying explicitly to quality and value scores; name the main risk. If unscored, say so.\n" +
      "- news_summary: 1-3 sentences synthesizing only material recent headlines, else 'No material company-specific news in the past two weeks.'\n" +
      "- management_assessment: 3-4 sentences of candid assessment of management quality, grounded ONLY in the five signals and insider activity above (capital allocation, capital efficiency, accounting integrity, insider conviction, dilution). Be balanced — credit strengths, flag weaknesses. Do not invent executive names or biographies.\n" +
      "- sentiment_summary: 2-3 sentences on the current mood from StockTwits retail chatter and the news flow — note whether retail is bullish or bearish and whether it aligns with the fundamentals. If StockTwits is unavailable, say sentiment data is limited.\n" +
      "- topics: 3-6 trending topics extracted from the headlines and retail messages (e.g. 'AI integration', 'iPhone 17', 'China demand'), each with a sentiment of 'positive' | 'negative' | 'neutral' | 'mixed'. If there's little to extract, return fewer.";

    const anthropicKey = await getSecret(supabase, "ANTHROPIC_API_KEY");
    if (!anthropicKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 503);

    const aiResp = await fetch(ANTHROPIC, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1600, system,
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

    const management = { signals, insiders, assessment: parsed.management_assessment ?? null };
    const sentiment = {
      summary: parsed.sentiment_summary ?? null,
      topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 6) : [],
      stocktwits: st ? {
        watchers: st.watchers, messages: st.messages, bullish: st.bullish, bearish: st.bearish,
        bull_pct: st.bull_pct, labeled: st.labeled,
        watchers_trend: trend(st.watchers, prevSt?.watchers),
        bull_trend: trend(st.bull_pct, prevSt?.bull_pct),
      } : null,
      sources: {
        stocktwits: st ? "live" : "unavailable",
        news: news.length ? "live" : "none",
        reddit: "no free programmatic feed",
        twitter: "no free programmatic feed",
      },
    };

    const row = {
      ticker,
      overview: parsed.overview ?? null,
      markets: parsed.markets ?? null,
      signal,
      rationale: parsed.signal_rationale ?? null,
      news_summary: parsed.news_summary ?? null,
      news,
      management,
      sentiment,
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
