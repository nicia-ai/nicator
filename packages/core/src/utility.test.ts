import { describe, expect, it } from "vitest";

import { normalizeHitlPrompt, policyRequiresHitl } from "./utility.js";

describe("normalizeHitlPrompt", () => {
  it("lowercases the prompt", () => {
    expect(normalizeHitlPrompt("Proceed With Deletion?")).toBe(
      "proceed with deletion",
    );
  });

  it("collapses internal whitespace", () => {
    expect(normalizeHitlPrompt("proceed   with\t\ndeletion")).toBe(
      "proceed with deletion",
    );
  });

  it("strips trailing punctuation", () => {
    expect(normalizeHitlPrompt("proceed with deletion???")).toBe(
      "proceed with deletion",
    );
    expect(normalizeHitlPrompt("proceed with deletion...")).toBe(
      "proceed with deletion",
    );
    expect(normalizeHitlPrompt("proceed with deletion!")).toBe(
      "proceed with deletion",
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeHitlPrompt("  proceed with deletion  ")).toBe(
      "proceed with deletion",
    );
  });

  it("normalizes two differently-formatted versions of the same question", () => {
    const a = normalizeHitlPrompt("Proceed with deletion?");
    const b = normalizeHitlPrompt("  proceed  with  DELETION??  ");
    expect(a).toBe(b);
  });

  it("preserves meaningful differences", () => {
    const a = normalizeHitlPrompt("proceed with deletion");
    const b = normalizeHitlPrompt("proceed with update");
    expect(a).not.toBe(b);
  });

  it("handles empty string", () => {
    expect(normalizeHitlPrompt("")).toBe("");
  });

  it("preserves mid-sentence punctuation", () => {
    expect(normalizeHitlPrompt("file: report.txt, ok?")).toBe(
      "file: report.txt, ok",
    );
  });
});

describe("policyRequiresHitl", () => {
  it("returns false for 'always' policy", () => {
    expect(policyRequiresHitl({ type: "always" })).toBe(false);
  });

  it("returns false for 'never' policy", () => {
    expect(policyRequiresHitl({ type: "never" })).toBe(false);
  });

  it("returns true for 'require_hitl_approval' policy", () => {
    expect(
      policyRequiresHitl({
        type: "require_hitl_approval",
        approverPrompt: "Allow?",
      }),
    ).toBe(true);
  });

  it("returns false for 'max_calls_per_run' policy", () => {
    expect(
      policyRequiresHitl({ type: "max_calls_per_run", limit: 5 }),
    ).toBe(false);
  });
});
