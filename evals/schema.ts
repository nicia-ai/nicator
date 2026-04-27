import {
  ContextWeightsSchema,
  PolicySchema,
  SubagentResultModeSchema,
  WorkspaceSchema,
} from "@nicator/core";
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
  "steering",
  /**
   * Tasks designed to isolate the decomposition effect. For these
   * tasks the "baseline" column runs the same harness wrapper but
   * with `skills: []` and the default eval system prompt, forcing a
   * single-pass answer through the same operational surface. The
   * delta to the full decomposed harness measures the value added by
   * skill decomposition specifically, holding prompt/tools constant.
   */
  "decomposition-value",
  /**
   * Tasks that measure pipeline execution reliability as complexity
   * grows, independent of content quality. Each task specifies a
   * fixed multi-stage dispatch chain with trivial per-stage work. A
   * run passes only if every graph assertion is satisfied. The
   * aggregate signal is the fraction of runs that pass — the
   * coordinator's clean-process rate at that pipeline complexity.
   * No flat-harness comparison (harness-only).
   */
  "reliability",
]);
export type TaskCategory = z.infer<typeof TaskCategorySchema>;

export const EvalPurposeSchema = z.enum(["forecast", "stress", "mechanism"]);
export type EvalPurpose = z.infer<typeof EvalPurposeSchema>;

export const EvalRealismSchema = z.enum([
  "prod-derived",
  "prod-shaped",
  "synthetic",
]);
export type EvalRealism = z.infer<typeof EvalRealismSchema>;

export const EvalReleaseGateSchema = z.enum([
  "blocker",
  "advisory",
  "research",
]);
export type EvalReleaseGate = z.infer<typeof EvalReleaseGateSchema>;

export const EvalComparisonModeSchema = z.enum([
  "none",
  "direct-api",
  "flat-harness",
]);
export type EvalComparisonMode = z.infer<typeof EvalComparisonModeSchema>;

export const EvalSuiteSchema = z.enum([
  "prod-gate",
  "preprod-headroom",
  "research",
  "decomposition-research",
]);
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

export const TaskMetadataSchema = z.object({
  purpose: EvalPurposeSchema.optional(),
  realism: EvalRealismSchema.optional(),
  releaseGate: EvalReleaseGateSchema.optional(),
  comparisonMode: EvalComparisonModeSchema.optional(),
  workloadFamily: z.string().optional(),
  hypothesis: z.string().optional(),
  stressAxes: z.array(z.string()).optional(),
  /**
   * When true, the task is excluded from every derived suite and from
   * default `pnpm eval` runs. It is still reachable via `--task <id>` or
   * `--category <name>`, so the scaffold remains runnable for iteration
   * while no longer contributing to headline suite metrics.
   */
  parked: z.boolean().optional(),
  /** Human-readable reason the task is parked; shown in reports. */
  parkedReason: z.string().optional(),
});
export type TaskMetadata = z.infer<typeof TaskMetadataSchema>;

export const ResolvedTaskMetadataSchema = z.object({
  purpose: EvalPurposeSchema,
  realism: EvalRealismSchema,
  releaseGate: EvalReleaseGateSchema,
  comparisonMode: EvalComparisonModeSchema,
  workloadFamily: z.string().optional(),
  hypothesis: z.string().optional(),
  stressAxes: z.array(z.string()),
  suites: z.array(EvalSuiteSchema),
  parked: z.boolean(),
  parkedReason: z.string().optional(),
});
export type ResolvedTaskMetadata = z.infer<typeof ResolvedTaskMetadataSchema>;

const CATEGORY_METADATA_DEFAULTS: Readonly<
  Record<
    TaskCategory,
    Pick<
      ResolvedTaskMetadata,
      "purpose" | "realism" | "releaseGate" | "comparisonMode"
    >
  >
> = {
  synthesis: {
    purpose: "forecast",
    realism: "prod-shaped",
    releaseGate: "blocker",
    comparisonMode: "direct-api",
  },
  extraction: {
    purpose: "forecast",
    realism: "prod-shaped",
    releaseGate: "blocker",
    comparisonMode: "direct-api",
  },
  "gap-analysis": {
    purpose: "forecast",
    realism: "prod-shaped",
    releaseGate: "blocker",
    comparisonMode: "direct-api",
  },
  "decision-support": {
    purpose: "forecast",
    realism: "prod-shaped",
    releaseGate: "blocker",
    comparisonMode: "direct-api",
  },
  dispatch: {
    purpose: "mechanism",
    realism: "synthetic",
    releaseGate: "research",
    comparisonMode: "direct-api",
  },
  hitl: {
    purpose: "mechanism",
    realism: "synthetic",
    releaseGate: "research",
    comparisonMode: "direct-api",
  },
  limits: {
    purpose: "mechanism",
    realism: "synthetic",
    releaseGate: "research",
    comparisonMode: "direct-api",
  },
  context: {
    purpose: "mechanism",
    realism: "synthetic",
    releaseGate: "research",
    comparisonMode: "direct-api",
  },
  coordination: {
    purpose: "mechanism",
    realism: "synthetic",
    releaseGate: "research",
    comparisonMode: "direct-api",
  },
  steering: {
    purpose: "mechanism",
    realism: "synthetic",
    releaseGate: "research",
    comparisonMode: "direct-api",
  },
  "decomposition-value": {
    purpose: "mechanism",
    realism: "synthetic",
    releaseGate: "research",
    comparisonMode: "flat-harness",
  },
  reliability: {
    purpose: "mechanism",
    realism: "synthetic",
    releaseGate: "research",
    comparisonMode: "none",
  },
};

