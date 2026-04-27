/**
 * Calibration runner — compares judge output against human labels.
 *
 * Usage:
 *   pnpm eval:calibrate                    # run on all labels
 *   pnpm eval:calibrate --task syn-001     # single task
 *
 * The workflow:
 * 1. Load human labels from labels.json
 * 2. For each label, run the judge on the same output
 * 3. Compare judge scores to human scores
 * 4. Report agreement metrics
 *
 * Iterate on the judge prompt until agreement is acceptable, then re-run.
 */

import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";

import { JUDGE_MODEL } from "../constants";
import { allTaskDocuments, type EvalTask } from "../schema";
import { loadTasks } from "../task-loader";
import { DIMENSIONS, computeComposite, round3 } from "../llm-judge/rubric";
import type { DimensionName } from "../llm-judge/rubric";
import {
  HumanLabelSchema,
  type HumanLabel,
  type CalibrationComparison,
  type CalibrationReport,
} from "./schema";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Task lookup — loaded once from YAML, indexed by ID
// ---------------------------------------------------------------------------

const ALL_TASKS = loadTasks();
const TASK_MAP = new Map<string, EvalTask>(
  ALL_TASKS.map((t) => [t.id, t]),
);

// ---------------------------------------------------------------------------
// Load labels
// ---------------------------------------------------------------------------

