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
  resolveTaskMetadata,
  type TaskResult,
  type FactualScore,
} from "./schema";
import type { StepGrade, StepGradingResult } from "./step-graders";
import { mean } from "./stats";

type TaskResultWithJudge = TaskResult & {
  judgeScoreAveraged: NonNullable<TaskResult["judgeScoreAveraged"]>;
};

function hasConclusiveJudgeScore(r: TaskResult): r is TaskResultWithJudge {
  return (
    r.judgeScoreAveraged !== undefined && !r.judgeScoreAveraged.inconclusive
  );
}

function hasBaselineComparison(r: TaskResult): boolean {
  return r.metadata?.comparisonMode !== "none";
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
    expected: fact.expected ?? "present",
    weight: fact.weight,
  }));

  const positiveFacts = facts.filter((f) => f.expected === "present");
  const totalWeight = positiveFacts.reduce((sum, f) => sum + f.weight, 0);
  const matchedWeight = positiveFacts
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

function gatedStepGradeAspects(
  task: EvalTask,
): Set<StepGrade["aspect"]> | "all" {
  if (task.passFail.requireZeroFailingStepGrades) {
    return "all";
  }

  const aspects = new Set<StepGrade["aspect"]>();
  if ((task.graphAssertions?.length ?? 0) > 0) {
    aspects.add("graph_assertion");
  }
  if (
    (task.requiredSkills?.length ?? 0) > 0 ||
    (task.forbiddenSkills?.length ?? 0) > 0
  ) {
    aspects.add("skill_decomposition");
  }
  return aspects;
}

export function getFailingGatedStepGrades(
  task: EvalTask,
  stepGrades: StepGradingResult | undefined,
): StepGrade[] {
  if (!stepGrades) return [];
  const gatedAspects = gatedStepGradeAspects(task);
  if (gatedAspects !== "all" && gatedAspects.size === 0) return [];

  return stepGrades.grades.filter(
    (g) =>
      g.severity === "fail" &&
      (gatedAspects === "all" || gatedAspects.has(g.aspect)),
  );
}

