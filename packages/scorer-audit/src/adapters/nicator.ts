/**
 * Adapter: nicator EvalReport JSON → generic scorer-audit input.
 *
 * A nicator EvalReport carries, per task, the harness and baseline output
 * texts plus the recorded matcher verdicts (`factualScore` /
 * `baselineFactualScore`). It does NOT carry the reference facts
 * themselves (canonical strings and matcher patterns live in the task
 * definitions), so the adapter also needs a facts file: a JSON object
 * mapping task id → array of nicator `ReferenceFact` objects.
 *
 * Only the fields this adapter consumes are validated; unknown fields in
 * the report are ignored. Nothing here imports from nicator packages.
 */
import { z } from "zod";

import type {
  AuditFact,
  AuditInput,
  AuditRun,
  AuditTask,
  ConditionOutput,
  MatcherSpec,
} from "../schema.js";

export const NICATOR_CONDITIONS = ["harness", "baseline"] as const;

// ---------------------------------------------------------------------------
// Nicator shapes (subset)
// ---------------------------------------------------------------------------

const NicatorFactVerdictSchema = z.object({
  factId: z.string(),
  matched: z.boolean(),
});

const NicatorFactualScoreSchema = z.object({
  facts: z.array(NicatorFactVerdictSchema),
  score: z.number().min(0).max(1),
});

const NicatorTaskResultSchema = z.object({
  taskId: z.string(),
  harnessOutput: z.object({ text: z.string() }),
  baselineOutput: z.object({ text: z.string() }),
  factualScore: NicatorFactualScoreSchema.optional(),
  baselineFactualScore: NicatorFactualScoreSchema.optional(),
});

export const NicatorEvalReportSchema = z.object({
  runId: z.string(),
  timestamp: z.string(),
  tasks: z.array(NicatorTaskResultSchema),
});
export type NicatorEvalReport = z.infer<typeof NicatorEvalReportSchema>;

/** Nicator ReferenceFact, as it appears in task definitions. */
export const NicatorReferenceFactSchema = z.object({
  id: z.string(),
  description: z.string().default(""),
  canonical: z.string(),
  pattern: z.string().optional(),
  requiredPatterns: z.array(z.string()).min(1).optional(),
  expected: z.enum(["present", "absent"]).default("present"),
  weight: z.number().nonnegative().default(1),
});
export type NicatorReferenceFact = z.infer<typeof NicatorReferenceFactSchema>;

/** Facts file: task id → reference facts for that task. */
export const NicatorFactsFileSchema = z.record(
  z.string(),
  z.array(NicatorReferenceFactSchema),
);
export type NicatorFactsFile = z.infer<typeof NicatorFactsFileSchema>;

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export function referenceFactToAuditFact(
  fact: NicatorReferenceFact,
): AuditFact {
  // Precedence mirrors nicator's matchFact: requiredPatterns > pattern >
  // canonical substring.
  let matcher: MatcherSpec;
  if (fact.requiredPatterns && fact.requiredPatterns.length > 0) {
    matcher = { kind: "all-of", patterns: fact.requiredPatterns };
  } else if (fact.pattern) {
    matcher = { kind: "regex", pattern: fact.pattern };
  } else {
    matcher = { kind: "substring" };
  }
  return {
    id: fact.id,
    description: fact.description,
    canonical: fact.canonical,
    matcher,
    expected: fact.expected,
    weight: fact.weight,
  };
}

function conditionOutput(
  text: string,
  factualScore:
    | Readonly<{
        facts: ReadonlyArray<{ factId: string; matched: boolean }>;
        score: number;
      }>
    | undefined,
): ConditionOutput {
  if (!factualScore) return { text };
  return {
    text,
    recordedVerdicts: Object.fromEntries(
      factualScore.facts.map((f) => [f.factId, f.matched]),
    ),
    recordedScore: factualScore.score,
  };
}

/**
 * Convert one EvalReport into an AuditRun. Tasks without a facts entry
 * are skipped (there is nothing to score them against); `onSkip` is
 * invoked with the task id when that happens.
 */
export function nicatorReportToAuditRun(
  report: NicatorEvalReport,
  factsByTask: NicatorFactsFile,
  onSkip?: (taskId: string, reason: string) => void,
): AuditRun {
  const tasks: AuditTask[] = [];
  for (const task of report.tasks) {
    const facts = factsByTask[task.taskId];
    if (!facts || facts.length === 0) {
      onSkip?.(task.taskId, "no reference facts in facts file");
      continue;
    }
    if (!task.harnessOutput.text || !task.baselineOutput.text) {
      onSkip?.(task.taskId, "missing harness or baseline output text");
      continue;
    }
    tasks.push({
      taskId: task.taskId,
      facts: facts.map((fact) => referenceFactToAuditFact(fact)),
      conditions: {
        harness: conditionOutput(task.harnessOutput.text, task.factualScore),
        baseline: conditionOutput(
          task.baselineOutput.text,
          task.baselineFactualScore,
        ),
      },
    });
  }
  return { runId: report.runId, tasks };
}

/**
 * Convert one or more EvalReports into a generic AuditInput with the
 * comparison pair ("harness", "baseline"). Runs whose every task was
 * skipped are dropped.
 */
export function nicatorReportsToAuditInput(
  reports: readonly NicatorEvalReport[],
  factsByTask: NicatorFactsFile,
  onSkip?: (taskId: string, reason: string) => void,
): AuditInput {
  const runs = reports
    .map((report) => nicatorReportToAuditRun(report, factsByTask, onSkip))
    .filter((run) => run.tasks.length > 0);
  if (runs.length === 0) {
    throw new Error(
      "No runs survived conversion — check that the facts file covers the tasks in the report(s).",
    );
  }
  return {
    comparison: [NICATOR_CONDITIONS[0], NICATOR_CONDITIONS[1]],
    runs,
  };
}
