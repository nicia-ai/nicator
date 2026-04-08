import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  asCompositeScore,
  FailureModeSchema,
  type CompositeScore,
  type DimensionScore,
  type EvalTask,
  type FailureMode,
  type JudgeDimensionScore,
  type JudgeResult,
} from "../schema";
import { JUDGE_MODEL } from "../constants";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts";
import { DIMENSIONS, computeComposite, round3 } from "./rubric";
import type { DimensionName } from "./rubric";

const JUDGE_MAX_TOKENS = 4096;

const client = new Anthropic();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type JudgeVerdict = {
  results: [JudgeResult, JudgeResult];
  averaged: { harness: CompositeScore; baseline: CompositeScore; inconclusive: boolean };
  harnessFailureMode: FailureMode;
  baselineFailureMode: FailureMode;
};

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const JudgeLabelScoresSchema = z.object({
  faithfulness: z.number().int().min(0).max(3),
  completeness: z.number().int().min(0).max(3),
  coherence: z.number().int().min(0).max(3),
  actionability: z.number().int().min(0).max(3),
  failureMode: z.string(),
});

const JudgeResponseScoresSchema = z.object({
  A: JudgeLabelScoresSchema,
  B: JudgeLabelScoresSchema,
});

type ValidatedScores = {
  A: Record<DimensionName, number> & { failureMode: FailureMode };
  B: Record<DimensionName, number> & { failureMode: FailureMode };
};

const VALID_FAILURE_MODES: ReadonlySet<string> = new Set(FailureModeSchema.options);

function parseJudgeResponse(text: string): {
  reasoning: string;
  scores: ValidatedScores;
} {
  const reasoningMatch = text.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
  const scoresMatch = text.match(/<scores>([\s\S]*?)<\/scores>/);

  if (!reasoningMatch || !scoresMatch) {
    throw new Error(
      `Judge response missing required blocks.\n` +
        `Has <reasoning>: ${!!reasoningMatch}\n` +
        `Has <scores>: ${!!scoresMatch}\n` +
        `Raw response:\n${text.slice(0, 500)}`,
    );
  }

  const reasoningText = reasoningMatch[1];
  const scoresText = scoresMatch[1];
  if (!reasoningText || !scoresText) {
    throw new Error(
      `Judge response has empty capture groups.\n` +
      `Has reasoning content: ${!!reasoningText}\n` +
      `Has scores content: ${!!scoresText}`,
    );
  }
  const reasoning = reasoningText.trim();
  const rawJson = scoresText.trim();

  let parsed: z.infer<typeof JudgeResponseScoresSchema>;
  try {
    parsed = JudgeResponseScoresSchema.parse(JSON.parse(rawJson));
  } catch (cause: unknown) {
    throw new Error(`Failed to parse/validate scores JSON: ${rawJson.slice(0, 200)}`, { cause });
  }

  for (const label of ["A", "B"] as const) {
    if (!VALID_FAILURE_MODES.has(parsed[label].failureMode)) {
      parsed[label].failureMode = "none";
    }
  }

  return { reasoning, scores: parsed as ValidatedScores };
}

// ---------------------------------------------------------------------------
// Score extraction helpers
// ---------------------------------------------------------------------------

function extractDimensionScores(
  scores: ValidatedScores,
  label: "A" | "B",
  reasoning: string,
): Record<DimensionName, JudgeDimensionScore> {
  return Object.fromEntries(
    DIMENSIONS.map((dim) => [
      dim.name,
      { score: scores[label][dim.name], reasoning },
    ]),
  ) as Record<DimensionName, JudgeDimensionScore>;
}

function compositeFromDimensionScores(
  dimScores: Record<DimensionName, JudgeDimensionScore>,
  rubricWeights: EvalTask["rubricWeights"],
): CompositeScore {
  const raw = Object.fromEntries(
    DIMENSIONS.map((d) => [d.name, dimScores[d.name].score]),
  ) as Record<DimensionName, DimensionScore>;
  return computeComposite(raw, rubricWeights);
}

/**
 * Pick the more informative failure mode between two orderings.
 * Prefers a non-"none" classification when one ordering detected a failure.
 * When both orderings detect different non-none failures, the harness-first
 * ordering wins — it's the canonical presentation order.
 */
function resolveFailureMode(primary: FailureMode, secondary: FailureMode): FailureMode {
  return primary !== "none" ? primary : secondary;
}

// ---------------------------------------------------------------------------
// Single judge call
// ---------------------------------------------------------------------------

async function runJudgeOnce(
  task: EvalTask,
  harnessOutput: string,
  baselineOutput: string,
  ordering: "harness-first" | "baseline-first",
): Promise<JudgeResult> {
  const [responseA, responseB] =
    ordering === "harness-first" ?
      [harnessOutput, baselineOutput]
    : [baselineOutput, harnessOutput];

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: JUDGE_MAX_TOKENS,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserPrompt(task, responseA, responseB),
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const { reasoning, scores } = parseJudgeResponse(text);

  const harnessLabel = ordering === "harness-first" ? "A" : "B";
  const baselineLabel = ordering === "harness-first" ? "B" : "A";

  const harnessScores = extractDimensionScores(scores, harnessLabel, reasoning);
  const baselineScores = extractDimensionScores(scores, baselineLabel, reasoning);

  return {
    taskId: task.id,
    ordering,
    harness: {
      ...harnessScores,
      composite: compositeFromDimensionScores(harnessScores, task.rubricWeights),
    },
    baseline: {
      ...baselineScores,
      composite: compositeFromDimensionScores(baselineScores, task.rubricWeights),
    },
    harnessFailureMode: scores[harnessLabel].failureMode,
    baselineFailureMode: scores[baselineLabel].failureMode,
  };
}

// ---------------------------------------------------------------------------
// Position-bias-mitigated judge
// ---------------------------------------------------------------------------

function detectPositionBias(first: JudgeResult, second: JudgeResult): boolean {
  const harnessWonInFirstOrdering = first.harness.composite > first.baseline.composite;
  const harnessWonInSecondOrdering = second.harness.composite > second.baseline.composite;
  return harnessWonInFirstOrdering !== harnessWonInSecondOrdering;
}

export async function runJudge(
  task: EvalTask,
  harnessOutput: string,
  baselineOutput: string,
): Promise<JudgeVerdict> {
  const [harnessFirst, baselineFirst] = await Promise.all([
    runJudgeOnce(task, harnessOutput, baselineOutput, "harness-first"),
    runJudgeOnce(task, harnessOutput, baselineOutput, "baseline-first"),
  ]);

  const positionBias = detectPositionBias(harnessFirst, baselineFirst);

  // Annotate both results — not known until both orderings complete
  harnessFirst.positionBiasDetected = positionBias;
  baselineFirst.positionBiasDetected = positionBias;

  const harnessAvg =
    (harnessFirst.harness.composite + baselineFirst.harness.composite) / 2;
  const baselineAvg =
    (harnessFirst.baseline.composite + baselineFirst.baseline.composite) / 2;

  return {
    results: [harnessFirst, baselineFirst],
    averaged: {
      harness: asCompositeScore(round3(harnessAvg)),
      baseline: asCompositeScore(round3(baselineAvg)),
      inconclusive: positionBias,
    },
    harnessFailureMode: resolveFailureMode(
      harnessFirst.harnessFailureMode ?? "none",
      baselineFirst.harnessFailureMode ?? "none",
    ),
    baselineFailureMode: resolveFailureMode(
      harnessFirst.baselineFailureMode ?? "none",
      baselineFirst.baselineFailureMode ?? "none",
    ),
  };
}
