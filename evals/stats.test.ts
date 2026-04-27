import { describe, expect, it } from "vitest";

import { ci95, mean, pairedTTest, stddev, summarize } from "./stats";

describe("mean", () => {
  it("returns 0 for empty array", () => {
    expect(mean([])).toBe(0);
  });

  it("computes arithmetic mean", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([1, 1, 1, 1])).toBe(1);
    expect(mean([10])).toBe(10);
  });
});

describe("stddev", () => {
  it("returns 0 for single element", () => {
    expect(stddev([42])).toBe(0);
  });

  it("returns 0 for empty array", () => {
    expect(stddev([])).toBe(0);
  });

  it("uses Bessel's correction (n-1)", () => {
    // [2, 4, 6]: mean=4, deviations=[-2,0,2], sumSq=8, n-1=2, var=4, sd=2
    expect(stddev([2, 4, 6])).toBe(2);
  });

  it("returns 0 for identical values", () => {
    expect(stddev([5, 5, 5, 5])).toBe(0);
  });
});

describe("ci95", () => {
  it("returns [-Inf, +Inf] for single observation", () => {
    const { lower, upper } = ci95([42]);
    expect(lower).toBe(-Infinity);
    expect(upper).toBe(Infinity);
  });

  it("returns a finite empty interval for no observations", () => {
    const { lower, upper } = ci95([]);
    expect(lower).toBe(0);
    expect(upper).toBe(0);
  });

  it("narrows with more observations", () => {
    const narrow = ci95([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
    expect(narrow.lower).toBe(5);
    expect(narrow.upper).toBe(5);
  });

  it("produces symmetric interval for symmetric data", () => {
    const { lower, upper } = ci95([8, 10, 12]);
    const m = mean([8, 10, 12]);
    expect(upper - m).toBeCloseTo(m - lower, 10);
  });

  it("contains the mean", () => {
    const data = [3, 7, 5, 9, 2];
    const { lower, upper } = ci95(data);
    const m = mean(data);
    expect(m).toBeGreaterThanOrEqual(lower);
    expect(m).toBeLessThanOrEqual(upper);
  });
});

describe("pairedTTest", () => {
  it("throws on unequal-length arrays", () => {
    expect(() => pairedTTest([1, 2], [1])).toThrow("equal-length");
  });

  it("returns non-significant for single pair", () => {
    const result = pairedTTest([5], [3]);
    expect(result.n).toBe(1);
    expect(result.meanDelta).toBe(2);
    expect(result.ci95Lower).toBeUndefined();
    expect(result.ci95Upper).toBeUndefined();
    expect(result.significant).toBe(false);
    expect(result.pValue).toBe(1);
  });

  it("detects significant difference in clearly separated data", () => {
    // Harness consistently scores 0.2 higher than baseline
    const a = [0.8, 0.85, 0.9, 0.75, 0.82, 0.88, 0.79, 0.84];
    const b = [0.6, 0.65, 0.7, 0.55, 0.62, 0.68, 0.59, 0.64];
    const result = pairedTTest(a, b);

    expect(result.n).toBe(8);
    expect(result.meanDelta).toBeCloseTo(0.2, 5);
    expect(result.ci95Lower).toBeLessThan(result.meanDelta);
    expect(result.ci95Upper).toBeGreaterThan(result.meanDelta);
    expect(result.significant).toBe(true);
    expect(result.pValue).toBeLessThan(0.05);
  });

  it("returns non-significant for identical arrays", () => {
    const a = [0.5, 0.6, 0.7];
    const result = pairedTTest(a, a);

    expect(result.meanDelta).toBe(0);
    expect(result.significant).toBe(false);
  });

  it("returns non-significant for noisy data with no real difference", () => {
    // Same mean, just noise — differences cancel out
    const a = [0.5, 0.7, 0.3, 0.6, 0.4];
    const b = [0.6, 0.4, 0.5, 0.3, 0.7];
    const result = pairedTTest(a, b);

    expect(Math.abs(result.meanDelta)).toBeLessThan(0.1);
    expect(result.significant).toBe(false);
  });
});

describe("summarize", () => {
  it("includes all fields", () => {
    const result = summarize([1, 2, 3, 4, 5]);
    expect(result.n).toBe(5);
    expect(result.mean).toBe(3);
    expect(result.stddev).toBeGreaterThan(0);
    expect(result.ci95Lower).toBeLessThan(result.mean);
    expect(result.ci95Upper).toBeGreaterThan(result.mean);
  });
});
