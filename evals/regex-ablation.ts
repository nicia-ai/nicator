/**
 * Regex-design ablation.
 *
 * Sweeps matcher specifications over checked-in dcv-004 result JSONs and
 * compares the comparative gap H-B under each matcher to the LLM-judge
 * baseline. Closes the "you used a bad regex" objection to the
 * surface-form-scoring measurement post.
 *
 * Read: if the comparative gap collapses with more permissive matchers,
 * the original measurement is a regex-specific bug, not a property of
 * the surface-form-scoring family. If the gap survives across matcher
 * generations, the strong-form claim holds.
 *
 * Variants:
 *
 *   original             — pattern verbatim from task YAML (control;
 *                          must reproduce the result-file regex scores
 *                          for the ablation to be sound)
 *   proximity-260        — replace the outermost {0,130} window with
 *                          {0,260}; intra-attribute windows untouched
 *   proximity-520        — {0,520}
 *   proximity-1040       — {0,1040}
 *   no-proximity         — strip the outermost proximity anchor; entity
 *                          anchor and value disjunction must each match
 *                          somewhere in the output, no contiguity
 *   substring-canonical  — case-insensitive substring of the canonical
 *                          string
 *   bag-of-tokens        — every non-stopword token from canonical must
 *                          appear somewhere in the output
 *   judge                — per-fact LLM judge from an existing rescore
 *                          artifact (reference upper bound)
 *
 * Usage:
 *
 *   pnpm eval:regex-ablation --task dcv-004 \
 *     --runs 7464bfdf 757cf6f9 a702013b e15c4595 ed259a03 \
 *     --judge-rescore evals/results/rescore-2026-04-22T17-57-49-540Z.json
 *
 * Output: evals/results/regex-ablation-{timestamp}.{md,json}
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { RESULTS_DIR } from "./constants";
import {
  loadEvalReportFile,
  selectEvalReportFiles,
  type EvalReportFile,
} from "./result-files";
import type { EvalReport, EvalTask, ReferenceFact, TaskResult } from "./schema";
import { mean, pairedTTest } from "./stats";
import { loadTasks } from "./task-loader";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Options = Readonly<{
  taskId: string;
  runs?: readonly string[];
  last?: number;
  judgeRescorePath?: string;
}>;

function parseArgs(argv: readonly string[]): Options {
  const opts: {
    taskId: string;
    runs?: string[];
    last?: number;
    judgeRescorePath?: string;
  } = { taskId: "dcv-004" };
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
    } else if (arg === "--judge-rescore") {
      const v = argv[++i];
      if (v) opts.judgeRescorePath = v;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Matcher variants
// ---------------------------------------------------------------------------

type Variant =
  | "original"
  | "proximity-260"
  | "proximity-520"
  | "proximity-1040"
  | "no-proximity"
  | "substring-canonical"
  | "bag-of-tokens"
  | "judge";

const VARIANT_ORDER: readonly Variant[] = [
  "original",
  "proximity-260",
  "proximity-520",
  "proximity-1040",
  "no-proximity",
  "substring-canonical",
  "bag-of-tokens",
  "judge",
];

/** Replace only the first `[\s\S]{0,N}` proximity window in a pattern. */
function widenFirstProximity(pattern: string, newWindow: number): string {
  return pattern.replace(/\[\\s\\S\]\{0,\d+\}/, `[\\s\\S]{0,${newWindow}}`);
}

/** Split a pattern on its first proximity anchor: `<entity><PROX><value...>`. */
function splitOnFirstProximity(
  pattern: string,
): { entity: string; value: string } | undefined {
  const match = pattern.match(/^(.*?)\[\\s\\S\]\{0,\d+\}(.*)$/s);
  if (!match) return undefined;
  const [, entity, value] = match;
  if (entity === undefined || value === undefined) return undefined;
  return { entity, value };
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "of",
  "the",
  "to",
  "is",
  "with",
  "for",
  "in",
  "on",
]);

