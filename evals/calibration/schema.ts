import { z } from "zod";

import { FailureModeSchema } from "../schema";
import type { DimensionName } from "../llm-judge/rubric";

/**
 * A human-labeled example: a task output with human scores and critique.
 * These are the ground truth that the judge is calibrated against.
 */
export const HumanLabelSchema = z.object({
  /** Task ID from KWB suite */
  taskId: z.string(),
  /** Which agent produced this output */
  agent: z.enum(["harness", "baseline"]),
  /** The actual output text that was scored */
  outputText: z.string(),
  /** Human's binary pass/fail judgment */
  pass: z.boolean(),
  /** Human's dimensional scores (0-3, same scale as judge) */
  scores: z.object({
    faithfulness: z.number().int().min(0).max(3),
    completeness: z.number().int().min(0).max(3),
    coherence: z.number().int().min(0).max(3),
    actionability: z.number().int().min(0).max(3),
  }),
  /** Human's open-ended critique — what specifically was good or bad */
  critique: z.string(),
  /** Human's failure mode classification (if not a pass) */
  failureMode: FailureModeSchema.default("none"),
  /** Who provided this label */
  labeler: z.string(),
  /** When the label was created */
  labeledAt: z.iso.datetime(),
});
export type HumanLabel = z.infer<typeof HumanLabelSchema>;

/**
 * Result of comparing one judge output against one human label.
 */
export type CalibrationComparison = Readonly<{
  taskId: string;
  agent: "harness" | "baseline";
  /** Binary agreement: did judge and human agree on pass/fail? */
  passFailAgreement: boolean;
  /** Per-dimension delta: judge score minus human score */
  dimensionDeltas: Record<DimensionName, number>;
  /** Did judge and human agree on failure mode? */
  failureModeAgreement: boolean;
  humanLabel: HumanLabel;
  judgeScores: Record<DimensionName, number>;
  judgeFailureMode: string;
}>;

/**
 * Summary statistics for a calibration run.
 */
export type CalibrationReport = Readonly<{
  /** Total number of comparisons */
  total: number;
  /** Binary pass/fail agreement rate */
  passFailAgreementRate: number;
  /** Mean absolute dimension score delta across all dimensions and examples */
  meanAbsDimensionDelta: number;
  /** Per-dimension mean absolute delta */
  perDimensionDelta: Record<DimensionName, number>;
  /** Failure mode agreement rate (excluding "none" cases) */
  failureModeAgreementRate: number;
  /** Individual comparisons for manual review */
  comparisons: ReadonlyArray<CalibrationComparison>;
}>;
