import { describe, expect, it } from "vitest";

import {
  gradeContextCompression,
  gradeRetryBehavior,
  gradeSkillDecomposition,
} from "./step-graders";

describe("gradeSkillDecomposition", () => {
  it("passes when no expected skills defined", () => {
    const result = gradeSkillDecomposition(["researcher"], []);
    expect(result.severity).toBe("pass");
  });

  it("passes when all expected skills invoked", () => {
    const result = gradeSkillDecomposition(
      ["researcher", "summarizer"],
      ["researcher", "summarizer"],
    );
    expect(result.severity).toBe("pass");
  });

  it("warns when expected skills are missing", () => {
    const result = gradeSkillDecomposition(
      ["researcher"],
      ["researcher", "fact-checker"],
    );
    expect(result.severity).toBe("warn");
    expect(result.finding).toContain("fact-checker");
  });

  it("passes with note when extra skills invoked", () => {
    const result = gradeSkillDecomposition(
      ["researcher", "summarizer", "extra-skill"],
      ["researcher", "summarizer"],
    );
    expect(result.severity).toBe("pass");
    expect(result.finding).toContain("extra-skill");
  });
});

describe("gradeContextCompression", () => {
  it("passes when no compression applied", () => {
    const result = gradeContextCompression(false, null, []);
    expect(result.severity).toBe("pass");
  });

  it("passes when all facts preserved", () => {
    const result = gradeContextCompression(
      true,
      "GDP was $2.5 trillion. Population: 330 million.",
      [
        { canonical: "2.5 trillion" },
        { canonical: "330 million" },
      ],
    );
    expect(result.severity).toBe("pass");
  });

  it("warns when facts lost in compression", () => {
    const result = gradeContextCompression(
      true,
      "GDP was $2.5 trillion.",
      [
        { canonical: "2.5 trillion" },
        { canonical: "330 million" },
      ],
    );
    expect(result.severity).toBe("warn");
    expect(result.finding).toContain("1 reference fact");
  });

  it("respects regex patterns", () => {
    const result = gradeContextCompression(
      true,
      "Revenue grew 15%",
      [{ canonical: "revenue", pattern: "\\d+%" }],
    );
    expect(result.severity).toBe("pass");
  });
});

describe("gradeRetryBehavior", () => {
  it("passes with no retries", () => {
    const result = gradeRetryBehavior(1, 1);
    expect(result.severity).toBe("pass");
  });

  it("fails when all attempts fail", () => {
    const result = gradeRetryBehavior(3, 0);
    expect(result.severity).toBe("fail");
  });

  it("warns on high retry rate", () => {
    // 5 attempts for 2 successes = 2.5x rate
    const result = gradeRetryBehavior(5, 2);
    expect(result.severity).toBe("warn");
  });

  it("passes on acceptable retry rate", () => {
    // 3 attempts for 2 successes = 1.5x rate
    const result = gradeRetryBehavior(3, 2);
    expect(result.severity).toBe("pass");
  });
});
