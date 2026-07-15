import { describe, expect, it } from "vitest";

import {
  bagOfTokens,
  DEFAULT_VARIANTS,
  matchFact,
  matchSpec,
  matchUnderVariant,
  splitOnFirstProximity,
  variantLabel,
  weightedScore,
  widenFirstProximity,
} from "./matchers";
import { type AuditFact, AuditFactSchema } from "./schema";

function fact(
  overrides: Partial<AuditFact> & { canonical: string },
): AuditFact {
  return AuditFactSchema.parse({ id: "f1", ...overrides });
}

// Realistic pattern shape from the dcv-004 fixtures: entity anchor,
// proximity window, value disjunction.
const SLA_PATTERN = String.raw`Quantix[\s\S]{0,130}(24.?hours?|24h\b)`;

describe("matchSpec", () => {
  it("substring is case-insensitive", () => {
    expect(
      matchSpec(
        { kind: "substring" },
        "Quantix 24 hours",
        "the QUANTIX 24 HOURS SLA",
      ),
    ).toBe(true);
    expect(
      matchSpec(
        { kind: "substring" },
        "Quantix 24 hours",
        "Quantix has a 24 hour SLA",
      ),
    ).toBe(false);
  });

  it("regex applies the pattern case-insensitively", () => {
    expect(
      matchSpec(
        { kind: "regex", pattern: SLA_PATTERN },
        "",
        "quantix responds within 24 hours",
      ),
    ).toBe(true);
    expect(
      matchSpec(
        { kind: "regex", pattern: SLA_PATTERN },
        "",
        "Forest Ledger responds within 24 hours",
      ),
    ).toBe(false);
  });

  it("all-of requires every pattern to match", () => {
    const spec = {
      kind: "all-of" as const,
      patterns: ["Quantix", "24.?hours?"],
    };
    expect(matchSpec(spec, "", "Quantix: 24 hours")).toBe(true);
    expect(matchSpec(spec, "", "Quantix: same day")).toBe(false);
  });
});

describe("widenFirstProximity", () => {
  it("replaces only the first proximity window", () => {
    const pattern = String.raw`A[\s\S]{0,130}B[\s\S]{0,60}C`;
    expect(widenFirstProximity(pattern, 520)).toBe(
      String.raw`A[\s\S]{0,520}B[\s\S]{0,60}C`,
    );
  });

  it("leaves patterns without a window untouched", () => {
    expect(widenFirstProximity("AES-?256", 520)).toBe("AES-?256");
  });
});

describe("splitOnFirstProximity", () => {
  it("splits entity anchor from value disjunction", () => {
    const split = splitOnFirstProximity(SLA_PATTERN);
    expect(split).toEqual({
      entity: "Quantix",
      value: String.raw`(24.?hours?|24h\b)`,
    });
  });

  it("returns undefined when there is no proximity anchor", () => {
    expect(splitOnFirstProximity("AES-?256")).toBeUndefined();
  });
});

describe("bagOfTokens", () => {
  it("lowercases, splits, and drops stopwords", () => {
    expect(bagOfTokens("Quantix SOC 2 Type II 2025-06-15")).toEqual([
      "quantix",
      "soc",
      "2",
      "type",
      "ii",
      "2025-06-15",
    ]);
    expect(bagOfTokens("the state of the art")).toEqual(["state", "art"]);
  });
});

