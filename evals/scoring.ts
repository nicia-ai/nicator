/**
 * Pure scoring and aggregation functions for eval results.
 *
 * All functions are stateless — they take data in and return computed results.
 * No I/O, no side effects.
 */

import {
  asCompositeScore,
  matchFact,
  type EvalTask,
  type EvalReport,
  type TaskResult,
  type FactualScore,
} from "./schema";
import { mean } from "./stats";

type TaskResultWithJudge = TaskResult & {
  judgeScoreAveraged: NonNullable<TaskResult["judgeScoreAveraged"]>;
};

function hasConclusiveJudgeScore(r: TaskResult): r is TaskResultWithJudge {
  return r.judgeScoreAveraged !== undefined && !r.judgeScoreAveraged.inconclusive;
}

// ---------------------------------------------------------------------------
// Factual accuracy scoring
// ---------------------------------------------------------------------------

export function scoreFactualAccuracy(
  task: EvalTask,
  output: string,
): FactualScore {
  const facts = task.referenceFacts.map((fact) => ({
    factId: fact.id,
    matched: matchFact(fact, output),
    weight: fact.weight,
  }));

  const totalWeight = facts.reduce((sum, f) => sum + f.weight, 0);
  const matchedWeight = facts
    .filter((f) => f.matched)
    .reduce((sum, f) => sum + f.weight, 0);

  return {
    taskId: task.id,
    facts,
    score: asCompositeScore(totalWeight > 0 ? matchedWeight / totalWeight : 0),
  };
}

// ---------------------------------------------------------------------------
// Binary pass/fail grading
// ---------------------------------------------------------------------------

export function gradePassFail(
  task: EvalTask,
  factual: FactualScore | undefined,
  judgeComposite: number | undefined,
): { pass: boolean; reason: string } {
  const criteria = task.passFail;
  const reasons: string[] = [];

  if (criteria.requiredFactIds.length > 0 && factual) {
    const missingRequired = criteria.requiredFactIds.filter((factId) => {
      const fact = factual.facts.find((f) => f.factId === factId);
      return !fact || !fact.matched;
    });
    if (missingRequired.length > 0) {
      reasons.push(`Missing required facts: ${missingRequired.join(", ")}`);
    }
  }

  if (
    criteria.minFactualScore !== undefined &&
    factual &&
    factual.score < criteria.minFactualScore
  ) {
    reasons.push(
      `Factual score ${factual.score.toFixed(2)} below threshold ${criteria.minFactualScore}`,
    );
  }

  if (
    criteria.minJudgeComposite !== undefined &&
    judgeComposite !== undefined &&
    judgeComposite < criteria.minJudgeComposite
  ) {
    reasons.push(
      `Judge composite ${judgeComposite.toFixed(3)} below threshold ${criteria.minJudgeComposite}`,
    );
  }

  if (reasons.length === 0) {
    return { pass: true, reason: "All criteria met" };
  }
  return { pass: false, reason: reasons.join("; ") };
}

// ---------------------------------------------------------------------------
// Per-result helpers
// ---------------------------------------------------------------------------

function getFactualScore(result: TaskResult, agent: "harness" | "baseline"): number {
  if (agent === "baseline") return result.baselineFactualScore?.score ?? 0;
  return result.factualScore?.score ?? 0;
}

// ---------------------------------------------------------------------------
// Aggregate computation
// ---------------------------------------------------------------------------

export function computeAggregate(
  tasks: EvalTask[],
  results: TaskResult[],
): EvalReport["aggregate"] {
  const withFactual = results.filter((r) => r.factualScore);
  const withJudge = results.filter(hasConclusiveJudgeScore);

  const avgFactualHarness = mean(withFactual.map((r) => getFactualScore(r, "harness")));
  const avgFactualBaseline = mean(withFactual.map((r) => getFactualScore(r, "baseline")));
  const avgJudgeHarness = mean(withJudge.map((r) => r.judgeScoreAveraged.harness));
  const avgJudgeBaseline = mean(withJudge.map((r) => r.judgeScoreAveraged.baseline));

  const inconclusiveCount = results.filter(
    (r) => r.judgeScoreAveraged?.inconclusive,
  ).length;

  const taskCategoryMap = new Map(tasks.map((t) => [t.id, t.category]));
  const categories = [...new Set(tasks.map((t) => t.category))];
  const byCategory = Object.fromEntries(
    categories.map((cat) => {
      const catResults = results.filter(
        (r) => taskCategoryMap.get(r.taskId) === cat,
      );
      return [
        cat,
        {
          harness: mean(catResults.map((r) => r.judgeScoreAveraged?.harness ?? 0)),
          baseline: mean(catResults.map((r) => r.judgeScoreAveraged?.baseline ?? 0)),
          n: catResults.length,
        },
      ];
    }),
  ) as EvalReport["aggregate"]["byCategory"];

  const processMetrics = {
    avgSkillsPerRun: mean(
      results.map((r) => r.harnessMetrics.skillsInvoked.length),
    ),
    avgOperationsPerRun: mean(
      results.map((r) => r.harnessMetrics.totalOperations),
    ),
    hitlRate:
      results.filter((r) => r.harnessMetrics.hitlTriggered).length /
      results.length,
    avgContextPressureRatio: mean(
      results.map(
        (r) => r.harnessMetrics.contextPressureTokens / r.baselineOutput.totalTokens,
      ),
    ),
  };

  const passRate =
    results.length > 0 ?
      {
        harness:
          results.filter((r) => r.passFailResult.harnessPass).length /
          results.length,
        baseline:
          results.filter((r) => r.passFailResult.baselinePass).length /
          results.length,
        total: results.length,
      }
    : undefined;

  const harnessFailureCounts: Record<string, number> = {};
  const baselineFailureCounts: Record<string, number> = {};
  for (const r of results) {
    if (r.harnessFailureMode) {
      harnessFailureCounts[r.harnessFailureMode] =
        (harnessFailureCounts[r.harnessFailureMode] ?? 0) + 1;
    }
    if (r.baselineFailureMode) {
      baselineFailureCounts[r.baselineFailureMode] =
        (baselineFailureCounts[r.baselineFailureMode] ?? 0) + 1;
    }
  }

  const hasFailureModes =
    Object.keys(harnessFailureCounts).length > 0 ||
    Object.keys(baselineFailureCounts).length > 0;
  const failureModes = hasFailureModes
    ? { harness: harnessFailureCounts, baseline: baselineFailureCounts }
    : undefined;

  return {
    factualAccuracy: {
      harness: avgFactualHarness,
      baseline: avgFactualBaseline,
      delta: avgFactualHarness - avgFactualBaseline,
    },
    judgeQuality: {
      harness: avgJudgeHarness,
      baseline: avgJudgeBaseline,
      delta: avgJudgeHarness - avgJudgeBaseline,
      inconclusiveCount,
    },
    passRate,
    failureModes,
    byCategory,
    processMetrics,
  };
}
