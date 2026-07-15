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
 *   # Stability check: re-run the judge with shuffled fact order N
 *   # times per (run, mode) and report per-fact stability
 *   pnpm eval:rescore --last 5 --shuffle-replicates 3
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

type Mode = "harness" | "baseline";

type ShuffleReplicate = Readonly<{
  mode: Mode;
  shuffleSeed: number;
  judgeScore: number;
  verdicts: readonly PerFactVerdict[];
}>;

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
  shuffleReplicates?: readonly ShuffleReplicate[];
}>;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

type Options = Readonly<{
  taskId?: string;
  runs?: readonly string[];
  last?: number;
  shuffleReplicates?: number;
  shuffleSeed?: number;
}>;

function parseArgs(argv: readonly string[]): Options {
  const opts: {
    taskId?: string;
    runs?: string[];
    last?: number;
    shuffleReplicates?: number;
    shuffleSeed?: number;
  } = {};
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
    } else if (arg === "--shuffle-replicates") {
      opts.shuffleReplicates = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg === "--shuffle-seed") {
      opts.shuffleSeed = Number.parseInt(argv[++i] ?? "", 10);
    }
  }
  return opts;
}

// Deterministic RNG for reproducible shuffles.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleFacts<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
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
  shuffleReplicates: number,
  shuffleSeedBase: number,
  runIndex: number,
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

    const replicates: ShuffleReplicate[] = [];
    if (shuffleReplicates > 0) {
      console.log(
        `           shuffle replicates: ${shuffleReplicates} per mode`,
      );
      // Sequential to avoid bursting the API; cheap relative to call cost.
      for (let r = 0; r < shuffleReplicates; r++) {
        for (const mode of ["harness", "baseline"] as const) {
          const seed =
            shuffleSeedBase + runIndex * 1000 + (mode === "harness" ? 1 : 2) * 100 + r;
          const rng = makeRng(seed);
          const shuffled = shuffleFacts(facts, rng);
          const text =
            mode === "harness"
              ? task.harnessOutput.text
              : task.baselineOutput.text;
          const v = await runPerFactJudge(shuffled, text);
          replicates.push({
            mode,
            shuffleSeed: seed,
            judgeScore: v.score,
            verdicts: v.verdicts,
          });
        }
      }
    }

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
      ...(replicates.length > 0 ? { shuffleReplicates: replicates } : {}),
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

  // Group by task for per-task aggregation
  const byTask = new Map<string, TaskRescore[]>();
  for (const r of results) {
    const arr = byTask.get(r.taskId) ?? [];
    arr.push(r);
    byTask.set(r.taskId, arr);
  }

  lines.push("\n## Disagreement audit (aggregated across runs)\n");
  lines.push(
    "Every fact-verdict decomposes into one of four mutually exclusive " +
      "categories. These are the load-bearing numbers for comparative " +
      "scorer-artifact analysis: high counts in `Regex failed, judge " +
      "passed` indicate surface-form false negatives where the regex " +
      "missed correct content.\n",
  );
  for (const [taskId, taskResults] of byTask) {
    for (const mode of ["harness", "baseline"] as const) {
      const audit = auditCategories(taskResults, mode);
      lines.push(`### ${taskId} — ${mode} side\n`);
      lines.push("| Category | Count |");
      lines.push("|---|---|");
      lines.push(`| Regex failed, judge passed | ${audit.regexFailJudgePass} |`);
      lines.push(`| Regex passed, judge failed | ${audit.regexPassJudgeFail} |`);
      lines.push(`| Both failed | ${audit.bothFailed} |`);
      lines.push(`| Both passed | ${audit.bothPassed} |`);
      if (audit.noJudgeVerdict > 0) {
        lines.push(`| No judge verdict | ${audit.noJudgeVerdict} |`);
      }
      lines.push(`| **Total ${mode} fact-verdicts** | **${audit.total}** |\n`);
    }
  }

  lines.push("\n## Per-run disagreements\n");
  lines.push(
    "Per-run breakdown of the disagreement counts. Use this to see " +
      "run-to-run variation in judge stochasticity.\n",
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

  // ---------------- Shuffle-replicate stability ----------------
  const hasReplicates = results.some(
    (r) => r.shuffleReplicates && r.shuffleReplicates.length > 0,
  );
  if (hasReplicates) {
    lines.push("\n## Shuffle-replicate stability\n");
    lines.push(
      "For each (run, mode), the canonical fact order plus N shuffled-order " +
        "replicates were judged. Each fact thus has N+1 verdicts. Below: " +
        "per-fact stability classification (stable = all verdicts agree, " +
        "borderline = one disagreement, flipped = two or more), aggregated " +
        "by (task, mode). Closes the 'intra-prompt position effects' " +
        "critique: if most facts are stable, position effects are not the " +
        "dominant noise source.\n",
    );

    type StabilityCounts = {
      stable: number;
      borderline: number;
      flipped: number;
      totalFacts: number;
      totalReplicates: number; // N+1
    };

    const byTaskMode = new Map<string, StabilityCounts>();
    for (const r of results) {
      for (const mode of ["harness", "baseline"] as const) {
        const canonical = r[mode].verdicts;
        const replicates = (r.shuffleReplicates ?? []).filter(
          (rep) => rep.mode === mode,
        );
        const totalReps = 1 + replicates.length;
        // Per-fact: collect verdicts across canonical + replicates.
        const perFactVerdicts = new Map<string, boolean[]>();
        for (const v of canonical) {
          perFactVerdicts.set(v.factId, [v.matched]);
        }
        for (const rep of replicates) {
          for (const v of rep.verdicts) {
            const arr = perFactVerdicts.get(v.factId);
            if (arr) arr.push(v.matched);
          }
        }
        const key = `${r.taskId}|${mode}`;
        const acc =
          byTaskMode.get(key) ?? {
            stable: 0,
            borderline: 0,
            flipped: 0,
            totalFacts: 0,
            totalReplicates: totalReps,
          };
        for (const verdicts of perFactVerdicts.values()) {
          acc.totalFacts++;
          const passes = verdicts.filter((v) => v).length;
          const fails = verdicts.length - passes;
          const minority = Math.min(passes, fails);
          if (minority === 0) acc.stable++;
          else if (minority === 1) acc.borderline++;
          else acc.flipped++;
        }
        byTaskMode.set(key, acc);
      }
    }

    lines.push(
      "| Task | Mode | N+1 verdicts/fact | Facts | Stable | Borderline | Flipped | % stable |",
    );
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const [key, c] of byTaskMode) {
      const [taskId, mode] = key.split("|") as [string, string];
      const pctStable = c.totalFacts === 0 ? 0 : (c.stable / c.totalFacts) * 100;
      lines.push(
        `| ${taskId} | ${mode} | ${c.totalReplicates} | ${c.totalFacts} | ${c.stable} | ${c.borderline} | ${c.flipped} | ${pctStable.toFixed(1)}% |`,
      );
    }
    lines.push("");
    lines.push(
      "**Reading**: high `% stable` means the judge gives consistent " +
        "verdicts regardless of fact order. `Borderline` cases are facts " +
        "where exactly one of N+1 verdicts disagreed — judge stochasticity " +
        "near a decision boundary. `Flipped` cases are facts where the " +
        "judge changed its mind under shuffling and warrant individual " +
        "inspection (suggests intra-prompt position is doing real work " +
        "on those facts).\n",
    );
  }

  return lines.join("\n") + "\n";
}

