/**
 * Per-fact LLM-judge rescore over a scorer-audit input.
 *
 * For every (run, task, condition), the deterministic matcher verdicts
 * (recorded in the input, or recomputed from each fact's matcher spec)
 * are compared against fresh per-fact judge verdicts. The disagreement
 * audit decomposes every fact-verdict into four mutually exclusive
 * categories; high counts in `matcher failed, judge passed` indicate
 * surface-form false negatives where the matcher missed correct content.
 */
import { type JudgeCall, runPerFactJudge } from "./judge.js";
import { type FactVerdict, matchFact, weightedScore } from "./matchers.js";
import type {
  AuditInput,
  AuditTask,
  ConditionOutput,
  ConditionRescore,
  RescoreOutput,
  TaskRescore,
} from "./schema.js";
import { mean } from "./stats.js";

// ---------------------------------------------------------------------------
// Matcher side
// ---------------------------------------------------------------------------

export function matcherVerdictsFor(
  task: AuditTask,
  output: ConditionOutput,
): Record<string, boolean> {
  if (output.recordedVerdicts) return { ...output.recordedVerdicts };
  return Object.fromEntries(
    task.facts.map((fact) => [fact.id, matchFact(fact, output.text)]),
  );
}

function matcherScoreFor(
  task: AuditTask,
  output: ConditionOutput,
  verdicts: Readonly<Record<string, boolean>>,
): number {
  if (output.recordedScore !== undefined) return output.recordedScore;
  const factVerdicts: FactVerdict[] = task.facts.map((fact) => ({
    factId: fact.id,
    matched: verdicts[fact.id] ?? false,
    expected: fact.expected,
    weight: fact.weight,
  }));
  return weightedScore(factVerdicts);
}

// ---------------------------------------------------------------------------
// Rescore
// ---------------------------------------------------------------------------

export type RescoreLogger = (message: string) => void;

export async function rescoreInput(
  input: AuditInput,
  call: JudgeCall,
  options: { judgeModel: string; log?: RescoreLogger },
): Promise<RescoreOutput> {
  const log = options.log ?? (() => undefined);
  const entries: TaskRescore[] = [];

  for (const run of input.runs) {
    for (const task of run.tasks) {
      const conditions: Record<string, ConditionRescore> = {};
      for (const conditionName of input.comparison) {
        const output = task.conditions[conditionName];
        if (!output) {
          log(
            `  [skip] ${run.runId.slice(0, 8)} ${task.taskId}: no "${conditionName}" condition`,
          );
          continue;
        }
        const matcherVerdicts = matcherVerdictsFor(task, output);
        const matcherScore = matcherScoreFor(task, output, matcherVerdicts);
        log(
          `  [judge] ${run.runId.slice(0, 8)} ${task.taskId} ${conditionName} ` +
            `(matcher=${matcherScore.toFixed(2)})`,
        );
        const judged = await runPerFactJudge(task.facts, output.text, call);
        log(`           judge=${judged.score.toFixed(2)}`);
        conditions[conditionName] = {
          matcherScore,
          judgeScore: judged.score,
          verdicts: [...judged.verdicts],
          matcherVerdicts,
        };
      }
      if (Object.keys(conditions).length > 0) {
        entries.push({ runId: run.runId, taskId: task.taskId, conditions });
      }
    }
  }

  return {
    comparison: input.comparison,
    judgeModel: options.judgeModel,
    generatedAt: new Date().toISOString(),
    entries,
  };
}

// ---------------------------------------------------------------------------
// Disagreement audit
// ---------------------------------------------------------------------------

export type AuditCategories = Readonly<{
  matcherFailJudgePass: number;
  matcherPassJudgeFail: number;
  bothFailed: number;
  bothPassed: number;
  noJudgeVerdict: number;
  total: number;
}>;

