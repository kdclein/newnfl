import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase.js";
import { SIGNALS } from "../lib/scoring.js";

// AI-written summary for one stock — lazily fetched (and server-cached ~24h)
// from the summarize-stock edge function when the modal opens.
const SIG_COLOR = {
  BUY: SIGNALS.BUY.color, WATCH: SIGNALS.WATCH.color,
  AVOID: SIGNALS.AVOID.color, SELL: SIGNALS.SELL.color,
};

function Line({ w = "100%" }) {
  return <div className="h-2.5 rounded bg-white/[0.06] animate-pulse" style={{ width: w }} />;
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
        <div className="text-white/30 text-[10px] mt-3 font-mono animate-pulse">writing the brief…</div>
      </section>
    );
  }

  const s = state.data;
  const color = s.signal ? SIG_COLOR[s.signal] : "#9aa0aa";
  const when = s.generated_at ? new Date(s.generated_at).toLocaleDateString() : null;

  return (
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
  );
}
