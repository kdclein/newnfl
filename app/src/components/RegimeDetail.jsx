import { useEffect } from "react";
import Ring from "./Ring.jsx";
import { scoreColor } from "../lib/detail.js";
import { CYCLE_LABEL } from "../lib/scoring.js";

// The six macro indicators behind the regime composite. `scale` converts the
// stored value to a human number: decimal YoY/spread series are ×100, while
// unemployment and the fed funds rate are already quoted in percent.
const META = [
  { key: "gdp_growth",   label: "Real GDP growth",     unit: "%",  scale: 100, dp: 1,
    blurb: "Year-over-year change in real output. Expansion is favorable." },
  { key: "unemployment", label: "Unemployment rate",   unit: "%",  scale: 1,   dp: 1,
    blurb: "Share of the labor force out of work. Lower is more favorable for deploying capital." },
  { key: "inflation",    label: "Inflation (CPI YoY)", unit: "%",  scale: 100, dp: 1,
    blurb: "Consumer prices vs a year ago. Healthiest near the ~2% target; both extremes hurt." },
  { key: "fed_funds",    label: "Fed funds rate",      unit: "%",  scale: 1,   dp: 2,
    blurb: "The policy rate. Higher means a more restrictive environment." },
  { key: "yield_curve",  label: "Yield curve (10Y–2Y)", unit: " pp", scale: 100, dp: 2,
    blurb: "Term spread. Positive/steep is healthy; inversion has preceded recessions." },
  { key: "payrolls",     label: "Payroll growth",      unit: "%",  scale: 100, dp: 1,
    blurb: "Year-over-year change in nonfarm payrolls. Positive is favorable." },
];

function IndicatorRow({ m, ind }) {
  const value = ind?.value == null ? null : Number(ind.value);
  const score = ind?.score == null ? null : Number(ind.score);
  const w = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div className="py-2.5 border-t border-white/5 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13px] font-medium text-white/85">{m.label}</div>
        <div className="font-mono tabular text-[12px] text-white/80 whitespace-nowrap">
          {value == null ? <span className="text-white/30">n/a</span> : `${(value * m.scale).toFixed(m.dp)}${m.unit}`}
          <span className="text-white/30"> · {score == null ? "—" : Math.round(score)}</span>
        </div>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${w}%`, background: scoreColor(score) }} />
      </div>
      <p className="text-white/35 text-[11px] mt-1.5 leading-snug">{m.blurb}</p>
    </div>
  );
}

export default function RegimeDetail({ regime, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ind = regime?.indicators || {};
  const composite = regime?.composite_score == null ? null : Number(regime.composite_score);
  const recession = regime?.recession_probability == null ? null : Number(regime.recession_probability);

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-3 sm:p-6 overflow-y-auto"
      onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative card w-full max-w-[620px] my-auto p-5 sm:p-6" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Ring value={composite} size={56} stroke={5} color="#f59e0b" label="Regime" />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40">Market regime</div>
              <div className="text-lg font-semibold">{CYCLE_LABEL[regime?.cycle_phase] || "—"}</div>
              <div className="text-[11px] text-white/45 font-mono">
                recession prob {recession == null ? "—" : Math.round(recession * 100) + "%"}
              </div>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="text-white/40 hover:text-white text-xl leading-none px-1">×</button>
        </div>

        <section className="card p-4 mt-5">
          <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1">Indicators</div>
          {META.map((m) => <IndicatorRow key={m.key} m={m} ind={ind[m.key]} />)}
        </section>

        <p className="text-white/30 text-[10px] mt-4 leading-snug">
          Composite is the average of the indicator scores (0–100). Regime <em>describes</em> the environment;
          macro-based factor timing has weak empirical support, so it does not predict turns — use it to calibrate
          position sizing and margin of safety, not to call tops or bottoms.
        </p>
      </div>
    </div>
  );
}