export function gradePassFail(
  task: EvalTask,
  factual: FactualScore | undefined,
  judgeComposite: number | undefined,
  stepGrades?: StepGradingResult,
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

  if (factual) {
    const forbiddenMatches = task.referenceFacts
      .filter((fact) => fact.expected === "absent")
      .filter((fact) =>
        factual.facts.some((f) => f.factId === fact.id && f.matched),
      )
      .map((fact) => fact.id);
    if (forbiddenMatches.length > 0) {
      reasons.push(`Forbidden facts matched: ${forbiddenMatches.join(", ")}`);
    }
  }

  const failingGrades = getFailingGatedStepGrades(task, stepGrades);
  if (failingGrades.length > 0) {
    const aspects = [...new Set(failingGrades.map((g) => g.aspect))];
    reasons.push(
      `Process gate failed: ${failingGrades.length} failing step grade(s) (${aspects.join(", ")})`,
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

export function regradePassFailResult(
  task: EvalTask,
  result: Pick<
    TaskResult,
    | "factualScore"
    | "baselineFactualScore"
    | "judgeScoreAveraged"
    | "stepGrades"
  >,
): TaskResult["passFailResult"] {
  const harness = gradePassFail(
    task,
    result.factualScore,
    result.judgeScoreAveraged?.harness,
    result.stepGrades,
  );
  const baseline = gradePassFail(
    task,
    result.baselineFactualScore,
    result.judgeScoreAveraged?.baseline,
    undefined,
  );

  return {
    harnessPass: harness.pass,
    baselinePass: baseline.pass,
    harnessReason: harness.reason,
    baselineReason: baseline.reason,
  };
}

function getFactualScore(
  result: TaskResult,
  agent: "harness" | "baseline",
): number {
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

  const avgFactualHarness = mean(
    withFactual.map((r) => getFactualScore(r, "harness")),
  );
  const withBaselineFactual = withFactual.filter(hasBaselineComparison);
  const avgFactualBaseline = mean(
    withBaselineFactual.map((r) => getFactualScore(r, "baseline")),
  );
  const avgJudgeHarness = mean(
    withJudge.map((r) => r.judgeScoreAveraged.harness),
  );
  const avgJudgeBaseline = mean(
    withJudge.map((r) => r.judgeScoreAveraged.baseline),
  );

  const inconclusiveCount = results.filter(
    (r) => r.judgeScoreAveraged?.inconclusive,
  ).length;

  const taskCategoryMap = new Map(tasks.map((t) => [t.id, t.category]));
  const taskDefinitionMap = new Map(tasks.map((t) => [t.id, t]));
  const taskMetadataMap = new Map(
    tasks.map((t) => [t.id, resolveTaskMetadata(t)]),
  );

  function buildGrouping(
    labels: string[],
    labelForResult: (result: TaskResult) => string[],
  ): Record<string, { harness: number; baseline: number; n: number }> {
    return Object.fromEntries(
      labels.map((label) => {
        const groupedResults = results.filter((r) =>
          labelForResult(r).includes(label),
        );
        // Filter to conclusive judge scores before averaging so that
        // --no-judge runs are not rolled in as 0. Matches the top-level
        // avgJudge{Harness,Baseline} computation above.
        const groupedWithJudge = groupedResults.filter(hasConclusiveJudgeScore);
        return [
          label,
          {
            harness: mean(
              groupedWithJudge.map((r) => r.judgeScoreAveraged.harness),
            ),
            baseline: mean(
              groupedWithJudge.map((r) => r.judgeScoreAveraged.baseline),
            ),
            n: groupedResults.length,
          },
        ];
      }),
    );
  }

  const categories = [...new Set(tasks.map((t) => t.category))];
  const byCategory = buildGrouping(categories, (r) => {
    const category = taskCategoryMap.get(r.taskId);
    return category ? [category] : [];
  }) as EvalReport["aggregate"]["byCategory"];

  const purposes = [
    ...new Set(tasks.map((t) => resolveTaskMetadata(t).purpose)),
  ];
  const byPurpose = buildGrouping(purposes, (r) => {
    const metadata = taskMetadataMap.get(r.taskId);
    return metadata ? [metadata.purpose] : [];
  }) as EvalReport["aggregate"]["byPurpose"];

  const releaseGates = [
    ...new Set(tasks.map((t) => resolveTaskMetadata(t).releaseGate)),
  ];
  const byReleaseGate = buildGrouping(releaseGates, (r) => {
    const metadata = taskMetadataMap.get(r.taskId);
    return metadata ? [metadata.releaseGate] : [];
  }) as EvalReport["aggregate"]["byReleaseGate"];

  const suites = [
    ...new Set(tasks.flatMap((t) => resolveTaskMetadata(t).suites)),
  ];
  const bySuite = buildGrouping(
    suites,
    (r) => taskMetadataMap.get(r.taskId)?.suites ?? [],
  ) as EvalReport["aggregate"]["bySuite"];

  // Reliability tasks (comparisonMode: "none") run no baseline, so
  // baselineOutput.totalTokens is 0 and the ratio is undefined for those
  // rows. Skip them before averaging; otherwise the mean is Infinity,
  // serializes to null in JSON, and fails EvalReportSchema on reload.
  const withBaselineTokens = results.filter(
    (r) => r.baselineOutput.totalTokens > 0,
  );
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
      withBaselineTokens.map(
        (r) =>
          r.harnessMetrics.contextPressureTokens / r.baselineOutput.totalTokens,
      ),
    ),
  };

  const comparableBaselineResults = results.filter(hasBaselineComparison);
  const countPasses = (
    agent: "harness" | "baseline",
    passResults: TaskResult[] = results,
  ): number =>
    passResults.filter((r) => {
      const task = taskDefinitionMap.get(r.taskId);
      if (!task) {
        return agent === "harness" ?
            r.passFailResult.harnessPass
          : r.passFailResult.baselinePass;
      }
      const passFail = regradePassFailResult(task, r);
      return agent === "harness" ? passFail.harnessPass : passFail.baselinePass;
    }).length;

  const passRate =
    results.length > 0 ?
      {
        harness: countPasses("harness") / results.length,
        baseline:
          comparableBaselineResults.length > 0 ?
            countPasses("baseline", comparableBaselineResults) /
            comparableBaselineResults.length
          : 0,
        total: results.length,
        baselineTotal: comparableBaselineResults.length,
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
  const failureModes =
    hasFailureModes ?
      { harness: harnessFailureCounts, baseline: baselineFailureCounts }
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
    byPurpose,
    byReleaseGate,
    bySuite,
    passRate,
    failureModes,
    byCategory,
    processMetrics,
  };
}
