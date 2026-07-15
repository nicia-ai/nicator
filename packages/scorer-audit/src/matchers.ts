/**
 * Matcher families for the matcher-design ablation.
 *
 * The `original` family applies the fact's matcher spec verbatim. The
 * remaining families are systematic perturbations of that spec: proximity
 * windows widened by a parameterized amount, proximity anchors stripped
 * entirely, canonical-substring matching, and bag-of-tokens matching.
 * Sweeping them over the same outputs shows whether a measured gap is a
 * property of one regex or of the surface-form-scoring family.
 */
import type { AuditFact, MatcherSpec } from "./schema.js";

// ---------------------------------------------------------------------------
// Base matching — the fact's own spec, verbatim
// ---------------------------------------------------------------------------

export function matchSpec(
  spec: MatcherSpec,
  canonical: string,
  text: string,
): boolean {
  switch (spec.kind) {
    case "substring": {
      return text.toLowerCase().includes(canonical.toLowerCase());
    }
    case "regex": {
      return new RegExp(spec.pattern, "i").test(text);
    }
    case "all-of": {
      return spec.patterns.every((pattern) =>
        new RegExp(pattern, "i").test(text),
      );
    }
  }
}

export function matchFact(fact: AuditFact, text: string): boolean {
  return matchSpec(fact.matcher, fact.canonical, text);
}

// ---------------------------------------------------------------------------
// Pattern surgery — proximity windows
// ---------------------------------------------------------------------------

/** Replace only the first `[\s\S]{0,N}` proximity window in a pattern. */
export function widenFirstProximity(
  pattern: string,
  newWindow: number,
): string {
  return pattern.replace(
    /\[\\s\\S\]\{0,\d+\}/,
    String.raw`[\s\S]{0,${newWindow}}`,
  );
}

/** Split a pattern on its first proximity anchor: `<entity><PROX><value...>`. */
export function splitOnFirstProximity(
  pattern: string,
): { entity: string; value: string } | undefined {
  const match = pattern.match(/^(.*?)\[\\s\\S\]\{0,\d+\}(.*)$/s);
  if (!match) return undefined;
  const [, entity, value] = match;
  if (entity === undefined || value === undefined) return undefined;
  return { entity, value };
}

// ---------------------------------------------------------------------------
// Bag of tokens
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "of",
  "the",
  "to",
  "is",
  "with",
  "for",
  "in",
  "on",
]);

export function bagOfTokens(canonical: string): string[] {
  return canonical
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export type MatcherVariant =
  | Readonly<{ family: "original" }>
  | Readonly<{ family: "proximity"; window: number }>
  | Readonly<{ family: "no-proximity" }>
  | Readonly<{ family: "substring-canonical" }>
  | Readonly<{ family: "bag-of-tokens" }>;

export function variantLabel(variant: MatcherVariant): string {
  return variant.family === "proximity" ?
      `proximity-${variant.window}`
    : variant.family;
}

export const DEFAULT_VARIANTS: readonly MatcherVariant[] = [
  { family: "original" },
  { family: "proximity", window: 260 },
  { family: "proximity", window: 520 },
  { family: "proximity", window: 1040 },
  { family: "no-proximity" },
  { family: "substring-canonical" },
  { family: "bag-of-tokens" },
];

function patternsOf(spec: MatcherSpec): readonly string[] | undefined {
  switch (spec.kind) {
    case "regex": {
      return [spec.pattern];
    }
    case "all-of": {
      return spec.patterns;
    }
    case "substring": {
      return undefined;
    }
  }
}

export function matchUnderVariant(
  variant: MatcherVariant,
  fact: AuditFact,
  text: string,
): boolean {
  const lcText = text.toLowerCase();

  if (variant.family === "substring-canonical") {
    return lcText.includes(fact.canonical.toLowerCase());
  }

  if (variant.family === "bag-of-tokens") {
    const tokens = bagOfTokens(fact.canonical);
    if (tokens.length === 0) return false;
    return tokens.every((token) => lcText.includes(token));
  }

  // Regex-surgery variants need patterns; substring specs fall back to
  // canonical substring (there is no proximity window to perturb).
  const patterns = patternsOf(fact.matcher);
  if (!patterns) {
    return lcText.includes(fact.canonical.toLowerCase());
  }

  if (variant.family === "no-proximity") {
    return patterns.every((pattern) => {
      const split = splitOnFirstProximity(pattern);
      if (!split) {
        // Pattern has no proximity anchor — apply verbatim.
        return new RegExp(pattern, "i").test(text);
      }
      return (
        new RegExp(split.entity, "i").test(text) &&
        new RegExp(split.value, "i").test(text)
      );
    });
  }

  if (variant.family === "proximity") {
    return patterns.every((pattern) =>
      new RegExp(widenFirstProximity(pattern, variant.window), "i").test(text),
    );
  }

  return patterns.every((pattern) => new RegExp(pattern, "i").test(text));
}

// ---------------------------------------------------------------------------
// Weighted scoring
// ---------------------------------------------------------------------------

export type FactVerdict = Readonly<{
  factId: string;
  matched: boolean;
  expected: "present" | "absent";
  weight: number;
}>;

/**
 * Weighted fraction of facts that pass. `absent` facts pass when NOT
 * matched. Weight-0 facts are excluded. Returns 0 when nothing is scorable.
 */
export function weightedScore(verdicts: readonly FactVerdict[]): number {
  let totalWeight = 0;
  let passedWeight = 0;
  for (const v of verdicts) {
    if (v.weight === 0) continue;
    totalWeight += v.weight;
    const passed = v.expected === "absent" ? !v.matched : v.matched;
    if (passed) passedWeight += v.weight;
  }
  return totalWeight === 0 ? 0 : passedWeight / totalWeight;
}
