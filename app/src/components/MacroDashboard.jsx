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

// One-year-ahead regime probabilities (Wells Fargo-style ordered probit).
const REGIMES = [
  { id: "soft_landing", label: "Soft landing", color: "#34d399",
    note: "growth holds, inflation contained" },
  { id: "stagflation", label: "Stagflation", color: "#fbbf24",
    note: "sticky inflation with sub-trend growth" },
  { id: "recession", label: "Recession", color: "#f87171",
    note: "broad contraction (NBER-defined)" },
];

function RegimeProbit({ probs, inputs }) {
  if (!probs) return null;
  const top = REGIMES.reduce((a, b) => ((probs[b.id] ?? 0) > (probs[a.id] ?? 0) ? b : a), REGIMES[0]);
  return (
    <section className="card p-4 mt-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h3 className="text-xs uppercase tracking-wider font-semibold text-white/60">
          🧮 One-Year-Ahead Regime Outlook
        </h3>
        <span className="text-[10px] text-white/40">
          base case: <span style={{ color: top.color }} className="font-semibold">{top.label}</span>
        </span>
      </div>
      <div className="mt-3 space-y-2.5">
        {REGIMES.map((rg) => {
          const p = probs[rg.id] != null ? Number(probs[rg.id]) : null;
          const pct = p == null ? 0 : Math.round(p * 100);
          const flag = rg.id === "recession" && p != null && p >= 0.33;
          return (
            <div key={rg.id}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] font-medium text-white/85">
                  {rg.label}
                  {flag && <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wide"
                    style={{ color: rg.color }}>· 33% threshold</span>}
                </span>
                <span className="font-mono tabular text-[12px] font-semibold" style={{ color: rg.color }}>
                  {p == null ? "—" : pct + "%"}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                <div className="h-full rounded-full" style={{ width: pct + "%", background: rg.color }} />
              </div>
              <p className="text-white/35 text-[10px] mt-0.5">{rg.note}</p>
            </div>
          );
        })}
      </div>
      {inputs && (
        <div className="mt-3 pt-2 border-t border-white/5 text-[10px] text-white/40 font-mono flex flex-wrap gap-x-3 gap-y-0.5">
          <span>10Y−3M {inputs.term_10y3m >= 0 ? "+" : ""}{inputs.term_10y3m}pp</span>
          <span>CPI {inputs.cpi_yoy}% YoY</span>
          <span>IP {inputs.indpro_yoy >= 0 ? "+" : ""}{inputs.indpro_yoy}% YoY</span>
          {inputs.sahm_gap != null && <span>Sahm +{inputs.sahm_gap}</span>}
        </div>
      )}
      <p className="text-white/30 text-[10px] mt-2 leading-snug">
        An ordered-probit reconstruction of the Wells Fargo Economics (Azhar Iqbal) recession/stagflation/soft-landing
        framework. We fit our own probit on 70 years of FRED history (1955–2026) across the same economic pillars —
        rates, prices, output, labor — and validate it the way Wells Fargo validates theirs: a 33% classification
        threshold reproduces 9 of 10 in-sample NBER recessions (recession AUC ≈ 0.84). Coefficients are our own
        estimates, not Wells Fargo's proprietary ones (their paper is paywalled), so this is a documented replication.
      </p>
    </section>
  );
}


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

        <RegimeProbit probs={regime?.indicators?.wells_ordered} inputs={regime?.indicators?.wells_inputs} />

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
