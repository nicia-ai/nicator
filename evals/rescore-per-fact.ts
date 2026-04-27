/**
 * Per-fact LLM-judge rescoring for existing result files.
 *
 * Reads one or more result JSONs from evals/results/, runs the
 * per-fact judge against each task's harness and baseline outputs,
 * and writes a comparison report alongside the originals. Does not
 * modify the original result files.
 *
 * Usage:
 *
 *   pnpm eval:rescore --task dcv-004 --last 5
 *   pnpm eval:rescore --runs <run-prefix-1> <run-prefix-2>
 *
 * Output: evals/results/rescore-{timestamp}.{json,md}
 */
import "dotenv/config";
import { writeFileSync } from "fs";
import { join } from "path";

import { RESULTS_DIR } from "./constants";
import { runPerFactJudge, type PerFactVerdict } from "./llm-judge/per-fact";
import {
  loadEvalReportFile,
  selectEvalReportFiles,
  type EvalReportFile,
} from "./result-files";
import type { EvalReport, EvalTask, ReferenceFact, TaskResult } from "./schema";
import { mean } from "./stats";
import { loadTasks } from "./task-loader";

type ModeRescore = Readonly<{
  regexScore: number;
  judgeScore: number;
  verdicts: readonly PerFactVerdict[];
  regexVerdicts: Readonly<Record<string, boolean>>;
}>;

type TaskRescore = Readonly<{
  runId: string;
  taskId: string;
  harness: ModeRescore;
  baseline: ModeRescore;
}>;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

type Options = Readonly<{
  taskId?: string;
  runs?: readonly string[];
  last?: number;
}>;

function parseArgs(argv: readonly string[]): Options {
  const opts: { taskId?: string; runs?: string[]; last?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--task") {
      const v = argv[++i];
      if (v) opts.taskId = v;
    } else if (arg === "--last") {
      opts.last = Number.parseInt(argv[++i] ?? "5", 10);
    } else if (arg === "--runs") {
      const runs: string[] = [];
      while (i + 1 < argv.length && !(argv[i + 1] ?? "").startsWith("--")) {
        const v = argv[++i];
        if (v) runs.push(v);
      }
      opts.runs = runs;
    }
  }
  return opts;
}

function resolveRunFiles(opts: Options): EvalReportFile[] {
  const selectOptions: { last?: number; runPrefixes?: readonly string[] } = {};
  if (opts.last !== undefined) selectOptions.last = opts.last;
  if (opts.runs !== undefined) selectOptions.runPrefixes = opts.runs;
  return selectEvalReportFiles(RESULTS_DIR, selectOptions);
}

function regexVerdictsFor(
  task: TaskResult,
  mode: "harness" | "baseline",
): Record<string, boolean> {
  const src = mode === "harness" ? task.factualScore : task.baselineFactualScore;
  if (!src) return {};
  return Object.fromEntries(src.facts.map((f) => [f.factId, f.matched]));
}

// ---------------------------------------------------------------------------
// Rescore a single run file
// ---------------------------------------------------------------------------

