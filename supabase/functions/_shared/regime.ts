// NEWNFL regime engine — turns macro indicators into a 0-100 environment score
// and a cycle-phase label. CAVEAT (surfaced in the UI): macro-based factor
// timing has weak empirical support. Regime DESCRIBES the environment; it does
// not predict turns. Use it to calibrate position sizing / margin-of-safety.
import { clamp, isFiniteNum, linMap, num } from "./math.ts";

// Alpha Vantage economic endpoints return { data: [{ date, value }, ...] } newest-first.
interface AvSeries { data?: { date: string; value: string }[] }
function latest(s: AvSeries | undefined, idx = 0): number {
  return num(s?.data?.[idx]?.value);
}
// Year-over-year % change for a monthly/quarterly series given periods-per-year.
function yoy(s: AvSeries | undefined, periodsPerYear: number): number {
  const cur = latest(s, 0);
  const prior = latest(s, periodsPerYear);
  return isFiniteNum(cur) && isFiniteNum(prior) && prior !== 0 ? (cur - prior) / Math.abs(prior) : NaN;
}

export interface RegimeRaw {
  gdp?: AvSeries;           // REAL_GDP quarterly
  unemployment?: AvSeries;  // UNEMPLOYMENT monthly
  cpi?: AvSeries;           // CPI monthly
  fed_rate?: AvSeries;      // FEDERAL_FUNDS_RATE daily
  treasury_10y?: AvSeries;
  treasury_2y?: AvSeries;
  nonfarm?: AvSeries;       // NONFARM_PAYROLL monthly
}

interface Indicator { value: number | null; score: number | null; favorable?: string }

export function computeRegime(raw: RegimeRaw) {
  const indicators: Record<string, Indicator> = {};

  // Yield curve (10Y - 2Y): steep/positive favorable, inverted unfavorable.
  const t10 = latest(raw.treasury_10y);
  const t2 = latest(raw.treasury_2y);
  const curve = isFiniteNum(t10) && isFiniteNum(t2) ? (t10 - t2) / 100 : NaN; // AV yields are in %
  indicators.yield_curve = ind(curve, isFiniteNum(curve) ? linMap(curve, -0.01, 0.02, 10, 90) : NaN);

  // Unemployment: lower is more favorable for deploying capital.
  const unemp = latest(raw.unemployment);
  indicators.unemployment = ind(unemp, isFiniteNum(unemp) ? linMap(unemp, 6.5, 3.5, 20, 85) : NaN);
  const unempTrend = latest(raw.unemployment, 0) - latest(raw.unemployment, 3); // 3-month change

  // Inflation (CPI YoY): distance from a ~2% target, both directions unfavorable.
  const cpiYoY = yoy(raw.cpi, 12);
  const inflScore = isFiniteNum(cpiYoY) ? clamp(100 - Math.abs(cpiYoY - 0.02) / 0.04 * 100) : NaN;
  indicators.inflation = ind(cpiYoY, inflScore);

  // Fed funds rate: higher = more restrictive environment.
  const fed = latest(raw.fed_rate);
  indicators.fed_funds = ind(fed, isFiniteNum(fed) ? linMap(fed, 0, 6, 80, 25) : NaN);

  // Real GDP growth (YoY): positive favorable.
  const gdpYoY = yoy(raw.gdp, 4);
  indicators.gdp_growth = ind(gdpYoY, isFiniteNum(gdpYoY) ? linMap(gdpYoY, -0.02, 0.04, 10, 90) : NaN);

  // Payroll growth (YoY): positive favorable.
  const payYoY = yoy(raw.nonfarm, 12);
  indicators.payrolls = ind(payYoY, isFiniteNum(payYoY) ? linMap(payYoY, -0.01, 0.03, 15, 85) : NaN);

  const scored = Object.values(indicators).map((i) => i.score).filter(isFiniteNum) as number[];
  const composite = scored.length ? clamp(scored.reduce((a, b) => a + b, 0) / scored.length) : NaN;

  // Cycle phase from the constellation of signals.
  const inverted = isFiniteNum(curve) && curve < 0;
  const risingUnemp = isFiniteNum(unempTrend) && unempTrend > 0.1;
  let cyclePhase = "mid_expansion";
  if (inverted && risingUnemp) cyclePhase = "contraction";
  else if (inverted || risingUnemp) cyclePhase = "late_expansion";
  else if (isFiniteNum(gdpYoY) && gdpYoY > 0.025 && isFiniteNum(unemp) && unemp < 4.5) cyclePhase = "mid_expansion";
  else if (isFiniteNum(gdpYoY) && gdpYoY > 0) cyclePhase = "early_expansion";

  // Crude recession probability proxy: inverted curve + deteriorating labor.
  let recession = 0.10;
  if (inverted) recession += 0.35;
  if (risingUnemp) recession += 0.25;
  if (isFiniteNum(gdpYoY) && gdpYoY < 0) recession += 0.20;
  recession = clamp(recession, 0, 0.95);

  return {
    composite_score: composite,
    cycle_phase: cyclePhase,
    recession_probability: recession,
    indicators,
    history: {}, // populated as the cron job accumulates daily snapshots
  };
}

function ind(value: number, score: number): Indicator {
  return { value: isFiniteNum(value) ? value : null, score: isFiniteNum(score) ? Math.round(score) : null };
}
