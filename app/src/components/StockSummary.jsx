import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase.js";
import { SIGNALS } from "../lib/scoring.js";

// AI-written dossier for one stock — lazily fetched (and server-cached ~24h)
// from the summarize-stock edge function when the modal opens. Renders overview/
// rationale/news plus a Management section (5 scored signals + real SEC insiders
// + AI assessment) and a Sentiment section (StockTwits + NLP topics).
const SIG_COLOR = {
  BUY: SIGNALS.BUY.color, WATCH: SIGNALS.WATCH.color,
  AVOID: SIGNALS.AVOID.color, SELL: SIGNALS.SELL.color,
};
const SIGNAL_COLOR = {
  favorable: "#34d399", neutral: "#9ca3af", caution: "#fbbf24", warning: "#f87171", na: "#6b7280",
};
const TOPIC_COLOR = {
  positive: "#34d399", negative: "#f87171", neutral: "#9ca3af", mixed: "#fbbf24",
};
const TREND = { up: { c: "#34d399", g: "↑" }, down: { c: "#f87171", g: "↓" }, flat: { c: "#9ca3af", g: "→" } };

const shares = (n) => {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
};

function Line({ w = "100%" }) {
  return <div className="h-2.5 rounded bg-white/[0.06] animate-pulse" style={{ width: w }} />;
}