async function rescoreRun(
  report: EvalReport,
  taskDefs: Map<string, EvalTask>,
  taskFilter: string | undefined,
): Promise<TaskRescore[]> {
  const out: TaskRescore[] = [];
  for (const task of report.tasks) {
    if (taskFilter && task.taskId !== taskFilter) continue;
    const def = taskDefs.get(task.taskId);
    if (!def) {
      console.warn(`  [skip] ${task.taskId}: no current task definition`);
      continue;
    }
    const facts: readonly ReferenceFact[] = def.referenceFacts;
    if (facts.length === 0) {
      console.warn(`  [skip] ${task.taskId}: task has no referenceFacts`);
      continue;
    }
    if (!task.harnessOutput?.text || !task.baselineOutput?.text) {
      console.warn(
        `  [skip] ${task.taskId}: missing harness or baseline output`,
      );
      continue;
    }
    console.log(
      `  [judge] ${report.runId.slice(0, 8)} ${task.taskId} ` +
        `(regex: harness=${task.factualScore?.score.toFixed(2)} ` +
        `baseline=${task.baselineFactualScore?.score.toFixed(2)})`,
    );
    const [harnessVerdict, baselineVerdict] = await Promise.all([
      runPerFactJudge(facts, task.harnessOutput.text),
      runPerFactJudge(facts, task.baselineOutput.text),
    ]);
    console.log(
      `           judge: harness=${harnessVerdict.score.toFixed(2)} ` +
        `baseline=${baselineVerdict.score.toFixed(2)}`,
    );

    out.push({
      runId: report.runId,
      taskId: task.taskId,
      harness: {
        regexScore: task.factualScore?.score ?? 0,
        judgeScore: harnessVerdict.score,
        verdicts: harnessVerdict.verdicts,
        regexVerdicts: regexVerdictsFor(task, "harness"),
      },
      baseline: {
        regexScore: task.baselineFactualScore?.score ?? 0,
        judgeScore: baselineVerdict.score,
        verdicts: baselineVerdict.verdicts,
        regexVerdicts: regexVerdictsFor(task, "baseline"),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function formatReport(results: readonly TaskRescore[]): string {
  if (results.length === 0) return "No rescored runs.\n";

  const lines: string[] = [];
  lines.push("# Per-fact LLM-judge rescoring\n");
  lines.push(
    "Rescores existing result files using an LLM judge that tolerates " +
      "surface-form variation. The regex columns reproduce the scores " +
      "already in the result files; the judge columns are fresh " +
      "per-fact verdicts.\n",
  );
  lines.push("## Per-run comparison\n");
  lines.push(
    "| Run | Task | Harness regex | Harness judge | Baseline regex | Baseline judge | Judge Δ (H−B) |",
  );
  lines.push(
    "|-----|------|---------------|---------------|----------------|----------------|---------------|",
  );
  for (const r of results) {
    const delta = r.harness.judgeScore - r.baseline.judgeScore;
    lines.push(
      `| ${r.runId.slice(0, 8)} | ${r.taskId} | ${r.harness.regexScore.toFixed(3)} | ${r.harness.judgeScore.toFixed(3)} | ${r.baseline.regexScore.toFixed(3)} | ${r.baseline.judgeScore.toFixed(3)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(3)} |`,
    );
  }

  lines.push("\n## Aggregate\n");
  lines.push(
    "| | Harness regex | Harness judge | Baseline regex | Baseline judge |",
  );
  lines.push("|---|---|---|---|---|");
  const hRegex = mean(results.map((r) => r.harness.regexScore));
  const hJudge = mean(results.map((r) => r.harness.judgeScore));
  const bRegex = mean(results.map((r) => r.baseline.regexScore));
  const bJudge = mean(results.map((r) => r.baseline.judgeScore));
  lines.push(
    `| Mean | ${hRegex.toFixed(3)} | ${hJudge.toFixed(3)} | ${bRegex.toFixed(3)} | ${bJudge.toFixed(3)} |`,
  );
  lines.push(
    `| Δ (H−B) | ${(hRegex - bRegex).toFixed(3)} | **${(hJudge - bJudge).toFixed(3)}** | | |`,
  );

  lines.push("\n## Disagreements between regex and judge\n");
  lines.push(
    "Facts where regex and judge disagree per run. High counts here " +
      "mean the regex scorer was not measuring content quality.\n",
  );
  lines.push(
    "| Run | Task | Mode | Regex matched, judge rejected | Regex missed, judge accepted |",
  );
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    for (const mode of ["harness", "baseline"] as const) {
      const judgeVerdicts = new Map(
        r[mode].verdicts.map((v) => [v.factId, v.matched]),
      );
      let regexMatchedJudgeRejected = 0;
      let regexMissedJudgeAccepted = 0;
      for (const [factId, regexMatched] of Object.entries(r[mode].regexVerdicts)) {
        const judgeMatched = judgeVerdicts.get(factId);
        if (regexMatched && judgeMatched === false) regexMatchedJudgeRejected++;
        if (!regexMatched && judgeMatched === true) regexMissedJudgeAccepted++;
      }
      lines.push(
        `| ${r.runId.slice(0, 8)} | ${r.taskId} | ${mode} | ${regexMatchedJudgeRejected} | ${regexMissedJudgeAccepted} |`,
      );
    }
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const files = resolveRunFiles(opts);
  if (files.length === 0) {
    console.error("No result files match the filter.");
    process.exitCode = 1;
    return;
  }
  console.log(
    `Rescoring ${files.length} run file(s)${opts.taskId ? ` (task=${opts.taskId})` : ""}`,
  );

  const taskList = loadTasks(opts.taskId ? { taskId: opts.taskId } : {});
  // Also include parked tasks for rescoring
  const allTasks =
    opts.taskId ?
      loadTasks({ taskId: opts.taskId })
    : loadTasks({ categories: ["decomposition-value"] });
  const defs = new Map<string, EvalTask>();
  for (const t of [...taskList, ...allTasks]) defs.set(t.id, t);

  const allResults: TaskRescore[] = [];
  for (const file of files) {
    const report = loadEvalReportFile(file);
    console.log(`\n[${file.name}]`);
    const rescored = await rescoreRun(report, defs, opts.taskId);
    allResults.push(...rescored);
  }

  const report = formatReport(allResults);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const jsonPath = join(RESULTS_DIR, `rescore-${stamp}.json`);
  const mdPath = join(RESULTS_DIR, `rescore-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(allResults, null, 2));
  writeFileSync(mdPath, report);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log("\n" + report);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
