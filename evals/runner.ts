import "dotenv/config";

import {
  type AgentDefinition,
  DEFAULT_MAX_TOKENS,
  generateId,
  now,
  type Run,
  type RunLineage,
  taskHasOperationType,
} from "@nicator/core";
import env from "@nicator/core/env";
import {
  AutoApproveHitlHandler,
  DenyHitlHandler,
  createHarness,
  createLocalRepo,
  runAgent,
  seedSkillsFromFixtures,
  toolRegistryFromMap,
} from "@nicator/harness";
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  EvalTask,
  EvalReport,
  TaskResult,
  ModelOutput,
  FailureMode,
} from "./schema";
import { resolveTaskMetadata, type HarnessRunMetrics } from "./schema";
import {
  scoreFactualAccuracy,
  gradePassFail,
  computeAggregate,
  getFailingGatedStepGrades,
} from "./scoring";
import {
  BASELINE_MODEL,
  DEFAULT_EVAL_SKILLS,
  DEFAULT_EVAL_SYSTEM_PROMPT,
  HARNESS_VERSION,
  RESULTS_DIR,
} from "./constants";
import { runJudge } from "./llm-judge/judge";
import { loadTasks } from "./task-loader";
import { evaluateAssertions } from "./graph-assertions";
import {
  gradeSkillDecomposition,
  gradeContextCompression,
  gradeRetryBehavior,
  type StepGrade,
  type StepGradingResult,
} from "./step-graders";

// ---------------------------------------------------------------------------
// Baseline implementation
// ---------------------------------------------------------------------------

/**
 * The baseline is a single Claude API call.
 * All source documents are concatenated and injected directly into the user
 * message. No system prompt, no skill decomposition, no retry.
 *
 * This is the "just call the model" approach. It is not a straw man — for
 * short, self-contained tasks it is genuinely competitive. The benchmark
 * is designed to identify the boundary where decomposition pays off.
 */
async function runBaseline(
  task: EvalTask,
  client: Anthropic,
): Promise<ModelOutput> {
  // Baseline always gets every document inline — otherwise we'd compare
  // "harness with read_artifact access" to "model with no data at all."
  const sourcesText = allTaskDocuments(task)
    .map((s) => `## ${s.title}\n\n${s.content}`)
    .join("\n\n---\n\n");

  const startMs = Date.now();

  const response = await client.messages.create({
    model: BASELINE_MODEL,
    max_tokens: DEFAULT_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: `${sourcesText}\n\n---\n\n${task.question}`,
      },
    ],
  });

  const latencyMs = Date.now() - startMs;
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    text,
    totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    latencyMs,
  };
}

import {
  buildInputArtifactPreamble,
  createEvalWorkspace,
  EVAL_TOOL_REGISTRY,
  loadSkillFixtures,
  toSeededInputArtifacts,
} from "./eval-infra";
import { allTaskDocuments } from "./schema";

// ---------------------------------------------------------------------------
// Harness runner — real harness invocation
// ---------------------------------------------------------------------------

type HarnessRunResult = Readonly<{
  output: ModelOutput;
  metrics: TaskResult["harnessMetrics"];
  lineageAnalysis: LineageAnalysis | null;
  lineage: RunLineage | null;
}>;