type TaskMetadataCarrier = Readonly<{
  category: TaskCategory;
  metadata?: TaskMetadata | undefined;
}>;

export function resolveTaskMetadata(
  task: TaskMetadataCarrier,
): ResolvedTaskMetadata {
  const defaults = CATEGORY_METADATA_DEFAULTS[task.category];
  const metadata = task.metadata ?? {};

  const parked = metadata.parked ?? false;

  const resolvedBase: Omit<ResolvedTaskMetadata, "suites"> = {
    purpose: metadata.purpose ?? defaults.purpose,
    realism: metadata.realism ?? defaults.realism,
    releaseGate: metadata.releaseGate ?? defaults.releaseGate,
    comparisonMode: metadata.comparisonMode ?? defaults.comparisonMode,
    ...(metadata.workloadFamily ?
      { workloadFamily: metadata.workloadFamily }
    : {}),
    ...(metadata.hypothesis ? { hypothesis: metadata.hypothesis } : {}),
    stressAxes: metadata.stressAxes ?? [],
    parked,
    ...(metadata.parkedReason ? { parkedReason: metadata.parkedReason } : {}),
  };

  // Parked tasks are excluded from every derived suite. They remain
  // reachable only through explicit `--task` or `--category` selection.
  const suites: EvalSuite[] = [];
  if (!parked) {
    if (
      resolvedBase.purpose === "forecast" &&
      resolvedBase.releaseGate === "blocker"
    ) {
      suites.push("prod-gate", "preprod-headroom");
    } else if (
      resolvedBase.purpose === "forecast" ||
      resolvedBase.purpose === "stress"
    ) {
      suites.push("preprod-headroom");
    }
    if (resolvedBase.purpose === "mechanism") {
      suites.push("research");
    }
    if (
      resolvedBase.purpose === "mechanism" &&
      resolvedBase.comparisonMode === "flat-harness"
    ) {
      suites.push("decomposition-research");
    }
  }

  return {
    ...resolvedBase,
    suites,
  };
}

export function taskBelongsToSuite(
  task: TaskMetadataCarrier,
  suite: EvalSuite,
): boolean {
  return resolveTaskMetadata(task).suites.includes(suite);
}

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
 * Supply `requiredPatterns` when the output must include multiple distinct
 * anchors (for example, two document IDs plus the conflicting values).
 */
export const ReferenceFactSchema = z.object({
  id: z.string(),
  description: z.string(),
  /** Canonical string that must appear in the output */
  canonical: z.string(),
  /** Optional regex pattern — if provided, takes precedence over canonical */
  pattern: z.string().optional(),
  /** Optional regex patterns that must ALL match. Takes precedence over `pattern`. */
  requiredPatterns: z.array(z.string()).min(1).optional(),
  /**
   * Whether this fact should be present or absent. `absent` facts are negative
   * checks: matching them means the output asserted something it should not.
   */
  expected: z.enum(["present", "absent"]).default("present"),
  /**
   * Weight for present facts in the factual accuracy score. Default: 1.
   * Weight 0 means the fact is tracked but excluded from the weighted score.
   */
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
  /**
   * If true, any failing step grade (for example graph-assertion or
   * required-skill failures) causes the harness run to fail the binary
   * pass/fail gate. This is useful for mechanism tasks where a factual
   * win should not count as a clean pass unless the intended process was
   * actually followed.
   */
  requireZeroFailingStepGrades: z.boolean().default(false),
  /** Custom description of what "pass" means for this task, shown in reports. */
  description: z.string(),
});
export type PassFailCriteria = z.infer<typeof PassFailCriteriaSchema>;