function SignalBar({ s }) {
  const c = SIGNAL_COLOR[s.signal] || SIGNAL_COLOR.na;
  const w = s.score == null ? 0 : Math.max(0, Math.min(100, s.score));
  return (
    <div className="py-1.5 border-t border-white/5 first:border-t-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-white/80">{s.label}</span>
        <span className="font-mono tabular text-[11px] whitespace-nowrap">
          <span className="text-white/75">{s.value}</span>
          <span className="text-white/30"> · {s.score == null ? "n/a" : Math.round(s.score)}</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${w}%`, background: c }} />
      </div>
    </div>
  );
}

export default function StockSummary({ ticker }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    supabase.functions.invoke("summarize-stock", { body: { ticker } })
      .then(({ data, error }) => {
        if (!alive) return;
        if (error || !data || data.error) setState({ loading: false, error: true });
        else setState({ loading: false, data });
      })
      .catch(() => { if (alive) setState({ loading: false, error: true }); });
    return () => { alive = false; };
  }, [ticker]);

  if (state.error) {
    return (
      <section className="card p-4 mt-5">
        <div className="text-[11px] uppercase tracking-wider text-white/35">AI summary</div>
        <p className="text-white/35 text-xs mt-1.5">Summary unavailable right now.</p>
      </section>
    );
  }

  if (state.loading) {
    return (
      <section className="card p-4 mt-5">
        <div className="text-[11px] uppercase tracking-wider text-white/35 mb-2">AI summary</div>
        <div className="space-y-2"><Line /><Line w="92%" /><Line w="70%" /></div>
        <div className="text-white/30 text-[10px] mt-3 font-mono animate-pulse">researching the company…</div>
      </section>
    );
  }

  const s = state.data;
  const color = s.signal ? SIG_COLOR[s.signal] : "#9aa0aa";
  const when = s.generated_at ? new Date(s.generated_at).toLocaleDateString() : null;
  const mgmt = s.management, sent = s.sentiment;
  const st = sent?.stocktwits;

  return (
    <>
      {/* ---- AI summary ---- */}
      <section className="card p-4 mt-5">
        <div className="text-[11px] uppercase tracking-wider text-white/35 mb-2">AI summary</div>
        {s.overview && <p className="text-[13px] text-white/85 leading-relaxed">{s.overview}</p>}
        {s.markets && <p className="text-white/55 text-xs leading-relaxed mt-1.5">{s.markets}</p>}
        {s.rationale && (
          <div className="mt-3 rounded-md px-3 py-2 leading-relaxed text-[13px] text-white/85"
            style={{ background: color + "12", borderLeft: `2px solid ${color}` }}>
            <span className="font-semibold" style={{ color }}>Why {s.signal || "—"}:</span> {s.rationale}
          </div>
        )}
        {s.news_summary && (
          <div className="mt-3">
            <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1">Latest news</div>
            <p className="text-white/75 text-xs leading-relaxed">{s.news_summary}</p>
            {Array.isArray(s.news) && s.news.length > 0 && (
              <ul className="mt-2 space-y-1">
                {s.news.slice(0, 4).map((n, i) => (
                  <li key={i} className="text-[11px] leading-snug">
                    <span className="text-white/30 font-mono">{n.datetime}</span>{" "}
                    {n.url
                      ? <a href={n.url} target="_blank" rel="noreferrer" className="text-white/65 hover:text-white underline decoration-white/20">{n.headline}</a>
                      : <span className="text-white/65">{n.headline}</span>}
                    {n.source && <span className="text-white/30"> · {n.source}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="text-white/25 text-[10px] mt-3 leading-snug">
          AI-generated{s.model ? ` by ${s.model}` : ""}{when ? ` · ${when}` : ""} from the scores and recent headlines —
          may contain errors, and is research, not investment advice.
        </p>
      </section>

      {/* ---- Management ---- */}
      {mgmt && (Array.isArray(mgmt.signals) || mgmt.assessment) && (
        <section className="card p-4 mt-4">
          <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1">Management quality</div>
          {Array.isArray(mgmt.signals) && mgmt.signals.map((sig) => <SignalBar key={sig.id} s={sig} />)}

          {Array.isArray(mgmt.insiders) && mgmt.insiders.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1.5">Insiders (SEC Form 4)</div>
              <div className="grid grid-cols-1 gap-y-1">
                {mgmt.insiders.map((p, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-3 text-[11px] font-mono tabular">
                    <span className="text-white/70 font-sans truncate">{p.name}</span>
                    <span className="whitespace-nowrap">
                      <span className="text-white/55">{shares(p.shares)} sh</span>
                      <span style={{ color: p.net_1y > 0 ? "#34d399" : p.net_1y < 0 ? "#f87171" : "#9ca3af" }}>
                        {" "}{p.net_1y >= 0 ? "+" : ""}{shares(p.net_1y)}/yr
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {mgmt.assessment && (
            <p className="text-white/70 text-xs leading-relaxed mt-3">{mgmt.assessment}</p>
          )}
        </section>
      )}

      {/* ---- Sentiment ---- */}
      {sent && (st || sent.summary || (sent.topics || []).length > 0) && (
        <section className="card p-4 mt-4">
          <div className="text-[11px] uppercase tracking-wider text-white/35 mb-2">Sentiment</div>

          {st && (
            <div className="mb-3">
              <div className="flex items-baseline justify-between text-[11px] font-mono tabular mb-1">
                <span className="text-white/55">StockTwits retail</span>
                <span className="text-white/70">
                  {st.bull_pct == null ? "—" : `${st.bull_pct}% bullish`}
                  <span className="text-white/30"> ({st.bullish}▲ / {st.bearish}▼ of {st.labeled} tagged)</span>
                </span>
              </div>
              <div className="h-2 rounded-full overflow-hidden flex bg-white/[0.06]">
                <div style={{ width: `${st.bull_pct ?? 50}%`, background: "#34d399" }} />
                <div style={{ width: `${100 - (st.bull_pct ?? 50)}%`, background: "#f87171" }} />
              </div>
              <div className="flex items-center gap-4 mt-1.5 text-[11px] font-mono tabular text-white/45">
                <span>{st.messages} recent msgs</span>
                <span>
                  {st.watchers.toLocaleString()} watchers{" "}
                  <span style={{ color: (TREND[st.watchers_trend] || TREND.flat).c }}>
                    {(TREND[st.watchers_trend] || TREND.flat).g}
                  </span>
                </span>
                {st.bull_trend && st.bull_trend !== "flat" && (
                  <span style={{ color: (TREND[st.bull_trend] || TREND.flat).c }}>
                    mood {(TREND[st.bull_trend]).g}
                  </span>
                )}
              </div>
            </div>
          )}

          {Array.isArray(sent.topics) && sent.topics.length > 0 && (
            <div className="mb-3">
              <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1.5">Trending topics (NLP)</div>
              <div className="flex flex-wrap gap-1.5">
                {sent.topics.map((t, i) => {
                  const c = TOPIC_COLOR[t.sentiment] || TOPIC_COLOR.neutral;
                  return (
                    <span key={i} className="rounded-full px-2 py-0.5 text-[11px]"
                      style={{ color: c, background: c + "1a", border: `1px solid ${c}33` }}>
                      {t.topic}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {sent.summary && <p className="text-white/70 text-xs leading-relaxed">{sent.summary}</p>}

          <p className="text-white/25 text-[10px] mt-3 leading-snug">
            Sources: StockTwits (live retail) + company news NLP. Reddit and Twitter/X have no free programmatic feed and are not included.
          </p>
        </section>
      )}
    </>
  );
}
