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

import { writeFileSync } from "fs";
import { join } from "path";
import { RESULTS_DIR } from "./constants";
import { loadCurrentTaskMap } from "./task-loader";
import { regradePassFailResult } from "./scoring";
import { selectEvalReportFiles, loadEvalReportFile } from "./result-files";
import { resolveTaskMetadata } from "./schema";
import type {
  EvalReport,
  ReportView,
  ComparisonRow,
  CategoryRow,
  MetadataRow,
  TaskRow,
  StepGradeFinding,
} from "./schema";

const CONTEXT_PRESSURE_HIGH = 1.5;
const CONTEXT_PRESSURE_LOW = 0.8;

function hasConclusiveJudgeScore(t: EvalReport["tasks"][number]): boolean {
  return (
    t.judgeScoreAveraged !== undefined && !t.judgeScoreAveraged.inconclusive
  );
}

const LIMITATIONS: ReadonlyArray<string> = [
  "Judge quality aggregate excludes inconclusive tasks. If > 20% of tasks are inconclusive, the judge prompt or rubric should be revised before drawing conclusions from the aggregate.",
  "Process metrics reflect harness behavior only. There are no process metrics for the baseline (it has no tasks, operations, or skills by design).",
  "Per-task pass/fail rows are re-evaluated against the current task YAML definitions when available. Historical result JSON may have stored different pass/fail outcomes under older rules.",
];

// ---------------------------------------------------------------------------
// View builder — structured extraction from EvalReport
// ---------------------------------------------------------------------------

