import { ContextWeightsSchema, PolicySchema, WorkspaceSchema } from "@nicator/core";
import { z } from "zod";
import { GraphAssertionSchema } from "./graph-assertions";
import { StepGradingResultSchema } from "./step-graders";

// ---------------------------------------------------------------------------
// Task definition
// ---------------------------------------------------------------------------

export const TaskCategorySchema = z.enum([
  "synthesis",
  "extraction",
  "gap-analysis",
  "decision-support",
  "dispatch",
  "hitl",
  "limits",
  "context",
  "coordination",
]);
export type TaskCategory = z.infer<typeof TaskCategorySchema>;

export const SourceDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  /** Token count — used to compute context pressure metrics */
  tokenCount: z.number().int().positive(),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

/**
 * A fact that can be checked deterministically against a model output.
 * Used for the factual accuracy dimension.
 *
 * Matching is case-insensitive substring by default. Supply `pattern` for
 * regex matching when the fact has multiple acceptable surface forms.
 */
export const ReferenceFactSchema = z.object({
  id: z.string(),
  description: z.string(),
  /** Canonical string that must appear in the output */
  canonical: z.string(),
  /** Optional regex pattern — if provided, takes precedence over canonical */
  pattern: z.string().optional(),
  /** Weight for this fact in the factual accuracy score. Default: 1. */
  /** Weight 0 means the fact is tracked but excluded from scoring (e.g., compliance checks that should NOT match). */
  weight: z.number().nonnegative().default(1),
  /** If true, this fact is a fabricated canary that exists only in source documents.
   *  Used by the weight sweep to distinguish context-dependent facts from
   *  facts the model could reconstruct from parametric knowledge. */
  canary: z.boolean().optional(),
});
export type ReferenceFact = z.infer<typeof ReferenceFactSchema>;

// Re-export from dedicated module to avoid circular dependency with step-graders.ts
export { matchFact } from "./match-fact";

/** Per-dimension scoring weights for a task. Defaults to equal weight (0.25 each) if omitted. */
export const RubricWeightsSchema = z.object({
  faithfulness: z.number().min(0).max(1).optional(),
  completeness: z.number().min(0).max(1).optional(),
  coherence: z.number().min(0).max(1).optional(),
  actionability: z.number().min(0).max(1).optional(),
});
export type RubricWeights = z.infer<typeof RubricWeightsSchema>;

/**
 * Binary pass/fail criteria — what a domain expert would check to decide
 * whether this output is acceptable. This is the primary optimization target.
 * Dimensional judge scores are diagnostic; pass/fail is the decision.
 */
export const PassFailCriteriaSchema = z.object({
  /** Minimum factual accuracy score (0-1) to pass. Null if task has no reference facts. */
  minFactualScore: z.number().min(0).max(1).optional(),
  /** Facts that MUST be present for a pass (by fact ID). Overrides the score threshold. */
  requiredFactIds: z.array(z.string()).default([]),
  /** Minimum judge composite score (0-1) to pass. */
  minJudgeComposite: z.number().min(0).max(1).optional(),
  /** Custom description of what "pass" means for this task, shown in reports. */
  description: z.string(),
});
export type PassFailCriteria = z.infer<typeof PassFailCriteriaSchema>;

