// Display metadata for the stock deep-dive. Each axis is a weighted sum of 7
// component scores (0-100); the composite is Σ(score × weight). This file maps
// the raw `component_detail` JSONB into human-readable rows so the modal can
// "show the work" without guessing at units.

const pct = (x, d = 1) =>
  x == null || Number.isNaN(Number(x)) ? "—" : `${(Number(x) * 100).toFixed(d)}%`;
const money = (x, d = 2) =>
  x == null || Number.isNaN(Number(x)) ? "—" : `$${Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const mult = (x, d = 1) =>
  x == null || Number.isNaN(Number(x)) ? "—" : `${Number(x).toFixed(d)}×`;
const num = (x, d = 2) =>
  x == null || Number.isNaN(Number(x)) ? "—" : Number(x).toFixed(d);

// Each component: key (matches component_detail), label, blurb (what it measures,
// and which direction is good), and the raw metrics to surface.
export const QUALITY_META = [
  {
    key: "piotroski", label: "Piotroski F-Score",
    blurb: "Nine binary tests of profitability, leverage and efficiency — fundamental momentum. Higher is better.",
    metrics: (r) => [["Score", r.piotroskiScore != null ? `${r.piotroskiScore}/9` : "—"]],
  },
  {
    key: "altman", label: "Altman Z-Score",
    blurb: "Distance from financial distress. Above 2.99 is the safe zone; below 1.81 is distress.",
    metrics: (r) => [["Z-score", num(r.altmanZ)], ["Zone", r.zone || "—"]],
  },
  {
    key: "roic", label: "Return on Invested Capital",
    blurb: "Does the business earn more than its cost of capital, durably? Higher and steadier is better.",
    metrics: (r) => [
      ["Current", pct(r.roic_current)], ["10-yr avg", pct(r.roic_10yr_avg)],
      ["Trend / yr", pct(r.roic_trend, 2)], ["Yrs above WACC", pct(r.pct_years_above_wacc, 0)],
    ],
  },
  {
    key: "earnings_quality", label: "Earnings Quality",
    blurb: "Are reported earnings backed by cash? Cash flow ≥ net income and low accruals are healthy.",
    metrics: (r) => [["OCF / Net income", mult(r.ocf_ni_ratio, 2)], ["Accrual ratio", pct(r.accrual_ratio, 1)]],
  },
  {
    key: "revenue_stability", label: "Revenue Stability",
    blurb: "How smooth is the top line? Coefficient of variation — lower is steadier.",
    metrics: (r) => [["Revenue CV", num(r.revenue_cv, 3)]],
  },
  {
    key: "management", label: "Management & Capital Allocation",
    blurb: "Insider buying vs selling, and how much of the balance sheet is acquisition goodwill.",
    metrics: (r) => [["Insider net ratio", num(r.insider_net_ratio, 2)], ["Goodwill / assets", pct(r.goodwill_to_assets)]],
  },
  {
    key: "competitive_position", label: "Competitive Position",
    blurb: "Gross margin level and trend — a proxy for pricing power and moat.",
    metrics: (r) => [["Gross margin", pct(r.gross_margin_current)], ["Margin trend / yr", pct(r.gross_margin_trend, 2)]],
  },
];

export const VALUE_META = [
  {
    key: "earnings_yield", label: "Earnings Yield vs Bonds",
    blurb: "Earnings yield minus the 10-yr Treasury — the equity risk premium you're being paid.",
    metrics: (r) => [["Earnings yield", pct(r.earnings_yield)], ["10-yr Treasury", pct(r.treasury_10y)], ["Spread", pct(r.spread)]],
  },
  {
    key: "fcf_yield", label: "Free Cash Flow Yield",
    blurb: "Free cash flow per dollar of price. Higher is cheaper; percentile is vs the universe.",
    metrics: (r) => [["FCF yield", pct(r.fcf_yield)], ["Percentile", r.percentile == null ? "—" : pct(r.percentile, 0)]],
  },
  {
    key: "pe_vs_sector", label: "P/E vs Sector",
    blurb: "Price-to-earnings against the sector median. Below the median is relatively cheap.",
    metrics: (r) => [["P/E", num(r.pe_ratio, 1)], ["Sector median", r.sector_median_pe == null ? "—" : num(r.sector_median_pe, 1)]],
  },
  {
    key: "ev_ebitda", label: "EV / EBITDA",
    blurb: "Enterprise value to operating earnings — capital-structure-neutral. Lower is cheaper.",
    metrics: (r) => [["EV/EBITDA", num(r.ev_ebitda, 1)], ["Peer percentile", r.peer_percentile == null ? "—" : pct(r.peer_percentile, 0)]],
  },
  {
    key: "dcf", label: "Discounted Cash Flow",
    blurb: "Intrinsic value from projected cash flows vs price. Positive margin of safety means undervalued.",
    metrics: (r) => [["Intrinsic value", money(r.dcf_intrinsic)], ["Margin of safety", pct(r.margin_of_safety, 0)]],
  },
  {
    key: "graham", label: "Graham Number",
    blurb: "Benjamin Graham's defensive fair value from earnings and book value.",
    metrics: (r) => [["Graham number", money(r.graham_number)], ["Book value / sh", money(r.bvps)], ["Margin of safety", pct(r.margin_of_safety, 0)]],
  },
  {
    key: "dividend", label: "Dividend Yield",
    blurb: "Current yield, and where it sits versus its own 5-year history.",
    metrics: (r) => [["Dividend yield", pct(r.dividend_yield)], ["vs 5-yr avg", r.div_yield_vs_5yr_avg == null ? "—" : mult(r.div_yield_vs_5yr_avg, 2)]],
  },
];

export const PIOTROSKI_LABELS = {
  roaPositive: "ROA positive",
  ocfPositive: "Operating cash flow positive",
  roaImproving: "ROA improving YoY",
  accruals: "Cash flow > net income",
  leverageDown: "Lower long-term leverage",
  currentRatioUp: "Current ratio improving",
  noDilution: "No share dilution",
  grossMarginUp: "Gross margin improving",
  assetTurnoverUp: "Asset turnover improving",
};

// Build ordered component rows from a component_detail object + its metadata.
export function components(detail, meta) {
  if (!detail) return [];
  return meta.map((m) => {
    const c = detail[m.key] || {};
    const score = c.score == null ? null : Number(c.score);
    const weight = c.weight == null ? null : Number(c.weight);
    return {
      key: m.key, label: m.label, blurb: m.blurb,
      score, weight,
      contribution: score != null && weight != null ? score * weight : null,
      metrics: m.metrics(c.raw || {}),
    };
  });
}

// Teal→amber→red by score; null is muted. Mild axis tint keeps it on-brand.
export function scoreColor(score) {
  if (score == null) return "#6b7280";
  if (score >= 67) return "#34d399";
  if (score >= 34) return "#fbbf24";
  return "#f87171";
}

const FINANCIAL = new Set(["Financials", "Real Estate"]);
export const isFinancial = (sector) => FINANCIAL.has(sector);

// Why a component is n/a — sector-aware, so financial-sector exclusions read as
// "by design" rather than "broken". Several metrics genuinely don't apply to
// banks/insurers/REITs (no working capital, gross margin, or undistorted FCF).
export function naReason(key, sector) {
  const fin = isFinancial(sector);
  switch (key) {
    case "altman": return fin ? "Altman Z excludes banks & insurers" : "needs full balance-sheet history";
    case "roic": return fin ? "not meaningful for financials" : "needs operating income & invested capital";
    case "competitive_position": return fin ? "no gross margin for financials" : "no gross-margin history";
    case "dcf": return fin ? "cash flow distorted by float / reserves" : "needs positive free cash flow";
    case "graham": return "needs positive earnings & book value";
    case "earnings_yield": return "no earnings yield or Treasury yet";
    case "fcf_yield": return "no free-cash-flow yield";
    case "pe_vs_sector": return "no positive P/E";
    case "ev_ebitda": return "no EV/EBITDA";
    case "dividend": return "pays no dividend";
    case "piotroski": return "needs 2+ years of statements";
    case "earnings_quality": return "needs cash flow & net income";
    case "revenue_stability": return "needs multi-year revenue";
    case "management": return "no insider / goodwill data";
    default: return "insufficient data";
  }
}
