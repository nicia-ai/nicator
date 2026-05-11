/**
 * Human-audit packet generator for per-fact judge calibration.
 *
 * Loads one or more rescore JSONs from `evals/results/`, stratifies the
 * fact-verdicts across the four agreement quadrants
 * (regex × judge), random-samples per quadrant according to a fixed
 * design, packages each case with the relevant context, shuffles them
 * so quadrant blocks don't leak, and emits:
 *
 *   - <packet>.md       — the labeling document. Judge verdicts are
 *                         hidden inside `<details>` blocks so the
 *                         labeler labels first and reveals second.
 *   - <packet>.key.json — the answer key (case order, run/fact ids,
 *                         quadrant, judge verdict, judge reason). Used
 *                         by `score.ts` to compare labels back.
 *
 * Sample design defaults (overridable via flags):
 *   regex-fail/judge-pass (harness):  40
 *   regex-fail/judge-pass (baseline): 20
 *   regex-pass/judge-fail (harness):  all (typically 1-2)
 *   regex-pass/judge-fail (baseline): all (typically 0)
 *   both-failed (harness):            all (typically 6)
 *   both-failed (baseline):           all (typically 0)
 *   both-passed (harness + baseline): 15 random
 *
 * Usage:
 *
 *   pnpm eval:audit-packet --rescore <rescore-file>
 *   pnpm eval:audit-packet --rescore <rescore-file> --seed 42
 *   pnpm eval:audit-packet --rescore <rescore-file> --rfjp-harness 60 --rfjp-baseline 30
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";

import { RESULTS_DIR } from "../constants";
import { matchFact } from "../match-fact";
import type { EvalTask, ReferenceFact } from "../schema";
import { loadTasks } from "../task-loader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Quadrant =
  | "regex-fail-judge-pass"
  | "regex-pass-judge-fail"
  | "both-failed"
  | "both-passed";

type Mode = "harness" | "baseline";

type Verdict = Readonly<{
  factId: string;
  matched: boolean;
  justification: string;
}>;

type ModeBlock = Readonly<{
  regexScore: number;
  judgeScore: number;
  verdicts: ReadonlyArray<Verdict>;
  // Optional: older rescore JSONs (pre-2026-05) lack this field;
  // we reconstruct from the source eval report when missing.
  regexVerdicts?: Readonly<Record<string, boolean>>;
}>;

type RescoreEntry = Readonly<{
  runId: string;
  taskId: string;
  harness: ModeBlock;
  baseline: ModeBlock;
}>;

type CaseRecord = Readonly<{
  caseIndex: number; // 1-based, matches the position in the shuffled packet
  runId: string;
  taskId: string;
  mode: Mode;
  factId: string;
  quadrant: Quadrant;
  regexMatched: boolean;
  judgeMatched: boolean;
  judgeJustification: string;
  fact: Readonly<{
    id: string;
    description: string;
    canonical: string;
    pattern?: string | undefined;
    weight: number;
  }>;
  outputExcerpt: string; // ~400 chars around the candidate match
}>;

type SampleSizes = Readonly<{
  rfjpHarness: number;
  rfjpBaseline: number;
  bothPassed: number;
  // both-failed and regex-pass-judge-fail are sampled exhaustively
}>;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Options = Readonly<{
  rescoreFile: string;
  seed: number;
  sample: SampleSizes;
  outputName?: string;
  outputsDir?: string; // optional: directory containing the run JSONs (for output text lookup)
}>;

function parseArgs(argv: readonly string[]): Options {
  let rescoreFile: string | undefined;
  let seed = 1337;
  let outputName: string | undefined;
  let outputsDir: string | undefined;
  let rfjpHarness = 40;
  let rfjpBaseline = 20;
  let bothPassed = 15;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rescore") {
      rescoreFile = argv[++i];
    } else if (arg === "--seed") {
      seed = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg === "--out-name") {
      outputName = argv[++i];
    } else if (arg === "--outputs-dir") {
      outputsDir = argv[++i];
    } else if (arg === "--rfjp-harness") {
      rfjpHarness = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg === "--rfjp-baseline") {
      rfjpBaseline = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg === "--both-passed") {
      bothPassed = Number.parseInt(argv[++i] ?? "", 10);
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  if (!rescoreFile) {
    printUsage();
    throw new Error("--rescore <file> is required");
  }
  const opts: {
    rescoreFile: string;
    seed: number;
    sample: SampleSizes;
    outputName?: string;
    outputsDir?: string;
  } = {
    rescoreFile,
    seed,
    sample: { rfjpHarness, rfjpBaseline, bothPassed },
  };
  if (outputName) opts.outputName = outputName;
  if (outputsDir) opts.outputsDir = outputsDir;
  return opts;
}

function printUsage(): void {
  console.log(
    `Usage: pnpm eval:audit-packet --rescore <rescore-file> [options]

Generates a stratified human-audit packet from a rescore output. The
packet hides judge verdicts inside collapsible <details> blocks so the
labeler labels independently and reveals afterward.

Required:
  --rescore <file>          Path to a rescore-*.json (relative to
                            evals/results/ or absolute)

Sampling (defaults shown):
  --rfjp-harness <n>        Sample size for regex-fail/judge-pass on
                            harness side (default: 40)
  --rfjp-baseline <n>       Same for baseline side (default: 20)
  --both-passed <n>         Random sample of both-passed across modes
                            (default: 15)

Other:
  --seed <n>                Random seed for sampling and shuffling
                            (default: 1337). Pass the same seed to
                            regenerate an identical packet.
  --outputs-dir <path>      Directory containing the per-run JSONs that
                            hold the agent outputs. Defaults to the
                            same directory as the rescore file.
  --out-name <stem>         Base name (without extension) for the
                            output files. Defaults to the timestamp
                            audit-packet-{ISO}.

Output:
  Writes <out>.md and <out>.key.json into evals/human-audit/.

regex-pass/judge-fail and both-failed quadrants are always sampled
exhaustively (typically 0-6 cases total — too small to subsample).
`,
  );
}

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32)
// ---------------------------------------------------------------------------

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

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
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

function sampleN<T>(items: readonly T[], n: number, rng: () => number): T[] {
  if (n >= items.length) return [...items];
  return shuffle(items, rng).slice(0, n);
}

// ---------------------------------------------------------------------------
// Load + classify
// ---------------------------------------------------------------------------

function resolveRescorePath(path: string): string {
  // 1. Absolute path → use as-is.
  if (isAbsolute(path)) return path;
  // 2. Relative path that exists from CWD → use it.
  const fromCwd = resolve(path);
  if (existsSync(fromCwd)) return fromCwd;
  // 3. Bare filename (or basename) → join under RESULTS_DIR.
  return join(RESULTS_DIR, basename(path));
}

function loadRescore(path: string): RescoreEntry[] {
  const resolved = resolveRescorePath(path);
  const raw = readFileSync(resolved, "utf-8");
  return JSON.parse(raw) as RescoreEntry[];
}

type RunData = Readonly<{
  outputs: Readonly<{ harness: string; baseline: string }>;
  regexVerdicts: Readonly<{
    harness: Readonly<Record<string, boolean>>;
    baseline: Readonly<Record<string, boolean>>;
  }>;
}>;

function loadAgentOutputs(
  entries: readonly RescoreEntry[],
  outputsDir: string,
): Map<string, RunData> {
  // Each entry references a runId. The agent outputs and authoritative
  // regex verdicts live in evals/results/<runId>.json (the eval report).
  // We pull both from there — the rescore JSON's regexVerdicts field
  // (when present) is just a mirror and is omitted entirely on older
  // rescore files.
  const out = new Map<string, RunData>();
  type EvalReport = {
    tasks?: Array<{
      taskId?: string;
      harnessOutput?: { text?: string };
      baselineOutput?: { text?: string };
      factualScore?: { facts?: Array<{ factId?: string; matched?: boolean }> };
      baselineFactualScore?: {
        facts?: Array<{ factId?: string; matched?: boolean }>;
      };
    }>;
  };
  for (const entry of entries) {
    const candidates = [
      join(outputsDir, `${entry.runId}.json`),
      join(outputsDir, `${entry.runId.slice(0, 8)}.json`),
    ];
    let report: EvalReport | null = null;
    for (const candidate of candidates) {
      try {
        report = JSON.parse(readFileSync(candidate, "utf-8")) as EvalReport;
        break;
      } catch {
        // try next
      }
    }
    if (!report) {
      throw new Error(
        `Could not find run report for ${entry.runId} (looked in ${candidates.join(", ")})`,
      );
    }
    const task = report.tasks?.find((t) => t.taskId === entry.taskId);
    if (!task?.harnessOutput?.text || !task.baselineOutput?.text) {
      throw new Error(
        `Run ${entry.runId} missing harness/baseline output for task ${entry.taskId}`,
      );
    }
    const factsToMap = (
      facts: Array<{ factId?: string; matched?: boolean }> | undefined,
    ): Record<string, boolean> => {
      const m: Record<string, boolean> = {};
      for (const f of facts ?? []) {
        if (f.factId !== undefined && f.matched !== undefined) {
          m[f.factId] = f.matched;
        }
      }
      return m;
    };
    out.set(entry.runId, {
      outputs: {
        harness: task.harnessOutput.text,
        baseline: task.baselineOutput.text,
      },
      regexVerdicts: {
        harness: factsToMap(task.factualScore?.facts),
        baseline: factsToMap(task.baselineFactualScore?.facts),
      },
    });
  }
  return out;
}

function classifyQuadrant(
  regexMatched: boolean,
  judgeMatched: boolean,
): Quadrant {
  if (!regexMatched && judgeMatched) return "regex-fail-judge-pass";
  if (regexMatched && !judgeMatched) return "regex-pass-judge-fail";
  if (!regexMatched && !judgeMatched) return "both-failed";
  return "both-passed";
}

// ---------------------------------------------------------------------------
// Excerpt extraction
// ---------------------------------------------------------------------------

const EXCERPT_RADIUS = 220;

function extractExcerpt(text: string, fact: ReferenceFact): string {
  // Prefer pattern match location; fall back to canonical substring;
  // final fallback to the first 440 chars of the output.
  let matchIndex = -1;
  if (fact.pattern) {
    try {
      const re = new RegExp(fact.pattern, "i");
      const m = re.exec(text);
      if (m) matchIndex = m.index;
    } catch {
      // bad regex — fall through
    }
  }
  if (matchIndex < 0) {
    const idx = text.toLowerCase().indexOf(fact.canonical.toLowerCase());
    if (idx >= 0) matchIndex = idx;
  }
  if (matchIndex < 0) {
    // No anchor anywhere — try to find any vendor or attribute name
    // referenced in the fact description as a soft anchor.
    const tokens = fact.description.match(/[A-Z][A-Za-z0-9]{2,}/g) ?? [];
    for (const tok of tokens) {
      const idx = text.indexOf(tok);
      if (idx >= 0) {
        matchIndex = idx;
        break;
      }
    }
  }
  if (matchIndex < 0) {
    // Truly nothing — return the first 2 × radius chars with a marker.
    const head = text.slice(0, EXCERPT_RADIUS * 2);
    return `[no anchor in output — first ${head.length} chars shown]\n${head}`;
  }
  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(text.length, matchIndex + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Build candidate cases
// ---------------------------------------------------------------------------

type Candidate = Omit<CaseRecord, "caseIndex">;

function buildCandidates(
  entries: readonly RescoreEntry[],
  taskDefs: ReadonlyMap<string, EvalTask>,
  runData: ReadonlyMap<string, RunData>,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    const taskDef = taskDefs.get(entry.taskId);
    if (!taskDef) {
      console.warn(`  [skip] no task def for ${entry.taskId}`);
      continue;
    }
    const factById = new Map(taskDef.referenceFacts.map((f) => [f.id, f]));
    const data = runData.get(entry.runId);
    if (!data) continue;
    for (const mode of ["harness", "baseline"] as const) {
      const block = entry[mode];
      const judgeById = new Map(block.verdicts.map((v) => [v.factId, v]));
      const text = data.outputs[mode];
      // Prefer regex verdicts from the rescore file (modern shape) when
      // present; fall back to the source eval report.
      const regexMap =
        block.regexVerdicts && Object.keys(block.regexVerdicts).length > 0
          ? block.regexVerdicts
          : data.regexVerdicts[mode];
      for (const [factId, regexMatched] of Object.entries(regexMap)) {
        const judge = judgeById.get(factId);
        if (!judge) continue; // no judge verdict for this fact (rare)
        const fact = factById.get(factId);
        if (!fact) continue;
        const quadrant = classifyQuadrant(regexMatched, judge.matched);
        candidates.push({
          runId: entry.runId,
          taskId: entry.taskId,
          mode,
          factId,
          quadrant,
          regexMatched,
          judgeMatched: judge.matched,
          judgeJustification: judge.justification,
          fact: {
            id: fact.id,
            description: fact.description,
            canonical: fact.canonical,
            ...(fact.pattern ? { pattern: fact.pattern } : {}),
            weight: fact.weight,
          },
          outputExcerpt: extractExcerpt(text, fact),
        });
      }
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Stratified sample
// ---------------------------------------------------------------------------

function stratifiedSample(
  candidates: readonly Candidate[],
  sample: SampleSizes,
  rng: () => number,
): Candidate[] {
  const byBucket = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${c.quadrant}:${c.mode}`;
    const arr = byBucket.get(key) ?? [];
    arr.push(c);
    byBucket.set(key, arr);
  }

  const bothPassedAll = [
    ...(byBucket.get("both-passed:harness") ?? []),
    ...(byBucket.get("both-passed:baseline") ?? []),
  ];

  const out: Candidate[] = [
    ...sampleN(byBucket.get("regex-fail-judge-pass:harness") ?? [], sample.rfjpHarness, rng),
    ...sampleN(byBucket.get("regex-fail-judge-pass:baseline") ?? [], sample.rfjpBaseline, rng),
    ...(byBucket.get("regex-pass-judge-fail:harness") ?? []),
    ...(byBucket.get("regex-pass-judge-fail:baseline") ?? []),
    ...(byBucket.get("both-failed:harness") ?? []),
    ...(byBucket.get("both-failed:baseline") ?? []),
    ...sampleN(bothPassedAll, sample.bothPassed, rng),
  ];

  // Final shuffle so quadrant blocks don't leak position cues.
  return shuffle(out, rng);
}

// ---------------------------------------------------------------------------
// Render packet
// ---------------------------------------------------------------------------

function renderPacket(
  cases: readonly CaseRecord[],
  rescoreSource: string,
  seed: number,
  sample: SampleSizes,
): string {
  const counts = new Map<Quadrant, number>();
  for (const c of cases) counts.set(c.quadrant, (counts.get(c.quadrant) ?? 0) + 1);

  const lines: string[] = [];
  lines.push("# Human-audit packet — per-fact judge calibration\n");
  lines.push(
    `Rescore source: \`${rescoreSource}\`  \nSeed: \`${seed}\`  \n` +
      `Sample design: rfjp-harness=${sample.rfjpHarness}, ` +
      `rfjp-baseline=${sample.rfjpBaseline}, both-passed=${sample.bothPassed}; ` +
      `regex-pass/judge-fail and both-failed sampled exhaustively\n`,
  );
  lines.push(
    "Quadrant counts in this packet: " +
      ["regex-fail-judge-pass", "regex-pass-judge-fail", "both-failed", "both-passed"]
        .map((q) => `${q}=${counts.get(q as Quadrant) ?? 0}`)
        .join(", ") +
      `  (total=${cases.length})\n`,
  );

  lines.push("## How to use this packet\n");
  lines.push(
    "Each case shows the reference fact, the regex pattern, the regex " +
      "verdict, and a ~440-character excerpt of the model output around " +
      "the candidate match span. The judge verdict is hidden inside a " +
      "collapsible block.\n\n" +
      "**Label every `Your label` line with one of:** `PASS`, `FAIL`, " +
      "`AMBIGUOUS`, or `DISPUTE-RUBRIC` (the last meaning you think the " +
      "rubric itself is wrong on this case). Label *before* expanding " +
      "the judge verdict — that's the whole point of the audit. After " +
      "labeling, expand to see whether you and the judge agreed.\n\n" +
      "When done, run `pnpm eval:audit-score --packet <this-file>` to " +
      "compute Cohen's κ and per-quadrant agreement.\n",
  );

  lines.push("---\n");

  for (const c of cases) {
    lines.push(`## Case ${c.caseIndex} of ${cases.length}\n`);
    lines.push(
      `Run: \`${c.runId.slice(0, 8)}\`  ` +
        `Mode: \`${c.mode}\`  ` +
        `Task: \`${c.taskId}\`  ` +
        `Fact: \`${c.factId}\`\n`,
    );
    lines.push(`**Reference fact**: ${c.fact.description}\n`);
    lines.push(`**Canonical**: \`${c.fact.canonical}\`\n`);
    if (c.fact.pattern) {
      lines.push(`**Regex pattern**: \`${c.fact.pattern}\`\n`);
    }
    lines.push(`**Regex verdict**: ${c.regexMatched ? "PASS" : "FAIL"}\n`);
    lines.push(`**Model output excerpt** (around candidate match):\n`);
    lines.push("```");
    lines.push(c.outputExcerpt);
    lines.push("```\n");
    lines.push(`**Your label**: \`[ TODO ]\`  *(replace with PASS / FAIL / AMBIGUOUS / DISPUTE-RUBRIC)*\n`);
    lines.push(`<details><summary>↓ Reveal judge verdict (label yours first)</summary>\n`);
    lines.push("");
    lines.push(`Judge verdict: **${c.judgeMatched ? "PASS" : "FAIL"}**`);
    lines.push("");
    lines.push(`Judge reason: ${c.judgeJustification}`);
    lines.push("");
    lines.push("</details>\n");
    lines.push("---\n");
  }

  return lines.join("\n");
}

function renderAnswerKey(
  cases: readonly CaseRecord[],
  rescoreSource: string,
  seed: number,
  sample: SampleSizes,
): string {
  return JSON.stringify(
    {
      rescoreSource,
      seed,
      sample,
      generatedAt: new Date().toISOString(),
      cases: cases.map((c) => ({
        caseIndex: c.caseIndex,
        runId: c.runId,
        taskId: c.taskId,
        mode: c.mode,
        factId: c.factId,
        quadrant: c.quadrant,
        regexMatched: c.regexMatched,
        judgeMatched: c.judgeMatched,
      })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const entries = loadRescore(opts.rescoreFile);
  if (entries.length === 0) {
    throw new Error(`Rescore file is empty: ${opts.rescoreFile}`);
  }

  const taskIds = new Set(entries.map((e) => e.taskId));
  const taskDefs = new Map<string, EvalTask>();
  for (const taskId of taskIds) {
    const tasks = loadTasks({ taskId });
    for (const t of tasks) taskDefs.set(t.id, t);
  }

  const outputsDir = opts.outputsDir ?? RESULTS_DIR;
  const outputs = loadAgentOutputs(entries, outputsDir);

  const candidates = buildCandidates(entries, taskDefs, outputs);
  const rng = makeRng(opts.seed);
  const sampled = stratifiedSample(candidates, opts.sample, rng);

  // Assign caseIndex (1-based) after final shuffle.
  const cases: CaseRecord[] = sampled.map((c, i) => ({
    ...c,
    caseIndex: i + 1,
  }));

  const stem =
    opts.outputName ??
    `audit-packet-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const dir = join(RESULTS_DIR, "..", "human-audit");
  const mdPath = join(dir, `${stem}.md`);
  const keyPath = join(dir, `${stem}.key.json`);

  writeFileSync(mdPath, renderPacket(cases, opts.rescoreFile, opts.seed, opts.sample));
  writeFileSync(keyPath, renderAnswerKey(cases, opts.rescoreFile, opts.seed, opts.sample));

  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${keyPath}`);
  console.log(`\n${cases.length} cases for labeling. Open the .md, fill in each \`Your label\`, then run:`);
  console.log(`  pnpm eval:audit-score --packet ${mdPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
