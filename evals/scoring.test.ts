import { describe, expect, it } from "vitest";

import {
  computeAggregate,
  gradePassFail,
  scoreFactualAccuracy,
} from "./scoring";
import type { EvalTask, FactualScore, TaskResult } from "./schema";
import { asCompositeScore, EvalReportSchema } from "./schema";
import type { StepGradingResult } from "./step-graders";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(
  overrides: Partial<Omit<EvalTask, "passFail">> & {
    passFail?: Partial<EvalTask["passFail"]>;
  } = {},
): EvalTask {
  return {
    id: "synth-001",
    category: "synthesis",
    name: "Test task",
    description: "A test task",
    sources: [
      { id: "s1", title: "Source", content: "content", tokenCount: 100 },
    ],
    question: "What is the answer?",
    referenceFacts: [],
    passFail: {
      requiredFactIds: [],
      requireZeroFailingStepGrades: false,
      description: "Must pass",
      ...overrides.passFail,
    },
    hitlBehavior: "auto_approve",
    ...overrides,
  } as EvalTask;
}

// ---------------------------------------------------------------------------
// scoreFactualAccuracy
// ---------------------------------------------------------------------------

describe("scoreFactualAccuracy", () => {
  it("scores 1.0 when all facts match", () => {
    const task = makeTask({
      referenceFacts: [
        {
          id: "f1",
          canonical: "42",
          description: "The answer",
          expected: "present",
          weight: 1,
        },
        {
          id: "f2",
          canonical: "universe",
          description: "Context",
          expected: "present",
          weight: 1,
        },
      ],
    });

    const result = scoreFactualAccuracy(
      task,
      "The answer is 42, the universe and everything",
    );
    expect(result.score).toBe(1);
    expect(result.facts.every((f) => f.matched)).toBe(true);
  });

  it("scores 0 when no facts match", () => {
    const task = makeTask({
      referenceFacts: [
        {
          id: "f1",
          canonical: "specific-term-xyz",
          description: "Term",
          expected: "present",
          weight: 1,
        },
      ],
    });

    const result = scoreFactualAccuracy(
      task,
      "This output contains nothing relevant",
    );
    expect(result.score).toBe(0);
  });

  it("scores by weighted fraction", () => {
    const task = makeTask({
      referenceFacts: [
        {
          id: "f1",
          canonical: "found-this",
          description: "Found",
          expected: "present",
          weight: 3,
        },
        {
          id: "f2",
          canonical: "missing-this",
          description: "Missing",
          expected: "present",
          weight: 1,
        },
      ],
    });

    const result = scoreFactualAccuracy(
      task,
      "Output contains found-this but not the other",
    );
    // 3/4 = 0.75
    expect(result.score).toBe(0.75);
  });

  it("handles zero-weight facts", () => {
    const task = makeTask({
      referenceFacts: [
        {
          id: "f1",
          canonical: "real",
          description: "Real",
          expected: "present",
          weight: 1,
        },
        {
          id: "f2",
          canonical: "compliance",
          description: "Should not match",
          expected: "present",
          weight: 0,
        },
      ],
    });

    const result = scoreFactualAccuracy(task, "real output with compliance");
    // weight 0 facts excluded from denominator: 1/1 = 1.0
    expect(result.score).toBe(1);
  });

  it("tracks absent facts without adding them to factual accuracy", () => {
    const task = makeTask({
      referenceFacts: [
        {
          id: "f1",
          canonical: "required",
          description: "Required",
          expected: "present",
          weight: 1,
        },
        {
          id: "f2",
          canonical: "forbidden",
          description: "Should not be asserted",
          expected: "absent",
          weight: 0,
        },
      ],
    });

    const result = scoreFactualAccuracy(task, "required and forbidden");
    expect(result.score).toBe(1);
    expect(result.facts).toContainEqual({
      factId: "f2",
      matched: true,
      expected: "absent",
      weight: 0,
    });
  });

  it("scores 0 for empty reference facts", () => {
    const task = makeTask({ referenceFacts: [] });
    const result = scoreFactualAccuracy(task, "any output");
    expect(result.score).toBe(0);
  });

  it("uses regex pattern when provided", () => {
    const task = makeTask({
      referenceFacts: [
        {
          id: "f1",
          canonical: "GDP",
          description: "GDP",
          expected: "present",
          weight: 1,
          pattern: "\\$?\\d+\\.?\\d*\\s*(trillion|billion)",
        },
      ],
    });

    const result = scoreFactualAccuracy(
      task,
      "The GDP was $2.5 trillion in 2025",
    );
    expect(result.score).toBe(1);
  });

  it("requires every requiredPatterns regex to match", () => {
    const task = makeTask({
      referenceFacts: [
        {
          id: "f1",
          canonical: "unused",
          description: "Must include both doc IDs and the conflicting value",
          expected: "present",
          weight: 1,
          requiredPatterns: ["MDS-POL-004", "MDS-REG-003", "60\\s*hours?"],
        },
      ],
    });

    expect(
      scoreFactualAccuracy(
        task,
        "Cite MDS-POL-004 and MDS-REG-003; the stricter deadline is 60 hours.",
      ).score,
    ).toBe(1);

    expect(
      scoreFactualAccuracy(
        task,
        "MDS-POL-004 conflicts with a stricter state deadline.",
      ).score,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// gradePassFail
// ---------------------------------------------------------------------------

describe("gradePassFail", () => {
  it("passes when all criteria met", () => {
    const task = makeTask({
      passFail: {
        minFactualScore: 0.5,
        requiredFactIds: ["f1"],
        description: "Must pass",
      },
    });
    const factual: FactualScore = {
      taskId: "synth-001",
      facts: [{ factId: "f1", matched: true, expected: "present", weight: 1 }],
      score: asCompositeScore(1),
    };

    const { pass } = gradePassFail(task, factual, undefined);
    expect(pass).toBe(true);
  });

  it("fails on missing required facts", () => {
    const task = makeTask({
      passFail: {
        requiredFactIds: ["f1", "f2"],
        description: "Must have facts",
      },
    });
    const factual: FactualScore = {
      taskId: "synth-001",
      facts: [
        { factId: "f1", matched: true, expected: "present", weight: 1 },
        { factId: "f2", matched: false, expected: "present", weight: 1 },
      ],
      score: asCompositeScore(0.5),
    };

    const { pass, reason } = gradePassFail(task, factual, undefined);
    expect(pass).toBe(false);
    expect(reason).toContain("f2");
  });

  it("fails on low factual score", () => {
    const task = makeTask({
      passFail: {
        minFactualScore: 0.8,
        requiredFactIds: [],
        description: "High bar",
      },
    });
    const factual: FactualScore = {
      taskId: "synth-001",
      facts: [{ factId: "f1", matched: false, expected: "present", weight: 1 }],
      score: asCompositeScore(0.3),
    };

    const { pass, reason } = gradePassFail(task, factual, undefined);
    expect(pass).toBe(false);
    expect(reason).toContain("below threshold");
  });

  it("fails on low judge composite", () => {
    const task = makeTask({
      passFail: {
        minJudgeComposite: 0.7,
        requiredFactIds: [],
        description: "Judge must like it",
      },
    });

    const { pass } = gradePassFail(task, undefined, 0.5);
    expect(pass).toBe(false);
  });

  it("fails when an absent fact is matched", () => {
    const task = makeTask({
      referenceFacts: [
        {
          id: "forbidden",
          canonical: "forbidden",
          description: "Should not be asserted",
          expected: "absent",
          weight: 0,
        },
      ],
      passFail: { requiredFactIds: [], description: "Must not hallucinate" },
    });
    const factual: FactualScore = {
      taskId: "synth-001",
      facts: [
        {
          factId: "forbidden",
          matched: true,
          expected: "absent",
          weight: 0,
        },
      ],
      score: asCompositeScore(0),
    };

    const { pass, reason } = gradePassFail(task, factual, undefined);
    expect(pass).toBe(false);
    expect(reason).toContain("Forbidden facts matched");
  });

  it("passes when no criteria require factual or judge scores", () => {
    const task = makeTask({
      passFail: { requiredFactIds: [], description: "Always pass" },
    });

    const { pass } = gradePassFail(task, undefined, undefined);
    expect(pass).toBe(true);
  });

  it("fails when process gate is enabled and failing step grades exist", () => {
    const task = makeTask({
      passFail: {
        requiredFactIds: [],
        requireZeroFailingStepGrades: true,
        description: "Process must pass",
      },
    });

    const stepGrades: StepGradingResult = {
      taskId: "synth-001",
      grades: [
        {
          aspect: "graph_assertion",
          severity: "fail",
          finding: "missing required subagent",
        },
      ],
      summary: { pass: 0, warn: 0, fail: 1 },
    };

    const { pass, reason } = gradePassFail(
      task,
      undefined,
      undefined,
      stepGrades,
    );
    expect(pass).toBe(false);
    expect(reason).toContain("Process gate failed");
    expect(reason).toContain("graph_assertion");
  });

  it("fails graph assertion step grades even without the legacy process gate flag", () => {
    const task = makeTask({
      graphAssertions: [
        {
          type: "run_status",
          status: "completed",
          description: "Run should complete",
        },
      ],
      passFail: {
        requiredFactIds: [],
        requireZeroFailingStepGrades: false,
        description: "Graph assertions must pass",
      },
    });

    const stepGrades: StepGradingResult = {
      taskId: "synth-001",
      grades: [
        {
          aspect: "graph_assertion",
          severity: "fail",
          finding: "run failed",
        },
      ],
      summary: { pass: 0, warn: 0, fail: 1 },
    };

    const { pass, reason } = gradePassFail(
      task,
      undefined,
      undefined,
      stepGrades,
    );
    expect(pass).toBe(false);
    expect(reason).toContain("graph_assertion");
  });

  it("passes process gate when there are no failing step grades", () => {
    const task = makeTask({
      passFail: {
        requiredFactIds: [],
        requireZeroFailingStepGrades: true,
        description: "Process must pass",
      },
    });

    const stepGrades: StepGradingResult = {
      taskId: "synth-001",
      grades: [
        {
          aspect: "retry_behavior",
          severity: "warn",
          finding: "high retry rate",
        },
      ],
      summary: { pass: 0, warn: 1, fail: 0 },
    };

    const { pass } = gradePassFail(task, undefined, undefined, stepGrades);
    expect(pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeAggregate — reliability and no-judge regression tests
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: "t-001",
    category: "reliability",
    harnessOutput: { text: "", totalTokens: 100, latencyMs: 0 },
    baselineOutput: { text: "", totalTokens: 100, latencyMs: 0 },
    harnessMetrics: {
      skillsInvoked: [],
      totalOperations: 0,
      hitlTriggered: false,
      contextPressureTokens: 500,
      compressionApplied: false,
    },
    passFailResult: {
      harnessPass: true,
      baselinePass: true,
      harnessReason: "",
      baselineReason: "",
    },
    ...overrides,
  } as TaskResult;
}

describe("computeAggregate — reliability regression", () => {
  it("emits a finite avgContextPressureRatio when every result has zero baseline tokens", () => {
    const task = makeTask({
      id: "rel-001",
      category: "reliability" as const,
    });
    const results: TaskResult[] = [
      makeResult({
        taskId: "rel-001",
        category: "reliability" as const,
        baselineOutput: { text: "", totalTokens: 0, latencyMs: 0 },
      }),
      makeResult({
        taskId: "rel-001",
        category: "reliability" as const,
        baselineOutput: { text: "", totalTokens: 0, latencyMs: 0 },
      }),
    ];

    const aggregate = computeAggregate([task], results);

    expect(
      Number.isFinite(aggregate.processMetrics.avgContextPressureRatio),
    ).toBe(true);
  });

  it("produces a report that round-trips through EvalReportSchema when baselines are zero", () => {
    const task = makeTask({
      id: "rel-001",
      category: "reliability" as const,
    });
    const results: TaskResult[] = [
      makeResult({
        taskId: "rel-001",
        category: "reliability" as const,
        baselineOutput: { text: "", totalTokens: 0, latencyMs: 0 },
      }),
    ];

    const aggregate = computeAggregate([task], results);
    const report = {
      runId: "test-run",
      timestamp: new Date().toISOString(),
      harnessVersion: "0.0.0",
      modelVersion: "test",
      tasks: results,
      aggregate,
    };

    // Round-trip through JSON and the schema. Before the fix the ratio
    // was Infinity, which JSON.stringify converts to null, and
    // EvalReportSchema's z.number() rejected null on reload.
    const roundTripped = JSON.parse(JSON.stringify(report));
    const parsed = EvalReportSchema.safeParse(roundTripped);
    expect(parsed.success).toBe(true);
  });

  it("skips no-judge runs in grouped aggregates instead of counting them as 0", () => {
    const task = makeTask({ id: "rel-001", category: "reliability" as const });

    // One result with a judge score, one without (the typical mix when a
    // reliability run is interleaved with a judge-scored run). If the
    // grouping treats the no-judge run as 0, the mean is 0.5; if it
    // skips it, the mean is the judge value itself.
    const results: TaskResult[] = [
      makeResult({
        taskId: "rel-001",
        category: "reliability" as const,
        judgeScoreAveraged: {
          harness: asCompositeScore(1),
          baseline: asCompositeScore(1),
          inconclusive: false,
        },
      }),
      makeResult({
        taskId: "rel-001",
        category: "reliability" as const,
        // no judgeScoreAveraged — this simulates a --no-judge run
      }),
    ];

    const aggregate = computeAggregate([task], results);

    expect(aggregate.byCategory["reliability"]?.harness).toBe(1);
    expect(aggregate.byCategory["reliability"]?.baseline).toBe(1);
    // n counts every result in the group, regardless of judge presence
    expect(aggregate.byCategory["reliability"]?.n).toBe(2);
  });
});
