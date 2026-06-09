// Computes the scores we used to get pre-baked from FMP, now derived ourselves
// from SEC annual records: Piotroski F-Score, Altman Z-Score, a simple DCF, and
// a per-year ROIC series. All formulas are standard; inputs that are missing
// yield NaN/null so the scoring engine can exclude them rather than guess.
import { isFiniteNum } from "./math.ts";
import type { AnnualRecord } from "./sec.ts";

const n = (x?: number) => (isFiniteNum(x as number) ? (x as number) : NaN);
const ratio = (a?: number, b?: number) => {
  const x = n(a), y = n(b);
  return isFiniteNum(x) && isFiniteNum(y) && y !== 0 ? x / y : NaN;
};
const grossProfit = (r: AnnualRecord) =>
  isFiniteNum(r.grossProfit as number) ? n(r.grossProfit) : n(r.revenue) - n(r.costOfRevenue);

/** Piotroski F-Score (0-9): nine binary fundamental health checks (needs 2 yrs). */
export function computePiotroski(recs: AnnualRecord[]): { score: number; detail: Record<string, boolean> } | null {
  if (recs.length < 2) return null;
  const t = recs[0], y = recs[1];
  const roaT = ratio(t.netIncome, t.assets), roaY = ratio(y.netIncome, y.assets);
  const gmT = ratio(grossProfit(t), t.revenue), gmY = ratio(grossProfit(y), y.revenue);
  const atT = ratio(t.revenue, t.assets), atY = ratio(y.revenue, y.assets);
  const crT = ratio(t.currentAssets, t.currentLiabilities), crY = ratio(y.currentAssets, y.currentLiabilities);
  const levT = ratio(t.longTermDebt, t.assets), levY = ratio(y.longTermDebt, y.assets);

  const detail: Record<string, boolean> = {
    roaPositive: roaT > 0,
    ocfPositive: n(t.ocf) > 0,
    roaImproving: roaT > roaY,
    accruals: n(t.ocf) > n(t.netIncome),                       // cash earnings quality
    leverageDown: isFiniteNum(levT) && isFiniteNum(levY) ? levT < levY : (n(t.longTermDebt) || 0) <= (n(y.longTermDebt) || 0),
    currentRatioUp: crT > crY,
    noDilution: n(t.shares) <= n(y.shares) * 1.01,             // tolerate rounding
    grossMarginUp: gmT > gmY,
    assetTurnoverUp: atT > atY,
  };
  return { score: Object.values(detail).filter(Boolean).length, detail };
}

/** Altman Z-Score (classic 5-factor manufacturing model). */
export function computeAltman(r: AnnualRecord, marketCap: number): number | null {
  const ta = n(r.assets);
  if (!isFiniteNum(ta) || ta === 0) return null;
  const x1 = (n(r.currentAssets) - n(r.currentLiabilities)) / ta;  // working capital / TA
  const x2 = n(r.retainedEarnings) / ta;
  const x3 = n(r.operatingIncome) / ta;                            // EBIT / TA
  const x4 = ratio(marketCap, r.liabilities);                     // mkt equity / total liab
  const x5 = n(r.revenue) / ta;
  const terms = [1.2 * x1, 1.4 * x2, 3.3 * x3, 0.6 * x4, 1.0 * x5];
  // Require the income/balance core; X4 may be absent if market cap is unknown.
  if (![x1, x2, x3, x5].every(isFiniteNum)) return null;
  return terms.reduce((a, b) => a + (isFiniteNum(b) ? b : 0), 0);
}

/** Per-year ROIC = NOPAT / (equity + long-term debt), newest-first. */
export function computeRoicSeries(recs: AnnualRecord[]): number[] {
  return recs.map((r) => {
    const taxRate = (() => {
      const tr = ratio(r.incomeTax, r.pretaxIncome);
      return isFiniteNum(tr) ? Math.min(Math.max(tr, 0), 0.5) : 0.21;
    })();
    const nopat = n(r.operatingIncome) * (1 - taxRate);
    const invested = n(r.equity) + (n(r.longTermDebt) || 0);
    return isFiniteNum(nopat) && isFiniteNum(invested) && invested > 0 ? nopat / invested : NaN;
  });
}

/** Simple two-stage FCF DCF -> intrinsic value per share. */
export function computeDCF(recs: AnnualRecord[], shares: number, discount = 0.09, terminalG = 0.025): number | null {
  if (!isFiniteNum(shares) || shares <= 0) return null;
  const fcf0 = n(recs[0]?.ocf) - Math.abs(n(recs[0]?.capex) || 0);
  if (!(fcf0 > 0)) return null;

  // Growth from revenue CAGR over the available window, capped to a sane band.
  const revs = recs.map((r) => n(r.revenue)).filter(isFiniteNum);
  let g = 0.04;
  if (revs.length >= 2 && revs[revs.length - 1] > 0) {
    g = Math.pow(revs[0] / revs[revs.length - 1], 1 / (revs.length - 1)) - 1;
  }
  g = Math.min(Math.max(g, 0), 0.12);

  let pv = 0, fcf = fcf0;
  for (let yr = 1; yr <= 5; yr++) { fcf *= (1 + g); pv += fcf / Math.pow(1 + discount, yr); }
  const terminal = (fcf * (1 + terminalG)) / (discount - terminalG);
  pv += terminal / Math.pow(1 + discount, 5);
  return pv / shares;
}
