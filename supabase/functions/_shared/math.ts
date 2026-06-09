// Small statistical helpers used by the scoring engine.
// Kept dependency-free so they run unmodified in Deno edge functions.

export function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Linear map of `x` in [inLo, inHi] onto [outLo, outHi], clamped to the output range. */
export function linMap(x: number, inLo: number, inHi: number, outLo: number, outHi: number): number {
  if (inHi === inLo) return outLo;
  const t = (x - inLo) / (inHi - inLo);
  return clamp(outLo + t * (outHi - outLo), Math.min(outLo, outHi), Math.max(outLo, outHi));
}

export function mean(xs: number[]): number {
  const v = xs.filter(isFiniteNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

export function stdev(xs: number[]): number {
  const v = xs.filter(isFiniteNum);
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** Coefficient of variation = stdev / |mean|. */
export function coeffVar(xs: number[]): number {
  const m = mean(xs);
  const s = stdev(xs);
  return isFiniteNum(m) && m !== 0 && isFiniteNum(s) ? s / Math.abs(m) : NaN;
}

/** Slope of a simple linear regression of ys against their index (oldest -> newest). */
export function slope(ys: number[]): number {
  const v = ys.filter(isFiniteNum);
  const n = v.length;
  if (n < 2) return NaN;
  const xm = (n - 1) / 2;
  const ym = mean(v);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (v[i] - ym);
    den += (i - xm) ** 2;
  }
  return den === 0 ? NaN : num / den;
}

export function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Coalesce to a number, or return the fallback when null/undefined/NaN. */
export function num(x: unknown, fallback = NaN): number {
  const n = typeof x === "string" ? parseFloat(x) : (x as number);
  return isFiniteNum(n) ? n : fallback;
}
