// Minimal SVG sparkline for a short history array. No axes, no deps — just the
// shape of the trend with the latest point marked.
export default function Sparkline({ data, color = "#5eead4", w = 96, h = 28, fmt }) {
  const xs = (data || []).filter((x) => x != null).map(Number);
  if (xs.length < 2) return <span className="text-white/25 text-[10px]">not enough history</span>;
  const min = Math.min(...xs), max = Math.max(...xs), span = max - min || 1;
  const pad = 3;
  const px = (i) => pad + (i / (xs.length - 1)) * (w - 2 * pad);
  const py = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const d = xs.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const last = xs[xs.length - 1];
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={w} height={h} className="overflow-visible">
        <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={px(xs.length - 1)} cy={py(last)} r={2.2} fill={color} />
      </svg>
      {fmt && <span className="font-mono text-[10px] text-white/55 tabular">{fmt(last)}</span>}
    </span>
  );
}
