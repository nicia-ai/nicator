import { describe, expect, it } from "vitest";

import {
  JUDGE_VARIANT_LABEL,
  judgeReferenceFromRescore,
  runAblation,
} from "./ablation";
import {
  type AuditInput,
  AuditInputSchema,
  type RescoreOutput,
  RescoreOutputSchema,
} from "./schema";

const SLA_PATTERN = String.raw`Quantix[\s\S]{0,130}(24.?hours?|24h\b)`;
const FILLER = "x".repeat(200);

// Two runs. In each, the "harness" output states the SLA fact but beyond
// the original proximity window; the "baseline" output omits it. Under
// `original` the gap is 0 (both fail); under `proximity-260` and wider
// the harness is credited and the gap opens to +1.
function task(runId: string): unknown {
  return {
    taskId: "t-1",
    facts: [
      {
        id: "fact-sla",
        description: "Quantix — 24 hour breach SLA",
        canonical: "Quantix 24 hours",
        matcher: { kind: "regex" as const, pattern: SLA_PATTERN },
      },
    ],
    conditions: {
      harness: {
        text: `Quantix ${FILLER} commits to a 24h breach SLA. (${runId})`,
        recordedVerdicts: { "fact-sla": false },
      },
      baseline: { text: `Quantix uses AES-256 at rest. (${runId})` },
    },
  };
}

function makeInput(): AuditInput {
  return AuditInputSchema.parse({
    comparison: ["harness", "baseline"],
    runs: [
      { runId: "run-1", tasks: [task("run-1")] },
      { runId: "run-2", tasks: [task("run-2")] },
    ],
  });
}

function makeJudgeRescore(): RescoreOutput {
  const conditions = {
    harness: {
      matcherScore: 0,
      judgeScore: 1,
      verdicts: [
        { factId: "fact-sla", matched: true, justification: "stated" },
      ],
      matcherVerdicts: { "fact-sla": false },
    },
    baseline: {
      matcherScore: 0,
      judgeScore: 0,
      verdicts: [
        { factId: "fact-sla", matched: false, justification: "absent" },
      ],
      matcherVerdicts: { "fact-sla": false },
    },
  };
  return RescoreOutputSchema.parse({
    comparison: ["harness", "baseline"],
    judgeModel: "test-model",
    generatedAt: new Date().toISOString(),
    entries: [
      { runId: "run-1", taskId: "t-1", conditions },
      { runId: "run-2", taskId: "t-1", conditions },
    ],
  });
}

describe("runAblation", () => {
  it("shows the gap opening as the proximity window widens", () => {
    const result = runAblation({ input: makeInput() });
    const byVariant = new Map(result.summaries.map((s) => [s.variant, s]));

    const original = byVariant.get("original")!;
    expect(original.aMean).toBe(0); // beyond the 130-char window
    expect(original.bMean).toBe(0);
    expect(original.deltaMean).toBe(0);

    const widened = byVariant.get("proximity-260")!;
    expect(widened.aMean).toBe(1);
    expect(widened.bMean).toBe(0);
    expect(widened.deltaMean).toBe(1);

    const noProx = byVariant.get("no-proximity")!;
    expect(noProx.deltaMean).toBe(1);

    // Canonical phrasing ("Quantix 24 hours") never appears verbatim.
    const substring = byVariant.get("substring-canonical")!;
    expect(substring.aMean).toBe(0);
  });

  it("sanity-checks `original` against recorded verdicts", () => {
    const result = runAblation({ input: makeInput() });
    const harnessChecks = result.sanity.filter(
      (s) => s.condition === "harness",
    );
    expect(harnessChecks).toHaveLength(2);
    for (const check of harnessChecks) {
      expect(check.reproduced).toBe(true);
      expect(check.ablation).toBe(0);
      expect(check.recorded).toBe(0);
    }
    // Baseline has no recorded verdicts — no sanity row.
    expect(result.sanity.some((s) => s.condition === "baseline")).toBe(false);
  });

  it("runs a paired t-test on per-run deltas", () => {
    const result = runAblation({ input: makeInput() });
    const widened = result.summaries.find(
      (s) => s.variant === "proximity-260",
    )!;
    expect(widened.perRun).toHaveLength(2);
    // n=2 with zero-variance deltas: se=0 path, p=0.
    expect(widened.deltaPValue).toBe(0);
  });

  it("adds a judge row and quadrant counts when a reference is provided", () => {
    const judge = judgeReferenceFromRescore(makeJudgeRescore());
    const result = runAblation({ input: makeInput(), judge });

    const judgeRow = result.summaries.find(
      (s) => s.variant === JUDGE_VARIANT_LABEL,
    )!;
    expect(judgeRow.aMean).toBe(1);
    expect(judgeRow.bMean).toBe(0);
    expect(judgeRow.deltaMean).toBe(1);

    // Under `original`, the harness SLA fact is judge-only-pass in both runs.
    const originalVsJudge = result.vsJudge?.["harness"]?.["original"];
    expect(originalVsJudge).toEqual({
      bothPass: 0,
      variantOnlyPass: 0,
      judgeOnlyPass: 2,
      bothFail: 0,
    });
    const widenedVsJudge = result.vsJudge?.["harness"]?.["proximity-260"];
    expect(widenedVsJudge?.bothPass).toBe(2);
  });
});
