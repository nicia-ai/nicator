/**
 * Case-insensitive match of a reference fact against output text.
 * Uses regex pattern if present, else substring.
 *
 * Extracted to its own module to break the circular dependency between
 * schema.ts and step-graders.ts.
 */

/** Minimal fact shape needed for matching — avoids importing the full schema. */
export type MatchableFact = Readonly<{
  canonical: string;
  pattern?: string | undefined;
}>;

export function matchFact(fact: MatchableFact, text: string): boolean {
  if (fact.pattern) {
    return new RegExp(fact.pattern, "i").test(text);
  }
  return text.toLowerCase().includes(fact.canonical.toLowerCase());
}
