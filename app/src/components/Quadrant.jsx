import { classify } from "../lib/scoring.js";

// Quality (y) × Value (x) scatter with adaptive median crosshairs. Hand-rolled
// SVG so there's no chart dependency and full control over the dark theme.
export default function Quadrant({ rows, qMed, vMed, selected, onSelect }) {
  const W = 560, H = 460, pad = 36;
  const sx = (v) => pad + (v / 100) * (W - 2 * pad);
  const sy = (q) => H - pad - (q / 100) * (H - 2 * pad);
  const xMed = sx(vMed ?? 50), yMed = sy(qMed ?? 50);

  const quadrants = [
    { x: xMed, y: pad, w: W - pad - xMed, h: yMed - pad, label: "BUY", fill: "#34d39911" },
    { x: pad, y: pad, w: xMed - pad, h: yMed - pad, label: "WATCH", fill: "#fbbf2410" },
    { x: xMed, y: yMed, w: W - pad - xMed, h: H - pad - yMed, label: "AVOID", fill: "#f59e0b10" },
    { x: pad, y: yMed, w: xMed - pad, h: H - pad - yMed, label: "SELL", fill: "#f8717110" },
  ];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {quadrants.map((q) => (
        <g key={q.label}>
          <rect x={q.x} y={q.y} width={Math.max(0, q.w)} height={Math.max(0, q.h)} fill={q.fill} />
          <text x={q.x + q.w / 2} y={q.y + q.h / 2} textAnchor="middle"
            className="fill-white/10 font-sans font-bold" style={{ fontSize: 34 }}>{q.label}</text>
        </g>
      ))}

      {/* median crosshair */}
      <line x1={xMed} y1={pad} x2={xMed} y2={H - pad} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 4" />
      <line x1={pad} y1={yMed} x2={W - pad} y2={yMed} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 4" />

      {/* axis labels */}
      <text x={W / 2} y={H - 6} textAnchor="middle" className="fill-value/70 font-mono" style={{ fontSize: 11 }}>VALUE →</text>
      <text x={12} y={H / 2} textAnchor="middle" transform={`rotate(-90 12 ${H / 2})`}
        className="fill-quality/70 font-mono" style={{ fontSize: 11 }}>QUALITY →</text>

      {rows.map((r) => {
        if (r.q == null || r.v == null) return null;
        const sig = classify(r.q, r.v, qMed, vMed);
        const isSel = selected === r.ticker;
        return (
          <circle key={r.ticker} cx={sx(r.v)} cy={sy(r.q)} r={isSel ? 7 : 4}
            fill={sig.color} fillOpacity={isSel ? 1 : 0.78}
            stroke={isSel ? "#fff" : "none"} strokeWidth={isSel ? 1.5 : 0}
            className="cursor-pointer hover:r-6" onClick={() => onSelect(r.ticker)}>
            <title>{r.ticker} — Q {Math.round(r.q)} / V {Math.round(r.v)} — {sig.label}</title>
          </circle>
        );
      })}
    </svg>
  );
}
