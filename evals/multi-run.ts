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

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EvalReportSchema } from "./schema";
import type { EvalReport, MultiRunSummary } from "./schema";
import { summarize, pairedTTest } from "./stats";

const RESULTS_DIR = join(__dirname, "results");
const MIN_RUNS = 2;

// ---------------------------------------------------------------------------
// Report loading
// ---------------------------------------------------------------------------

type LoadOptions = {
  last?: number;
  runPrefixes?: string[];
};

function loadReports(options: LoadOptions): EvalReport[] {
  let files: string[];
  try {
    files = readdirSync(RESULTS_DIR).filter(
      (f) => f.endsWith(".json") && !f.startsWith("multi-run"),
    );
  } catch {
    console.error("No results directory found. Run `pnpm eval` first.");
    process.exit(1);
  }

  if (files.length === 0) {
    console.error("No result files found. Run `pnpm eval` first.");
    process.exit(1);
  }

  // Sort by mtime descending (newest first)
  const sorted = files
    .map((f) => ({ name: f, mtime: statSync(join(RESULTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  let selected: string[];
  if (options.runPrefixes && options.runPrefixes.length > 0) {
    selected = options.runPrefixes.map((prefix) => {
      const match = sorted.find((f) => f.name.startsWith(prefix));
      if (!match) {
        console.error(`No result file matches prefix: ${prefix}`);
        process.exit(1);
      }
      return match.name;
    });
  } else if (options.last) {
    selected = sorted.slice(0, options.last).map((f) => f.name);
  } else {
    selected = sorted.map((f) => f.name);
  }

  return selected.map((name) => {
    const raw = readFileSync(join(RESULTS_DIR, name), "utf-8");
    return EvalReportSchema.parse(JSON.parse(raw));
  });
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
};

function extractMetricVectors(reports: EvalReport[]): MetricVectors {
  const vectors: MetricVectors = {
    factualHarness: [],
    factualBaseline: [],
    judgeHarness: [],
    judgeBaseline: [],
    passRateHarness: [],
    passRateBaseline: [],
    byCategory: {},
  };

  for (const report of reports) {
    const { aggregate } = report;

    vectors.factualHarness.push(aggregate.factualAccuracy.harness);
    vectors.factualBaseline.push(aggregate.factualAccuracy.baseline);
    vectors.judgeHarness.push(aggregate.judgeQuality.harness);
    vectors.judgeBaseline.push(aggregate.judgeQuality.baseline);

    if (aggregate.passRate) {
      vectors.passRateHarness.push(aggregate.passRate.harness);
      vectors.passRateBaseline.push(aggregate.passRate.baseline);
    }

    for (const [cat, scores] of Object.entries(aggregate.byCategory)) {
      if (!vectors.byCategory[cat]) {
        vectors.byCategory[cat] = { harness: [], baseline: [] };
      }
      vectors.byCategory[cat].harness.push(scores.harness);
      vectors.byCategory[cat].baseline.push(scores.baseline);
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

  const firstTasks = reports[0]!.tasks.map((t) => t.taskId).sort().join(",");
  for (let i = 1; i < reports.length; i++) {
    const thisTasks = reports[i]!.tasks.map((t) => t.taskId).sort().join(",");
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
  for (const [cat, scores] of Object.entries(firstReport.aggregate.byCategory)) {
    categoryCounts.set(cat, scores.n);
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
  lines.push(`## Aggregate (mean +/- 95% CI)`);
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
        `| ${formatPercent(row.harness.mean)} +/- ${formatPercent(row.harness.stddev)} ` +
        `| ${formatPercent(row.baseline.mean)} +/- ${formatPercent(row.baseline.stddev)} ` +
        `| ${deltaStr(row.delta.meanDelta)} ` +
        `| ${formatCI(row.delta.meanDelta - row.delta.stddevDelta, row.delta.meanDelta + row.delta.stddevDelta)} ` +
        `| ${formatPValue(row.delta.pValue)} ` +
        `| ${sigMarker(row.delta.pValue)} |`,
    );
  }

  // Pass rate (no paired test, just descriptive)
  lines.push(
    `| Pass rate ` +
      `| ${formatPercent(summary.passRate.harness.mean)} +/- ${formatPercent(summary.passRate.harness.stddev)} ` +
      `| ${formatPercent(summary.passRate.baseline.mean)} +/- ${formatPercent(summary.passRate.baseline.stddev)} ` +
      `| ${deltaStr(summary.passRate.harness.mean - summary.passRate.baseline.mean)} ` +
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
        `| ${formatPercent(data.harness.mean)} +/- ${formatPercent(data.harness.stddev)} ` +
        `| ${formatPercent(data.baseline.mean)} +/- ${formatPercent(data.baseline.stddev)} ` +
        `| ${deltaStr(data.delta.meanDelta)} ` +
        `| ${formatPValue(data.delta.pValue)} ` +
        `| ${sigMarker(data.delta.pValue)} |`,
    );
  }
  lines.push(``);

  // --- Notes ---
  lines.push(`## Notes`);
  lines.push(``);
  lines.push(
    `- 95% CI computed using t-distribution (df=${summary.runCount - 1})`,
  );
  lines.push(`- Paired t-test on per-run harness-vs-baseline aggregate scores`);
  lines.push(`- \\* = significant at alpha=0.05, \\*\\* = significant at alpha=0.01`);
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