function loadLabels(taskFilter?: string): HumanLabel[] {
  const raw = readFileSync(join(__dirname, "labels.json"), "utf-8");
  const parsed = z.array(HumanLabelSchema).parse(JSON.parse(raw));
  if (taskFilter) {
    return parsed.filter((l) => l.taskId === taskFilter);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Run judge on a single output (simplified — doesn't need pairwise comparison)
// ---------------------------------------------------------------------------

const client = new Anthropic();

async function judgeOutput(
  task: EvalTask,
  output: string,
): Promise<{
  scores: Record<DimensionName, number>;
  failureMode: string;
}> {
  const rubricText = DIMENSIONS.map((dim) => {
    const anchors = dim.anchors
      .map((a) => `    ${a.score} — ${a.label}: ${a.description}`)
      .join("\n");
    return `### ${dim.name}\n${dim.description}\n\nScoring anchors:\n${anchors}`;
  }).join("\n\n");

  const sourcesText = allTaskDocuments(task)
    .map((s) => `### ${s.title}\n\n${s.content}`)
    .join("\n\n---\n\n");

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1500,
    temperature: 0,
    system: `
You are an expert evaluator of knowledge work outputs. Score the response on
four dimensions using the rubric below, and classify its dominant failure mode.

## Rubric

${rubricText}

## Failure modes

Classify the dominant failure mode:
- "none" — acceptable, no dominant failure
- "hallucination" — claims not in sources
- "source_confusion" — attributes info to wrong source
- "incomplete_coverage" — misses significant aspects
- "misinterpretation" — distorts source content
- "wrong_refusal" — declines when sources are sufficient
- "formatting_only" — content adequate, presentation poor

## Output format

Write reasoning in a <reasoning> block, then emit a <scores> block:

<scores>
{
  "faithfulness": <0|1|2|3>,
  "completeness": <0|1|2|3>,
  "coherence": <0|1|2|3>,
  "actionability": <0|1|2|3>,
  "failureMode": "<mode>"
}
</scores>
    `.trim(),
    messages: [
      {
        role: "user",
        content: `## Source documents\n\n${sourcesText}\n\n---\n\n## Question\n\n${task.question}\n\n---\n\n## Response\n\n${output}`,
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const scoresMatch = text.match(/<scores>([\s\S]*?)<\/scores>/);
  if (!scoresMatch?.[1]) {
    throw new Error("Judge response missing <scores> block");
  }

  const CalibrationScoresSchema = z.object({
    faithfulness: z.number().int().min(0).max(3),
    completeness: z.number().int().min(0).max(3),
    coherence: z.number().int().min(0).max(3),
    actionability: z.number().int().min(0).max(3),
    failureMode: z.string().default("none"),
  });

  const parsed = CalibrationScoresSchema.parse(JSON.parse(scoresMatch[1].trim()));
  return {
    scores: {
      faithfulness: parsed.faithfulness,
      completeness: parsed.completeness,
      coherence: parsed.coherence,
      actionability: parsed.actionability,
    },
    failureMode: parsed.failureMode,
  };
}

// ---------------------------------------------------------------------------
// Compare and report
// ---------------------------------------------------------------------------

function computeReport(
  comparisons: CalibrationComparison[],
): CalibrationReport {
  const total = comparisons.length;
  if (total === 0) {
    return {
      total: 0,
      passFailAgreementRate: 0,
      meanAbsDimensionDelta: 0,
      perDimensionDelta: {
        faithfulness: 0,
        completeness: 0,
        coherence: 0,
        actionability: 0,
      },
      failureModeAgreementRate: 0,
      comparisons,
    };
  }

  const passFailAgree = comparisons.filter(
    (c) => c.passFailAgreement,
  ).length;

  const dims: DimensionName[] = [
    "faithfulness",
    "completeness",
    "coherence",
    "actionability",
  ];

  const perDim = Object.fromEntries(
    dims.map((dim) => {
      const avg =
        comparisons.reduce(
          (sum, c) => sum + Math.abs(c.dimensionDeltas[dim]),
          0,
        ) / total;
      return [dim, Math.round(avg * 100) / 100];
    }),
  ) as Record<DimensionName, number>;

  const meanAbsDelta =
    comparisons.reduce((sum, c) => {
      const avgDelta =
        dims.reduce((s, d) => s + Math.abs(c.dimensionDeltas[d]), 0) /
        dims.length;
      return sum + avgDelta;
    }, 0) / total;

  const withFailures = comparisons.filter(
    (c) => c.humanLabel.failureMode !== "none",
  );
  const fmAgree =
    withFailures.length > 0 ?
      withFailures.filter((c) => c.failureModeAgreement).length /
      withFailures.length
    : 1;

  return {
    total,
    passFailAgreementRate: round3(passFailAgree / total),
    meanAbsDimensionDelta: Math.round(meanAbsDelta * 100) / 100,
    perDimensionDelta: perDim,
    failureModeAgreementRate: round3(fmAgree),
    comparisons,
  };
}

function printReport(report: CalibrationReport): void {
  console.log("\n=== Calibration Report ===\n");
  console.log(`Labels evaluated: ${report.total}`);
  console.log(
    `Pass/fail agreement: ${(report.passFailAgreementRate * 100).toFixed(1)}%`,
  );
  console.log(
    `Mean abs dimension delta: ${report.meanAbsDimensionDelta.toFixed(2)} (lower is better, 0 = perfect)`,
  );
  console.log(`\nPer-dimension mean abs delta:`);
  for (const [dim, delta] of Object.entries(report.perDimensionDelta)) {
    const bar = delta <= 0.5 ? "✓" : delta <= 1.0 ? "~" : "✗";
    console.log(`  ${bar} ${dim}: ${delta.toFixed(2)}`);
  }
  console.log(
    `\nFailure mode agreement: ${(report.failureModeAgreementRate * 100).toFixed(1)}%`,
  );

  console.log("\n--- Detail ---\n");
  for (const c of report.comparisons) {
    const passMatch = c.passFailAgreement ? "✓" : "✗";
    console.log(
      `[${c.taskId}/${c.agent}] pass/fail: ${passMatch}  ` +
        `Δfaith=${c.dimensionDeltas.faithfulness} ` +
        `Δcomp=${c.dimensionDeltas.completeness} ` +
        `Δcoher=${c.dimensionDeltas.coherence} ` +
        `Δaction=${c.dimensionDeltas.actionability}  ` +
        `FM: human=${c.humanLabel.failureMode} judge=${c.judgeFailureMode}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let taskFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--task" && args[i + 1]) taskFilter = args[++i];
  }

  const labels = loadLabels(taskFilter);
  if (labels.length === 0) {
    console.error("No labels found. Add labels to calibration/labels.json.");
    process.exit(1);
  }

  console.log(`Running calibration on ${labels.length} label(s)...`);

  const comparisons: CalibrationComparison[] = [];

  for (const label of labels) {
    const task = TASK_MAP.get(label.taskId);
    if (!task) {
      console.warn(`Skipping ${label.taskId}/${label.agent} — task not found`);
      continue;
    }

    process.stdout.write(`  ${label.taskId}/${label.agent}... `);

    const judgeResult = await judgeOutput(task, label.outputText);

    // Compute pass/fail from judge scores using the task's criteria
    const composite = computeComposite(judgeResult.scores, task.rubricWeights);
    const judgePass =
      (task.passFail.minJudgeComposite === undefined ||
        composite >= task.passFail.minJudgeComposite) &&
      (task.passFail.minFactualScore === undefined); // can't check factual without running scorer

    const dims: DimensionName[] = [
      "faithfulness",
      "completeness",
      "coherence",
      "actionability",
    ];

    comparisons.push({
      taskId: label.taskId,
      agent: label.agent,
      passFailAgreement: judgePass === label.pass,
      dimensionDeltas: Object.fromEntries(
        dims.map((d) => [d, judgeResult.scores[d] - label.scores[d]]),
      ) as Record<DimensionName, number>,
      failureModeAgreement:
        judgeResult.failureMode === label.failureMode,
      humanLabel: label,
      judgeScores: judgeResult.scores,
      judgeFailureMode: judgeResult.failureMode,
    });

    console.log("done");
  }

  const report = computeReport(comparisons);
  printReport(report);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
