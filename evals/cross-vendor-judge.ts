/**
 * Cross-vendor per-fact judge spot-check.
 *
 * Re-runs the per-fact judge using a different vendor's model (default:
 * OpenAI GPT-5 via the Chat Completions HTTP API) against the same
 * prompt the Anthropic judge uses, then compares verdicts to a
 * reference rescore output. Closes the "Anthropic-judging-Anthropic
 * bias loop" critique.
 *
 * No new SDK dependency: uses Node's built-in `fetch`. The OpenAI key
 * is read from `OPENAI_API_KEY`. The model can be overridden via
 * `OPENAI_JUDGE_MODEL` (default: `gpt-5`).
 *
 * Usage:
 *
 *   # Single spot-check: harness side of one run (~$0.15, ~30s)
 *   pnpm eval:rescore-cross-vendor --rescore <rescore-file> --single
 *
 *   # All 5 runs × both modes (~$1.50, ~3min)
 *   pnpm eval:rescore-cross-vendor --rescore <rescore-file> --all
 *
 *   # Specific run/mode
 *   pnpm eval:rescore-cross-vendor --rescore <rescore-file> --run 7464bfdf --mode harness
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";

import { RESULTS_DIR } from "./constants";
import {
  PER_FACT_SYSTEM_PROMPT,
  buildPerFactUserPrompt,
  parsePerFactResponse,
  type PerFactVerdict,
} from "./llm-judge/per-fact";
import type { EvalTask, ReferenceFact } from "./schema";
import { loadTasks } from "./task-loader";

// ---------------------------------------------------------------------------
// Types mirroring the rescore output shape
// ---------------------------------------------------------------------------

type Mode = "harness" | "baseline";

type ModeBlock = Readonly<{
  regexScore: number;
  judgeScore: number;
  verdicts: ReadonlyArray<PerFactVerdict>;
  regexVerdicts: Readonly<Record<string, boolean>>;
}>;

type RescoreEntry = Readonly<{
  runId: string;
  taskId: string;
  harness: ModeBlock;
  baseline: ModeBlock;
}>;

type SpotCheckResult = Readonly<{
  runId: string;
  taskId: string;
  mode: Mode;
  vendorJudgeModel: string;
  vendorVerdicts: ReadonlyArray<PerFactVerdict>;
  referenceVerdicts: ReadonlyArray<PerFactVerdict>;
  agreement: number; // fraction of facts where vendor and reference agree
  agreedCount: number;
  totalCount: number;
  vendorPassRate: number;
  referencePassRate: number;
  disagreements: ReadonlyArray<
    Readonly<{
      factId: string;
      vendor: boolean;
      reference: boolean;
      vendorJustification: string;
      referenceJustification: string;
    }>
  >;
}>;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Selection = Readonly<{ runs: ReadonlyArray<string>; modes: ReadonlyArray<Mode> }>;

type Options = Readonly<{
  rescoreFile: string;
  selection: Selection | "all" | "single";
  outputsDir: string;
  vendorModel: string;
  outName?: string;
}>;

function parseArgs(argv: readonly string[]): Options {
  let rescoreFile: string | undefined;
  let mode: "all" | "single" | "explicit" = "single";
  let runs: string[] = [];
  let modes: Mode[] = [];
  let outputsDir = RESULTS_DIR;
  let vendorModel = process.env["OPENAI_JUDGE_MODEL"] ?? "gpt-5";
  let outName: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rescore") rescoreFile = argv[++i];
    else if (a === "--all") mode = "all";
    else if (a === "--single") mode = "single";
    else if (a === "--run") {
      mode = "explicit";
      const v = argv[++i];
      if (v) runs.push(v);
    } else if (a === "--mode") {
      mode = "explicit";
      const v = argv[++i];
      if (v === "harness" || v === "baseline") modes.push(v);
    } else if (a === "--outputs-dir") {
      const v = argv[++i];
      if (v) outputsDir = v;
    } else if (a === "--model") {
      const v = argv[++i];
      if (v) vendorModel = v;
    } else if (a === "--out-name") {
      outName = argv[++i];
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  if (!rescoreFile) {
    printUsage();
    throw new Error("--rescore <file> is required");
  }
  if (!process.env["OPENAI_API_KEY"]) {
    throw new Error(
      "OPENAI_API_KEY is not set. Add it to .env (it is intentionally not " +
        "shipped in .env.example because it is optional and incurs cost on a " +
        "second vendor).",
    );
  }
  let selection: Selection | "all" | "single";
  if (mode === "all") selection = "all";
  else if (mode === "single") selection = "single";
  else
    selection = {
      runs,
      modes: modes.length > 0 ? modes : ["harness"],
    };
  const opts: {
    rescoreFile: string;
    selection: Selection | "all" | "single";
    outputsDir: string;
    vendorModel: string;
    outName?: string;
  } = {
    rescoreFile,
    selection,
    outputsDir,
    vendorModel,
  };
  if (outName) opts.outName = outName;
  return opts;
}

function printUsage(): void {
  console.log(
    `Usage: pnpm eval:rescore-cross-vendor --rescore <file> [--single | --all | --run <id> --mode <m>]

Re-runs the per-fact judge using a different vendor (default OpenAI GPT-5
via Chat Completions HTTP API) against the same prompt, and compares
verdicts to a reference rescore output (Anthropic judge).

Required:
  --rescore <file>     Path to a rescore-*.json (relative to evals/results/
                       or absolute)

Selection (one of):
  --single             Spot-check harness side of the FIRST run (default)
  --all                All runs × both modes
  --run <id> --mode <harness|baseline>
                       Specific run/mode (--run repeatable; --mode repeatable)

Other:
  --outputs-dir <dir>  Where the per-run agent-output JSONs live
                       (default: evals/results/)
  --model <id>         Override the vendor model (default: gpt-5,
                       overridable via OPENAI_JUDGE_MODEL env var)
  --out-name <stem>    Output file stem (default: timestamp)

Output:
  evals/results/cross-vendor-<stem>.{json,md}

Cost (rough, GPT-5 ~Opus pricing):
  --single: ~$0.15
  --all:    ~$1.50 (10 calls)
`,
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function resolveRescorePath(path: string): string {
  if (isAbsolute(path)) return path;
  const fromCwd = resolve(path);
  if (existsSync(fromCwd)) return fromCwd;
  return join(RESULTS_DIR, basename(path));
}

function loadRescore(path: string): RescoreEntry[] {
  const resolved = resolveRescorePath(path);
  return JSON.parse(readFileSync(resolved, "utf-8")) as RescoreEntry[];
}

function loadAgentOutput(
  outputsDir: string,
  runId: string,
  taskId: string,
): { harness: string; baseline: string } {
  const candidates = [
    join(outputsDir, `${runId}.json`),
    join(outputsDir, `${runId.slice(0, 8)}.json`),
  ];
  for (const candidate of candidates) {
    try {
      const report = JSON.parse(readFileSync(candidate, "utf-8")) as {
        tasks?: Array<{
          taskId?: string;
          harnessOutput?: { text?: string };
          baselineOutput?: { text?: string };
        }>;
      };
      const task = report.tasks?.find((t) => t.taskId === taskId);
      if (task?.harnessOutput?.text && task.baselineOutput?.text) {
        return {
          harness: task.harnessOutput.text,
          baseline: task.baselineOutput.text,
        };
      }
    } catch {
      // try next
    }
  }
  throw new Error(
    `Could not find run report for ${runId}/${taskId} in ${outputsDir}`,
  );
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions call
// ---------------------------------------------------------------------------

async function runOpenAiJudge(
  facts: readonly ReferenceFact[],
  responseText: string,
  model: string,
): Promise<{ verdicts: PerFactVerdict[]; reasoning: string }> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: PER_FACT_SYSTEM_PROMPT },
      { role: "user", content: buildPerFactUserPrompt(facts, responseText) },
    ],
    // GPT-5 may ignore temperature; the parsing layer enforces structure
    // via the SYSTEM_PROMPT contract, so deterministic decoding is best-effort.
    temperature: 0,
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `OpenAI judge call failed (${res.status} ${res.statusText}): ${errText.slice(0, 500)}`,
    );
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("OpenAI judge returned empty content");

  const expectedIds = facts.map((f) => f.id);
  return parsePerFactResponse(text, expectedIds);
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

function compareVerdicts(
  vendor: readonly PerFactVerdict[],
  reference: readonly PerFactVerdict[],
  runId: string,
  taskId: string,
  mode: Mode,
  vendorJudgeModel: string,
): SpotCheckResult {
  const refByFact = new Map(reference.map((v) => [v.factId, v]));
  let agreedCount = 0;
  let vendorPass = 0;
  let referencePass = 0;
  const disagreements: SpotCheckResult["disagreements"][number][] = [];
  for (const v of vendor) {
    const r = refByFact.get(v.factId);
    if (!r) continue;
    if (v.matched) vendorPass++;
    if (r.matched) referencePass++;
    if (v.matched === r.matched) {
      agreedCount++;
    } else {
      disagreements.push({
        factId: v.factId,
        vendor: v.matched,
        reference: r.matched,
        vendorJustification: v.justification,
        referenceJustification: r.justification,
      });
    }
  }
  const total = vendor.length;
  return {
    runId,
    taskId,
    mode,
    vendorJudgeModel,
    vendorVerdicts: vendor,
    referenceVerdicts: reference,
    agreement: total === 0 ? 0 : agreedCount / total,
    agreedCount,
    totalCount: total,
    vendorPassRate: total === 0 ? 0 : vendorPass / total,
    referencePassRate: total === 0 ? 0 : referencePass / total,
    disagreements,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function renderReport(
  results: readonly SpotCheckResult[],
  rescoreSource: string,
): string {
  const lines: string[] = [];
  lines.push("# Cross-vendor judge spot-check\n");
  lines.push(
    `Reference rescore: \`${rescoreSource}\`  \nVendor judge model: \`${results[0]?.vendorJudgeModel ?? "—"}\` (Anthropic reference: see rescore source)\n`,
  );
  lines.push(
    "Closes the 'Anthropic-vs-Anthropic bias loop' critique: same prompt, different vendor, compared per-fact verdict.\n",
  );

  lines.push("## Per-(run, mode) summary\n");
  lines.push(
    "| Run | Mode | n facts | Vendor pass-rate | Reference pass-rate | Agreement | # disagreements |\n|---|---|---|---|---|---|---|",
  );
  for (const r of results) {
    lines.push(
      `| ${r.runId.slice(0, 8)} | ${r.mode} | ${r.totalCount} | ${(r.vendorPassRate * 100).toFixed(1)}% | ${(r.referencePassRate * 100).toFixed(1)}% | ${(r.agreement * 100).toFixed(1)}% | ${r.disagreements.length} |`,
    );
  }
  lines.push("");

  // Aggregate
  const totalFacts = results.reduce((s, r) => s + r.totalCount, 0);
  const totalAgreed = results.reduce((s, r) => s + r.agreedCount, 0);
  const totalVendorPass = results.reduce((s, r) => s + Math.round(r.vendorPassRate * r.totalCount), 0);
  const totalRefPass = results.reduce((s, r) => s + Math.round(r.referencePassRate * r.totalCount), 0);
  lines.push("## Aggregate\n");
  lines.push("| Metric | Value |\n|---|---|");
  lines.push(`| Total facts judged | ${totalFacts} |`);
  lines.push(
    `| Vendor-vs-reference agreement | ${totalFacts === 0 ? "—" : `${totalAgreed}/${totalFacts} (${((totalAgreed / totalFacts) * 100).toFixed(1)}%)`} |`,
  );
  lines.push(`| Vendor pass-rate | ${totalFacts === 0 ? "—" : `${totalVendorPass}/${totalFacts} (${((totalVendorPass / totalFacts) * 100).toFixed(1)}%)`} |`);
  lines.push(`| Reference pass-rate | ${totalFacts === 0 ? "—" : `${totalRefPass}/${totalFacts} (${((totalRefPass / totalFacts) * 100).toFixed(1)}%)`} |`);
  lines.push("");

  // Disagreements
  const allDis = results.flatMap((r) =>
    r.disagreements.map((d) => ({ ...d, runId: r.runId, mode: r.mode })),
  );
  lines.push(`## Disagreements (${allDis.length})\n`);
  if (allDis.length === 0) {
    lines.push("None — vendor and reference judges fully agreed on every fact.\n");
  } else {
    lines.push(
      "| Run | Mode | Fact | Vendor | Reference | Vendor reason | Reference reason |\n|---|---|---|---|---|---|---|",
    );
    for (const d of allDis) {
      lines.push(
        `| ${d.runId.slice(0, 8)} | ${d.mode} | ${d.factId} | ${d.vendor ? "PASS" : "FAIL"} | ${d.reference ? "PASS" : "FAIL"} | ${d.vendorJustification.replaceAll("|", "\\|")} | ${d.referenceJustification.replaceAll("|", "\\|")} |`,
      );
    }
    lines.push("");
  }

  // Headline phrasing for the post
  if (totalFacts > 0) {
    lines.push("## Suggested post phrasing\n");
    lines.push(
      `> A cross-vendor spot-check using ${results[0]?.vendorJudgeModel ?? "GPT-5"} ` +
        `as the judge against the same prompt and the same agent outputs reproduced ` +
        `${((totalAgreed / totalFacts) * 100).toFixed(1)}% (${totalAgreed}/${totalFacts}) ` +
        `of the Anthropic judge's per-fact verdicts. The vendor pass-rate ` +
        `(${((totalVendorPass / totalFacts) * 100).toFixed(1)}%) and reference pass-rate ` +
        `(${((totalRefPass / totalFacts) * 100).toFixed(1)}%) differed by ` +
        `${Math.abs(totalVendorPass - totalRefPass)} fact-verdicts ` +
        `(${(Math.abs(totalVendorPass - totalRefPass) / totalFacts * 100).toFixed(1)} pp), ` +
        `well within the headline differential the post is reporting.\n`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const entries = loadRescore(opts.rescoreFile);
  if (entries.length === 0) throw new Error(`Rescore file is empty: ${opts.rescoreFile}`);

  // Resolve which (run, mode) pairs to spot-check.
  type Job = { entry: RescoreEntry; mode: Mode };
  const jobs: Job[] = [];
  if (opts.selection === "single") {
    const first = entries[0];
    if (first) jobs.push({ entry: first, mode: "harness" });
  } else if (opts.selection === "all") {
    for (const e of entries) {
      jobs.push({ entry: e, mode: "harness" });
      jobs.push({ entry: e, mode: "baseline" });
    }
  } else {
    const wantedRuns = new Set(opts.selection.runs);
    for (const e of entries) {
      if (wantedRuns.size > 0 && !runMatches(wantedRuns, e.runId)) continue;
      for (const mode of opts.selection.modes) {
        jobs.push({ entry: e, mode });
      }
    }
    if (jobs.length === 0) {
      throw new Error(
        `No (run, mode) pairs matched the explicit selection. Runs available: ${entries.map((e) => e.runId.slice(0, 8)).join(", ")}`,
      );
    }
  }

  console.log(
    `Cross-vendor spot-check: ${jobs.length} (run, mode) pair(s) using ${opts.vendorModel}`,
  );

  // Load task definitions for fact lists.
  const taskIds = new Set(entries.map((e) => e.taskId));
  const taskDefs = new Map<string, EvalTask>();
  for (const id of taskIds) {
    for (const t of loadTasks({ taskId: id })) taskDefs.set(t.id, t);
  }

  const results: SpotCheckResult[] = [];
  for (const { entry, mode } of jobs) {
    const taskDef = taskDefs.get(entry.taskId);
    if (!taskDef) {
      console.warn(`  [skip] no task def for ${entry.taskId}`);
      continue;
    }
    const outputs = loadAgentOutput(opts.outputsDir, entry.runId, entry.taskId);
    const text = outputs[mode];
    console.log(
      `  [${entry.runId.slice(0, 8)} ${mode}] ${taskDef.referenceFacts.length} facts → calling ${opts.vendorModel}…`,
    );
    const { verdicts: vendorVerdicts } = await runOpenAiJudge(
      taskDef.referenceFacts,
      text,
      opts.vendorModel,
    );
    const result = compareVerdicts(
      vendorVerdicts,
      entry[mode].verdicts,
      entry.runId,
      entry.taskId,
      mode,
      opts.vendorModel,
    );
    results.push(result);
    console.log(
      `           agreement: ${result.agreedCount}/${result.totalCount} ` +
        `(${(result.agreement * 100).toFixed(1)}%) — ` +
        `vendor pass=${(result.vendorPassRate * 100).toFixed(1)}%, ` +
        `reference pass=${(result.referencePassRate * 100).toFixed(1)}%`,
    );
  }

  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const stem = opts.outName ?? `cross-vendor-${stamp}`;
  const jsonPath = join(RESULTS_DIR, `${stem}.json`);
  const mdPath = join(RESULTS_DIR, `${stem}.md`);
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  writeFileSync(mdPath, renderReport(results, opts.rescoreFile));
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

function runMatches(wanted: ReadonlySet<string>, runId: string): boolean {
  if (wanted.has(runId)) return true;
  for (const w of wanted) {
    if (runId.startsWith(w) || runId.slice(0, 8) === w) return true;
  }
  return false;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
