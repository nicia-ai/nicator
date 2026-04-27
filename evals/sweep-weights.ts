/**
 * Context weight sweep — empirical validation of scoring weights.
 *
 * Runs context-category eval tasks across a grid of weight configurations,
 * collects factual scores per config, and outputs a comparison table.
 * This answers: "are the default weights better than alternatives?"
 *
 * Usage:
 *   pnpm eval:sweep-weights                    # full grid, 1 run per config
 *   pnpm eval:sweep-weights --runs 3           # 3 runs per config (statistical)
 *   pnpm eval:sweep-weights --task ctx-001     # single task only
 *   pnpm eval:sweep-weights --concurrency 2    # limit parallelism
 */

import "dotenv/config";

import {
  type AgentDefinition,
  type ContextWeights,
  DEFAULT_CONTEXT_WEIGHTS,
  generateId,
  now,
  type Run,
} from "@nicator/core";
import env from "@nicator/core/env";
import {
  AutoApproveHitlHandler,
  createHarness,
  createLocalRepo,
  runAgent,
  seedSkillsFromFixtures,
  toolRegistryFromMap,
} from "@nicator/harness";
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_EVAL_SKILLS,
  DEFAULT_EVAL_SYSTEM_PROMPT,
  HARNESS_VERSION,
} from "./constants";
import type { EvalTask } from "./schema";
import { scoreFactualAccuracy } from "./scoring";
import { mean, stddev, ci95 } from "./stats";
import { loadTasks } from "./task-loader";

// ---------------------------------------------------------------------------
// Weight configurations to sweep
//
// Each config is a named set of weights. The grid should include:
//   - The current defaults (the hypothesis we're testing)
//   - Ablations that zero out each dimension (to measure its contribution)
//   - Alternatives that redistribute weight differently
// ---------------------------------------------------------------------------

const SWEEP_CONFIGS: ReadonlyArray<
  Readonly<{ name: string; weights: ContextWeights }>
> = [
  {
    name: "defaults",
    weights: DEFAULT_CONTEXT_WEIGHTS,
  },
  {
    name: "recency-heavy",
    weights: { recency: 0.6, downstream: 0.15, artifactType: 0.1, retry: 0.05, skillType: 0.1 },
  },
  {
    name: "downstream-heavy",
    weights: { recency: 0.15, downstream: 0.6, artifactType: 0.1, retry: 0.05, skillType: 0.1 },
  },
  {
    name: "equal",
    weights: { recency: 0.2, downstream: 0.2, artifactType: 0.2, retry: 0.2, skillType: 0.2 },
  },
  {
    name: "no-downstream",
    weights: { recency: 0.5, downstream: 0.0, artifactType: 0.2, retry: 0.15, skillType: 0.15 },
  },
  {
    name: "no-recency",
    weights: { recency: 0.0, downstream: 0.5, artifactType: 0.2, retry: 0.15, skillType: 0.15 },
  },
  {
    name: "recency-only",
    weights: { recency: 1.0, downstream: 0.0, artifactType: 0.0, retry: 0.0, skillType: 0.0 },
  },
  {
    name: "downstream-only",
    weights: { recency: 0.0, downstream: 1.0, artifactType: 0.0, retry: 0.0, skillType: 0.0 },
  },
];

import {
  buildInputArtifactPreamble,
  createEvalWorkspace,
  EVAL_TOOL_REGISTRY,
  loadSkillFixtures,
  toSeededInputArtifacts,
} from "./eval-infra";

// ---------------------------------------------------------------------------
// Single task+config execution
// ---------------------------------------------------------------------------

type FactDetail = {
  factId: string;
  matched: boolean;
  weight: number;
};

type SweepRunResult = {
  configName: string;
  taskId: string;
  factualScore: number;
  factDetails: ReadonlyArray<FactDetail>;
  completed: boolean;
  totalTokens: number;
  latencyMs: number;
};