type AuditCategories = Readonly<{
  regexFailJudgePass: number;
  regexPassJudgeFail: number;
  bothFailed: number;
  bothPassed: number;
  noJudgeVerdict: number;
  total: number;
}>;

function auditCategories(
  results: readonly TaskRescore[],
  mode: "harness" | "baseline",
): AuditCategories {
  let regexFailJudgePass = 0;
  let regexPassJudgeFail = 0;
  let bothFailed = 0;
  let bothPassed = 0;
  let noJudgeVerdict = 0;
  for (const r of results) {
    const judgeVerdicts = new Map(
      r[mode].verdicts.map((v) => [v.factId, v.matched]),
    );
    for (const [factId, regexMatched] of Object.entries(r[mode].regexVerdicts)) {
      const judgeMatched = judgeVerdicts.get(factId);
      if (judgeMatched === undefined) {
        noJudgeVerdict++;
      } else if (!regexMatched && judgeMatched) {
        regexFailJudgePass++;
      } else if (regexMatched && !judgeMatched) {
        regexPassJudgeFail++;
      } else if (!regexMatched && !judgeMatched) {
        bothFailed++;
      } else {
        bothPassed++;
      }
    }
  }
  const total =
    regexFailJudgePass +
    regexPassJudgeFail +
    bothFailed +
    bothPassed +
    noJudgeVerdict;
  return {
    regexFailJudgePass,
    regexPassJudgeFail,
    bothFailed,
    bothPassed,
    noJudgeVerdict,
    total,
  };
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

  const shuffleReplicates = opts.shuffleReplicates ?? 0;
  const shuffleSeedBase = opts.shuffleSeed ?? 1337;
  if (shuffleReplicates > 0) {
    console.log(
      `Shuffle replicates enabled: ${shuffleReplicates} extra judge calls per ` +
        `(run, mode) — total extra cost ≈ ${shuffleReplicates * files.length * 2} judge calls.`,
    );
  }

  const allResults: TaskRescore[] = [];
  let runIndex = 0;
  for (const file of files) {
    const report = loadEvalReportFile(file);
    console.log(`\n[${file.name}]`);
    const rescored = await rescoreRun(
      report,
      defs,
      opts.taskId,
      shuffleReplicates,
      shuffleSeedBase,
      runIndex,
    );
    allResults.push(...rescored);
    runIndex++;
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