export function buildReportView(report: EvalReport): ReportView {
  const { aggregate, tasks } = report;
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const currentTaskMap = loadCurrentTaskMap(taskIds);

  const tasksWithFactual = tasks.filter((t) => t.factualScore !== undefined);
  const tasksWithJudge = tasks.filter(hasConclusiveJudgeScore);

  const aggregateRows: ComparisonRow[] = [
    tasksWithFactual.length > 0 ?
      {
        label: "Factual accuracy",
        harness: aggregate.factualAccuracy.harness,
        baseline: aggregate.factualAccuracy.baseline,
        delta: aggregate.factualAccuracy.delta,
      }
    : {
        label: "Factual accuracy",
        harness: null,
        baseline: null,
        delta: null,
      },
    tasksWithJudge.length > 0 ?
      {
        label: "Judge quality",
        harness: aggregate.judgeQuality.harness,
        baseline: aggregate.judgeQuality.baseline,
        delta: aggregate.judgeQuality.delta,
      }
    : {
        label: "Judge quality",
        harness: null,
        baseline: null,
        delta: null,
      },
  ];

  const judgeNByCategory = new Map<string, number>();
  for (const task of tasks) {
    if (!hasConclusiveJudgeScore(task)) continue;
    judgeNByCategory.set(
      task.category,
      (judgeNByCategory.get(task.category) ?? 0) + 1,
    );
  }

  const byCategory: CategoryRow[] = Object.entries(aggregate.byCategory).map(
    ([category, scores]) => {
      const judgeN = judgeNByCategory.get(category) ?? 0;
      if (judgeN === 0) {
        return {
          category,
          n: scores.n,
          harness: null,
          baseline: null,
          delta: null,
        };
      }
      return {
        category,
        n: scores.n,
        harness: scores.harness,
        baseline: scores.baseline,
        delta: scores.harness - scores.baseline,
      };
    },
  );

  const judgeNByLabel = (
    labelsForTask: (task: EvalReport["tasks"][number]) => string[],
  ): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (!hasConclusiveJudgeScore(task)) continue;
      for (const label of labelsForTask(task)) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    return counts;
  };

  const toMetadataRows = (
    groups:
      | Record<string, { harness: number; baseline: number; n: number }>
      | undefined,
    judgeCounts: Map<string, number>,
  ): MetadataRow[] =>
    Object.entries(groups ?? {}).map(([label, scores]) => {
      const judgeN = judgeCounts.get(label) ?? 0;
      if (judgeN === 0) {
        return {
          label,
          n: scores.n,
          harness: null,
          baseline: null,
          delta: null,
        };
      }
      return {
        label,
        n: scores.n,
        harness: scores.harness,
        baseline: scores.baseline,
        delta: scores.harness - scores.baseline,
      };
    });

  const computeMetadataRowsFromTasks = (
    labelsForTask: (task: EvalReport["tasks"][number]) => string[],
  ): MetadataRow[] => {
    const grouped = new Map<
      string,
      { judgeHarness: number[]; judgeBaseline: number[]; n: number }
    >();

    for (const task of tasks) {
      const labels = labelsForTask(task);
      for (const label of labels) {
        const bucket = grouped.get(label) ?? {
          judgeHarness: [],
          judgeBaseline: [],
          n: 0,
        };
        if (hasConclusiveJudgeScore(task) && task.judgeScoreAveraged) {
          bucket.judgeHarness.push(task.judgeScoreAveraged.harness);
          bucket.judgeBaseline.push(task.judgeScoreAveraged.baseline);
        }
        bucket.n += 1;
        grouped.set(label, bucket);
      }
    }

    return [...grouped.entries()].map(([label, scores]) => {
      if (scores.judgeHarness.length === 0) {
        return {
          label,
          n: scores.n,
          harness: null,
          baseline: null,
          delta: null,
        };
      }
      const harnessMean =
        scores.judgeHarness.reduce((sum, value) => sum + value, 0) /
        scores.judgeHarness.length;
      const baselineMean =
        scores.judgeBaseline.reduce((sum, value) => sum + value, 0) /
        scores.judgeBaseline.length;
      return {
        label,
        n: scores.n,
        harness: harnessMean,
        baseline: baselineMean,
        delta: harnessMean - baselineMean,
      };
    });
  };

  const purposeLabel = (task: EvalReport["tasks"][number]): string[] => [
    (task.metadata ?? resolveTaskMetadata({ category: task.category })).purpose,
  ];
  const releaseGateLabel = (task: EvalReport["tasks"][number]): string[] => [
    (task.metadata ?? resolveTaskMetadata({ category: task.category }))
      .releaseGate,
  ];
  const suiteLabels = (task: EvalReport["tasks"][number]): string[] =>
    (task.metadata ?? resolveTaskMetadata({ category: task.category })).suites;

  const purposeRows = toMetadataRows(
    aggregate.byPurpose,
    judgeNByLabel(purposeLabel),
  );
  const byPurpose =
    purposeRows.length > 0 ?
      purposeRows
    : computeMetadataRowsFromTasks(purposeLabel);
  const releaseGateRows = toMetadataRows(
    aggregate.byReleaseGate,
    judgeNByLabel(releaseGateLabel),
  );
  const byReleaseGate =
    releaseGateRows.length > 0 ?
      releaseGateRows
    : computeMetadataRowsFromTasks(releaseGateLabel);
  const suiteRows = toMetadataRows(
    aggregate.bySuite,
    judgeNByLabel(suiteLabels),
  );
  const bySuite =
    suiteRows.length > 0 ? suiteRows : (
      computeMetadataRowsFromTasks(suiteLabels)
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

  const taskRows: TaskRow[] = tasks.map((t) => {
    const metadata =
      t.metadata ?? resolveTaskMetadata({ category: t.category });
    const currentTask = currentTaskMap.get(t.taskId);
    const passFail =
      currentTask ? regradePassFailResult(currentTask, t) : t.passFailResult;
    const hasBaselineComparison = metadata.comparisonMode !== "none";
    return {
      taskId: t.taskId,
      category: t.category,
      purpose: metadata.purpose,
      releaseGate: metadata.releaseGate,
      harnessPass: passFail.harnessPass,
      baselinePass: hasBaselineComparison ? passFail.baselinePass : null,
      stepFailCount: t.stepGrades?.summary.fail ?? 0,
      factualHarness: t.factualScore?.score ?? null,
      factualBaseline:
        hasBaselineComparison ? (t.baselineFactualScore?.score ?? null) : null,
      judgeHarness: t.judgeScoreAveraged?.harness ?? null,
      judgeBaseline:
        hasBaselineComparison ? (t.judgeScoreAveraged?.baseline ?? null) : null,
      inconclusive: t.judgeScoreAveraged?.inconclusive ?? false,
      skillCount: t.harnessMetrics.skillsInvoked.length,
      operationCount: t.harnessMetrics.totalOperations,
    };
  });

  const tasksWithGrades = tasks.filter((t) => t.stepGrades);
  let stepGrades: ReportView["stepGrades"] = null;
  if (tasksWithGrades.length > 0) {
    const findings: StepGradeFinding[] = tasksWithGrades.flatMap((t) =>
      (t.stepGrades?.grades ?? [])
        .filter(
          (g): g is typeof g & { severity: "warn" | "fail" } =>
            g.severity !== "pass",
        )
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
    byPurpose,
    byReleaseGate,
    bySuite,
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

const NOT_AVAILABLE = "N/A";

function formatPercent(n: number | null): string {
  if (n === null) return NOT_AVAILABLE;
  return (n * 100).toFixed(1) + "%";
}

function formatDeltaCell(d: number | null): string {
  if (d === null) return NOT_AVAILABLE;
  const badgeStr =
    d > 0.05 ? "▲"
    : d < -0.05 ? "▼"
    : "→";
  const sign = d >= 0 ? "+" : "";
  return `${badgeStr} ${sign}${(d * 100).toFixed(1)}pp`;
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
      `| ${row.label} | ${formatPercent(row.harness)} | ${formatPercent(row.baseline)} | ${formatDeltaCell(row.delta)} |`,
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
      `| ${row.category} | ${row.n} | ${formatPercent(row.harness)} | ${formatPercent(row.baseline)} | ${formatDeltaCell(row.delta)} |`,
    );
  }
  lines.push(``);

  lines.push(`## By purpose`);
  lines.push(``);
  lines.push(`| Purpose | N | Harness | Baseline | Delta |`);
  lines.push(`|---------|---|---------|----------|-------|`);
  for (const row of view.byPurpose) {
    lines.push(
      `| ${row.label} | ${row.n} | ${formatPercent(row.harness)} | ${formatPercent(row.baseline)} | ${formatDeltaCell(row.delta)} |`,
    );
  }
  lines.push(``);

  lines.push(`## By release gate`);
  lines.push(``);
  lines.push(`| Gate | N | Harness | Baseline | Delta |`);
  lines.push(`|------|---|---------|----------|-------|`);
  for (const row of view.byReleaseGate) {
    lines.push(
      `| ${row.label} | ${row.n} | ${formatPercent(row.harness)} | ${formatPercent(row.baseline)} | ${formatDeltaCell(row.delta)} |`,
    );
  }
  lines.push(``);

  if (view.bySuite.length > 0) {
    lines.push(`## By suite`);
    lines.push(``);
    lines.push(`| Suite | N | Harness | Baseline | Delta |`);
    lines.push(`|-------|---|---------|----------|-------|`);
    for (const row of view.bySuite) {
      lines.push(
        `| ${row.label} | ${row.n} | ${formatPercent(row.harness)} | ${formatPercent(row.baseline)} | ${formatDeltaCell(row.delta)} |`,
      );
    }
    lines.push(``);
  }

  // --- Process metrics ---
  lines.push(`## Process metrics`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(
    `| Avg skills per run | ${view.processMetrics.avgSkillsPerRun.toFixed(1)} |`,
  );
  lines.push(
    `| Avg operations per run | ${view.processMetrics.avgOperationsPerRun.toFixed(1)} |`,
  );
  lines.push(
    `| HITL trigger rate | ${formatPercent(view.processMetrics.hitlRate)} |`,
  );
  lines.push(
    `| Avg context pressure ratio | ${view.processMetrics.avgContextPressureRatio.toFixed(2)}x baseline |`,
  );
  lines.push(``);

  if (view.processMetrics.contextPressureNote) {
    lines.push(`> ${view.processMetrics.contextPressureNote}`);
    lines.push(``);
  }

  // --- Per-task detail ---
  lines.push(`## Per-task results`);
  lines.push(``);
  lines.push(
    `| Task | Category | Purpose | Gate | Pass (H) | Pass (B) | Step fails | Factual (H) | Factual (B) | Judge (H) | Judge (B) | Inconclusive | Skills | Operations |`,
  );
  lines.push(
    `|------|----------|---------|------|----------|----------|------------|-------------|-------------|-----------|-----------|--------------|--------|----------|`,
  );
  for (const t of view.tasks) {
    const fh =
      t.factualHarness !== null ? formatPercent(t.factualHarness) : "—";
    const fb =
      t.factualBaseline !== null ? formatPercent(t.factualBaseline) : "—";
    const jh = t.judgeHarness !== null ? formatPercent(t.judgeHarness) : "—";
    const jb = t.judgeBaseline !== null ? formatPercent(t.judgeBaseline) : "—";
    const bp =
      t.baselinePass === null ? "—"
      : t.baselinePass ? "PASS"
      : "FAIL";
    lines.push(
      `| ${t.taskId} | ${t.category} | ${t.purpose} | ${t.releaseGate} | ${t.harnessPass ? "PASS" : "FAIL"} | ${bp} | ${t.stepFailCount} | ${fh} | ${fb} | ${jh} | ${jb} | ${t.inconclusive ? "yes" : "no"} | ${t.skillCount} | ${t.operationCount} |`,
    );
  }
  lines.push(``);

  // --- Step grades ---
  if (view.stepGrades) {
    lines.push(`## Step grades`);
    lines.push(``);

    if (view.stepGrades.findings.length === 0) {
      lines.push(
        `All step graders passed across ${view.stepGrades.taskCount} task(s).`,
      );
    } else {
      lines.push(`| Task | Severity | Aspect | Finding |`);
      lines.push(`|------|----------|--------|---------|`);
      for (const g of view.stepGrades.findings) {
        lines.push(
          `| ${g.taskId} | ${g.severity} | ${g.aspect} | ${g.finding} |`,
        );
      }
    }
    lines.push(``);

    const { totals } = view.stepGrades;
    lines.push(
      `> Step grade totals: ${totals.pass} pass, ${totals.warn} warn, ${totals.fail} fail`,
    );
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
  try {
    const selectOptions: { runPrefix?: string } = {};
    if (runPrefix !== undefined) selectOptions.runPrefix = runPrefix;
    const files = selectEvalReportFiles(RESULTS_DIR, selectOptions);
    if (files.length === 0) {
      console.error("No EvalReport results found. Run `pnpm eval` first.");
      process.exit(1);
    }
    return loadEvalReportFile(files[0]!);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("No EvalReport")) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(
      "No results directory found. Run `pnpm eval` first to generate results.",
    );
    process.exit(1);
  }
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
