// NEWNFL scoring engine — Quality (price-independent) and Value (price-dependent)
// axes. Each component is scored 0-100 with EQUAL weights to start (BUILD_SPEC.md
// principle #7); IC-weighting is a later, backtest-validated change.
//
// Every component returns its score AND the raw inputs that produced it, so the
// UI can "show the work" (principle #4). Missing data lowers confidence and is
// excluded from the composite rather than silently scored as zero.
import { clamp, coeffVar, isFiniteNum, linMap, mean, num, slope } from "./math.ts";

// FMP statement arrays come newest-first; reverse to oldest->newest for trends.
type Row = Record<string, unknown>;
const series = (rows: Row[] | undefined, key: string): number[] =>
  (rows ?? []).map((r) => num(r[key])).filter(isFiniteNum);
const oldestFirst = (xs: number[]): number[] => [...xs].reverse();

const WACC_ESTIMATE = 0.09; // proxy hurdle rate for ROIC-spread scoring

export interface Component {
  score: number;            // 0-100
  weight: number;           // fraction of the axis
  raw: Record<string, unknown>;
}
type Components = Record<string, Component>;

function composite(components: Components): number {
  const present = Object.values(components).filter((c) => isFiniteNum(c.score));
  if (!present.length) return NaN;
  const wsum = present.reduce((a, c) => a + c.weight, 0);
  return clamp(present.reduce((a, c) => a + c.score * c.weight, 0) / wsum);
}

// ----------------------------------------------------------------------------
// QUALITY AXIS
// ----------------------------------------------------------------------------
export interface QualityRaw {
  income?: Row[];
  balance?: Row[];
  cashflow?: Row[];
  metrics?: Row[];
  ratios?: Row[];
  score?: Row[] | Row;      // FMP /score (Piotroski + Altman)
  insiders?: { data?: Row[] };
  executives?: Row[];
}

