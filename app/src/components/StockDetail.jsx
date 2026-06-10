import { useEffect, useState } from "react";
import Ring from "./Ring.jsx";
import Sparkline from "./Sparkline.jsx";
import { unified } from "../lib/scoring.js";
import { QUALITY_META, VALUE_META, PIOTROSKI_LABELS, components, scoreColor } from "../lib/detail.js";

// A single component of a score: name + what it measures, a 0-100 bar, its
// weight, the points it contributes to the composite, and the raw metrics.
function ComponentRow({ c }) {
  const w = c.score == null ? 0 : Math.max(0, Math.min(100, c.score));
  return (
    <div className="py-2.5 border-t border-white/5 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13px] font-medium text-white/85">{c.label}</div>
        <div className="font-mono tabular text-[11px] text-white/45 whitespace-nowrap">
          {c.score == null ? <span className="text-white/30">n/a</span> : Math.round(c.score)}
          <span className="text-white/25"> · {c.weight != null ? `${Math.round(c.weight * 100)}%` : "—"} wt</span>
        </div>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${w}%`, background: scoreColor(c.score) }} />
      </div>
      <p className="text-white/35 text-[11px] mt-1.5 leading-snug">{c.blurb}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5">
        {c.metrics.map(([k, val]) => (
          <span key={k} className="font-mono text-[11px] tabular">
            <span className="text-white/35">{k} </span><span className="text-white/80">{val}</span>
          </span>
        ))}
        {c.contribution != null && (
          <span className="font-mono text-[11px] tabular ml-auto text-white/45">
            +{c.contribution.toFixed(1)} pts
          </span>
        )}
      </div>
    </div>
  );
}

function Column({ title, hue, composite, rows, footer }) {
  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs uppercase tracking-wider font-semibold" style={{ color: hue }}>{title}</h3>
        <span className="font-mono tabular text-sm text-white/80">{composite == null ? "—" : Math.round(composite)}</span>
      </div>
      {rows.map((c) => <ComponentRow key={c.key} c={c} />)}
      {footer}
    </section>
  );
}

export default function StockDetail({ data, loading, onClose }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function copyLink() {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  const qRows = components(data?.qDetail, QUALITY_META);
  const vRows = components(data?.vDetail, VALUE_META);
  const sub = data?.piotroskiSub || {};
  const qHist = data?.qHist || {};
  const uni = data ? unified(data.q, data.v) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 sm:p-6 overflow-y-auto"
      onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative card w-full max-w-[920px] my-auto p-5 sm:p-6"
        onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-2xl font-bold">{data?.ticker || "…"}</span>
              {data?.sig && (
                <span className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide"
                  style={{ color: data.sig.color, background: data.sig.color + "1a" }}>{data.sig.label}</span>
              )}
            </div>
            <div className="text-white/50 text-sm mt-0.5">{data?.name}</div>
            <div className="text-white/35 text-xs">{data?.sector}{data?.sig ? ` · ${data.sig.quadrant}` : ""}</div>
          </div>
          <div className="flex items-center gap-3">
            <Ring value={data?.q} color="#5eead4" label="Quality" />
            <Ring value={data?.v} color="#818cf8" label="Value" />
            <Ring value={uni} color="#e8e8f0" label="Q×V" />
            <div className="flex flex-col items-end gap-1 self-start">
              <button onClick={onClose} aria-label="Close"
                className="text-white/40 hover:text-white text-xl leading-none px-1">×</button>
              <button onClick={copyLink} title="Copy a shareable link to this breakdown"
                className="text-[10px] text-white/40 hover:text-white/80 transition whitespace-nowrap">
                {copied ? "✓ copied" : "🔗 copy link"}
              </button>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="h-48 grid place-items-center text-white/30 text-sm">loading the breakdown…</div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2 mt-5">
              <Column title="Quality — is it a great business?" hue="#5eead4" composite={data?.q} rows={qRows}
                footer={
                  <div className="border-t border-white/5 mt-1 pt-3">
                    <div className="text-[11px] uppercase tracking-wider text-white/35 mb-2">Piotroski signals</div>
                    <div className="grid grid-cols-1 gap-y-1">
                      {Object.entries(PIOTROSKI_LABELS).map(([k, label]) => {
                        const on = sub[k] === true, known = k in sub;
                        return (
                          <div key={k} className="flex items-center gap-2 text-[11px]">
                            <span className="font-mono" style={{ color: !known ? "#6b7280" : on ? "#34d399" : "#f87171" }}>
                              {!known ? "·" : on ? "✓" : "✗"}
                            </span>
                            <span className={known ? "text-white/65" : "text-white/30"}>{label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                } />
              <Column title="Value — what am I paying for it?" hue="#818cf8" composite={data?.v} rows={vRows} />
            </div>

            {/* History */}
            {(qHist.roic || qHist.revenue || qHist.gross_margin) && (
              <section className="card p-4 mt-4">
                <div className="text-[11px] uppercase tracking-wider text-white/35 mb-3">History (last {Math.max(
                  qHist.roic?.length || 0, qHist.revenue?.length || 0, qHist.gross_margin?.length || 0)} yrs)</div>
                <div className="flex flex-wrap gap-x-8 gap-y-3">
                  <Trend label="ROIC" data={qHist.roic} color="#5eead4" fmt={(x) => `${(x * 100).toFixed(1)}%`} />
                  <Trend label="Gross margin" data={qHist.gross_margin} color="#5eead4" fmt={(x) => `${(x * 100).toFixed(0)}%`} />
                  <Trend label="Revenue" data={qHist.revenue} color="#a78bfa"
                    fmt={(x) => x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(0)}M`} />
                </div>
              </section>
            )}

            <p className="text-white/30 text-[10px] mt-4 leading-snug">
              Composite = weighted sum of component scores (0–100). Components marked n/a lack source data and are
              excluded, with remaining weights renormalized. Decomposable and for research, not investment advice.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Trend({ label, data, color, fmt: f }) {
  if (!data || data.length < 2) return null;
  return (
    <div>
      <div className="text-white/45 text-[11px] mb-1">{label}</div>
      <Sparkline data={data} color={color} fmt={f} />
    </div>
  );
}
