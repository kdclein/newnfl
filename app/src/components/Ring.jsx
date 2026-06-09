// Score ring: an SVG arc proportional to a 0-100 score with the number centered.
export default function Ring({ value, size = 56, stroke = 5, color = "#5eead4", label }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value)) / 100;
  return (
    <div className="inline-flex flex-col items-center gap-1">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
          style={{ transition: "stroke-dashoffset .6s ease" }}
        />
        <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle"
          className="rotate-90 fill-white font-mono tabular" style={{ fontSize: size * 0.3, transformOrigin: "center" }}>
          {value == null ? "—" : Math.round(value)}
        </text>
      </svg>
      {label && <span className="text-[10px] uppercase tracking-wider text-white/40">{label}</span>}
    </div>
  );
}
