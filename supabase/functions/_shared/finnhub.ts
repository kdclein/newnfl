// Maps Finnhub's `/stock/metric?metric=all` bundle (one call/stock) into the
// valuation inputs the scoring engine needs. Finnhub gives current ratios; the
// multi-year statement series come from SEC (see sec.ts).
import { isFiniteNum, num } from "./math.ts";

export interface FinnhubMetrics {
  peTTM?: number;            // price / earnings
  earningsYield?: number;    // 1 / PE (decimal)
  fcfYield?: number;         // 1 / price-to-FCF (decimal)
  evEbitda?: number;
  dividendYield?: number;    // percent, as Finnhub reports it
  bookValuePerShare?: number;
  marketCap?: number;        // USD (Finnhub reports millions -> scaled here)
}

const opt = (x: number) => (isFiniteNum(x) ? x : undefined);

export function parseFinnhubMetric(resp: unknown): FinnhubMetrics {
  const m = (resp as { metric?: Record<string, unknown> })?.metric ?? {};
  const pe = num(m.peTTM ?? m.peBasicExclExtraTTM ?? m.peAnnual);
  const pfcf = num(m.pfcfShareTTM ?? m.pfcfShareAnnual);
  const mcapM = num(m.marketCapitalization);
  return {
    peTTM: opt(pe),
    earningsYield: isFiniteNum(pe) && pe !== 0 ? 1 / pe : undefined,
    fcfYield: isFiniteNum(pfcf) && pfcf !== 0 ? 1 / pfcf : undefined,
    evEbitda: opt(num(m.evEbitdaTTM ?? m.currentEv_freeCashFlowTTM)),
    dividendYield: opt(num(m.currentDividendYieldTTM ?? m.dividendYieldIndicatedAnnual)),
    bookValuePerShare: opt(num(m.bookValuePerShareQuarterly ?? m.bookValuePerShareAnnual)),
    marketCap: isFiniteNum(mcapM) ? mcapM * 1e6 : undefined,
  };
}
