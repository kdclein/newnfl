import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase.js";
import Ring from "./Ring.jsx";
import Sparkline from "./Sparkline.jsx";
import { CYCLE_LABEL } from "../lib/scoring.js";

// Full macro dashboard: 22+ indicators in four categories, each with current
// value, historical norm, signal classification, and an analytical note.
// Data comes from the macro_indicators table (written daily by refresh-macro).
const CATS = [
  { id: "valuation", icon: "📊", label: "Market Valuation" },
  { id: "sentiment", icon: "🧭", label: "Sentiment & Positioning" },
  { id: "credit", icon: "🏦", label: "Credit & Rates" },
  { id: "labor", icon: "👷", label: "Labor & Economy" },
];

const SIG = {
  favorable: { label: "favorable", color: "#34d399" },
  neutral: { label: "neutral", color: "#9ca3af" },
  caution: { label: "caution", color: "#fbbf24" },
  warning: { label: "warning", color: "#f87171" },
  na: { label: "n/a", color: "#6b7280" },
};

function IndicatorRow({ r }) {
  const sig = SIG[r.signal] || SIG.na;
  return (
    <div className="py-2.5 border-t border-white/5 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[13px] font-medium text-white/85">{r.label}</span>
          <span className="rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide uppercase whitespace-nowrap"
            style={{ color: sig.color, background: sig.color + "1a" }}>{sig.label}</span>
        </div>
        <div className="font-mono tabular text-[12px] whitespace-nowrap">
          <span className="text-white/90 font-semibold">{r.display ?? "—"}</span>
          {r.percentile != null && <span className="text-white/35"> · {r.percentile}th pctl</span>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 mt-0.5">
        <span className="text-white/35 text-[11px] font-mono">{r.norm}</span>
        {Array.isArray(r.history) && r.history.length > 1 && (
          <Sparkline data={r.history} color={sig.color} w={84} h={20} />
        )}
      </div>
      <p className="text-white/40 text-[11px] mt-1 leading-snug">{r.explanation}</p>
    </div>
  );
}

export default function MacroDashboard({ regime, onClose }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    supabase.from("macro_indicators").select("*").order("sort_order")
      .then(({ data }) => setRows(data || []));
  }, []);

  const composite = regime?.composite_score != null ? Number(regime.composite_score) : null;
  const recession = regime?.recession_probability != null ? Number(regime.recession_probability) : null;
  const updated = rows?.[0]?.updated_at ? new Date(rows[0].updated_at).toLocaleDateString() : null;
  const model = regime?.indicators?.recession_model;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 sm:p-6 overflow-y-auto" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative card w-full max-w-[980px] my-4 p-5 sm:p-6" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Ring value={composite} size={56} stroke={5} color="#f59e0b" label="Macro" />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40">🌐 Macro dashboard</div>
              <div className="text-lg font-semibold">
                {CYCLE_LABEL[regime?.cycle_phase] || "—"}
                <span className="text-white/45 text-sm font-normal"> · credit cycle</span>
              </div>
              <div className="text-[11px] text-white/45 font-mono">
                recession probability {recession == null ? "—" : Math.round(recession * 100) + "%"}
                {model && <span className="text-white/30"> (yield-curve probit{model.sahm_gap != null ? ` · Sahm +${model.sahm_gap}` : ""} · credit)</span>}
              </div>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="text-white/40 hover:text-white text-xl leading-none px-1">×</button>
        </div>

        {rows == null ? (
          <div className="h-40 grid place-items-center text-white/30 text-sm">loading indicators…</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 mt-5 items-start">
            {CATS.map((c) => (
              <section key={c.id} className="card p-4">
                <h3 className="text-xs uppercase tracking-wider font-semibold text-white/60 mb-1">
                  {c.icon} {c.label}
                </h3>
                {rows.filter((r) => r.category === c.id).map((r) => <IndicatorRow key={r.id} r={r} />)}
              </section>
            ))}
          </div>
        )}

        <p className="text-white/30 text-[10px] mt-4 leading-snug">
          Updated {updated || "—"} · daily · sources: FRED (St. Louis Fed), multpl.com, and self-computed aggregates from
          our S&P 500 universe. Proprietary series (ISM, Conference Board LEI/Confidence, AAII, CNN Fear/Greed, Fed dot plot)
          are replaced with documented substitutes, labeled in each note. Recession probability follows the Estrella–Mishkin
          yield-curve probit, floored by the Sahm rule and adjusted for high-yield credit stress. Macro describes the
          environment — it does not predict turns. Research, not investment advice.
        </p>
      </div>
    </div>
  );
}