async function runHarness(
  task: EvalTask,
  client: Anthropic,
  mode: "decomposed" | "flat" = "decomposed",
): Promise<HarnessRunResult> {
  // Optional: persist the graph for post-run investigation.
  // EVAL_PERSIST_DB=/tmp/run-<task>.db
  const persistDb = process.env["EVAL_PERSIST_DB"];
  const dbSuffix = mode === "flat" ? `${task.id}-flat` : task.id;
  const dbPath = persistDb ? `${persistDb}.${dbSuffix}` : ":memory:";
  const { repo } = await createLocalRepo(dbPath);

  const sourcesText = task.sources
    .map((s, i) => `[Source ${i + 1}: ${s.title}]\n\n${s.content}`)
    .join("\n\n---\n\n");

  const inputArtifactPreamble =
    task.inputArtifacts?.length ?
      buildInputArtifactPreamble(task.inputArtifacts.length)
    : undefined;

  const overrides = task.definitionOverrides;

  // Flat mode: strip the task's decomposition-specific system prompt and
  // skill set. The harness wrapper (tools, operational sections, output
  // guidance) stays identical, so a delta between flat and decomposed
  // isolates the decomposition effect from the wrapper effect.
  const definitionSystemPrompt =
    mode === "flat" ?
      DEFAULT_EVAL_SYSTEM_PROMPT
    : (overrides?.systemPrompt ?? DEFAULT_EVAL_SYSTEM_PROMPT);
  const definitionSkills =
    mode === "flat" ? [] : (overrides?.skills ?? [...DEFAULT_EVAL_SKILLS]);

  const definition: AgentDefinition = {
    id: generateId(),
    version: 1,
    name: `eval-${task.id}${mode === "flat" ? "-flat" : ""}`,
    description: task.description,
    systemPrompt: definitionSystemPrompt,
    subagentResultMode: overrides?.subagentResultMode ?? "inline",
    autoFinalizeFromSubagent:
      mode === "flat" ? undefined : overrides?.autoFinalizeFromSubagent,
    skills: definitionSkills,
    limits: {
      maxTasksPerRun: overrides?.limits?.maxTasksPerRun ?? 20,
      maxOperationsPerTask: overrides?.limits?.maxOperationsPerTask ?? 3,
      maxTokensPerRun: overrides?.limits?.maxTokensPerRun ?? 200_000,
      ...(overrides?.limits?.contextWeights && {
        contextWeights: overrides.limits.contextWeights,
      }),
    },
    createdAt: now(),
  };
  // Skills must be seeded before definitions so uses edges can be created
  await seedSkillsFromFixtures(repo, loadSkillFixtures());
  await repo.agents.createDefinition(definition);

  const runId = generateId();
  const run: Run = {
    id: runId,
    agentDefinitionId: definition.id,
    agentDefinitionVersion: definition.version,
    status: "pending",
    input: [sourcesText, inputArtifactPreamble, `Question: ${task.question}`]
      .filter((s): s is string => Boolean(s))
      .join("\n\n---\n\n"),
    totalTokensUsed: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  await repo.runs.create(run);

  // Fresh workspace per run so eval files don't leak across runs
  const wsOverrides = task.definitionOverrides?.workspace;
  const { workspace, bashTool } = await createEvalWorkspace(runId, {
    ...(wsOverrides?.outputPaths ?
      { outputPaths: wsOverrides.outputPaths }
    : {}),
    ...(wsOverrides?.initialFiles ?
      { initialFiles: wsOverrides.initialFiles }
    : {}),
  });
  const toolRegistry = toolRegistryFromMap([
    ...EVAL_TOOL_REGISTRY.list().map((t) => [t.tool.name, t] as const),
    ["bash", bashTool],
  ]);

  const config = createHarness({
    apiKey: client.apiKey ?? env.ANTHROPIC_API_KEY,
    repo,
    toolRegistry,
    workspace,
    hitlHandler:
      task.hitlBehavior === "deny" ?
        new DenyHitlHandler()
      : new AutoApproveHitlHandler(),
    ...(task.inputArtifacts?.length ?
      { inputArtifacts: toSeededInputArtifacts(task.inputArtifacts) }
    : {}),
  });

  const emptyMetrics: TaskResult["harnessMetrics"] = {
    skillsInvoked: [],
    totalOperations: 0,
    hitlTriggered: false,
    contextPressureTokens: 0,
    compressionApplied: false,
  };

  const startMs = Date.now();
  try {
    await runAgent(runId, config);
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    console.error(`  Harness error for ${task.id}:`, err);

    // Retrieve partial lineage even on failure — tasks and operations are
    // persisted before the error is thrown, so graph assertions can evaluate
    // the execution state that led to the failure.
    const lineage = (await repo.lineage.getRunLineage(runId)) ?? null;
    const analysis = lineage ? analyzeLineage(lineage) : null;
    const failedRun = lineage?.run ?? (await repo.runs.get(runId));

    return {
      output: {
        text: failedRun?.status === "completed" ? failedRun.output : "",
        totalTokens: failedRun?.totalTokensUsed ?? 0,
        latencyMs,
      },
      metrics: analysis?.metrics ?? emptyMetrics,
      lineageAnalysis: analysis,
      lineage,
    };
  } finally {
    await workspace.dispose();
  }
  const latencyMs = Date.now() - startMs;

  const lineage = await repo.lineage.getRunLineage(runId);
  if (!lineage) {
    return {
      output: { text: "", totalTokens: 0, latencyMs },
      metrics: emptyMetrics,
      lineageAnalysis: null,
      lineage: null,
    };
  }

  const analysis = analyzeLineage(lineage);
  return {
    output: {
      text: lineage.run.status === "completed" ? lineage.run.output : "",
      totalTokens: lineage.run.totalTokensUsed,
      latencyMs,
    },
    metrics: analysis.metrics,
    lineageAnalysis: analysis,
    lineage,
  };
}

type LineageAnalysis = {
  metrics: HarnessRunMetrics;
  /** Text output of the compression summary attempt, if any */
  compressedSummary: string | null;
  /** Number of operations that completed successfully (across all tasks) */
  successfulOperations: number;
};

function analyzeLineage(lineage: RunLineage): LineageAnalysis {
  const skillsInvoked = [
    ...new Set(
      lineage.tasks
        .filter(
          (t) =>
            t.task.role === "subagent" &&
            t.skill !== undefined &&
            t.task.subagentName !== undefined,
        )
        .map((t) => t.task.subagentName as string),
    ),
  ];

  const totalOperations = lineage.tasks.reduce(
    (sum, t) => sum + t.operations.length,
    0,
  );

  const successfulOperations = lineage.tasks.reduce(
    (sum, t) =>
      sum +
      t.operations.filter((a) => a.operation.status === "succeeded").length,
    0,
  );

  const hitlTriggered = lineage.tasks.some((t) =>
    taskHasOperationType(t, "hitl_response"),
  );

  // Compaction detection from graph compaction records
  const compressionApplied = lineage.compactions.length > 0;
  const compressedSummary = lineage.compactions[0]?.summary ?? null;

  const contextPressureTokens = lineage.tasks.reduce(
    (sum, t) =>
      sum +
      t.operations
        .filter((a) => a.operation.status === "succeeded")
        .reduce((s, a) => s + a.operation.inputTokens, 0),
    0,
  );

  return {
    metrics: {
      skillsInvoked,
      totalOperations,
      hitlTriggered,
      contextPressureTokens,
      compressionApplied,
    },
    compressedSummary,
    successfulOperations,
  };
}

// ---------------------------------------------------------------------------
// Step grading
// ---------------------------------------------------------------------------

function runStepGraders(
  task: EvalTask,
  analysis: LineageAnalysis,
  lineage: RunLineage | null,
): StepGradingResult {
  const grades: StepGrade[] = [
    gradeSkillDecomposition(
      analysis.metrics.skillsInvoked,
      task.requiredSkills ?? [],
      task.forbiddenSkills ?? [],
    ),
    gradeContextCompression(
      analysis.metrics.compressionApplied,
      analysis.compressedSummary,
      task.referenceFacts.filter((fact) => fact.expected === "present"),
    ),
    gradeRetryBehavior(
      analysis.metrics.totalOperations,
      analysis.successfulOperations,
    ),
  ];

  // Graph assertions — structural predicates on the execution graph
  if (task.graphAssertions && lineage) {
    const results = evaluateAssertions(task.graphAssertions, lineage);
    for (const result of results) {
      grades.push({
        aspect: "graph_assertion",
        severity: result.passed ? "pass" : "fail",
        finding: `[${result.assertion.type}] ${result.assertion.description}: ${result.detail}`,
      });
    }
  }

  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const g of grades) {
    summary[g.severity]++;
  }

  return { taskId: task.id, grades, summary };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY = 3;

type RunOptions = {
  categories?: string[];
  excludeCategories?: string[];
  purposes?: string[];
  excludePurposes?: string[];
  suites?: string[];
  taskId?: string;
  noJudge?: boolean;
  baselineOnly?: boolean;
  runs?: number;
  concurrency?: number;
};

/**
 * Creates a logger that prefixes all output with a run tag.
 * When running a single eval, the prefix is empty (no noise).
 */
function createLogger(tag: string) {
  const prefix = tag ? `[${tag}] ` : "";
  return {
    log: (...args: unknown[]) =>
      console.log(prefix + args.map(String).join(" ")),
    error: (...args: unknown[]) =>
      console.error(prefix + args.map(String).join(" ")),
  };
}

async function run(options: RunOptions = {}, tag = ""): Promise<string> {
  const log = createLogger(tag);
  const client = new Anthropic();

  const tasks = loadTasks({
    categories: options.categories,
    excludeCategories: options.excludeCategories,
    purposes: options.purposes,
    excludePurposes: options.excludePurposes,
    suites: options.suites,
    taskId: options.taskId,
  });

  if (tasks.length === 0) {
    console.error("No tasks matched the provided filters.");
    process.exit(1);
  }

  log.log(`Running ${tasks.length} task(s)...`);

  const results: TaskResult[] = [];

  for (const task of tasks) {
    log.log(`\n[${task.id}] ${task.name}`);
    const metadata = resolveTaskMetadata(task);
    const hasBaselineComparison = metadata.comparisonMode !== "none";

    // Metadata controls what the "baseline" column means. Most tasks compare
    // against a direct API call; decomposition-research tasks compare against
    // a flat harness run so the delta isolates decomposition specifically;
    // reliability tasks (comparisonMode: "none") have no meaningful baseline
    // — the signal is the harness's own pass/fail across repeated runs.
    const baselineRunner: Promise<ModelOutput> =
      metadata.comparisonMode === "flat-harness" ?
        runHarness(task, client, "flat").then((r) => r.output)
      : metadata.comparisonMode === "none" ?
        Promise.resolve({ text: "", totalTokens: 0, latencyMs: 0 })
      : runBaseline(task, client);

    const [baselineOutput, harnessResult] = await Promise.all([
      baselineRunner,
      options.baselineOnly ? Promise.resolve(null) : runHarness(task, client),
    ]);

    const harnessOutput = harnessResult?.output ?? baselineOutput;
    const harnessMetrics = harnessResult?.metrics ?? {
      skillsInvoked: [],
      totalOperations: 0,
      hitlTriggered: false,
      contextPressureTokens: 0,
      compressionApplied: false,
    };

    // Run step graders when lineage is available
    const stepGrades =
      harnessResult?.lineageAnalysis ?
        runStepGraders(
          task,
          harnessResult.lineageAnalysis,
          harnessResult.lineage,
        )
      : undefined;

    const factualScoreHarness =
      task.referenceFacts.length > 0 ?
        scoreFactualAccuracy(task, harnessOutput.text)
      : undefined;

    const factualScoreBaseline =
      hasBaselineComparison && task.referenceFacts.length > 0 ?
        scoreFactualAccuracy(task, baselineOutput.text)
      : undefined;

    const baselineLabel =
      metadata.comparisonMode === "flat-harness" ? "flat"
      : metadata.comparisonMode === "none" ? "no-baseline"
      : "baseline";
    log.log(
      `  Factual: harness=${factualScoreHarness?.score.toFixed(2) ?? "n/a"} ` +
        `${baselineLabel}=${factualScoreBaseline?.score.toFixed(2) ?? "n/a"}`,
    );

    let judgeResults: TaskResult["judgeResults"];
    let judgeScoreAveraged: TaskResult["judgeScoreAveraged"];
    let harnessFailureMode: FailureMode | undefined;
    let baselineFailureMode: FailureMode | undefined;

    if (!options.noJudge && !options.baselineOnly && hasBaselineComparison) {
      log.log(`  Running judge (2 orderings)...`);
      try {
        const judgeOutput = await runJudge(
          task,
          harnessOutput.text,
          baselineOutput.text,
        );
        judgeResults = judgeOutput.results;
        judgeScoreAveraged = judgeOutput.averaged;
        harnessFailureMode = judgeOutput.harnessFailureMode;
        baselineFailureMode = judgeOutput.baselineFailureMode;
        log.log(
          `  Judge:   harness=${judgeOutput.averaged.harness.toFixed(3)} ` +
            `baseline=${judgeOutput.averaged.baseline.toFixed(3)} ` +
            `inconclusive=${judgeOutput.averaged.inconclusive}`,
        );
        if (harnessFailureMode !== "none") {
          log.log(`  Harness failure: ${harnessFailureMode}`);
        }
        if (baselineFailureMode !== "none") {
          log.log(`  Baseline failure: ${baselineFailureMode}`);
        }
      } catch (e) {
        log.error(`  Judge failed for ${task.id}:`, e);
      }
    } else if (
      !options.noJudge &&
      !options.baselineOnly &&
      !hasBaselineComparison
    ) {
      log.log(`  Judge:   skipped (comparisonMode=none)`);
    }

    const harnessPassFail = gradePassFail(
      task,
      factualScoreHarness,
      judgeScoreAveraged?.harness,
      stepGrades,
    );
    const baselinePassFail =
      hasBaselineComparison ?
        gradePassFail(task, factualScoreBaseline, judgeScoreAveraged?.baseline)
      : { pass: false, reason: "No baseline for comparisonMode=none" };
    log.log(
      `  Pass/fail: harness=${harnessPassFail.pass ? "PASS" : "FAIL"} ` +
        `${hasBaselineComparison ? `baseline=${baselinePassFail.pass ? "PASS" : "FAIL"}` : "baseline=n/a"}`,
    );
    if (!harnessPassFail.pass) {
      log.log(`    Harness: ${harnessPassFail.reason}`);
    }
    if (hasBaselineComparison && !baselinePassFail.pass) {
      log.log(`    Baseline: ${baselinePassFail.reason}`);
    }

    if (
      getFailingGatedStepGrades(task, stepGrades).length > 0 &&
      (factualScoreHarness?.score ?? 0) > (factualScoreBaseline?.score ?? 0)
    ) {
      log.log(
        `  Note: harness outperformed ${baselineLabel} on factual score, but process gate failed; this is not a clean win.`,
      );
    }

    // Log step grade warnings/failures
    if (
      stepGrades &&
      (stepGrades.summary.warn > 0 || stepGrades.summary.fail > 0)
    ) {
      for (const g of stepGrades.grades) {
        if (g.severity !== "pass") {
          log.log(`  Step [${g.severity}] ${g.aspect}: ${g.finding}`);
        }
      }
    }

    results.push({
      taskId: task.id,
      category: task.category,
      metadata,
      harnessOutput,
      baselineOutput,
      harnessMetrics,
      factualScore: factualScoreHarness,
      baselineFactualScore: factualScoreBaseline,
      judgeResults,
      judgeScoreAveraged,
      passFailResult: {
        harnessPass: harnessPassFail.pass,
        baselinePass: baselinePassFail.pass,
        harnessReason: harnessPassFail.reason,
        baselineReason: baselinePassFail.reason,
      },
      harnessFailureMode,
      baselineFailureMode,
      stepGrades,
    });
  }

  const report: EvalReport = {
    runId: generateId(),
    timestamp: new Date().toISOString(),
    harnessVersion: HARNESS_VERSION,
    modelVersion: BASELINE_MODEL,
    tasks: results,
    aggregate: computeAggregate(tasks, results),
  };

  // Write results
  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `${report.runId.slice(0, 8)}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  log.log(`\nResults written to ${outPath}`);

  // Print aggregate summary
  const { aggregate } = report;
  log.log("\n=== Aggregate ===");
  log.log(
    `Factual accuracy:  harness=${aggregate.factualAccuracy.harness.toFixed(3)} ` +
      `baseline=${aggregate.factualAccuracy.baseline.toFixed(3)} ` +
      `delta=${aggregate.factualAccuracy.delta > 0 ? "+" : ""}${aggregate.factualAccuracy.delta.toFixed(3)}`,
  );
  log.log(
    `Judge quality:     harness=${aggregate.judgeQuality.harness.toFixed(3)} ` +
      `baseline=${aggregate.judgeQuality.baseline.toFixed(3)} ` +
      `delta=${aggregate.judgeQuality.delta > 0 ? "+" : ""}${aggregate.judgeQuality.delta.toFixed(3)} ` +
      `(${aggregate.judgeQuality.inconclusiveCount} inconclusive)`,
  );
  log.log(
    `Process:           avg ${aggregate.processMetrics.avgSkillsPerRun.toFixed(1)} skills/run, ` +
      `${aggregate.processMetrics.avgOperationsPerRun.toFixed(1)} operations/run, ` +
      `context ratio=${aggregate.processMetrics.avgContextPressureRatio.toFixed(2)}x`,
  );

  return outPath;
}

// Parse CLI args when run directly
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: pnpm eval [options]

Filters (combine to narrow the run set):
  --task <id>              Run a single task by id (e.g. dcv-004)
  --category <name>        Run all tasks in a category (repeatable)
  --exclude-category <n>   Exclude a category (repeatable)
  --purpose <name>         Run tasks with a given purpose (repeatable)
  --exclude-purpose <n>    Exclude a purpose (repeatable)
  --suite <name>           Run tasks in a named suite (repeatable)

Execution:
  --runs <n>               Repeat the suite n times (default: 1)
  --concurrency <n>        Max concurrent runs (default: bounded)
  --no-judge               Skip the LLM judge (regex/graph scoring only)
  --baseline-only          Run baseline mode only (skip harness)
  -h, --help               Show this help

Caution: evals call the Anthropic API and can run up large bills quickly.
Use --no-judge or a single --task while iterating.`);
  process.exit(0);
}
const options: RunOptions = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--category") {
    const v = args[++i];
    if (v) {
      if (!options.categories) options.categories = [];
      options.categories.push(v);
    }
  }
  if (args[i] === "--task") {
    const v = args[++i];
    if (v) options.taskId = v;
  }
  if (args[i] === "--purpose") {
    const v = args[++i];
    if (v) {
      if (!options.purposes) options.purposes = [];
      options.purposes.push(v);
    }
  }
  if (args[i] === "--exclude-purpose") {
    const v = args[++i];
    if (v) {
      if (!options.excludePurposes) options.excludePurposes = [];
      options.excludePurposes.push(v);
    }
  }
  if (args[i] === "--suite") {
    const v = args[++i];
    if (v) {
      if (!options.suites) options.suites = [];
      options.suites.push(v);
    }
  }
  if (args[i] === "--exclude-category") {
    const v = args[++i];
    if (v) {
      if (!options.excludeCategories) options.excludeCategories = [];
      options.excludeCategories.push(v);
    }
  }
  if (args[i] === "--no-judge") options.noJudge = true;
  if (args[i] === "--baseline-only") options.baselineOnly = true;
  if (args[i] === "--runs") {
    const v = args[++i];
    if (v) options.runs = Number.parseInt(v, 10);
  }
  if (args[i] === "--concurrency") {
    const v = args[++i];
    if (v) options.concurrency = Number.parseInt(v, 10);
  }
}

/**
 * Run N eval passes concurrently with bounded parallelism.
 * Each run is independent — own client, own repo, own result file.
 */
async function runPool(
  totalRuns: number,
  concurrency: number,
  options: RunOptions,
): Promise<string[]> {
  if (totalRuns === 1) {
    const path = await run(options);
    return [path];
  }

  console.log(`Starting ${totalRuns} runs (concurrency=${concurrency})...\n`);

  const results: string[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < totalRuns) {
      const i = nextIndex++;
      const tag = `run ${i + 1}/${totalRuns}`;
      try {
        const path = await run(options, tag);
        results.push(path);
      } catch (err) {
        console.error(`[${tag}] FAILED:`, err);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, totalRuns) }, () =>
    worker(),
  );
  await Promise.all(workers);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Completed ${results.length}/${totalRuns} runs`);
  for (const p of results) {
    console.log(`  ${p}`);
  }
  console.log(`${"=".repeat(60)}`);

  return results;
}

const totalRuns = options.runs ?? 1;
const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

runPool(totalRuns, concurrency, options).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