export function computeQualityScore(raw: QualityRaw) {
  const W = 1 / 7; // equal weights
  const scoreObj: Row = Array.isArray(raw.score) ? (raw.score[0] ?? {}) : (raw.score ?? {});

  // 1. Piotroski F-Score (0-9 -> 0-100)
  const piotroski = num(scoreObj.piotroskiScore);
  const cPiotroski: Component = {
    weight: W,
    score: isFiniteNum(piotroski) ? clamp((piotroski / 9) * 100) : NaN,
    raw: { piotroskiScore: piotroski },
  };

  // 2. Altman Z-Score
  const z = num(scoreObj.altmanZScore);
  let zScore = NaN, zone = "unknown";
  if (isFiniteNum(z)) {
    if (z > 3.0) { zScore = linMap(z, 3, 6, 85, 100); zone = "safe"; }
    else if (z >= 1.8) { zScore = linMap(z, 1.8, 3.0, 40, 85); zone = "grey"; }
    else { zScore = linMap(z, 0, 1.8, 0, 40); zone = "distress"; }
  }
  const cAltman: Component = { weight: W, score: zScore, raw: { altmanZ: z, zone } };

  // 3. ROIC consistency over 10yr
  const roic = series(raw.metrics, "roic");
  let roicScore = NaN, roicCur = NaN, roicAvg = NaN, roicTrend = NaN, pctAboveWacc = NaN;
  if (roic.length) {
    roicCur = roic[0];
    roicAvg = mean(roic);
    roicTrend = slope(oldestFirst(roic));
    pctAboveWacc = roic.filter((r) => r > WACC_ESTIMATE).length / roic.length;
    const spreadScore = linMap(roicCur - WACC_ESTIMATE, -0.05, 0.15, 0, 100);
    const consistency = pctAboveWacc * 100;
    const trendScore = roicTrend >= 0 ? linMap(roicTrend, 0, 0.02, 55, 100) : linMap(roicTrend, -0.02, 0, 0, 55);
    roicScore = clamp(0.4 * spreadScore + 0.4 * consistency + 0.2 * trendScore);
  }
  const cRoic: Component = {
    weight: W, score: roicScore,
    raw: { roic_current: roicCur, roic_10yr_avg: roicAvg, roic_trend: roicTrend, pct_years_above_wacc: pctAboveWacc },
  };

  // 4. Earnings quality (OCF / NI)
  const ocf = num(raw.cashflow?.[0]?.operatingCashFlow);
  const ni = num(raw.income?.[0]?.netIncome);
  const totalAssets = num(raw.balance?.[0]?.totalAssets);
  const ocfNi = isFiniteNum(ocf) && isFiniteNum(ni) && ni > 0 ? ocf / ni : NaN;
  const accrual = isFiniteNum(ni) && isFiniteNum(ocf) && isFiniteNum(totalAssets) && totalAssets !== 0
    ? (ni - ocf) / totalAssets : NaN;
  const cEarnings: Component = {
    weight: W,
    score: isFiniteNum(ocfNi) ? clamp(ocfNi * 60) : NaN,
    raw: { ocf_ni_ratio: ocfNi, accrual_ratio: accrual },
  };

  // 5. Revenue stability (coefficient of variation, 10yr)
  const revenue = series(raw.income, "revenue");
  const cv = coeffVar(revenue);
  let revScore = NaN;
  if (isFiniteNum(cv)) {
    if (cv < 0.10) revScore = linMap(cv, 0, 0.10, 100, 95);
    else if (cv < 0.20) revScore = linMap(cv, 0.10, 0.20, 95, 70);
    else if (cv < 0.40) revScore = linMap(cv, 0.20, 0.40, 70, 40);
    else revScore = linMap(cv, 0.40, 1.0, 40, 0);
  }
  const cRevenue: Component = { weight: W, score: revScore, raw: { revenue_cv: cv } };

  // 6. Management quality (insider net buy/sell + goodwill load) — low confidence
  const insiderChanges = (raw.insiders?.data ?? []).map((d) => num(d.change)).filter(isFiniteNum);
  const netShares = insiderChanges.reduce((a, b) => a + b, 0);
  const absShares = insiderChanges.reduce((a, b) => a + Math.abs(b), 0);
  const insiderRatio = absShares > 0 ? netShares / absShares : NaN; // -1..1
  const goodwill = num(raw.balance?.[0]?.goodwill, 0);
  const goodwillRatio = isFiniteNum(totalAssets) && totalAssets > 0 ? goodwill / totalAssets : NaN;
  const buyScore = isFiniteNum(insiderRatio) ? linMap(insiderRatio, -1, 1, 20, 90) : 50;
  const goodwillScore = isFiniteNum(goodwillRatio) ? linMap(goodwillRatio, 0.4, 0, 40, 80) : 50;
  const cManagement: Component = {
    weight: W, score: clamp(0.7 * buyScore + 0.3 * goodwillScore),
    raw: { insider_net_ratio: insiderRatio, goodwill_to_assets: goodwillRatio },
  };

  // 7. Competitive position / moat (gross-margin level + durability)
  let margins = series(raw.ratios, "grossProfitMargin");
  if (!margins.length) {
    const gp = series(raw.income, "grossProfit");
    const rev = series(raw.income, "revenue");
    margins = gp.map((g, i) => (rev[i] ? g / rev[i] : NaN)).filter(isFiniteNum);
  }
  let moatScore = NaN, marginLevel = NaN, marginTrend = NaN;
  if (margins.length) {
    marginLevel = margins[0];
    marginTrend = slope(oldestFirst(margins));
    const levelScore = linMap(marginLevel, 0.10, 0.60, 30, 90);
    const trendScore = marginTrend >= 0 ? linMap(marginTrend, 0, 0.01, 55, 100) : linMap(marginTrend, -0.01, 0, 10, 55);
    moatScore = clamp(0.5 * levelScore + 0.5 * trendScore);
  }
  const cMoat: Component = {
    weight: W, score: moatScore,
    raw: { gross_margin_current: marginLevel, gross_margin_trend: marginTrend },
  };

  const components: Components = {
    piotroski: cPiotroski, altman: cAltman, roic: cRoic, earnings_quality: cEarnings,
    revenue_stability: cRevenue, management: cManagement, competitive_position: cMoat,
  };

  // Confidence: management is inherently soft; downgrade when key series are thin.
  const missing = Object.values(components).filter((c) => !isFiniteNum(c.score)).length;
  const confidence = missing >= 2 ? "low" : roic.length >= 7 && revenue.length >= 7 ? "high" : "medium";

  return {
    composite_score: composite(components),
    piotroski_score: isFiniteNum(piotroski) ? piotroski : null,
    piotroski_sub: scoreObj.piotroskiScoreDetail ?? null,
    altman_z: isFiniteNum(z) ? z : null,
    altman_zone: zone,
    roic_current: nz(roicCur), roic_10yr_avg: nz(roicAvg), roic_trend: nz(roicTrend),
    earnings_quality: nz(ocfNi), accrual_ratio: nz(accrual), revenue_cv: nz(cv),
    management_score: cManagement.score, moat_score: cMoat.score,
    confidence,
    component_detail: components,
    history_10yr: {
      roic: oldestFirst(roic), revenue: oldestFirst(revenue), gross_margin: oldestFirst(margins),
    },
  };
}

