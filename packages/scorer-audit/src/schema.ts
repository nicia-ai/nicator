/**
 * Generic scorer-audit input format.
 *
 * A scorer-audit input file describes one or more eval runs. Each run holds
 * one or more tasks; each task holds a shared list of reference facts and a
 * set of named conditions (for example "harness" vs "baseline", or any two
 * arbitrary condition names) whose output text is scored against those facts.
 *
 * The format is designed so nicator's EvalReport maps onto it losslessly
 * (see `adapters/nicator.ts`), but nothing in this package depends on
 * nicator — any eval system that can emit {facts, output text, optional
 * recorded verdicts} can produce this format.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Matcher spec — how a fact is checked deterministically
// ---------------------------------------------------------------------------

export const MatcherSpecSchema = z.discriminatedUnion("kind", [
  /** Case-insensitive substring match of the canonical string. */
  z.object({ kind: z.literal("substring") }),
  /** Case-insensitive regex test. */
  z.object({ kind: z.literal("regex"), pattern: z.string() }),
  /** Every pattern must match (case-insensitive). */
  z.object({ kind: z.literal("all-of"), patterns: z.array(z.string()).min(1) }),
]);
export type MatcherSpec = z.infer<typeof MatcherSpecSchema>;

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export const AuditFactSchema = z.object({
  id: z.string(),
  /** Human-readable claim, shown to the LLM judge. Falls back to canonical. */
  description: z.string().default(""),
  /** Canonical surface form of the fact. */
  canonical: z.string(),
  /** Deterministic matcher spec. Defaults to canonical substring. */
  matcher: MatcherSpecSchema.default({ kind: "substring" }),
  /**
   * Whether the fact should be present or absent. `absent` facts are
   * negative checks: matching them means the output asserted something
   * it should not have.
   */
  expected: z.enum(["present", "absent"]).default("present"),
  /** Weight in the factual score. Weight 0 is tracked but not scored. */
  weight: z.number().nonnegative().default(1),
});
export type AuditFact = z.infer<typeof AuditFactSchema>;

// ---------------------------------------------------------------------------
// Runs / tasks / conditions
// ---------------------------------------------------------------------------

export const ConditionOutputSchema = z.object({
  /** The agent output text to score against the task's facts. */
  text: z.string(),
  /**
   * Verdicts recorded by the original scorer, keyed by fact id. When
   * present, these are treated as the authoritative "matcher" side of
   * the rescore comparison (and the ablation sanity check reproduces
   * them under the `original` variant).
   */
  recordedVerdicts: z.record(z.string(), z.boolean()).optional(),
  /** Score recorded by the original scorer, if any. Range [0, 1]. */
  recordedScore: z.number().min(0).max(1).optional(),
});
export type ConditionOutput = z.infer<typeof ConditionOutputSchema>;

export const AuditTaskSchema = z.object({
  taskId: z.string(),
  facts: z.array(AuditFactSchema).min(1),
  /** Condition name → output. Names must match `comparison` entries. */
  conditions: z.record(z.string(), ConditionOutputSchema),
});
export type AuditTask = z.infer<typeof AuditTaskSchema>;

export const AuditRunSchema = z.object({
  runId: z.string(),
  tasks: z.array(AuditTaskSchema).min(1),
});
export type AuditRun = z.infer<typeof AuditRunSchema>;

export const AuditInputSchema = z.object({
  /**
   * The two condition names being compared. The comparative gap is
   * always reported as `comparison[0] − comparison[1]`.
   */
  comparison: z.tuple([z.string(), z.string()]),
  runs: z.array(AuditRunSchema).min(1),
});
export type AuditInput = z.infer<typeof AuditInputSchema>;

// ---------------------------------------------------------------------------
// Rescore output — shared between rescore, ablation (judge reference),
// audit-packet generation, and cross-vendor spot-checks
// ---------------------------------------------------------------------------

export const RescoreVerdictSchema = z.object({
  factId: z.string(),
  matched: z.boolean(),
  justification: z.string(),
});
export type RescoreVerdict = z.infer<typeof RescoreVerdictSchema>;

export const ConditionRescoreSchema = z.object({
  /** Weighted factual score under the deterministic matcher. */
  matcherScore: z.number(),
  /** Weighted factual score under the per-fact LLM judge. */
  judgeScore: z.number(),
  verdicts: z.array(RescoreVerdictSchema),
  /** Deterministic matcher verdicts, keyed by fact id. */
  matcherVerdicts: z.record(z.string(), z.boolean()),
});
export type ConditionRescore = z.infer<typeof ConditionRescoreSchema>;

export const TaskRescoreSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  conditions: z.record(z.string(), ConditionRescoreSchema),
});
export type TaskRescore = z.infer<typeof TaskRescoreSchema>;

export const RescoreOutputSchema = z.object({
  comparison: z.tuple([z.string(), z.string()]),
  judgeModel: z.string(),
  generatedAt: z.string(),
  entries: z.array(TaskRescoreSchema),
});
export type RescoreOutput = z.infer<typeof RescoreOutputSchema>;

// ---------------------------------------------------------------------------
// Multi-run statistics (consumed by stats.ts)
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
