import { describe, expect, it } from "vitest";

import { normalizeHitlPrompt } from "./utility.js";

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
