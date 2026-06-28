// NEWNFL scoring engine — Quality (price-independent) and Value (price-dependent)
// axes. Each component is scored 0-100 with EQUAL weights to start (BUILD_SPEC.md
// principle #7); IC-weighting is a later, backtest-validated change.
//
// Every component returns its score AND the raw inputs that produced it, so the
// UI can "show the work" (principle #4). Missing data lowers confidence and is
// excluded from the composite rather than silently scored as zero.
import { clamp, coeffVar, isFiniteNum, linMap, mean, num, slope } from "./math.ts";
import type { FinnhubMetrics } from "./finnhub.ts";
import type { AnnualRecord } from "./sec.ts";

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

  // 3. ROIC consistency over 10yr (FMP stable key-metrics: returnOnInvestedCapital)
  const roic = series(raw.metrics, "returnOnInvestedCapital");
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
  const hasInsider = isFiniteNum(insiderRatio);
  const hasGoodwill = isFiniteNum(goodwillRatio);
  const buyScore = hasInsider ? linMap(insiderRatio, -1, 1, 20, 90) : 50;
  const goodwillScore = hasGoodwill ? linMap(goodwillRatio, 0.4, 0, 40, 80) : 50;
  const cManagement: Component = {
    // With NO real management inputs this used to default to a flat 50, which —
    // for names that also have no statements — became the sole present component
    // and produced a bogus composite of exactly 50 (a horizontal line of dots on
    // the Quality axis). Score it only when at least one real input exists.
    weight: W, score: (hasInsider || hasGoodwill) ? clamp(0.7 * buyScore + 0.3 * goodwillScore) : NaN,
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

  // Management is the only "soft" component (an insider/goodwill prior). It must
  // never stand alone: a name with no statements but some insider filings would
  // otherwise be scored purely on management and plotted as a real quality dot.
  // Require at least one hard (fundamentals-derived) component, else no composite.
  const hardKeys = ["piotroski", "altman", "roic", "earnings_quality", "revenue_stability", "competitive_position"];
  const hasHard = hardKeys.some((k) => isFiniteNum(components[k].score));

  // Confidence: management is inherently soft; downgrade when key series are thin.
  // FMP's free tier caps history at 5 annual periods, so "high" needs >=5 years.
  const missing = Object.values(components).filter((c) => !isFiniteNum(c.score)).length;
  const confidence = missing >= 2 ? "low" : roic.length >= 5 && revenue.length >= 5 ? "high" : "medium";

  return {
    composite_score: hasHard ? composite(components) : NaN,
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

// Quality backstop — a reduced, TTM-snapshot quality read for names where the
// statement pipeline yields nothing usable (no parseable annual filings, or only
// stale ones). Built entirely from Finnhub's `metric` feed — the same source the
// value backstop uses — so it covers ADRs/foreign filers and thinly-covered
// small caps that have no SEC-style statements. It is level-only (no multi-year
// trend, no Piotroski/Altman), so it is always reported at "low" confidence and
// flagged `_basis: "ttm_metrics"` for the UI. Returns the same row shape as
// computeQualityScore so callers can persist it interchangeably.
export function computeQualityBackstop(m: FinnhubMetrics) {
  const comps: Components = {};
  // 1. Returns on capital (ROIC level vs WACC). Finnhub gives roic in percent.
  const roic = isFiniteNum(m.roic) ? m.roic! / 100 : NaN;
  if (isFiniteNum(roic)) {
    comps.roic = { weight: 1, score: linMap(roic - WACC_ESTIMATE, -0.05, 0.15, 0, 100), raw: { roic_current: roic } };
  }
  // 2. Competitive position / moat (gross-margin level).
  const gm = isFiniteNum(m.grossMargin) ? m.grossMargin! / 100 : NaN;
  if (isFiniteNum(gm)) {
    comps.competitive_position = { weight: 1, score: linMap(gm, 0.10, 0.60, 30, 90), raw: { gross_margin_current: gm } };
  }
  // 3. Profitability (net margin, else operating margin, else ROA).
  const prof = isFiniteNum(m.netMargin) ? m.netMargin! / 100
    : isFiniteNum(m.operatingMargin) ? m.operatingMargin! / 100
    : isFiniteNum(m.roa) ? m.roa! / 100 : NaN;
  if (isFiniteNum(prof)) {
    comps.profitability = { weight: 1, score: linMap(prof, 0, 0.25, 30, 95), raw: { net_margin: prof } };
  }
  // 4. Balance-sheet health (current ratio + leverage; lower debt/equity is better).
  const crScore = isFiniteNum(m.currentRatio) ? linMap(m.currentRatio!, 0.8, 2.5, 25, 90) : NaN;
  const deScore = isFiniteNum(m.debtToEquity) ? linMap(m.debtToEquity!, 2.0, 0.0, 20, 90) : NaN;
  const healthParts = [crScore, deScore].filter(isFiniteNum);
  if (healthParts.length) {
    comps.balance_health = {
      weight: 1, score: healthParts.reduce((a, b) => a + b, 0) / healthParts.length,
      raw: { current_ratio: nz(m.currentRatio), debt_to_equity: nz(m.debtToEquity) },
    };
  }

  const present = Object.values(comps).filter((c) => isFiniteNum(c.score));
  return {
    composite_score: present.length ? composite(comps) : NaN,
    piotroski_score: null, piotroski_sub: null, altman_z: null, altman_zone: "unknown",
    roic_current: nz(roic), roic_10yr_avg: null, roic_trend: null,
    earnings_quality: null, accrual_ratio: null, revenue_cv: null,
    management_score: null, moat_score: comps.competitive_position?.score ?? null,
    confidence: "low",
    component_detail: { ...comps, _basis: "ttm_metrics" },
    history_10yr: { roic: [], revenue: [], gross_margin: [] },
  };
}

// Financial-sector quality scorer. The industrial metrics (Piotroski, Altman,
// ROIC, gross-margin moat, FCF DCF) are undefined or misleading for banks /
// insurers / REITs — no working capital, no COGS/gross margin, leverage is the
// business model, and cash flow is distorted by loan & deposit flows. So for
// `isFinancial` names we score the dimensions that actually describe a financial:
// profitability (ROE, ROA — from Finnhub's metric feed), the lending spread (net
// interest margin + asset yield), operating discipline (efficiency ratio), and
// credit quality (loan-loss reserves vs loans & nonperforming loans). Margin and
// credit inputs come from the parsed statements; ROE/ROA fall back to the metric
// feed so even foreign banks with no statements still score on profitability.
export function computeFinancialQuality(m: FinnhubMetrics, records: AnnualRecord[], opts?: { excludeROE?: boolean }) {
  const r0 = records[0] ?? {} as AnnualRecord;
  const comps: Components = {};

  // Profitability (ROE / ROA) — Finnhub reports these in percent (16.32 == 16.32%).
  // REITs are scored on ROA only: their book equity is eroded by depreciation, so
  // ROE is artificially inflated (often >100%) and not a quality signal. Also skip
  // any implausible ROE (>60%) as an equity-distortion artifact rather than merit.
  // Profitability scales differ sharply by sub-type, so a single curve saturates
  // one cohort: a 16% ROE / 1.2% ROA is elite for a *bank*, but a non-bank
  // financial (insurer, asset manager, exchange) routinely runs ROE 20-40% / ROA
  // 5-15%. One shared scale pegged ~60 profitable non-banks at the 95 ceiling (a
  // flat line of dots). So split the ROE/ROA bands by bank (deposit-taker) vs
  // non-bank vs REIT. `isBank`/`deposits`/`equity` are reused below for funding.
  const isREIT = !!opts?.excludeROE; // excludeROE is set only for Real Estate
  const deposits = num(r0.deposits);
  const equity = num(r0.equity);
  const isBank = isFiniteNum(deposits) && deposits > 0;
  const roeOk = isFiniteNum(m.roe) && !isREIT && m.roe! <= 60;
  if (roeOk) {
    const roeScore = isBank ? linMap(m.roe!, 5, 16, 25, 92) : linMap(m.roe!, 8, 30, 30, 95);
    comps.roe = { weight: 1, score: roeScore, raw: { roe: m.roe } };
  }
  if (isFiniteNum(m.roa)) {
    const roaScore = isREIT ? linMap(m.roa!, 1, 14, 30, 95)
      : isBank ? linMap(m.roa!, 0.3, 1.6, 20, 95)
      : linMap(m.roa!, 1, 16, 25, 95);
    comps.roa = { weight: 1, score: roaScore, raw: { roa: m.roa } };
  }

  // Lending spread — net interest margin (NII / assets) + asset yield (interest income / assets).
  const assets = num(r0.assets);
  const nii = num(r0.netInterestIncome);
  const nim = isFiniteNum(nii) && isFiniteNum(assets) && assets > 0 ? nii / assets : NaN;
  const assetYield = isFiniteNum(num(r0.interestIncome)) && isFiniteNum(assets) && assets > 0 ? num(r0.interestIncome) / assets : NaN;
  if (isFiniteNum(nim)) {
    comps.nim = { weight: 1, score: linMap(nim, 0.015, 0.045, 30, 92), raw: { nim, asset_yield: nz(assetYield) } };
  }

  // Operating discipline — efficiency ratio (noninterest expense / total net revenue);
  // lower is better. Use the bank total-revenue tag, falling back to NII + noninterest
  // income, then the generic revenue field (the generic field alone can be a small
  // fee-revenue line on some banks, which would blow the ratio past 100%).
  const totalRev = isFiniteNum(num(r0.bankRevenue)) ? num(r0.bankRevenue)
    : (isFiniteNum(nii) && isFiniteNum(num(r0.noninterestIncome)) ? nii + num(r0.noninterestIncome) : num(r0.revenue));
  const eff = isFiniteNum(num(r0.noninterestExpense)) && isFiniteNum(totalRev) && totalRev > 0 ? num(r0.noninterestExpense) / totalRev : NaN;
  if (isFiniteNum(eff)) comps.efficiency = { weight: 1, score: linMap(eff, 0.75, 0.45, 20, 95), raw: { efficiency_ratio: eff } };

  // Credit quality — reserves vs loans and nonperforming loans. Gross loans =
  // loans-net-of-allowance + allowance (both us-gaap; company-specific gross-loan
  // tags are unreliable). Scored on NPL coverage when nonaccruals are disclosed
  // (often they aren't), otherwise shown for context without a score.
  const allow = num(r0.allowanceForLoanLoss);
  const loansNet = num(r0.loansNetOfAllowance);
  const grossLoans = isFiniteNum(allow) && isFiniteNum(loansNet) ? loansNet + allow : NaN;
  const reserveRatio = isFiniteNum(allow) && isFiniteNum(grossLoans) && grossLoans > 0 ? allow / grossLoans : NaN;
  const npl = num(r0.nonaccrualLoans);
  const nplCoverage = isFiniteNum(allow) && isFiniteNum(npl) && npl > 0 ? allow / npl : NaN;
  const provRatio = isFiniteNum(num(r0.provisionForCreditLoss)) && isFiniteNum(grossLoans) && grossLoans > 0
    ? num(r0.provisionForCreditLoss) / grossLoans : NaN;
  if (isFiniteNum(reserveRatio) || isFiniteNum(nplCoverage)) {
    comps.credit_quality = {
      weight: 1,
      score: isFiniteNum(nplCoverage) ? linMap(nplCoverage, 0.5, 2.5, 30, 95) : NaN,
      raw: { reserve_ratio: nz(reserveRatio), npl_coverage: nz(nplCoverage), provision_ratio: nz(provRatio) },
    };
  }

  // Capital adequacy & funding — bank-only (gated on deposits). Capital adequacy
  // uses common equity / assets (a tangible-leverage-ratio proxy; regulatory CET1
  // isn't in the free feed) — more cushion is safer. Loan-to-deposit gauges
  // funding: a moderate ratio (~85%) is healthiest; far above ~100% leans on
  // flightier wholesale funding, far below means under-deployed deposits.
  // (deposits / equity / isBank are declared with the profitability block above.)
  const capRatio = isFiniteNum(equity) && isFiniteNum(assets) && assets > 0 ? equity / assets : NaN;
  if (isBank && isFiniteNum(capRatio)) {
    comps.capital_adequacy = { weight: 1, score: linMap(capRatio, 0.05, 0.14, 25, 95), raw: { equity_to_assets: capRatio } };
  }
  const ldr = isBank && isFiniteNum(grossLoans) ? grossLoans / deposits : NaN;
  if (isFiniteNum(ldr)) {
    comps.loan_to_deposit = { weight: 1, score: clamp(90 - Math.abs(ldr - 0.85) * 100), raw: { loan_to_deposit: ldr } };
  }

  const hasStatement = isFiniteNum(nim) || isFiniteNum(eff) || isFiniteNum(reserveRatio);
  const confidence = hasStatement ? (records.length >= 3 ? "high" : "medium") : "low";

  const present = Object.values(comps).filter((c) => isFiniteNum(c.score));
  return {
    composite_score: present.length ? composite(comps) : NaN,
    piotroski_score: null, piotroski_sub: null, altman_z: null, altman_zone: "unknown",
    roic_current: null, roic_10yr_avg: null, roic_trend: null,
    earnings_quality: null, accrual_ratio: null, revenue_cv: null,
    management_score: null, moat_score: null,
    confidence,
    component_detail: { ...comps, _basis: "financial" },
    history_10yr: { roic: [], revenue: oldestFirst(series(records, "revenue")), gross_margin: [] },
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
  const m: Row = raw.metrics?.[0] ?? {};  // FMP stable key-metrics
  const r: Row = raw.ratios?.[0] ?? {};   // FMP stable ratios
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

  // 3. P/E vs sector median (FMP stable ratios: priceToEarningsRatio)
  const pe = num(r.priceToEarningsRatio);
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
  const eps = num(raw.income?.[0]?.eps, num(r.netIncomePerShare));
  const bvps = num(r.bookValuePerShare);
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

  // 5. EV/EBITDA vs peers (FMP stable key-metrics: evToEBITDA; peer pctl deferred)
  const evEbitda = num(m.evToEBITDA);
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

  // 7. Dividend yield vs own history (FMP stable ratios: dividendYield)
  const divYield = num(r.dividendYield);
  const divHist = series(raw.ratios, "dividendYield").slice(0, 5);
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
    history_10yr: { dividend_yield: oldestFirst(series(raw.ratios, "dividendYield")) },
  };
}

// JSON columns are happier with null than NaN.
function nz(x: unknown): number | null {
  return isFiniteNum(x as number) ? (x as number) : null;
}