export const EvalTaskSchema = z.object({
  id: z.string().regex(/^[a-z]+-\d{3}$/),
  category: TaskCategorySchema,
  metadata: TaskMetadataSchema.optional(),
  name: z.string(),
  description: z.string(),
  sources: z.array(SourceDocumentSchema).max(6),
  /**
   * Artifacts the runner seeds into the run at startup. The agent reads
   * their content on demand via `read_artifact`. Use when the content
   * should flow through the context builder's scoring path rather than
   * being inlined into the prompt.
   */
  inputArtifacts: z.array(SourceDocumentSchema).optional(),
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
   * Skills that MUST be invoked for the run to pass decomposition grading.
   * Missing required skills produce a `fail` step grade. Use for tasks
   * where decomposition is the thing under test (e.g. research tasks that
   * genuinely require the researcher skill).
   */
  requiredSkills: z.array(z.string()).optional(),
  /**
   * Skills that MUST NOT be invoked. Any invocation produces a `fail` step
   * grade. Use for tasks where firing a skill would be a wasted detour or
   * introduce noise (e.g. source-provided synthesis tasks where invoking
   * researcher would hit the web unnecessarily).
   */
  forbiddenSkills: z.array(z.string()).optional(),
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
      subagentResultMode: SubagentResultModeSchema.optional(),
      autoFinalizeFromSubagent: z.string().min(1).optional(),
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
export const DimensionScoreSchema = z
  .number()
  .int()
  .min(0)
  .max(3) as unknown as z.ZodType<DimensionScore>;

/** Zod schema that parses a float 0-1 and brands it as CompositeScore. */
export const CompositeScoreSchema = z
  .number()
  .min(0)
  .max(1) as unknown as z.ZodType<CompositeScore>;

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
      expected: z.enum(["present", "absent"]).default("present"),
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
  metadata: ResolvedTaskMetadataSchema.optional(),
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
    byPurpose: z
      .record(
        z.string(),
        z.object({
          harness: z.number().min(0).max(1),
          baseline: z.number().min(0).max(1),
          n: z.number().int().positive(),
        }),
      )
      .optional(),
    byReleaseGate: z
      .record(
        z.string(),
        z.object({
          harness: z.number().min(0).max(1),
          baseline: z.number().min(0).max(1),
          n: z.number().int().positive(),
        }),
      )
      .optional(),
    bySuite: z
      .record(
        z.string(),
        z.object({
          harness: z.number().min(0).max(1),
          baseline: z.number().min(0).max(1),
          n: z.number().int().positive(),
        }),
      )
      .optional(),
    passRate: z
      .object({
        harness: z.number().min(0).max(1),
        baseline: z.number().min(0).max(1),
        total: z.number().int().nonnegative(),
        baselineTotal: z.number().int().nonnegative().optional(),
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
  n: z.number().int().nonnegative(),
  mean: z.number(),
  stddev: z.number().nonnegative(),
  ci95Lower: z.number(),
  ci95Upper: z.number(),
});
export type StatSummary = z.infer<typeof StatSummarySchema>;

export const PairedTestResultSchema = z.object({
  n: z.number().int().nonnegative(),
  meanDelta: z.number(),
  stddevDelta: z.number().nonnegative(),
  ci95Lower: z.number().optional(),
  ci95Upper: z.number().optional(),
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
  byPurpose: z.record(
    z.string(),
    z.object({
      harness: StatSummarySchema,
      baseline: StatSummarySchema,
      delta: PairedTestResultSchema,
      n: z.number().int().positive(),
    }),
  ),
  byReleaseGate: z.record(
    z.string(),
    z.object({
      harness: StatSummarySchema,
      baseline: StatSummarySchema,
      delta: PairedTestResultSchema,
      n: z.number().int().positive(),
    }),
  ),
  bySuite: z.record(
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
  harness: number | null;
  baseline: number | null;
  delta: number | null;
}>;

export type CategoryRow = Readonly<{
  category: string;
  n: number;
  harness: number | null;
  baseline: number | null;
  delta: number | null;
}>;

export type MetadataRow = Readonly<{
  label: string;
  n: number;
  harness: number | null;
  baseline: number | null;
  delta: number | null;
}>;

export type TaskRow = Readonly<{
  taskId: string;
  category: string;
  purpose: EvalPurpose;
  releaseGate: EvalReleaseGate;
  harnessPass: boolean;
  baselinePass: boolean | null;
  stepFailCount: number;
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
  byPurpose: ReadonlyArray<MetadataRow>;
  byReleaseGate: ReadonlyArray<MetadataRow>;
  bySuite: ReadonlyArray<MetadataRow>;
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

/**
 * Every document associated with a task, regardless of delivery path.
 * Used by baseline / judge / calibration code that must see the full
 * universe of source material.
 */
export function allTaskDocuments(task: EvalTask): SourceDocument[] {
  return [...task.sources, ...(task.inputArtifacts ?? [])];
}
