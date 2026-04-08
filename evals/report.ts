/**
 * Report generator for eval results.
 *
 * Two-phase architecture:
 * 1. buildReportView() — extracts a structured ReportView from an EvalReport
 * 2. formatMarkdown()  — renders a ReportView as markdown
 *
 * Usage:
 *   pnpm eval:report                          # latest result, stdout
 *   pnpm eval:report --run <runId-prefix>     # specific result
 *   pnpm eval:report --write                  # write .report.md alongside JSON
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import {
  EvalReportSchema,
} from "./schema";
import type {
  EvalReport,
  ReportView,
  ComparisonRow,
  CategoryRow,
  TaskRow,
  StepGradeFinding,
} from "./schema";

const RESULTS_DIR = join(__dirname, "results");

const CONTEXT_PRESSURE_HIGH = 1.5;
const CONTEXT_PRESSURE_LOW = 0.8;

const LIMITATIONS: ReadonlyArray<string> = [
  "Judge quality aggregate excludes inconclusive tasks. If > 20% of tasks are inconclusive, the judge prompt or rubric should be revised before drawing conclusions from the aggregate.",
  "Process metrics reflect harness behavior only. There are no process metrics for the baseline (it has no tasks, operations, or skills by design).",
];

// ---------------------------------------------------------------------------
// View builder — structured extraction from EvalReport
// ---------------------------------------------------------------------------

export function buildReportView(report: EvalReport): ReportView {
  const { aggregate, tasks } = report;

  const aggregateRows: ComparisonRow[] = [
    {
      label: "Factual accuracy",
      harness: aggregate.factualAccuracy.harness,
      baseline: aggregate.factualAccuracy.baseline,
      delta: aggregate.factualAccuracy.delta,
    },
    {
      label: "Judge quality",
      harness: aggregate.judgeQuality.harness,
      baseline: aggregate.judgeQuality.baseline,
      delta: aggregate.judgeQuality.delta,
    },
  ];

  const byCategory: CategoryRow[] = Object.entries(aggregate.byCategory).map(
    ([category, scores]) => ({
      category,
      n: scores.n,
      harness: scores.harness,
      baseline: scores.baseline,
      delta: scores.harness - scores.baseline,
    }),
  );

  const { processMetrics } = aggregate;
  let contextPressureNote: string | null = null;
  if (processMetrics.avgContextPressureRatio > CONTEXT_PRESSURE_HIGH) {
    contextPressureNote =
      "Context pressure ratio > 1.5x — harness is consuming significantly more tokens than the baseline. " +
      "Check for unnecessary context injection or retry churn.";
  } else if (processMetrics.avgContextPressureRatio < CONTEXT_PRESSURE_LOW) {
    contextPressureNote =
      "Context pressure ratio < 0.8x — compression may be active or harness is injecting less context than baseline.";
  }

  const taskRows: TaskRow[] = tasks.map((t) => ({
    taskId: t.taskId,
    category: t.category,
    factualHarness: t.factualScore?.score ?? null,
    factualBaseline: t.baselineFactualScore?.score ?? null,
    judgeHarness: t.judgeScoreAveraged?.harness ?? null,
    judgeBaseline: t.judgeScoreAveraged?.baseline ?? null,
    inconclusive: t.judgeScoreAveraged?.inconclusive ?? false,
    skillCount: t.harnessMetrics.skillsInvoked.length,
    operationCount: t.harnessMetrics.totalOperations,
  }));

  const tasksWithGrades = tasks.filter((t) => t.stepGrades);
  let stepGrades: ReportView["stepGrades"] = null;
  if (tasksWithGrades.length > 0) {
    const findings: StepGradeFinding[] = tasksWithGrades.flatMap((t) =>
      (t.stepGrades?.grades ?? [])
        .filter((g): g is typeof g & { severity: "warn" | "fail" } => g.severity !== "pass")
        .map((g) => ({
          taskId: t.taskId,
          severity: g.severity,
          aspect: g.aspect,
          finding: g.finding,
        })),
    );

    const totals = { pass: 0, warn: 0, fail: 0 };
    for (const t of tasksWithGrades) {
      if (t.stepGrades) {
        totals.pass += t.stepGrades.summary.pass;
        totals.warn += t.stepGrades.summary.warn;
        totals.fail += t.stepGrades.summary.fail;
      }
    }

    stepGrades = { findings, totals, taskCount: tasksWithGrades.length };
  }

  return {
    meta: {
      runId: report.runId,
      timestamp: new Date(report.timestamp).toLocaleString(),
      harnessVersion: report.harnessVersion,
      modelVersion: report.modelVersion,
      taskCount: tasks.length,
    },
    aggregate: aggregateRows,
    inconclusiveCount: aggregate.judgeQuality.inconclusiveCount,
    byCategory,
    processMetrics: {
      avgSkillsPerRun: processMetrics.avgSkillsPerRun,
      avgOperationsPerRun: processMetrics.avgOperationsPerRun,
      hitlRate: processMetrics.hitlRate,
      avgContextPressureRatio: processMetrics.avgContextPressureRatio,
      contextPressureNote,
    },
    tasks: taskRows,
    stepGrades,
    limitations: LIMITATIONS,
  };
}

// ---------------------------------------------------------------------------
// Markdown formatter — pure string rendering from ReportView
// ---------------------------------------------------------------------------

function formatPercent(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function deltaStr(d: number): string {
  const sign = d >= 0 ? "+" : "";
  return `${sign}${(d * 100).toFixed(1)}pp`;
}

function badge(d: number): string {
  if (d > 0.05) return "▲";
  if (d < -0.05) return "▼";
  return "→";
}

export function formatMarkdown(view: ReportView): string {
  const lines: string[] = [];

  // --- Header ---
  lines.push(`# Eval report`);
  lines.push(``);
  lines.push(`**Run ID:** \`${view.meta.runId}\``);
  lines.push(`**Timestamp:** ${view.meta.timestamp}`);
  lines.push(`**Harness version:** ${view.meta.harnessVersion}`);
  lines.push(`**Model:** ${view.meta.modelVersion}`);
  lines.push(`**Tasks:** ${view.meta.taskCount}`);
  lines.push(``);

  // --- Aggregate ---
  lines.push(`## Aggregate`);
  lines.push(``);
  lines.push(`| Metric | Harness | Baseline | Delta |`);
  lines.push(`|--------|---------|----------|-------|`);
  for (const row of view.aggregate) {
    lines.push(
      `| ${row.label} | ${formatPercent(row.harness)} | ${formatPercent(row.baseline)} | ${badge(row.delta)} ${deltaStr(row.delta)} |`,
    );
  }
  lines.push(``);

  if (view.inconclusiveCount > 0) {
    lines.push(
      `> **${view.inconclusiveCount} inconclusive** judge result(s) — position bias detected. These tasks are excluded from judge quality aggregate.`,
    );
    lines.push(``);
  }

  // --- By category ---
  lines.push(`## By category`);
  lines.push(``);
  lines.push(`| Category | N | Harness | Baseline | Delta |`);
  lines.push(`|----------|---|---------|----------|-------|`);
  for (const row of view.byCategory) {
    lines.push(
      `| ${row.category} | ${row.n} | ${formatPercent(row.harness)} | ${formatPercent(row.baseline)} | ${badge(row.delta)} ${deltaStr(row.delta)} |`,
    );
  }
  lines.push(``);

  // --- Process metrics ---
  lines.push(`## Process metrics`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Avg skills per run | ${view.processMetrics.avgSkillsPerRun.toFixed(1)} |`);
  lines.push(`| Avg operations per run | ${view.processMetrics.avgOperationsPerRun.toFixed(1)} |`);
  lines.push(`| HITL trigger rate | ${formatPercent(view.processMetrics.hitlRate)} |`);
  lines.push(`| Avg context pressure ratio | ${view.processMetrics.avgContextPressureRatio.toFixed(2)}x baseline |`);
  lines.push(``);

  if (view.processMetrics.contextPressureNote) {
    lines.push(`> ${view.processMetrics.contextPressureNote}`);
    lines.push(``);
  }

  // --- Per-task detail ---
  lines.push(`## Per-task results`);
  lines.push(``);
  lines.push(
    `| Task | Category | Factual (H) | Factual (B) | Judge (H) | Judge (B) | Inconclusive | Skills | Operations |`,
  );
  lines.push(
    `|------|----------|-------------|-------------|-----------|-----------|--------------|--------|----------|`,
  );
  for (const t of view.tasks) {
    const fh = t.factualHarness !== null ? formatPercent(t.factualHarness) : "—";
    const fb = t.factualBaseline !== null ? formatPercent(t.factualBaseline) : "—";
    const jh = t.judgeHarness !== null ? formatPercent(t.judgeHarness) : "—";
    const jb = t.judgeBaseline !== null ? formatPercent(t.judgeBaseline) : "—";
    lines.push(
      `| ${t.taskId} | ${t.category} | ${fh} | ${fb} | ${jh} | ${jb} | ${t.inconclusive ? "yes" : "no"} | ${t.skillCount} | ${t.operationCount} |`,
    );
  }
  lines.push(``);

  // --- Step grades ---
  if (view.stepGrades) {
    lines.push(`## Step grades`);
    lines.push(``);

    if (view.stepGrades.findings.length === 0) {
      lines.push(`All step graders passed across ${view.stepGrades.taskCount} task(s).`);
    } else {
      lines.push(`| Task | Severity | Aspect | Finding |`);
      lines.push(`|------|----------|--------|---------|`);
      for (const g of view.stepGrades.findings) {
        lines.push(`| ${g.taskId} | ${g.severity} | ${g.aspect} | ${g.finding} |`);
      }
    }
    lines.push(``);

    const { totals } = view.stepGrades;
    lines.push(`> Step grade totals: ${totals.pass} pass, ${totals.warn} warn, ${totals.fail} fail`);
    lines.push(``);
  }

  // --- Known limitations ---
  lines.push(`## Known limitations`);
  lines.push(``);
  for (const limitation of view.limitations) {
    lines.push(`- ${limitation}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI — load report, build view, format
// ---------------------------------------------------------------------------

function loadReport(runPrefix?: string): EvalReport {
  let files: string[];
  try {
    files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    console.error("No results directory found. Run `pnpm eval` first to generate results.");
    process.exit(1);
  }
  if (files.length === 0) {
    console.error("No results found. Run `pnpm eval` first.");
    process.exit(1);
  }

  let target: string;
  if (runPrefix) {
    const match = files.find((f) => f.startsWith(runPrefix));
    if (!match) {
      console.error(`No result found with prefix: ${runPrefix}`);
      process.exit(1);
    }
    target = match;
  } else {
    const newestByMtime = files
      .map((f) => ({ name: f, mtime: statSync(join(RESULTS_DIR, f)).mtimeMs }))
      .reduce((a, b) => (a.mtime >= b.mtime ? a : b));
    target = newestByMtime.name;
  }

  const raw = readFileSync(join(RESULTS_DIR, target), "utf-8");
  return EvalReportSchema.parse(JSON.parse(raw));
}

const args = process.argv.slice(2);
let runPrefix: string | undefined;
const writeFile = args.includes("--write");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--run" && args[i + 1]) runPrefix = args[++i];
}

const report = loadReport(runPrefix);
const view = buildReportView(report);
const markdown = formatMarkdown(view);

if (writeFile) {
  const outPath = join(RESULTS_DIR, `${report.runId.slice(0, 8)}.report.md`);
  writeFileSync(outPath, markdown);
  console.log(`Written to ${outPath}`);
} else {
  console.log(markdown);
}