// ----------------------------------------------------------------------------
// VALUE AXIS
// ----------------------------------------------------------------------------
export interface ValueRaw {
  income?: Row[];
  metrics?: Row[];
  ratios?: Row[];
  dcf?: Row[] | Row;
  profile?: Row[] | Row;
  price?: number;             // real-time price (Finnhub) preferred
  treasury10y?: number;       // decimal, e.g. 0.043 (from regime refresh)
  sectorMedianPE?: number;    // optional; neutral when absent
}

export function computeValueScore(raw: ValueRaw) {
  const W = 1 / 7;
  const m: Row = raw.metrics?.[0] ?? {};
  const profile: Row = Array.isArray(raw.profile) ? (raw.profile[0] ?? {}) : (raw.profile ?? {});
  const dcfObj: Row = Array.isArray(raw.dcf) ? (raw.dcf[0] ?? {}) : (raw.dcf ?? {});
  const price = num(raw.price, num(profile.price, num(dcfObj["Stock Price"])));

  // 1. Earnings yield vs 10Y bond
  const ey = num(m.earningsYield);
  const t10 = num(raw.treasury10y);
  const spread = isFiniteNum(ey) && isFiniteNum(t10) ? ey - t10 : NaN;
  let eyScore = NaN;
  if (isFiniteNum(spread)) {
    if (spread > 0.03) eyScore = linMap(spread, 0.03, 0.08, 90, 100);
    else if (spread > 0.01) eyScore = linMap(spread, 0.01, 0.03, 60, 90);
    else if (spread > 0) eyScore = linMap(spread, 0, 0.01, 30, 60);
    else eyScore = linMap(spread, -0.04, 0, 0, 30);
  }
  const cEy: Component = { weight: W, score: eyScore, raw: { earnings_yield: ey, treasury_10y: t10, spread } };

  // 2. FCF yield (universe percentile deferred to the universe pass; absolute fallback)
  const fcfYield = num(m.freeCashFlowYield);
  const cFcf: Component = {
    weight: W,
    score: isFiniteNum(fcfYield) ? linMap(fcfYield, 0, 0.08, 20, 95) : NaN,
    raw: { fcf_yield: fcfYield, percentile: null /* set during recompute */ },
  };

  // 3. P/E vs sector median
  const pe = num(m.peRatio);
  let peScore = 50;
  if (isFiniteNum(pe) && isFiniteNum(raw.sectorMedianPE) && raw.sectorMedianPE! > 0) {
    const premium = (pe - raw.sectorMedianPE!) / raw.sectorMedianPE!;
    peScore = linMap(premium, 0.30, -0.30, 10, 90); // discount -> high score
  }
  const cPe: Component = {
    weight: W, score: isFiniteNum(pe) ? peScore : NaN,
    raw: { pe_ratio: pe, sector_median_pe: nz(raw.sectorMedianPE) },
  };

  // 4. Graham number — caps contribution for capital-light names (BVPS < $5)
  const eps = num(raw.income?.[0]?.eps, num(m.netIncomePerShare));
  const bvps = num(m.bookValuePerShare);
  let graham = num(m.grahamNumber);
  if (!isFiniteNum(graham) && isFiniteNum(eps) && isFiniteNum(bvps) && eps > 0 && bvps > 0) {
    graham = Math.sqrt(22.5 * eps * bvps);
  }
  const mos = isFiniteNum(graham) && isFiniteNum(price) && graham > 0 ? (graham - price) / graham : NaN;
  let grahamScore = isFiniteNum(mos) ? linMap(mos, -0.5, 0.5, 10, 95) : NaN;
  let grahamReliable = true;
  if (isFiniteNum(bvps) && bvps < 5) { grahamReliable = false; grahamScore = isFiniteNum(grahamScore) ? Math.min(grahamScore, 60) : NaN; }
  const cGraham: Component = {
    weight: W, score: grahamScore,
    raw: { graham_number: nz(graham), margin_of_safety: nz(mos), bvps: nz(bvps), reliable: grahamReliable },
  };

  // 5. EV/EBITDA vs peers (peer percentile deferred; absolute fallback, lower is better)
  const evEbitda = num(m.enterpriseValueOverEBITDA);
  const cEv: Component = {
    weight: W,
    score: isFiniteNum(evEbitda) && evEbitda > 0 ? linMap(evEbitda, 5, 25, 90, 20) : NaN,
    raw: { ev_ebitda: evEbitda, peer_percentile: null },
  };

  // 6. DCF intrinsic value vs price
  const dcfVal = num(dcfObj.dcf);
  const dcfMos = isFiniteNum(dcfVal) && isFiniteNum(price) && dcfVal > 0 ? (dcfVal - price) / dcfVal : NaN;
  const cDcf: Component = {
    weight: W,
    score: isFiniteNum(dcfMos) ? linMap(dcfMos, -0.5, 0.5, 10, 95) : NaN,
    raw: { dcf_intrinsic: nz(dcfVal), margin_of_safety: nz(dcfMos) },
  };

  // 7. Dividend yield vs own history
  const divYield = num(m.dividendYield);
  const divHist = series(raw.metrics, "dividendYield").slice(0, 5);
  const divAvg = mean(divHist);
  const divRatio = isFiniteNum(divYield) && isFiniteNum(divAvg) && divAvg > 0 ? divYield / divAvg : NaN;
  const cDiv: Component = {
    weight: W,
    // No dividend is not a value penalty — treat as neutral/NaN (excluded).
    score: divYield > 0 && isFiniteNum(divRatio) ? clamp(linMap(divRatio, 0.8, 1.2, 30, 90)) : NaN,
    raw: { dividend_yield: nz(divYield), div_yield_vs_5yr_avg: nz(divRatio) },
  };

  const components: Components = {
    earnings_yield: cEy, fcf_yield: cFcf, pe_vs_sector: cPe, graham: cGraham,
    ev_ebitda: cEv, dcf: cDcf, dividend: cDiv,
  };

  return {
    composite_score: composite(components),
    earnings_yield: nz(ey), treasury_10y: nz(t10), ey_vs_bond_spread: nz(spread),
    fcf_yield: nz(fcfYield), fcf_yield_pctl: null,
    pe_ratio: nz(pe), pe_vs_sector_median: nz(raw.sectorMedianPE),
    graham_number: nz(graham), price: nz(price), margin_of_safety: nz(mos),
    ev_ebitda: nz(evEbitda), ev_ebitda_vs_peers: null,
    dcf_intrinsic: nz(dcfVal), dividend_yield: nz(divYield), div_yield_vs_history: nz(divRatio),
    component_detail: components,
    history_10yr: { dividend_yield: oldestFirst(series(raw.metrics, "dividendYield")) },
  };
}

// JSON columns are happier with null than NaN.
function nz(x: unknown): number | null {
  return isFiniteNum(x as number) ? (x as number) : null;
}
