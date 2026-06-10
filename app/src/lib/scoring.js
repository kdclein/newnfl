// Quadrant classification from adaptive universe medians (BUILD_SPEC.md).
// Boundaries are the universe medians on each axis, never hardcoded 50/50.
export const SIGNALS = {
  BUY: { label: "BUY", quadrant: "Quality Bargain", color: "#34d399" },
  WATCH: { label: "WATCH", quadrant: "Quality Premium", color: "#fbbf24" },
  AVOID: { label: "AVOID", quadrant: "Value Trap", color: "#f59e0b" },
  SELL: { label: "SELL", quadrant: "Expensive Junk", color: "#f87171" },
  NA: { label: "—", quadrant: "Unscored", color: "#6b7280" },
};

export function classify(q, v, qMed, vMed) {
  if (q == null || v == null) return SIGNALS.NA;
  const hiQ = q >= qMed, hiV = v >= vMed;
  if (hiQ && hiV) return SIGNALS.BUY;
  if (hiQ && !hiV) return SIGNALS.WATCH;
  if (!hiQ && hiV) return SIGNALS.AVOID;
  return SIGNALS.SELL;
}

// Unified rank: both axes must be strong to rank high.
export const unified = (q, v) => (q == null || v == null ? null : (q * v) / 100);

export const fmt = (x, d = 0) =>
  x == null || Number.isNaN(Number(x)) ? "—" : Number(x).toLocaleString("en-US", {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });

export const INDEXES = [
  { id: "all", label: "All US" },
  { id: "sp500", label: "S&P 500" },
  { id: "djia", label: "Dow 30" },
  { id: "nasdaq100", label: "Nasdaq-100" },
  { id: "smallcap", label: "Small Caps" },
];

export const CYCLE_LABEL = {
  early_expansion: "Early Expansion",
  mid_expansion: "Mid Expansion",
  late_expansion: "Late Expansion",
  contraction: "Contraction",
};