export const EvalTaskSchema = z.object({
  id: z.string().regex(/^[a-z]+-\d{3}$/),
  category: TaskCategorySchema,
  name: z.string(),
  description: z.string(),
  sources: z.array(SourceDocumentSchema).min(1).max(6),
  question: z.string(),
  /** Facts checked deterministically. May be empty for purely open-ended tasks. */
  referenceFacts: z.array(ReferenceFactSchema).default([]),
  /** Per-dimension scoring weights. Extraction tasks weight faithfulness; decision-support weights actionability. */
  rubricWeights: RubricWeightsSchema.optional(),
  /**
   * Binary pass/fail criteria for this task. This is the primary signal:
   * "would a domain expert accept this output?"
   */
  passFail: PassFailCriteriaSchema,
  /**
   * Expected skill sequence for the harness execution.
   * If the harness deviates significantly, flagged in process metrics.
   * Not enforced — deviation isn't penalized, just noted.
   */
  expectedSkills: z.array(z.string()).optional(),
  /**
   * If true, the correct answer is "I cannot answer this from the sources" or
   * similar. Tests the agent's ability to decline rather than fabricate.
   */
  isNegativeCase: z.boolean().optional(),
  /**
   * Structural assertions on the execution graph. Each assertion is a
   * predicate that must hold after the run completes. Assertions test
   * agent behavior (dispatch, HITL, ordering) without needing an LLM judge.
   */
  graphAssertions: z.array(GraphAssertionSchema).optional(),
  /**
   * HITL handler behavior for this eval. Defaults to "auto_approve".
   * Use "deny" to test the rejection/graceful-degradation path.
   */
  hitlBehavior: z.enum(["auto_approve", "deny"]).default("auto_approve"),
  /**
   * Overrides for the AgentDefinition used in the harness run.
   * Behavioral tasks (dispatch, hitl) use this to test specific system
   * prompt instructions and skill configurations.
   */
  definitionOverrides: z
    .object({
      systemPrompt: z.string().optional(),
      skills: z
        .array(
          z.object({
            name: z.string(),
            version: z.string(),
            policy: PolicySchema.optional(),
          }),
        )
        .optional(),
      limits: z
        .object({
          maxTasksPerRun: z.number().int().positive().optional(),
          maxOperationsPerTask: z.number().int().positive().optional(),
          maxTokensPerRun: z.number().int().positive().optional(),
          contextWeights: ContextWeightsSchema.optional(),
        })
        .optional(),
      workspace: WorkspaceSchema.optional(),
    })
    .optional(),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;

// ---------------------------------------------------------------------------
// Run outputs
// ---------------------------------------------------------------------------

export const ModelOutputSchema = z.object({
  text: z.string(),
  /** Total tokens consumed across all API calls for this output */
  totalTokens: z.number().int().nonnegative(),
  /** Wall time in ms */
  latencyMs: z.number().int().nonnegative(),
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export const HarnessRunMetricsSchema = z.object({
  skillsInvoked: z.array(z.string()),
  totalOperations: z.number().int().nonnegative(),
  hitlTriggered: z.boolean(),
  contextPressureTokens: z.number().int().nonnegative(),
  compressionApplied: z.boolean(),
});
export type HarnessRunMetrics = z.infer<typeof HarnessRunMetricsSchema>;

// ---------------------------------------------------------------------------
// Branded score types — compile-time distinction between score ranges
// ---------------------------------------------------------------------------

declare const __dimensionScore: unique symbol;
/** Integer score 0-3 from a judge dimension evaluation. */
export type DimensionScore = number & Readonly<{ [__dimensionScore]: true }>;

declare const __compositeScore: unique symbol;
/** Float score 0-1 representing a weighted composite or factual accuracy. */
export type CompositeScore = number & Readonly<{ [__compositeScore]: true }>;

/** Zod schema that parses an integer 0-3 and brands it as DimensionScore. */
export const DimensionScoreSchema = z.number().int().min(0).max(3) as unknown as z.ZodType<DimensionScore>;

/** Zod schema that parses a float 0-1 and brands it as CompositeScore. */
export const CompositeScoreSchema = z.number().min(0).max(1) as unknown as z.ZodType<CompositeScore>;

/** Cast a validated number in [0,1] to CompositeScore. Use only after validation. */
export function asCompositeScore(value: number): CompositeScore {
  return value as unknown as CompositeScore;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const FactualScoreSchema = z.object({
  taskId: z.string(),
  facts: z.array(
    z.object({
      factId: z.string(),
      matched: z.boolean(),
      weight: z.number(),
    }),
  ),
  /** Weighted fraction of facts matched. Range: [0, 1]. */
  score: CompositeScoreSchema,
});
export type FactualScore = z.infer<typeof FactualScoreSchema>;

/**
 * Dominant failure mode for a response. The judge classifies the single
 * most impactful issue. This drives the failure taxonomy — you fix the
 * most frequent failure mode first, not the lowest dimension score.
 */
export const FailureModeSchema = z.enum([
  "none",
  "hallucination",
  "source_confusion",
  "incomplete_coverage",
  "misinterpretation",
  "wrong_refusal",
  "formatting_only",
]);
export type FailureMode = z.infer<typeof FailureModeSchema>;

export const JudgeDimensionScoreSchema = z.object({
  score: DimensionScoreSchema,
  reasoning: z.string(),
});
export type JudgeDimensionScore = z.infer<typeof JudgeDimensionScoreSchema>;

export const JudgeResultSchema = z.object({
  taskId: z.string(),
  /** Which response appeared first in the prompt ("harness" | "baseline") */
  ordering: z.enum(["harness-first", "baseline-first"]),
  harness: z.object({
    faithfulness: JudgeDimensionScoreSchema,
    completeness: JudgeDimensionScoreSchema,
    coherence: JudgeDimensionScoreSchema,
    actionability: JudgeDimensionScoreSchema,
    /** Weighted composite using task rubric weights. Range: [0, 1]. */
    composite: CompositeScoreSchema,
  }),
  baseline: z.object({
    faithfulness: JudgeDimensionScoreSchema,
    completeness: JudgeDimensionScoreSchema,
    coherence: JudgeDimensionScoreSchema,
    actionability: JudgeDimensionScoreSchema,
    composite: CompositeScoreSchema,
  }),
  /**
   * Whether the judge reversed its preference when orderings were swapped.
   * Set after both orderings have been run.
   */
  positionBiasDetected: z.boolean().optional(),
  /** Dominant failure mode for the harness response in this ordering. */
  harnessFailureMode: FailureModeSchema.optional(),
  /** Dominant failure mode for the baseline response in this ordering. */
  baselineFailureMode: FailureModeSchema.optional(),
});
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

export const TaskResultSchema = z.object({
  taskId: z.string(),
  category: TaskCategorySchema,
  harnessOutput: ModelOutputSchema,
  baselineOutput: ModelOutputSchema,
  harnessMetrics: HarnessRunMetricsSchema,
  factualScore: FactualScoreSchema.optional(),
  baselineFactualScore: FactualScoreSchema.optional(),
  judgeResults: z.tuple([JudgeResultSchema, JudgeResultSchema]).optional(),
  /** Final averaged judge scores after position-bias mitigation */
  judgeScoreAveraged: z
    .object({
      harness: CompositeScoreSchema,
      baseline: CompositeScoreSchema,
      inconclusive: z.boolean(),
    })
    .optional(),
  /** Binary pass/fail grading results */
  passFailResult: z.object({
    harnessPass: z.boolean(),
    baselinePass: z.boolean(),
    harnessReason: z.string(),
    baselineReason: z.string(),
  }),
  /** Dominant failure modes (from judge, averaged across orderings) */
  harnessFailureMode: FailureModeSchema.optional(),
  baselineFailureMode: FailureModeSchema.optional(),
  /** Step-level process grades (skill decomposition, compression, retries) */
  stepGrades: StepGradingResultSchema.optional(),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const EvalReportSchema = z.object({
  runId: z.string(),
  timestamp: z.iso.datetime(),
  harnessVersion: z.string(),
  modelVersion: z.string(),
  tasks: z.array(TaskResultSchema),
  aggregate: z.object({
    factualAccuracy: z.object({
      harness: z.number().min(0).max(1),
      baseline: z.number().min(0).max(1),
      delta: z.number(),
    }),
    judgeQuality: z.object({
      harness: z.number().min(0).max(1),
      baseline: z.number().min(0).max(1),
      delta: z.number(),
      inconclusiveCount: z.number().int().nonnegative(),
    }),
    byCategory: z.record(
      z.string(),
      z.object({
        harness: z.number().min(0).max(1),
        baseline: z.number().min(0).max(1),
        n: z.number().int().positive(),
      }),
    ),
    passRate: z
      .object({
        harness: z.number().min(0).max(1),
        baseline: z.number().min(0).max(1),
        total: z.number().int().nonnegative(),
      })
      .optional(),
    failureModes: z
      .object({
        harness: z.record(z.string(), z.number().int().nonnegative()),
        baseline: z.record(z.string(), z.number().int().nonnegative()),
      })
      .optional(),
    processMetrics: z.object({
      avgSkillsPerRun: z.number(),
      avgOperationsPerRun: z.number(),
      hitlRate: z.number().min(0).max(1),
      avgContextPressureRatio: z.number(),
    }),
  }),
});
export type EvalReport = z.infer<typeof EvalReportSchema>;

// ---------------------------------------------------------------------------
// Multi-run statistical summary
// ---------------------------------------------------------------------------

export const StatSummarySchema = z.object({
  n: z.number().int().positive(),
  mean: z.number(),
  stddev: z.number().nonnegative(),
  ci95Lower: z.number(),
  ci95Upper: z.number(),
});
export type StatSummary = z.infer<typeof StatSummarySchema>;

export const PairedTestResultSchema = z.object({
  n: z.number().int().positive(),
  meanDelta: z.number(),
  stddevDelta: z.number().nonnegative(),
  tStatistic: z.number(),
  /** Two-tailed p-value from paired t-test */
  pValue: z.number().min(0).max(1),
  significant: z.boolean(),
});
export type PairedTestResult = z.infer<typeof PairedTestResultSchema>;

export const MultiRunSummarySchema = z.object({
  runIds: z.array(z.string()),
  runCount: z.number().int().positive(),
  timestamp: z.iso.datetime(),
  factualAccuracy: z.object({
    harness: StatSummarySchema,
    baseline: StatSummarySchema,
    delta: PairedTestResultSchema,
  }),
  judgeQuality: z.object({
    harness: StatSummarySchema,
    baseline: StatSummarySchema,
    delta: PairedTestResultSchema,
  }),
  passRate: z.object({
    harness: StatSummarySchema,
    baseline: StatSummarySchema,
  }),
  byCategory: z.record(
    z.string(),
    z.object({
      harness: StatSummarySchema,
      baseline: StatSummarySchema,
      delta: PairedTestResultSchema,
      n: z.number().int().positive(),
    }),
  ),
});
export type MultiRunSummary = z.infer<typeof MultiRunSummarySchema>;

// ---------------------------------------------------------------------------
// Report view — structured intermediate representation for formatters
// ---------------------------------------------------------------------------

export type ComparisonRow = Readonly<{
  label: string;
  harness: number;
  baseline: number;
  delta: number;
}>;

export type CategoryRow = Readonly<{
  category: string;
  n: number;
  harness: number;
  baseline: number;
  delta: number;
}>;

export type TaskRow = Readonly<{
  taskId: string;
  category: string;
  factualHarness: number | null;
  factualBaseline: number | null;
  judgeHarness: number | null;
  judgeBaseline: number | null;
  inconclusive: boolean;
  skillCount: number;
  operationCount: number;
}>;

export type StepGradeFinding = Readonly<{
  taskId: string;
  severity: "warn" | "fail";
  aspect: string;
  finding: string;
}>;

export type ReportView = Readonly<{
  meta: Readonly<{
    runId: string;
    timestamp: string;
    harnessVersion: string;
    modelVersion: string;
    taskCount: number;
  }>;
  aggregate: ReadonlyArray<ComparisonRow>;
  inconclusiveCount: number;
  byCategory: ReadonlyArray<CategoryRow>;
  processMetrics: Readonly<{
    avgSkillsPerRun: number;
    avgOperationsPerRun: number;
    hitlRate: number;
    avgContextPressureRatio: number;
    contextPressureNote: string | null;
  }>;
  tasks: ReadonlyArray<TaskRow>;
  stepGrades: Readonly<{
    findings: ReadonlyArray<StepGradeFinding>;
    totals: Readonly<{ pass: number; warn: number; fail: number }>;
    taskCount: number;
  }> | null;
  limitations: ReadonlyArray<string>;
}>;
