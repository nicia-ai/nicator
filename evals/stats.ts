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
  /* df=0 (unused) */ 0,
  /* df=1  */ 12.706, /* df=2  */ 4.303, /* df=3  */ 3.182, /* df=4  */ 2.776,
  /* df=5  */ 2.571,  /* df=6  */ 2.447, /* df=7  */ 2.365, /* df=8  */ 2.306,
  /* df=9  */ 2.262,  /* df=10 */ 2.228, /* df=11 */ 2.201, /* df=12 */ 2.179,
  /* df=13 */ 2.160,  /* df=14 */ 2.145, /* df=15 */ 2.131, /* df=16 */ 2.120,
  /* df=17 */ 2.110,  /* df=18 */ 2.101, /* df=19 */ 2.093, /* df=20 */ 2.086,
  /* df=21 */ 2.080,  /* df=22 */ 2.074, /* df=23 */ 2.069, /* df=24 */ 2.064,
  /* df=25 */ 2.060,  /* df=26 */ 2.056, /* df=27 */ 2.052, /* df=28 */ 2.048,
  /* df=29 */ 2.045,
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
    -0.138_571_095_265_720_12, 9.984_369_578_019_572e-6, 1.505_632_735_149_311_6e-7,
  ];
  let xx = x;
  let tmp = xx + g + 0.5;
  tmp = (xx + 0.5) * Math.log(tmp) - tmp;
  let ser = c[0]!;
  for (let j = 1; j < g + 2; j++) {
    xx += 1;
    ser += c[j]! / xx;
  }
  return tmp + Math.log(Math.sqrt(2 * Math.PI) * ser / x);
}

/**
 * Regularized incomplete beta function I_x(a, b) via continued fraction
 * (Lentz's method). Sufficient precision for p-value computation.
 */
function betaIncomplete(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);

  // Lentz's continued fraction
  const MAX_ITER = 200;
  const EPS = 1e-14;
  const TINY = 1e-30;

  let f = 1 + cfTerm(0, x, a, b);
  if (Math.abs(f) < TINY) f = TINY;
  let c = f;
  let d = 1;

  for (let m = 1; m <= MAX_ITER; m++) {
    const am = cfTerm(m, x, a, b);
    d = 1 + am * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + am / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = c * d;
    f *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }

  return (front / a) * f;
}

function cfTerm(m: number, x: number, a: number, b: number): number {
  if (m === 0) return 0;
  const k = Math.floor((m + 1) / 2);
  if (m % 2 === 0) {
    // even term
    return (k * (b - k) * x) / ((a + 2 * k - 1) * (a + 2 * k));
  }
  // odd term
  return -((a + k) * (a + b + k) * x) / ((a + 2 * k) * (a + 2 * k + 1));
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

/** 95% confidence interval using t-distribution. Returns mean +/- margin. */
export function ci95(xs: readonly number[]): { lower: number; upper: number } {
  const n = xs.length;
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
    throw new Error(`Paired t-test requires equal-length arrays: ${a.length} vs ${b.length}`);
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
  const se = sd / Math.sqrt(n);
  const t = se === 0 ? 0 : md / se;
  const df = n - 1;
  const pValue = se === 0 ? (md === 0 ? 1 : 0) : tDistPValue(t, df);

  return {
    n,
    meanDelta: md,
    stddevDelta: sd,
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
