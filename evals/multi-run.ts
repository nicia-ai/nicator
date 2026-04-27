/**
 * Multi-run cross-analysis.
 *
 * Loads multiple EvalReport JSON files, computes statistical summaries
 * across runs (mean, stddev, 95% CI, paired t-test), and outputs a
 * MultiRunSummary with variance and significance data.
 *
 * Usage:
 *   pnpm eval:multi-run                          # all result files
 *   pnpm eval:multi-run --last 5                 # 5 most recent results
 *   pnpm eval:multi-run --runs abc123 def456     # specific run prefixes
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { RESULTS_DIR } from "./constants";
import { regradePassFailResult } from "./scoring";
import { loadCurrentTaskMap } from "./task-loader";
import { loadEvalReports } from "./result-files";
import { resolveTaskMetadata } from "./schema";
import type { EvalReport, MultiRunSummary } from "./schema";
import { summarize, pairedTTest } from "./stats";

const MIN_RUNS = 2;

// ---------------------------------------------------------------------------
// Report loading
// ---------------------------------------------------------------------------

type LoadOptions = {
  last?: number;
  runPrefixes?: string[];
};

function loadReports(options: LoadOptions): EvalReport[] {
  try {
    const selectOptions: { last?: number; runPrefixes?: readonly string[] } =
      {};
    if (options.last !== undefined) selectOptions.last = options.last;
    if (options.runPrefixes !== undefined) {
      selectOptions.runPrefixes = options.runPrefixes;
    }
    const reports = loadEvalReports(RESULTS_DIR, selectOptions);
    if (reports.length === 0) {
      console.error("No EvalReport result files found. Run `pnpm eval` first.");
      process.exit(1);
    }
    return reports;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("No EvalReport")) {
      console.error(err.message);
      process.exit(1);
    }
    console.error("No results directory found. Run `pnpm eval` first.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Metric extraction
// ---------------------------------------------------------------------------

type MetricVectors = {
  factualHarness: number[];
  factualBaseline: number[];
  judgeHarness: number[];
  judgeBaseline: number[];
  passRateHarness: number[];
  passRateBaseline: number[];
  byCategory: Record<string, { harness: number[]; baseline: number[] }>;
  byPurpose: Record<string, { harness: number[]; baseline: number[] }>;
  byReleaseGate: Record<string, { harness: number[]; baseline: number[] }>;
  bySuite: Record<string, { harness: number[]; baseline: number[] }>;
};

function extractMetricVectors(reports: EvalReport[]): MetricVectors {
  const currentTaskMap = loadCurrentTaskMap();
  const vectors: MetricVectors = {
    factualHarness: [],
    factualBaseline: [],
    judgeHarness: [],
    judgeBaseline: [],
    passRateHarness: [],
    passRateBaseline: [],
    byCategory: {},
    byPurpose: {},
    byReleaseGate: {},
    bySuite: {},
  };

  for (const report of reports) {
    const { aggregate } = report;

    vectors.factualHarness.push(aggregate.factualAccuracy.harness);
    vectors.factualBaseline.push(aggregate.factualAccuracy.baseline);
    vectors.judgeHarness.push(aggregate.judgeQuality.harness);
    vectors.judgeBaseline.push(aggregate.judgeQuality.baseline);
    const passRateTotal = report.tasks.length;
    let harnessPassCount = 0;
    let baselinePassCount = 0;
    let baselineTotal = 0;
    for (const task of report.tasks) {
      const metadata =
        task.metadata ?? resolveTaskMetadata({ category: task.category });
      const currentTask = currentTaskMap.get(task.taskId);
      const passFail =
        currentTask ?
          regradePassFailResult(currentTask, task)
        : task.passFailResult;
      if (passFail.harnessPass) harnessPassCount += 1;
      if (metadata.comparisonMode !== "none") {
        baselineTotal += 1;
        if (passFail.baselinePass) baselinePassCount += 1;
      }
    }
    if (passRateTotal > 0) {
      vectors.passRateHarness.push(harnessPassCount / passRateTotal);
      if (baselineTotal > 0) {
        vectors.passRateBaseline.push(baselinePassCount / baselineTotal);
      }
    }

    for (const [cat, scores] of Object.entries(aggregate.byCategory)) {
      if (!vectors.byCategory[cat]) {
        vectors.byCategory[cat] = { harness: [], baseline: [] };
      }
      vectors.byCategory[cat].harness.push(scores.harness);
      vectors.byCategory[cat].baseline.push(scores.baseline);
    }

    const fallbackGroupScores = (
      labelForTask: (task: EvalReport["tasks"][number]) => string[],
    ): Record<string, { harness: number; baseline: number }> => {
      const buckets = new Map<
        string,
        { harness: number[]; baseline: number[] }
      >();
      for (const task of report.tasks) {
        const harness = task.judgeScoreAveraged?.harness ?? 0;
        const baseline = task.judgeScoreAveraged?.baseline ?? 0;
        for (const label of labelForTask(task)) {
          const bucket = buckets.get(label) ?? { harness: [], baseline: [] };
          bucket.harness.push(harness);
          bucket.baseline.push(baseline);
          buckets.set(label, bucket);
        }
      }
      return Object.fromEntries(
        [...buckets.entries()].map(([label, scores]) => [
          label,
          {
            harness:
              scores.harness.reduce((sum, value) => sum + value, 0) /
              scores.harness.length,
            baseline:
              scores.baseline.reduce((sum, value) => sum + value, 0) /
              scores.baseline.length,
          },
        ]),
      );
    };

    const purposeGroups =
      aggregate.byPurpose ??
      fallbackGroupScores((task) => [
        (task.metadata ?? resolveTaskMetadata({ category: task.category }))
          .purpose,
      ]);

    for (const [purpose, scores] of Object.entries(purposeGroups)) {
      if (!vectors.byPurpose[purpose]) {
        vectors.byPurpose[purpose] = { harness: [], baseline: [] };
      }
      vectors.byPurpose[purpose].harness.push(scores.harness);
      vectors.byPurpose[purpose].baseline.push(scores.baseline);
    }

    const releaseGateGroups =
      aggregate.byReleaseGate ??
      fallbackGroupScores((task) => [
        (task.metadata ?? resolveTaskMetadata({ category: task.category }))
          .releaseGate,
      ]);

    for (const [releaseGate, scores] of Object.entries(releaseGateGroups)) {
      if (!vectors.byReleaseGate[releaseGate]) {
        vectors.byReleaseGate[releaseGate] = { harness: [], baseline: [] };
      }
      vectors.byReleaseGate[releaseGate].harness.push(scores.harness);
      vectors.byReleaseGate[releaseGate].baseline.push(scores.baseline);
    }

    const suiteGroups =
      aggregate.bySuite ??
      fallbackGroupScores(
        (task) =>
          (task.metadata ?? resolveTaskMetadata({ category: task.category }))
            .suites,
      );

    for (const [suite, scores] of Object.entries(suiteGroups)) {
      if (!vectors.bySuite[suite]) {
        vectors.bySuite[suite] = { harness: [], baseline: [] };
      }
      vectors.bySuite[suite].harness.push(scores.harness);
      vectors.bySuite[suite].baseline.push(scores.baseline);
    }
  }

  return vectors;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateMatchingTasks(reports: EvalReport[]): void {
  if (reports.length < MIN_RUNS) {
    console.error(
      `Need at least ${MIN_RUNS} result files for multi-run analysis. Found ${reports.length}.`,
    );
    process.exit(1);
  }

  const firstTasks = reports[0]!.tasks
    .map((t) => t.taskId)
    .sort()
    .join(",");
  for (let i = 1; i < reports.length; i++) {
    const thisTasks = reports[i]!.tasks.map((t) => t.taskId)
      .sort()
      .join(",");
    if (thisTasks !== firstTasks) {
      console.error(
        `Task set mismatch: run ${reports[0]!.runId.slice(0, 8)} has [${firstTasks}] ` +
          `but run ${reports[i]!.runId.slice(0, 8)} has [${thisTasks}]. ` +
          `Only compare runs with identical task sets.`,
      );
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function analyze(reports: EvalReport[]): MultiRunSummary {
  validateMatchingTasks(reports);

  const vectors = extractMetricVectors(reports);

  // Per-category analysis — get task count from first report
  const firstReport = reports[0]!;
  const categoryCounts = new Map<string, number>();
  for (const [cat, scores] of Object.entries(
    firstReport.aggregate.byCategory,
  )) {
    categoryCounts.set(cat, scores.n);
  }

  const purposeCounts = new Map<string, number>();
  for (const task of firstReport.tasks) {
    const metadata =
      task.metadata ?? resolveTaskMetadata({ category: task.category });
    purposeCounts.set(
      metadata.purpose,
      (purposeCounts.get(metadata.purpose) ?? 0) + 1,
    );
  }

  const releaseGateCounts = new Map<string, number>();
  for (const task of firstReport.tasks) {
    const metadata =
      task.metadata ?? resolveTaskMetadata({ category: task.category });
    releaseGateCounts.set(
      metadata.releaseGate,
      (releaseGateCounts.get(metadata.releaseGate) ?? 0) + 1,
    );
  }

  const suiteCounts = new Map<string, number>();
  for (const task of firstReport.tasks) {
    const metadata =
      task.metadata ?? resolveTaskMetadata({ category: task.category });
    for (const suite of metadata.suites) {
      suiteCounts.set(suite, (suiteCounts.get(suite) ?? 0) + 1);
    }
  }

  const byCategory: MultiRunSummary["byCategory"] = {};
  for (const [cat, vecs] of Object.entries(vectors.byCategory)) {
    byCategory[cat] = {
      harness: summarize(vecs.harness),
      baseline: summarize(vecs.baseline),
      delta: pairedTTest(vecs.harness, vecs.baseline),
      n: categoryCounts.get(cat) ?? 0,
    };
  }

  const byPurpose: MultiRunSummary["byPurpose"] = {};
  for (const [purpose, vecs] of Object.entries(vectors.byPurpose)) {
    byPurpose[purpose] = {
      harness: summarize(vecs.harness),
      baseline: summarize(vecs.baseline),
      delta: pairedTTest(vecs.harness, vecs.baseline),
      n: purposeCounts.get(purpose) ?? 0,
    };
  }

  const byReleaseGate: MultiRunSummary["byReleaseGate"] = {};
  for (const [releaseGate, vecs] of Object.entries(vectors.byReleaseGate)) {
    byReleaseGate[releaseGate] = {
      harness: summarize(vecs.harness),
      baseline: summarize(vecs.baseline),
      delta: pairedTTest(vecs.harness, vecs.baseline),
      n: releaseGateCounts.get(releaseGate) ?? 0,
    };
  }

  const bySuite: MultiRunSummary["bySuite"] = {};
  for (const [suite, vecs] of Object.entries(vectors.bySuite)) {
    bySuite[suite] = {
      harness: summarize(vecs.harness),
      baseline: summarize(vecs.baseline),
      delta: pairedTTest(vecs.harness, vecs.baseline),
      n: suiteCounts.get(suite) ?? 0,
    };
  }

  return {
    runIds: reports.map((r) => r.runId),
    runCount: reports.length,
    timestamp: new Date().toISOString(),
    factualAccuracy: {
      harness: summarize(vectors.factualHarness),
      baseline: summarize(vectors.factualBaseline),
      delta: pairedTTest(vectors.factualHarness, vectors.factualBaseline),
    },
    judgeQuality: {
      harness: summarize(vectors.judgeHarness),
      baseline: summarize(vectors.judgeBaseline),
      delta: pairedTTest(vectors.judgeHarness, vectors.judgeBaseline),
    },
    passRate: {
      harness: summarize(vectors.passRateHarness),
      baseline: summarize(vectors.passRateBaseline),
    },
    byCategory,
    byPurpose,
    byReleaseGate,
    bySuite,
  };
}

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatCI(lower: number, upper: number): string {
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return "n/a";
  return `[${formatPercent(lower)}, ${formatPercent(upper)}]`;
}

function formatSummary(
  summary: MultiRunSummary["factualAccuracy"]["harness"],
): string {
  if (summary.n === 0) return "—";
  return `${formatPercent(summary.mean)} ${formatCI(summary.ci95Lower, summary.ci95Upper)}`;
}

function formatDeltaCI(
  delta: MultiRunSummary["factualAccuracy"]["delta"],
): string {
  if (delta.ci95Lower === undefined || delta.ci95Upper === undefined) {
    return "n/a";
  }
  return formatCI(delta.ci95Lower, delta.ci95Upper);
}

function sigMarker(p: number): string {
  if (p < 0.01) return "**";
  if (p < 0.05) return "*";
  return "";
}

function formatPValue(p: number): string {
  if (p < 0.001) return "< .001";
  if (p < 0.01) return `< .01`;
  return p.toFixed(3);
}

function deltaStr(d: number): string {
  const sign = d >= 0 ? "+" : "";
  return `${sign}${(d * 100).toFixed(1)}pp`;
}

export function formatMultiRunMarkdown(summary: MultiRunSummary): string {
  const lines: string[] = [];

  lines.push(`# Multi-Run Eval Summary`);
  lines.push(``);
  lines.push(`**Runs:** ${summary.runCount}`);
  lines.push(
    `**Run IDs:** ${summary.runIds.map((id) => id.slice(0, 8)).join(", ")}`,
  );
  lines.push(`**Generated:** ${new Date(summary.timestamp).toLocaleString()}`);
  lines.push(``);

  // --- Aggregate ---
  lines.push(`## Aggregate (mean and 95% CI)`);
  lines.push(``);
  lines.push(
    `| Metric | Harness | Baseline | Delta | 95% CI (delta) | p-value | Sig |`,
  );
  lines.push(
    `|--------|---------|----------|-------|----------------|---------|-----|`,
  );

  const rows: Array<{
    label: string;
    harness: MultiRunSummary["factualAccuracy"]["harness"];
    baseline: MultiRunSummary["factualAccuracy"]["baseline"];
    delta: MultiRunSummary["factualAccuracy"]["delta"];
  }> = [
    {
      label: "Factual accuracy",
      harness: summary.factualAccuracy.harness,
      baseline: summary.factualAccuracy.baseline,
      delta: summary.factualAccuracy.delta,
    },
    {
      label: "Judge quality",
      harness: summary.judgeQuality.harness,
      baseline: summary.judgeQuality.baseline,
      delta: summary.judgeQuality.delta,
    },
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.label} ` +
        `| ${formatSummary(row.harness)} ` +
        `| ${formatSummary(row.baseline)} ` +
        `| ${deltaStr(row.delta.meanDelta)} ` +
        `| ${formatDeltaCI(row.delta)} ` +
        `| ${formatPValue(row.delta.pValue)} ` +
        `| ${sigMarker(row.delta.pValue)} |`,
    );
  }

  // Pass rate (no paired test, just descriptive)
  const passRateDelta =
    summary.passRate.baseline.n > 0 ?
      deltaStr(summary.passRate.harness.mean - summary.passRate.baseline.mean)
    : "—";
  lines.push(
    `| Pass rate ` +
      `| ${formatSummary(summary.passRate.harness)} ` +
      `| ${formatSummary(summary.passRate.baseline)} ` +
      `| ${passRateDelta} ` +
      `| — | — | |`,
  );
  lines.push(``);

  // --- By category ---
  lines.push(`## By Category`);
  lines.push(``);
  lines.push(
    `| Category | Tasks | Harness | Baseline | Delta | p-value | Sig |`,
  );
  lines.push(
    `|----------|-------|---------|----------|-------|---------|-----|`,
  );

  for (const [cat, data] of Object.entries(summary.byCategory)) {
    if (!data) continue;
    lines.push(
      `| ${cat} ` +
        `| ${data.n} ` +
        `| ${formatSummary(data.harness)} ` +
        `| ${formatSummary(data.baseline)} ` +
        `| ${deltaStr(data.delta.meanDelta)} ` +
        `| ${formatPValue(data.delta.pValue)} ` +
        `| ${sigMarker(data.delta.pValue)} |`,
    );
  }
  lines.push(``);

  const appendGroupedSection = (
    title: string,
    groups: Record<
      string,
      {
        harness: MultiRunSummary["factualAccuracy"]["harness"];
        baseline: MultiRunSummary["factualAccuracy"]["baseline"];
        delta: MultiRunSummary["factualAccuracy"]["delta"];
        n: number;
      }
    >,
  ) => {
    lines.push(`## ${title}`);
    lines.push(``);
    lines.push(
      `| Group | Tasks | Harness | Baseline | Delta | p-value | Sig |`,
    );
    lines.push(
      `|-------|-------|---------|----------|-------|---------|-----|`,
    );
    for (const [label, data] of Object.entries(groups)) {
      lines.push(
        `| ${label} ` +
          `| ${data.n} ` +
          `| ${formatSummary(data.harness)} ` +
          `| ${formatSummary(data.baseline)} ` +
          `| ${deltaStr(data.delta.meanDelta)} ` +
          `| ${formatPValue(data.delta.pValue)} ` +
          `| ${sigMarker(data.delta.pValue)} |`,
      );
    }
    lines.push(``);
  };

  appendGroupedSection("By Purpose", summary.byPurpose);
  appendGroupedSection("By Release Gate", summary.byReleaseGate);
  appendGroupedSection("By Suite", summary.bySuite);

  // --- Notes ---
  lines.push(`## Notes`);
  lines.push(``);
  lines.push(
    `- 95% CI computed using t-distribution (df=${summary.runCount - 1})`,
  );
  lines.push(`- Paired t-test on per-run harness-vs-baseline aggregate scores`);
  lines.push(
    `- \\* = significant at alpha=0.05, \\*\\* = significant at alpha=0.01`,
  );
  if (summary.runCount < 5) {
    lines.push(
      `- **Low power warning:** ${summary.runCount} runs is marginal for significance testing. Consider 5+ runs.`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const loadOptions: LoadOptions = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--last") {
    const v = args[++i];
    if (v) loadOptions.last = Number.parseInt(v, 10);
  }
  if (args[i] === "--runs") {
    loadOptions.runPrefixes = [];
    while (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
      loadOptions.runPrefixes.push(args[++i]!);
    }
  }
}

const writeFile = args.includes("--write");

const reports = loadReports(loadOptions);
console.log(`Loaded ${reports.length} result file(s).`);

const summary = analyze(reports);

// Write JSON
mkdirSync(RESULTS_DIR, { recursive: true });
const timestamp = Date.now();
const outPath = join(RESULTS_DIR, `multi-run-${timestamp}.json`);
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`Summary written to ${outPath}\n`);

// Markdown
const markdown = formatMultiRunMarkdown(summary);
if (writeFile) {
  const mdPath = join(RESULTS_DIR, `multi-run-${timestamp}.report.md`);
  writeFileSync(mdPath, markdown);
  console.log(`Report written to ${mdPath}`);
} else {
  console.log(markdown);
}
