// Maps Finnhub /stock/metric?metric=all into valuation inputs for the engine.
import { isFiniteNum, num } from "./math.ts";

export interface FinnhubMetrics {
  peTTM?: number; earningsYield?: number; fcfYield?: number; evEbitda?: number;
  dividendYield?: number; bookValuePerShare?: number; marketCap?: number;
  // Quality TTM snapshots (percent or ratio as noted) — used by the quality
  // backstop for names with no parseable annual statements. roic/margins are in
  // percent (10.66 == 10.66%); currentRatio and debtToEquity are plain ratios.
  roic?: number; roa?: number; grossMargin?: number; operatingMargin?: number;
  netMargin?: number; currentRatio?: number; debtToEquity?: number;
}

const opt = (x: number) => (isFiniteNum(x) ? x : undefined);

export function parseFinnhubMetric(resp: unknown): FinnhubMetrics {
  const m = (resp as { metric?: Record<string, unknown> })?.metric ?? {};
  const pe = num(m.peTTM ?? m.peBasicExclExtraTTM ?? m.peAnnual);
  const pfcf = num(m.pfcfShareTTM ?? m.pfcfShareAnnual);
  const mcapM = num(m.marketCapitalization);
  // Finnhub quotes dividend yield in percent (2.52 == 2.52%); normalize to a decimal.
  const divPct = num(m.currentDividendYieldTTM ?? m.dividendYieldIndicatedAnnual);
  return {
    peTTM: opt(pe),
    earningsYield: isFiniteNum(pe) && pe !== 0 ? 1 / pe : undefined,
    fcfYield: isFiniteNum(pfcf) && pfcf !== 0 ? 1 / pfcf : undefined,
    evEbitda: opt(num(m.evEbitdaTTM ?? m["currentEv/freeCashFlowTTM"])),
    dividendYield: isFiniteNum(divPct) ? divPct / 100 : undefined,
    bookValuePerShare: opt(num(m.bookValuePerShareQuarterly ?? m.bookValuePerShareAnnual)),
    marketCap: isFiniteNum(mcapM) ? mcapM * 1e6 : undefined,
    roic: opt(num(m.roiTTM ?? m.roiAnnual)),
    roa: opt(num(m.roaTTM ?? m.roaRfy ?? m.roaAnnual)),
    grossMargin: opt(num(m.grossMarginTTM ?? m.grossMarginAnnual)),
    operatingMargin: opt(num(m.operatingMarginTTM ?? m.operatingMarginAnnual)),
    netMargin: opt(num(m.netProfitMarginTTM ?? m.netProfitMarginAnnual)),
    currentRatio: opt(num(m.currentRatioQuarterly ?? m.currentRatioAnnual)),
    debtToEquity: opt(num(m["totalDebt/totalEquityQuarterly"] ?? m["totalDebt/totalEquityAnnual"] ?? m.longTermDebt_equityQuarterly)),
  };
}