export function auditCategories(
  entries: readonly TaskRescore[],
  condition: string,
): AuditCategories {
  let matcherFailJudgePass = 0;
  let matcherPassJudgeFail = 0;
  let bothFailed = 0;
  let bothPassed = 0;
  let noJudgeVerdict = 0;
  for (const entry of entries) {
    const block = entry.conditions[condition];
    if (!block) continue;
    const judgeVerdicts = new Map(
      block.verdicts.map((v) => [v.factId, v.matched]),
    );
    for (const [factId, matcherMatched] of Object.entries(
      block.matcherVerdicts,
    )) {
      const judgeMatched = judgeVerdicts.get(factId);
      if (judgeMatched === undefined) {
        noJudgeVerdict++;
      } else if (!matcherMatched && judgeMatched) {
        matcherFailJudgePass++;
      } else if (matcherMatched && !judgeMatched) {
        matcherPassJudgeFail++;
      } else if (!matcherMatched && !judgeMatched) {
        bothFailed++;
      } else {
        bothPassed++;
      }
    }
  }
  const total =
    matcherFailJudgePass +
    matcherPassJudgeFail +
    bothFailed +
    bothPassed +
    noJudgeVerdict;
  return {
    matcherFailJudgePass,
    matcherPassJudgeFail,
    bothFailed,
    bothPassed,
    noJudgeVerdict,
    total,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(v: number | undefined): string {
  return v === undefined ? "—" : v.toFixed(3);
}

export function formatRescoreReport(output: RescoreOutput): string {
  const [condA, condB] = output.comparison;
  const entries = output.entries;
  if (entries.length === 0) return "No rescored runs.\n";

  const scoreOf = (
    entry: TaskRescore,
    condition: string,
    kind: "matcherScore" | "judgeScore",
  ): number | undefined => entry.conditions[condition]?.[kind];

  const lines: string[] = [
    "# Per-fact LLM-judge rescore\n",
    `Judge model: \`${output.judgeModel}\` · Generated: ${output.generatedAt}\n`,
    "Rescores existing outputs using an LLM judge that tolerates " +
      "surface-form variation. The matcher columns reproduce the " +
      "deterministic scorer's verdicts; the judge columns are fresh " +
      "per-fact verdicts.\n",
    "## Per-run comparison\n",
    `| Run | Task | ${condA} matcher | ${condA} judge | ${condB} matcher | ${condB} judge | Judge Δ (${condA}−${condB}) |`,
    "|---|---|---|---|---|---|---|",
  ];
  for (const entry of entries) {
    const aJudge = scoreOf(entry, condA, "judgeScore");
    const bJudge = scoreOf(entry, condB, "judgeScore");
    const delta =
      aJudge !== undefined && bJudge !== undefined ?
        aJudge - bJudge
      : undefined;
    lines.push(
      `| ${entry.runId.slice(0, 8)} | ${entry.taskId} | ` +
        `${fmt(scoreOf(entry, condA, "matcherScore"))} | ${fmt(aJudge)} | ` +
        `${fmt(scoreOf(entry, condB, "matcherScore"))} | ${fmt(bJudge)} | ` +
        `${delta === undefined ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`} |`,
    );
  }

  lines.push(
    "\n## Aggregate\n",
    `| | ${condA} matcher | ${condA} judge | ${condB} matcher | ${condB} judge |`,
    "|---|---|---|---|---|",
  );
  const collect = (
    condition: string,
    kind: "matcherScore" | "judgeScore",
  ): number[] =>
    entries
      .map((entry) => scoreOf(entry, condition, kind))
      .filter((v): v is number => v !== undefined);
  const aMatcher = mean(collect(condA, "matcherScore"));
  const aJudge = mean(collect(condA, "judgeScore"));
  const bMatcher = mean(collect(condB, "matcherScore"));
  const bJudge = mean(collect(condB, "judgeScore"));
  lines.push(
    `| Mean | ${aMatcher.toFixed(3)} | ${aJudge.toFixed(3)} | ${bMatcher.toFixed(3)} | ${bJudge.toFixed(3)} |`,
    `| Δ (${condA}−${condB}) | ${(aMatcher - bMatcher).toFixed(3)} | **${(aJudge - bJudge).toFixed(3)}** | | |`,
  );

  // Group by task for per-task disagreement audit.
  const byTask = new Map<string, TaskRescore[]>();
  for (const entry of entries) {
    const array = byTask.get(entry.taskId) ?? [];
    array.push(entry);
    byTask.set(entry.taskId, array);
  }

  lines.push(
    "\n## Disagreement audit (aggregated across runs)\n",
    "Every fact-verdict decomposes into one of four mutually exclusive " +
      "categories. These are the load-bearing numbers for comparative " +
      "scorer-artifact analysis: high counts in `Matcher failed, judge " +
      "passed` indicate surface-form false negatives where the matcher " +
      "missed correct content.\n",
  );
  for (const [taskId, taskEntries] of byTask) {
    for (const condition of output.comparison) {
      const audit = auditCategories(taskEntries, condition);
      if (audit.total === 0) continue;
      lines.push(
        `### ${taskId} — ${condition} side\n`,
        "| Category | Count |",
        "|---|---|",
        `| Matcher failed, judge passed | ${audit.matcherFailJudgePass} |`,
        `| Matcher passed, judge failed | ${audit.matcherPassJudgeFail} |`,
        `| Both failed | ${audit.bothFailed} |`,
        `| Both passed | ${audit.bothPassed} |`,
      );
      if (audit.noJudgeVerdict > 0) {
        lines.push(`| No judge verdict | ${audit.noJudgeVerdict} |`);
      }
      lines.push(
        `| **Total ${condition} fact-verdicts** | **${audit.total}** |\n`,
      );
    }
  }

  lines.push(
    "\n## Per-run disagreements\n",
    "Per-run breakdown of the disagreement counts. Use this to see " +
      "run-to-run variation in judge stochasticity.\n",
    "| Run | Task | Condition | Matcher matched, judge rejected | Matcher missed, judge accepted |",
    "|---|---|---|---|---|",
  );
  for (const entry of entries) {
    for (const condition of output.comparison) {
      const block = entry.conditions[condition];
      if (!block) continue;
      const judgeVerdicts = new Map(
        block.verdicts.map((v) => [v.factId, v.matched]),
      );
      let matcherMatchedJudgeRejected = 0;
      let matcherMissedJudgeAccepted = 0;
      for (const [factId, matcherMatched] of Object.entries(
        block.matcherVerdicts,
      )) {
        const judgeMatched = judgeVerdicts.get(factId);
        if (matcherMatched && judgeMatched === false)
          matcherMatchedJudgeRejected++;
        if (!matcherMatched && judgeMatched === true)
          matcherMissedJudgeAccepted++;
      }
      lines.push(
        `| ${entry.runId.slice(0, 8)} | ${entry.taskId} | ${condition} | ${matcherMatchedJudgeRejected} | ${matcherMissedJudgeAccepted} |`,
      );
    }
  }

  return lines.join("\n") + "\n";
}