async function runTaskWithWeights(
  task: EvalTask,
  weights: ContextWeights,
  configName: string,
  client: Anthropic,
): Promise<SweepRunResult> {
  const { repo } = await createLocalRepo(":memory:");

  const sweepDocs =
    task.inputArtifacts && task.inputArtifacts.length > 0
      ? task.inputArtifacts
      : task.sources;
  const inputText = `${buildInputArtifactPreamble(sweepDocs.length)}\n\n---\n\nQuestion: ${task.question}`;

  const overrides = task.definitionOverrides;

  const definition: AgentDefinition = {
    id: generateId(),
    version: 1,
    name: `sweep-${task.id}-${configName}`,
    description: task.description,
    systemPrompt: overrides?.systemPrompt ?? DEFAULT_EVAL_SYSTEM_PROMPT,
    subagentResultMode: overrides?.subagentResultMode ?? "inline",
    autoFinalizeFromSubagent: overrides?.autoFinalizeFromSubagent,
    skills: overrides?.skills ?? [...DEFAULT_EVAL_SKILLS],
    limits: {
      maxTasksPerRun: overrides?.limits?.maxTasksPerRun ?? 20,
      maxOperationsPerTask: overrides?.limits?.maxOperationsPerTask ?? 3,
      maxTokensPerRun: overrides?.limits?.maxTokensPerRun ?? 500_000,
      contextWeights: weights,
    },
    createdAt: now(),
  };
  await seedSkillsFromFixtures(repo, loadSkillFixtures());
  await repo.agents.createDefinition(definition);

  const runId = generateId();
  const run: Run = {
    id: runId,
    agentDefinitionId: definition.id,
    agentDefinitionVersion: definition.version,
    status: "pending",
    input: inputText,
    totalTokensUsed: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  await repo.runs.create(run);

  const { workspace, bashTool } = await createEvalWorkspace(runId);
  const existingTools = EVAL_TOOL_REGISTRY.list();
  const toolRegistry = toolRegistryFromMap([
    ...existingTools.map((t) => [t.tool.name, t] as const),
    ["bash", bashTool],
  ]);

  const config = createHarness({
    apiKey: client.apiKey ?? env.ANTHROPIC_API_KEY,
    repo,
    toolRegistry,
    workspace,
    hitlHandler: new AutoApproveHitlHandler(),
    inputArtifacts: toSeededInputArtifacts(sweepDocs),
  });

  const startMs = Date.now();
  let completed = false;
  try {
    await runAgent(runId, config);
    completed = true;
  } catch (err) {
    console.error(`  [${configName}/${task.id}] Error:`, err);
  } finally {
    await workspace.dispose();
  }
  const latencyMs = Date.now() - startMs;

  const lineage = await repo.lineage.getRunLineage(runId);
  const outputText =
    lineage?.run.status === "completed" ? lineage.run.output : "";
  const totalTokens = lineage?.run.totalTokensUsed ?? 0;

  const factual =
    task.referenceFacts.length > 0
      ? scoreFactualAccuracy(task, outputText)
      : undefined;

  return {
    configName,
    taskId: task.id,
    factualScore: factual?.score ?? 0,
    factDetails: factual?.facts ?? [],
    completed,
    totalTokens,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Sweep orchestration
// ---------------------------------------------------------------------------

type ConfigSummary = {
  name: string;
  weights: ContextWeights;
  results: SweepRunResult[];
  meanFactual: number;
  stddevFactual: number;
  ci95Lower: number;
  ci95Upper: number;
  completionRate: number;
  meanTokens: number;
  meanLatencyMs: number;
};

async function sweepConfig(
  configEntry: (typeof SWEEP_CONFIGS)[number],
  tasks: EvalTask[],
  runsPerConfig: number,
  client: Anthropic,
): Promise<ConfigSummary> {
  const results: SweepRunResult[] = [];

  for (let runIdx = 0; runIdx < runsPerConfig; runIdx++) {
    for (const task of tasks) {
      const tag =
        runsPerConfig > 1
          ? `[${configEntry.name} run ${runIdx + 1}/${runsPerConfig}] ${task.id}`
          : `[${configEntry.name}] ${task.id}`;
      console.log(`  ${tag}`);

      const result = await runTaskWithWeights(
        task,
        configEntry.weights,
        configEntry.name,
        client,
      );
      results.push(result);

      console.log(
        `    factual=${result.factualScore.toFixed(2)} ` +
          `completed=${result.completed} ` +
          `tokens=${result.totalTokens} ` +
          `latency=${(result.latencyMs / 1000).toFixed(1)}s`,
      );
    }
  }

  const scores = results.map((r) => r.factualScore);
  const { lower, upper } = ci95(scores);

  return {
    name: configEntry.name,
    weights: configEntry.weights,
    results,
    meanFactual: mean(scores),
    stddevFactual: stddev(scores),
    ci95Lower: lower,
    ci95Upper: upper,
    completionRate: results.filter((r) => r.completed).length / results.length,
    meanTokens: mean(results.map((r) => r.totalTokens)),
    meanLatencyMs: mean(results.map((r) => r.latencyMs)),
  };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatSweepReport(summaries: ConfigSummary[], runsPerConfig: number): string {
  const lines: string[] = [];

  lines.push(`# Context Weight Sweep Results`);
  lines.push(``);
  lines.push(`**Date:** ${new Date().toLocaleString()}`);
  lines.push(`**Harness:** ${HARNESS_VERSION}`);
  lines.push(`**Runs per config:** ${runsPerConfig}`);
  lines.push(`**Task count:** ${summaries[0]?.results.length ?? 0 / runsPerConfig}`);
  lines.push(``);

  // --- Main comparison table ---
  lines.push(`## Factual Accuracy by Weight Configuration`);
  lines.push(``);
  lines.push(
    `| Config | Mean | Stddev | 95% CI | Completion | Avg Tokens | Avg Latency |`,
  );
  lines.push(
    `|--------|------|--------|--------|------------|------------|-------------|`,
  );

  const sorted = [...summaries].sort((a, b) => b.meanFactual - a.meanFactual);

  for (const s of sorted) {
    const ciStr =
      Number.isFinite(s.ci95Lower) && Number.isFinite(s.ci95Upper)
        ? `[${(s.ci95Lower * 100).toFixed(1)}%, ${(s.ci95Upper * 100).toFixed(1)}%]`
        : "n/a";
    lines.push(
      `| ${s.name} ` +
        `| ${(s.meanFactual * 100).toFixed(1)}% ` +
        `| ${(s.stddevFactual * 100).toFixed(1)}% ` +
        `| ${ciStr} ` +
        `| ${(s.completionRate * 100).toFixed(0)}% ` +
        `| ${Math.round(s.meanTokens).toLocaleString()} ` +
        `| ${(s.meanLatencyMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push(``);

  // --- Weight detail ---
  lines.push(`## Weight Configurations`);
  lines.push(``);
  lines.push(
    `| Config | recency | downstream | artifactType | retry | skillType |`,
  );
  lines.push(
    `|--------|---------|------------|--------------|-------|-----------|`,
  );
  for (const s of sorted) {
    const w = s.weights;
    lines.push(
      `| ${s.name} | ${w.recency} | ${w.downstream} | ${w.artifactType} | ${w.retry} | ${w.skillType} |`,
    );
  }
  lines.push(``);

  // --- Per-task breakdown ---
  lines.push(`## Per-Task Breakdown`);
  lines.push(``);

  const taskIds = [...new Set(summaries[0]?.results.map((r) => r.taskId) ?? [])];
  const configNames = sorted.map((s) => s.name);
  lines.push(`| Task | ${configNames.join(" | ")} |`);
  lines.push(`|------|${configNames.map(() => "------").join("|")}|`);

  for (const taskId of taskIds) {
    const cells = configNames.map((name) => {
      const summary = sorted.find((s) => s.name === name);
      const taskResults = summary?.results.filter((r) => r.taskId === taskId) ?? [];
      const avgScore = taskResults.length > 0 ? mean(taskResults.map((r) => r.factualScore)) : 0;
      return `${(avgScore * 100).toFixed(0)}%`;
    });
    lines.push(`| ${taskId} | ${cells.join(" | ")} |`);
  }
  lines.push(``);

  // --- Per-fact heatmap (only for tasks with fact details) ---
  const allFactIds = new Map<string, string[]>(); // taskId -> factId[]
  for (const summary of summaries) {
    for (const result of summary.results) {
      if (result.factDetails.length > 0 && !allFactIds.has(result.taskId)) {
        allFactIds.set(
          result.taskId,
          result.factDetails.map((f) => f.factId),
        );
      }
    }
  }

  if (allFactIds.size > 0) {
    lines.push(`## Per-Fact Heatmap`);
    lines.push(``);
    lines.push(
      `Match rate per fact across weight configs (averaged over ${runsPerConfig} runs).`,
    );
    lines.push(``);

    for (const [taskId, factIds] of allFactIds) {
      lines.push(`### ${taskId}`);
      lines.push(``);
      lines.push(`| Fact | ${configNames.join(" | ")} |`);
      lines.push(`|------|${configNames.map(() => "------").join("|")}|`);

      for (const factId of factIds) {
        const cells = configNames.map((name) => {
          const summary = sorted.find((s) => s.name === name);
          const taskResults =
            summary?.results.filter((r) => r.taskId === taskId) ?? [];
          const matchCount = taskResults.reduce((count, r) => {
            const detail = r.factDetails.find((f) => f.factId === factId);
            return count + (detail?.matched ? 1 : 0);
          }, 0);
          const rate = taskResults.length > 0 ? matchCount / taskResults.length : 0;
          return `${(rate * 100).toFixed(0)}%`;
        });
        lines.push(`| ${factId} | ${cells.join(" | ")} |`);
      }
      lines.push(``);
    }
  }

  // --- Interpretation ---
  const best = sorted[0];
  const defaults = sorted.find((s) => s.name === "defaults");
  lines.push(`## Interpretation`);
  lines.push(``);
  if (best && defaults) {
    if (best.name === "defaults") {
      lines.push(
        `Default weights produced the highest mean factual score (${(best.meanFactual * 100).toFixed(1)}%). ` +
          `The current weights are empirically supported by this sweep.`,
      );
    } else {
      const delta = best.meanFactual - defaults.meanFactual;
      lines.push(
        `**"${best.name}"** outperformed defaults by ${(delta * 100).toFixed(1)}pp ` +
          `(${(best.meanFactual * 100).toFixed(1)}% vs ${(defaults.meanFactual * 100).toFixed(1)}%). ` +
          `Consider updating DEFAULT_CONTEXT_WEIGHTS. ` +
          `Run with \`--runs 5\` to confirm statistical significance.`,
      );
    }
  }
  lines.push(``);
  if (runsPerConfig < 3) {
    lines.push(
      `**Low-confidence warning:** ${runsPerConfig} run(s) per config is insufficient for ` +
        `statistical conclusions. Run \`pnpm eval:sweep-weights --runs 5\` for reliable results.`,
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let runsPerConfig = 1;
let taskFilter: string | undefined;
let concurrency = 1; // sequential by default — configs must not interfere

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--runs") {
    const v = args[++i];
    if (v) runsPerConfig = Math.max(1, Number.parseInt(v, 10) || 1);
  }
  if (args[i] === "--task") {
    taskFilter = args[++i];
  }
  if (args[i] === "--concurrency") {
    const v = args[++i];
    if (v) concurrency = Math.max(1, Number.parseInt(v, 10) || 1);
  }
}

async function main(): Promise<void> {
  const client = new Anthropic();

  const tasks = loadTasks({ categories: ["context"], taskId: taskFilter });
  if (tasks.length === 0) {
    console.error("No context-category tasks found. Create ctx-*.yaml files first.");
    process.exit(1);
  }

  const totalRuns = SWEEP_CONFIGS.length * tasks.length * runsPerConfig;
  console.log(
    `Weight sweep: ${SWEEP_CONFIGS.length} configs x ${tasks.length} tasks x ${runsPerConfig} runs = ${totalRuns} total runs\n`,
  );

  const summaries: ConfigSummary[] = [];

  // Run configs sequentially (or with bounded concurrency)
  if (concurrency <= 1) {
    for (const configEntry of SWEEP_CONFIGS) {
      console.log(`\nConfig: ${configEntry.name}`);
      console.log(`  weights: ${JSON.stringify(configEntry.weights)}`);
      const summary = await sweepConfig(configEntry, tasks, runsPerConfig, client);
      summaries.push(summary);
      console.log(
        `  => mean factual: ${(summary.meanFactual * 100).toFixed(1)}% ` +
          `completion: ${(summary.completionRate * 100).toFixed(0)}%`,
      );
    }
  } else {
    // Bounded parallel execution across configs
    let nextIdx = 0;
    async function worker(): Promise<void> {
      while (nextIdx < SWEEP_CONFIGS.length) {
        const idx = nextIdx++;
        const configEntry = SWEEP_CONFIGS[idx]!;
        console.log(`\nConfig: ${configEntry.name}`);
        console.log(`  weights: ${JSON.stringify(configEntry.weights)}`);
        const summary = await sweepConfig(configEntry, tasks, runsPerConfig, client);
        summaries.push(summary);
        console.log(
          `  => mean factual: ${(summary.meanFactual * 100).toFixed(1)}% ` +
            `completion: ${(summary.completionRate * 100).toFixed(0)}%`,
        );
      }
    }
    const workers = Array.from(
      { length: Math.min(concurrency, SWEEP_CONFIGS.length) },
      () => worker(),
    );
    await Promise.all(workers);
  }

  // Generate report
  const report = formatSweepReport(summaries, runsPerConfig);

  const resultsDir = join(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });

  const timestamp = Date.now();
  const mdPath = join(resultsDir, `sweep-weights-${timestamp}.md`);
  writeFileSync(mdPath, report);
  console.log(`\nReport written to ${mdPath}`);

  const jsonPath = join(resultsDir, `sweep-weights-${timestamp}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        harnessVersion: HARNESS_VERSION,
        runsPerConfig,
        taskCount: tasks.length,
        taskIds: tasks.map((t) => t.id),
        configs: summaries.map((s) => ({
          name: s.name,
          weights: s.weights,
          meanFactual: s.meanFactual,
          stddevFactual: s.stddevFactual,
          ci95Lower: s.ci95Lower,
          ci95Upper: s.ci95Upper,
          completionRate: s.completionRate,
          meanTokens: s.meanTokens,
          meanLatencyMs: s.meanLatencyMs,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`JSON written to ${jsonPath}`);

  // Print summary to stdout
  console.log(`\n${report}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