describe("matchUnderVariant", () => {
  const slaFact = fact({
    canonical: "Quantix 24 hours",
    matcher: { kind: "regex", pattern: SLA_PATTERN },
  });

  // 200 chars of filler between entity and value — beyond the 130-char
  // window, inside the 260-char one.
  const filler = "x".repeat(200);
  const distantText = `Quantix ${filler} responds within 24 hours`;

  it("original applies the pattern verbatim", () => {
    expect(
      matchUnderVariant({ family: "original" }, slaFact, "Quantix: 24 hours"),
    ).toBe(true);
    expect(
      matchUnderVariant({ family: "original" }, slaFact, distantText),
    ).toBe(false);
  });

  it("widened proximity accepts matches beyond the original window", () => {
    expect(
      matchUnderVariant(
        { family: "proximity", window: 260 },
        slaFact,
        distantText,
      ),
    ).toBe(true);
  });

  it("no-proximity accepts entity and value anywhere in the output", () => {
    const farApart = `Quantix is a vendor. ${"y".repeat(5000)} The SLA is 24 hours.`;
    expect(
      matchUnderVariant({ family: "no-proximity" }, slaFact, farApart),
    ).toBe(true);
    expect(
      matchUnderVariant(
        { family: "no-proximity" },
        slaFact,
        "Forest Ledger: 24 hours",
      ),
    ).toBe(false);
  });

  it("substring-canonical requires the exact canonical phrasing", () => {
    expect(
      matchUnderVariant(
        { family: "substring-canonical" },
        slaFact,
        "quantix 24 hours SLA",
      ),
    ).toBe(true);
    expect(
      matchUnderVariant(
        { family: "substring-canonical" },
        slaFact,
        "Quantix responds within 24 hours",
      ),
    ).toBe(false);
  });

  it("bag-of-tokens requires every non-stopword token", () => {
    expect(
      matchUnderVariant(
        { family: "bag-of-tokens" },
        slaFact,
        "For Quantix the SLA is 24 hours",
      ),
    ).toBe(true);
    expect(
      matchUnderVariant(
        { family: "bag-of-tokens" },
        slaFact,
        "Quantix has a one-day SLA",
      ),
    ).toBe(false);
  });

  it("falls back to canonical substring for substring specs under regex-surgery variants", () => {
    const substringFact = fact({ canonical: "AES-256" });
    expect(
      matchUnderVariant(
        { family: "proximity", window: 520 },
        substringFact,
        "uses aes-256 at rest",
      ),
    ).toBe(true);
    expect(
      matchUnderVariant({ family: "no-proximity" }, substringFact, "uses RSA"),
    ).toBe(false);
  });

  it("applies proximity widening to every all-of pattern", () => {
    const allOfFact = fact({
      canonical: "Quantix 24 hours",
      matcher: {
        kind: "all-of",
        patterns: [String.raw`Quantix[\s\S]{0,130}24.?hours?`, "SOC.?2"],
      },
    });
    const text = `Quantix ${filler} 24 hours. SOC 2 certified.`;
    expect(matchUnderVariant({ family: "original" }, allOfFact, text)).toBe(
      false,
    );
    expect(
      matchUnderVariant({ family: "proximity", window: 260 }, allOfFact, text),
    ).toBe(true);
  });
});

describe("matchFact", () => {
  it("uses the fact's own matcher spec", () => {
    const f = fact({
      canonical: "Quantix 24 hours",
      matcher: { kind: "regex", pattern: SLA_PATTERN },
    });
    expect(matchFact(f, "Quantix commits to 24h turnaround")).toBe(true);
  });
});

describe("weightedScore", () => {
  it("computes the weighted fraction of passing facts", () => {
    const score = weightedScore([
      { factId: "a", matched: true, expected: "present", weight: 1 },
      { factId: "b", matched: false, expected: "present", weight: 1 },
      { factId: "c", matched: true, expected: "present", weight: 2 },
    ]);
    expect(score).toBeCloseTo(3 / 4, 10);
  });

  it("passes absent facts when NOT matched", () => {
    const score = weightedScore([
      { factId: "a", matched: false, expected: "absent", weight: 1 },
      { factId: "b", matched: true, expected: "absent", weight: 1 },
    ]);
    expect(score).toBe(0.5);
  });

  it("excludes weight-0 facts and returns 0 when nothing is scorable", () => {
    expect(
      weightedScore([
        { factId: "a", matched: true, expected: "present", weight: 0 },
      ]),
    ).toBe(0);
    expect(weightedScore([])).toBe(0);
  });
});

describe("variant catalog", () => {
  it("labels variants stably", () => {
    expect(DEFAULT_VARIANTS.map((variant) => variantLabel(variant))).toEqual([
      "original",
      "proximity-260",
      "proximity-520",
      "proximity-1040",
      "no-proximity",
      "substring-canonical",
      "bag-of-tokens",
    ]);
  });
});
