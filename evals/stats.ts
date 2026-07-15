/**
 * Pure statistical functions for multi-run analysis.
 *
 * No external dependencies. All functions take number arrays and return numbers.
 * Uses t-distribution (not z) for CI and significance — critical for small N.
 */

import type { StatSummary, PairedTestResult } from "./schema";

// ---------------------------------------------------------------------------
// t-critical values (two-tailed, alpha = 0.05) for df 1–29
// ---------------------------------------------------------------------------

const T_CRITICAL_005: readonly number[] = [
  /* df=0 (unused) */ 0, /* df=1  */ 12.706, /* df=2  */ 4.303,
  /* df=3  */ 3.182, /* df=4  */ 2.776, /* df=5  */ 2.571, /* df=6  */ 2.447,
  /* df=7  */ 2.365, /* df=8  */ 2.306, /* df=9  */ 2.262, /* df=10 */ 2.228,
  /* df=11 */ 2.201, /* df=12 */ 2.179, /* df=13 */ 2.16, /* df=14 */ 2.145,
  /* df=15 */ 2.131, /* df=16 */ 2.12, /* df=17 */ 2.11, /* df=18 */ 2.101,
  /* df=19 */ 2.093, /* df=20 */ 2.086, /* df=21 */ 2.08, /* df=22 */ 2.074,
  /* df=23 */ 2.069, /* df=24 */ 2.064, /* df=25 */ 2.06, /* df=26 */ 2.056,
  /* df=27 */ 2.052, /* df=28 */ 2.048, /* df=29 */ 2.045,
];

const Z_CRITICAL_005 = 1.96;

function tCritical(df: number): number {
  if (df < 1) return Number.POSITIVE_INFINITY;
  if (df < T_CRITICAL_005.length) return T_CRITICAL_005[df]!;
  return Z_CRITICAL_005;
}

// ---------------------------------------------------------------------------
// p-value approximation via regularized incomplete beta function
//
// For t-distribution with df degrees of freedom:
//   p = I_{df/(df+t^2)}(df/2, 1/2)
// where I_x(a,b) is the regularized incomplete beta function.
// ---------------------------------------------------------------------------

/** ln(Gamma(x)) via Lanczos approximation — accurate for x > 0.5 */
function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.999_999_999_999_809_93, 676.520_368_121_885_1, -1259.139_216_722_402_8,
    771.323_428_777_653_1, -176.615_029_162_140_6, 12.507_343_278_686_905,
    -0.138_571_095_265_720_12, 9.984_369_578_019_572e-6,
    1.505_632_735_149_311_6e-7,
  ];
  let xx = x;
  let tmp = xx + g + 0.5;
  tmp = (xx + 0.5) * Math.log(tmp) - tmp;
  let ser = c[0]!;
  for (let j = 1; j < g + 2; j++) {
    xx += 1;
    ser += c[j]! / xx;
  }
  return tmp + Math.log((Math.sqrt(2 * Math.PI) * ser) / x);
}

/**
 * Continued fraction for the incomplete beta function via modified Lentz's
 * method (Numerical Recipes `betacf`). Converges for x < (a+1)/(a+b+2).
 */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const MAX_ITER = 200;
  const EPS = 1e-14;
  const TINY = 1e-30;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    // even step: d_{2m} = m(b-m)x / ((a+2m-1)(a+2m))
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    // odd step: d_{2m+1} = -(a+m)(a+b+m)x / ((a+2m)(a+2m+1))
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }

  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
function betaIncomplete(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Continued fraction converges fast only for x < (a+1)/(a+b+2);
  // otherwise use the symmetry I_x(a,b) = 1 - I_{1-x}(b,a).
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - betaIncomplete(1 - x, b, a);
  }

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);

  return (front / a) * betaContinuedFraction(x, a, b);
}

/** Two-tailed p-value for t-distribution with given df */
function tDistPValue(t: number, df: number): number {
  const x = df / (df + t * t);
  const iBeta = betaIncomplete(x, df / 2, 0.5);
  return iBeta; // already two-tailed for symmetric t
}

// ---------------------------------------------------------------------------
// Descriptive statistics
// ---------------------------------------------------------------------------

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Sample standard deviation (Bessel's correction, n-1). Returns 0 for n <= 1. */
export function stddev(xs: readonly number[]): number {
  if (xs.length <= 1) return 0;
  const m = mean(xs);
  let sumSq = 0;
  for (const x of xs) sumSq += (x - m) ** 2;
  return Math.sqrt(sumSq / (xs.length - 1));
}

// ---------------------------------------------------------------------------
// Confidence interval
// ---------------------------------------------------------------------------

/** 95% confidence interval using the t-distribution. */
export function ci95(xs: readonly number[]): { lower: number; upper: number } {
  const n = xs.length;
  if (n === 0) return { lower: 0, upper: 0 };
  if (n <= 1) return { lower: -Infinity, upper: Infinity };

  const m = mean(xs);
  const se = stddev(xs) / Math.sqrt(n);
  const tc = tCritical(n - 1);
  return { lower: m - tc * se, upper: m + tc * se };
}

// ---------------------------------------------------------------------------
// Paired t-test
// ---------------------------------------------------------------------------

const DEFAULT_ALPHA = 0.05;

/**
 * Two-tailed paired t-test.
 *
 * Tests H0: mean(a - b) = 0 against H1: mean(a - b) != 0.
 * Arrays must be equal length (paired observations).
 */
export function pairedTTest(
  a: readonly number[],
  b: readonly number[],
  alpha = DEFAULT_ALPHA,
): PairedTestResult {
  if (a.length !== b.length) {
    throw new Error(
      `Paired t-test requires equal-length arrays: ${a.length} vs ${b.length}`,
    );
  }
  const n = a.length;
  if (n < 2) {
    return {
      n,
      meanDelta: n === 1 ? a[0]! - b[0]! : 0,
      stddevDelta: 0,
      tStatistic: 0,
      pValue: 1,
      significant: false,
    };
  }

  const diffs = a.map((ai, i) => ai - b[i]!);
  const md = mean(diffs);
  const sd = stddev(diffs);
  const ci = ci95(diffs);
  const se = sd / Math.sqrt(n);
  const t = se === 0 ? 0 : md / se;
  const df = n - 1;
  let pValue: number;
  if (se === 0) {
    pValue = md === 0 ? 1 : 0;
  } else {
    pValue = tDistPValue(t, df);
  }

  return {
    n,
    meanDelta: md,
    stddevDelta: sd,
    ci95Lower: ci.lower,
    ci95Upper: ci.upper,
    tStatistic: t,
    pValue,
    significant: pValue < alpha,
  };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

export function summarize(xs: readonly number[]): StatSummary {
  const { lower, upper } = ci95(xs);
  return {
    n: xs.length,
    mean: mean(xs),
    stddev: stddev(xs),
    ci95Lower: lower,
    ci95Upper: upper,
  };
}
