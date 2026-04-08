import { describe, expect, it } from "vitest";

import { gradePassFail, scoreFactualAccuracy } from "./scoring";
import type { EvalTask, FactualScore } from "./schema";
import { asCompositeScore } from "./schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: "synth-001",
    category: "synthesis",
    name: "Test task",
    description: "A test task",
    sources: [{ id: "s1", title: "Source", content: "content", tokenCount: 100 }],
    question: "What is the answer?",
    referenceFacts: [],
    passFail: {
      requiredFactIds: [],
      description: "Must pass",
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
        { id: "f1", canonical: "42", description: "The answer", weight: 1 },
        { id: "f2", canonical: "universe", description: "Context", weight: 1 },
      ],
    });

    const result = scoreFactualAccuracy(task, "The answer is 42, the universe and everything");
    expect(result.score).toBe(1);
    expect(result.facts.every((f) => f.matched)).toBe(true);
  });

  it("scores 0 when no facts match", () => {
    const task = makeTask({
      referenceFacts: [
        { id: "f1", canonical: "specific-term-xyz", description: "Term", weight: 1 },
      ],
    });

    const result = scoreFactualAccuracy(task, "This output contains nothing relevant");
    expect(result.score).toBe(0);
  });

  it("scores by weighted fraction", () => {
    const task = makeTask({
      referenceFacts: [
        { id: "f1", canonical: "found-this", description: "Found", weight: 3 },
        { id: "f2", canonical: "missing-this", description: "Missing", weight: 1 },
      ],
    });

    const result = scoreFactualAccuracy(task, "Output contains found-this but not the other");
    // 3/4 = 0.75
    expect(result.score).toBe(0.75);
  });

  it("handles zero-weight facts", () => {
    const task = makeTask({
      referenceFacts: [
        { id: "f1", canonical: "real", description: "Real", weight: 1 },
        { id: "f2", canonical: "compliance", description: "Should not match", weight: 0 },
      ],
    });

    const result = scoreFactualAccuracy(task, "real output with compliance");
    // weight 0 facts excluded from denominator: 1/1 = 1.0
    expect(result.score).toBe(1);
  });

  it("scores 0 for empty reference facts", () => {
    const task = makeTask({ referenceFacts: [] });
    const result = scoreFactualAccuracy(task, "any output");
    expect(result.score).toBe(0);
  });

  it("uses regex pattern when provided", () => {
    const task = makeTask({
      referenceFacts: [
        { id: "f1", canonical: "GDP", description: "GDP", weight: 1, pattern: "\\$?\\d+\\.?\\d*\\s*(trillion|billion)" },
      ],
    });

    const result = scoreFactualAccuracy(task, "The GDP was $2.5 trillion in 2025");
    expect(result.score).toBe(1);
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
      facts: [{ factId: "f1", matched: true, weight: 1 }],
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
        { factId: "f1", matched: true, weight: 1 },
        { factId: "f2", matched: false, weight: 1 },
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
      facts: [{ factId: "f1", matched: false, weight: 1 }],
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

  it("passes when no criteria require factual or judge scores", () => {
    const task = makeTask({
      passFail: { requiredFactIds: [], description: "Always pass" },
    });

    const { pass } = gradePassFail(task, undefined, undefined);
    expect(pass).toBe(true);
  });
});