function bagOfTokens(canonical: string): string[] {
  return canonical
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function matchUnder(
  variant: Variant,
  fact: ReferenceFact,
  text: string,
): boolean {
  if (variant === "judge") {
    throw new Error("judge variant is resolved from rescore data, not regex");
  }

  const lcText = text.toLowerCase();

  if (variant === "substring-canonical") {
    return lcText.includes(fact.canonical.toLowerCase());
  }

  if (variant === "bag-of-tokens") {
    const tokens = bagOfTokens(fact.canonical);
    if (tokens.length === 0) return false;
    return tokens.every((token) => lcText.includes(token));
  }

  // All regex-based variants need a pattern. dcv-004 facts all have one.
  if (!fact.pattern) {
    return lcText.includes(fact.canonical.toLowerCase());
  }

  if (variant === "no-proximity") {
    const split = splitOnFirstProximity(fact.pattern);
    if (!split) {
      // Pattern has no proximity anchor — apply verbatim.
      return new RegExp(fact.pattern, "i").test(text);
    }
    return (
      new RegExp(split.entity, "i").test(text) &&
      new RegExp(split.value, "i").test(text)
    );
  }

  let widened: string;
  switch (variant) {
    case "original":
      widened = fact.pattern;
      break;
    case "proximity-260":
      widened = widenFirstProximity(fact.pattern, 260);
      break;
    case "proximity-520":
      widened = widenFirstProximity(fact.pattern, 520);
      break;
    case "proximity-1040":
      widened = widenFirstProximity(fact.pattern, 1040);
      break;
  }

  return new RegExp(widened, "i").test(text);
}

// ---------------------------------------------------------------------------
// Judge rescore loader
// ---------------------------------------------------------------------------

type JudgeVerdict = Readonly<{ factId: string; matched: boolean }>;

type JudgeRescoreEntry = Readonly<{
  runId: string;
  taskId: string;
  harness: { verdicts: readonly JudgeVerdict[] };
  baseline: { verdicts: readonly JudgeVerdict[] };
}>;

function loadJudgeRescore(
  path: string,
): Map<string, { harness: Map<string, boolean>; baseline: Map<string, boolean> }> {
  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw) as readonly JudgeRescoreEntry[];
  const out = new Map<
    string,
    { harness: Map<string, boolean>; baseline: Map<string, boolean> }
  >();
  for (const entry of data) {
    const key = `${entry.runId}|${entry.taskId}`;
    const harness = new Map<string, boolean>();
    const baseline = new Map<string, boolean>();
    for (const v of entry.harness.verdicts) harness.set(v.factId, v.matched);
    for (const v of entry.baseline.verdicts) baseline.set(v.factId, v.matched);
    out.set(key, { harness, baseline });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

type Mode = "harness" | "baseline";

type PerFactRow = Readonly<{
  runId: string;
  factId: string;
  weight: number;
  expected: "present" | "absent";
  matches: Record<Variant, boolean | undefined>;
}>;

function scoreVariant(
  rows: readonly PerFactRow[],
  variant: Variant,
): number {
  let totalWeight = 0;
  let matchedWeight = 0;
  for (const row of rows) {
    if (row.weight === 0) continue;
    const matched = row.matches[variant];
    if (matched === undefined) continue;
    totalWeight += row.weight;
    // `absent` facts pass when NOT matched.
    const passed =
      row.expected === "absent" ? !matched : matched;
    if (passed) matchedWeight += row.weight;
  }
  return totalWeight === 0 ? 0 : matchedWeight / totalWeight;
}

function perRunScore(
  rows: readonly PerFactRow[],
  variant: Variant,
  runId: string,
): number {
  return scoreVariant(
    rows.filter((r) => r.runId === runId),
    variant,
  );
}

// ---------------------------------------------------------------------------
// Per-run × variant × mode build
// ---------------------------------------------------------------------------

function buildPerFactRows(args: {
  task: TaskResult;
  facts: readonly ReferenceFact[];
  runId: string;
  mode: Mode;
  text: string;
  judge?: Map<string, boolean>;
}): PerFactRow[] {
  const { facts, runId, text, judge } = args;
  return facts.map((fact) => {
    const matches: Record<Variant, boolean | undefined> = {
      original: matchUnder("original", fact, text),
      "proximity-260": matchUnder("proximity-260", fact, text),
      "proximity-520": matchUnder("proximity-520", fact, text),
      "proximity-1040": matchUnder("proximity-1040", fact, text),
      "no-proximity": matchUnder("no-proximity", fact, text),
      "substring-canonical": matchUnder("substring-canonical", fact, text),
      "bag-of-tokens": matchUnder("bag-of-tokens", fact, text),
      judge: judge?.get(fact.id),
    };
    return {
      runId,
      factId: fact.id,
      weight: fact.weight,
      expected: fact.expected,
      matches,
    };
  });
}

// ---------------------------------------------------------------------------
// Sanity check
// ---------------------------------------------------------------------------

function sanityCheckOriginal(
  rows: readonly PerFactRow[],
  taskResult: TaskResult,
  mode: Mode,
  runId: string,
): {
  runId: string;
  mode: Mode;
  reproduced: boolean;
  ablation: number;
  resultFile: number;
} {
  const ablation = perRunScore(rows, "original", runId);
  const src =
    mode === "harness" ? taskResult.factualScore : taskResult.baselineFactualScore;
  const resultFile = src?.score ?? 0;
  return {
    runId,
    mode,
    reproduced: Math.abs(ablation - resultFile) < 0.005,
    ablation,
    resultFile,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

type VariantSummary = Readonly<{
  variant: Variant;
  perRun: ReadonlyArray<{ runId: string; harness: number; baseline: number; delta: number }>;
  harnessMean: number;
  baselineMean: number;
  deltaMean: number;
  deltaCi95Lower: number;
  deltaCi95Upper: number;
  deltaPValue: number;
  deltaSignificant: boolean;
}>;

type FactCategoryCounts = Readonly<{
  bothPass: number;
  variantOnlyPass: number;
  judgeOnlyPass: number;
  bothFail: number;
}>;

function compareToJudge(
  rows: readonly PerFactRow[],
  variant: Variant,
): FactCategoryCounts {
  let bothPass = 0;
  let variantOnlyPass = 0;
  let judgeOnlyPass = 0;
  let bothFail = 0;
  for (const row of rows) {
    const judge = row.matches.judge;
    const variantMatched = row.matches[variant];
    if (judge === undefined || variantMatched === undefined) continue;
    const judgePassed = row.expected === "absent" ? !judge : judge;
    const variantPassed =
      row.expected === "absent" ? !variantMatched : variantMatched;
    if (judgePassed && variantPassed) bothPass++;
    else if (!judgePassed && variantPassed) variantOnlyPass++;
    else if (judgePassed && !variantPassed) judgeOnlyPass++;
    else bothFail++;
  }
  return { bothPass, variantOnlyPass, judgeOnlyPass, bothFail };
}

function summarizeVariant(
  variant: Variant,
  perRunRows: ReadonlyMap<string, { harness: PerFactRow[]; baseline: PerFactRow[] }>,
): VariantSummary {
  const perRun: Array<{ runId: string; harness: number; baseline: number; delta: number }> = [];
  for (const [runId, rows] of perRunRows) {
    const h = scoreVariant(rows.harness, variant);
    const b = scoreVariant(rows.baseline, variant);
    perRun.push({ runId, harness: h, baseline: b, delta: h - b });
  }
  const harnessMean = mean(perRun.map((r) => r.harness));
  const baselineMean = mean(perRun.map((r) => r.baseline));
  const deltaMean = mean(perRun.map((r) => r.delta));
  const test = pairedTTest(
    perRun.map((r) => r.harness),
    perRun.map((r) => r.baseline),
  );
  return {
    variant,
    perRun,
    harnessMean,
    baselineMean,
    deltaMean,
    deltaCi95Lower: test.ci95Lower ?? 0,
    deltaCi95Upper: test.ci95Upper ?? 0,
    deltaPValue: test.pValue,
    deltaSignificant: test.significant,
  };
}

function formatReport(args: {
  taskId: string;
  runIds: readonly string[];
  summaries: readonly VariantSummary[];
  sanity: ReadonlyArray<{
    runId: string;
    mode: Mode;
    reproduced: boolean;
    ablation: number;
    resultFile: number;
  }>;
  judgeRescorePath?: string;
  vsJudge?: ReadonlyMap<Mode, Map<Variant, FactCategoryCounts>>;
}): string {
  const { taskId, runIds, summaries, sanity, judgeRescorePath, vsJudge } = args;
  const lines: string[] = [];
  lines.push("# Regex-design ablation\n");
  lines.push(
    `Task: \`${taskId}\` · Runs: ${runIds.map((r) => `\`${r.slice(0, 8)}\``).join(", ")}\n`,
  );
  if (judgeRescorePath) {
    lines.push(`Judge reference: \`${judgeRescorePath}\`\n`);
  }
  lines.push(
    "## What this measures\n\n" +
      "Same agent outputs, varied matcher. The comparative gap H−B under " +
      "each matcher tells us whether the original measurement is a property " +
      "of the regex spec specifically or of surface-form scoring in general. " +
      "If the gap collapses as the matcher becomes more permissive, the " +
      "original finding narrows to 'this regex was wrong.' If the gap " +
      "survives across matcher generations and only the LLM judge closes " +
      "it, the surface-form-family claim holds.\n",
  );

  lines.push("## Sanity check — `original` must reproduce result-file scores\n");
  lines.push("| Run | Mode | Ablation | Result file | Match |");
  lines.push("|---|---|---|---|---|");
  for (const s of sanity) {
    lines.push(
      `| ${s.runId.slice(0, 8)} | ${s.mode} | ${s.ablation.toFixed(3)} | ${s.resultFile.toFixed(3)} | ${s.reproduced ? "✓" : "✗"} |`,
    );
  }
  lines.push("");

  lines.push("## Comparative gap H−B under each matcher\n");
  lines.push(
    "| Variant | Harness mean | Baseline mean | Δ (H−B) | Δ 95% CI | p (paired t) |",
  );
  lines.push("|---|---|---|---|---|---|");
  for (const s of summaries) {
    const sign = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
    lines.push(
      `| \`${s.variant}\` | ${s.harnessMean.toFixed(3)} | ${s.baselineMean.toFixed(3)} | ${sign(s.deltaMean)} | [${sign(s.deltaCi95Lower)}, ${sign(s.deltaCi95Upper)}] | ${s.deltaPValue.toFixed(3)}${s.deltaSignificant ? " *" : ""} |`,
    );
  }
  lines.push("");
  lines.push(
    "Δ 95% CI and p are from a two-tailed paired t-test on per-run H−B " +
      "deltas (t-distribution, df = runs − 1). `*` marks p < .05. Gaps " +
      "whose CI includes zero are not statistically distinguishable from " +
      "zero at this run count.\n",
  );

  lines.push("## Per-run breakdown\n");
  for (const s of summaries) {
    lines.push(`### \`${s.variant}\`\n`);
    lines.push("| Run | Harness | Baseline | Δ (H−B) |");
    lines.push("|---|---|---|---|");
    for (const r of s.perRun) {
      lines.push(
        `| ${r.runId.slice(0, 8)} | ${r.harness.toFixed(3)} | ${r.baseline.toFixed(3)} | ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(3)} |`,
      );
    }
    lines.push("");
  }

  if (vsJudge) {
    lines.push("## Per-variant agreement with LLM judge (fact-verdict level)\n");
    lines.push(
      "Aggregated across all (run, fact) pairs. `Variant-only pass` are " +
        "facts the matcher accepted but the judge rejected (false positives " +
        "of the matcher); `Judge-only pass` are facts the judge accepted but " +
        "the matcher rejected (the surface-form false-negative bucket the " +
        "post is about).\n",
    );
    for (const mode of ["harness", "baseline"] as const) {
      lines.push(`### ${mode} side\n`);
      lines.push(
        "| Variant | Both pass | Variant-only pass | Judge-only pass | Both fail |",
      );
      lines.push("|---|---|---|---|---|");
      const modeMap = vsJudge.get(mode);
      if (modeMap) {
        for (const variant of VARIANT_ORDER) {
          if (variant === "judge") continue;
          const c = modeMap.get(variant);
          if (!c) continue;
          lines.push(
            `| \`${variant}\` | ${c.bothPass} | ${c.variantOnlyPass} | ${c.judgeOnlyPass} | ${c.bothFail} |`,
          );
        }
      }
      lines.push("");
    }
  }

  lines.push("## Reading\n");
  lines.push(
    "- If `proximity-260` / `proximity-520` / `proximity-1040` show the " +
      "comparative gap shrinking monotonically toward the `judge` row, the " +
      "regex's proximity window is the principal driver of the artifact.\n" +
      "- If `no-proximity` shows the gap close to the `judge` row, the " +
      "issue is contiguity-anchoring specifically, not proximity per se.\n" +
      "- If `substring-canonical` / `bag-of-tokens` show large gaps relative " +
      "to `judge`, surface-form sensitivity to canonical phrasing is the " +
      "bigger driver than proximity.\n" +
      "- If the gap is roughly stable across all regex variants and only " +
      "`judge` closes it, the strong-form 'surface-form scoring family is " +
      "structurally undercounting' claim survives.\n",
  );

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const selectOptions: { last?: number; runPrefixes?: readonly string[] } = {};
  if (opts.last !== undefined) selectOptions.last = opts.last;
  if (opts.runs !== undefined) selectOptions.runPrefixes = opts.runs;
  const files: EvalReportFile[] = selectEvalReportFiles(
    RESULTS_DIR,
    selectOptions,
  );
  if (files.length === 0) {
    console.error("No result files match the filter.");
    process.exitCode = 1;
    return;
  }

  const tasks: EvalTask[] = loadTasks({ taskId: opts.taskId });
  const taskDef = tasks.find((t) => t.id === opts.taskId);
  if (!taskDef) {
    console.error(`No task definition for ${opts.taskId}`);
    process.exitCode = 1;
    return;
  }
  const facts = taskDef.referenceFacts;
  if (facts.length === 0) {
    console.error(`Task ${opts.taskId} has no referenceFacts`);
    process.exitCode = 1;
    return;
  }

  const judgeRescore = opts.judgeRescorePath
    ? loadJudgeRescore(opts.judgeRescorePath)
    : undefined;

  const perRunRows = new Map<
    string,
    { harness: PerFactRow[]; baseline: PerFactRow[] }
  >();
  const sanity: Array<{
    runId: string;
    mode: Mode;
    reproduced: boolean;
    ablation: number;
    resultFile: number;
  }> = [];
  const runIds: string[] = [];

  for (const file of files) {
    const report: EvalReport = loadEvalReportFile(file);
    const task = report.tasks.find((t) => t.taskId === opts.taskId);
    if (!task) continue;
    if (!task.harnessOutput?.text || !task.baselineOutput?.text) continue;
    const judgeForRun = judgeRescore?.get(`${report.runId}|${opts.taskId}`);

    const harnessRows = buildPerFactRows({
      task,
      facts,
      runId: report.runId,
      mode: "harness",
      text: task.harnessOutput.text,
      ...(judgeForRun ? { judge: judgeForRun.harness } : {}),
    });
    const baselineRows = buildPerFactRows({
      task,
      facts,
      runId: report.runId,
      mode: "baseline",
      text: task.baselineOutput.text,
      ...(judgeForRun ? { judge: judgeForRun.baseline } : {}),
    });
    perRunRows.set(report.runId, { harness: harnessRows, baseline: baselineRows });
    runIds.push(report.runId);

    sanity.push(sanityCheckOriginal(harnessRows, task, "harness", report.runId));
    sanity.push(
      sanityCheckOriginal(baselineRows, task, "baseline", report.runId),
    );
  }

  // Per-run summaries by variant.
  const summaries = VARIANT_ORDER
    .filter((v) => v !== "judge" || judgeRescore !== undefined)
    .map((variant) => summarizeVariant(variant, perRunRows));

  // Variant-vs-judge agreement counts, by mode.
  const vsJudge: Map<Mode, Map<Variant, FactCategoryCounts>> = new Map();
  if (judgeRescore) {
    for (const mode of ["harness", "baseline"] as const) {
      const rows = [...perRunRows.values()].flatMap((r) => r[mode]);
      const map = new Map<Variant, FactCategoryCounts>();
      for (const variant of VARIANT_ORDER) {
        if (variant === "judge") continue;
        map.set(variant, compareToJudge(rows, variant));
      }
      vsJudge.set(mode, map);
    }
  }

  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const formatArgs: Parameters<typeof formatReport>[0] = {
    taskId: opts.taskId,
    runIds,
    summaries,
    sanity,
  };
  if (opts.judgeRescorePath) formatArgs.judgeRescorePath = opts.judgeRescorePath;
  if (judgeRescore) formatArgs.vsJudge = vsJudge;
  const md = formatReport(formatArgs);
  const jsonPath = join(RESULTS_DIR, `regex-ablation-${stamp}.json`);
  const mdPath = join(RESULTS_DIR, `regex-ablation-${stamp}.md`);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        taskId: opts.taskId,
        runIds,
        summaries,
        sanity,
        ...(opts.judgeRescorePath ? { judgeRescorePath: opts.judgeRescorePath } : {}),
        vsJudge: judgeRescore
          ? Object.fromEntries(
              [...vsJudge].map(([mode, m]) => [mode, Object.fromEntries(m)]),
            )
          : undefined,
      },
      null,
      2,
    ),
  );
  writeFileSync(mdPath, md);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log("\n" + md);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
