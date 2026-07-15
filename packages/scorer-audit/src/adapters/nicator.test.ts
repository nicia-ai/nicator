import { describe, expect, it } from "vitest";

import {
  NicatorEvalReportSchema,
  NicatorFactsFileSchema,
  NicatorReferenceFactSchema,
  nicatorReportsToAuditInput,
  referenceFactToAuditFact,
} from "./nicator";

// Minimal EvalReport fixture — only the fields the adapter consumes,
// plus extra fields to confirm unknown keys are tolerated.
const REPORT = NicatorEvalReportSchema.parse({
  runId: "7464bfdf-0000-0000-0000-000000000000",
  timestamp: "2026-07-07T00:00:00.000Z",
  harnessVersion: "0.1.0",
  modelVersion: "claude-sonnet-4-6",
  tasks: [
    {
      taskId: "dcv-004",
      category: "decomposition-value",
      harnessOutput: {
        text: "Quantix commits to 24h.",
        totalTokens: 10,
        latencyMs: 5,
      },
      baselineOutput: {
        text: "Quantix: no SLA stated.",
        totalTokens: 8,
        latencyMs: 4,
      },
      factualScore: {
        facts: [
          { factId: "fact-sla", matched: true, expected: "present", weight: 1 },
        ],
        score: 1,
      },
      baselineFactualScore: {
        facts: [
          {
            factId: "fact-sla",
            matched: false,
            expected: "present",
            weight: 1,
          },
        ],
        score: 0,
      },
      passFailResult: {
        harnessPass: true,
        baselinePass: false,
        harnessReason: "ok",
        baselineReason: "missed",
      },
    },
    {
      taskId: "syn-001",
      harnessOutput: { text: "some output" },
      baselineOutput: { text: "some baseline" },
    },
  ],
  aggregate: { factualAccuracy: { harness: 1, baseline: 0, delta: 1 } },
});

const FACTS_FILE = NicatorFactsFileSchema.parse({
  "dcv-004": [
    {
      id: "fact-sla",
      description: "Quantix — 24 hour breach SLA",
      canonical: "Quantix 24 hours",
      pattern: String.raw`Quantix[\s\S]{0,130}(24.?hours?|24h\b)`,
    },
  ],
});

describe("referenceFactToAuditFact", () => {
  it("maps pattern to a regex matcher", () => {
    const fact = referenceFactToAuditFact(
      NicatorReferenceFactSchema.parse({
        id: "f",
        canonical: "Quantix 24 hours",
        pattern: "Quantix.?24",
      }),
    );
    expect(fact.matcher).toEqual({ kind: "regex", pattern: "Quantix.?24" });
    expect(fact.expected).toBe("present");
    expect(fact.weight).toBe(1);
  });

  it("gives requiredPatterns precedence over pattern", () => {
    const fact = referenceFactToAuditFact(
      NicatorReferenceFactSchema.parse({
        id: "f",
        canonical: "c",
        pattern: "ignored",
        requiredPatterns: ["a", "b"],
      }),
    );
    expect(fact.matcher).toEqual({ kind: "all-of", patterns: ["a", "b"] });
  });

  it("falls back to substring matching", () => {
    const fact = referenceFactToAuditFact(
      NicatorReferenceFactSchema.parse({ id: "f", canonical: "c" }),
    );
    expect(fact.matcher).toEqual({ kind: "substring" });
  });

  it("preserves absent expectation and weight", () => {
    const fact = referenceFactToAuditFact(
      NicatorReferenceFactSchema.parse({
        id: "f",
        canonical: "c",
        expected: "absent",
        weight: 0,
      }),
    );
    expect(fact.expected).toBe("absent");
    expect(fact.weight).toBe(0);
  });
});

describe("nicatorReportsToAuditInput", () => {
  it("converts a report to the generic format losslessly", () => {
    const skipped: string[] = [];
    const input = nicatorReportsToAuditInput([REPORT], FACTS_FILE, (taskId) =>
      skipped.push(taskId),
    );

    expect(input.comparison).toEqual(["harness", "baseline"]);
    expect(input.runs).toHaveLength(1);
    const run = input.runs[0]!;
    expect(run.runId).toBe(REPORT.runId);

    // syn-001 has no facts entry — skipped.
    expect(skipped).toEqual(["syn-001"]);
    expect(run.tasks).toHaveLength(1);

    const task = run.tasks[0]!;
    expect(task.taskId).toBe("dcv-004");
    expect(task.facts[0]!.matcher.kind).toBe("regex");

    const harness = task.conditions["harness"]!;
    expect(harness.text).toBe("Quantix commits to 24h.");
    expect(harness.recordedVerdicts).toEqual({ "fact-sla": true });
    expect(harness.recordedScore).toBe(1);

    const baseline = task.conditions["baseline"]!;
    expect(baseline.text).toBe("Quantix: no SLA stated.");
    expect(baseline.recordedVerdicts).toEqual({ "fact-sla": false });
    expect(baseline.recordedScore).toBe(0);
  });

  it("throws when nothing survives conversion", () => {
    expect(() => nicatorReportsToAuditInput([REPORT], {})).toThrow(
      "No runs survived conversion",
    );
  });
});
