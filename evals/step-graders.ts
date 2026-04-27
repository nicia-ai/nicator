/**
 * Step-level graders for harness run evaluation.
 *
 * These graders examine the RunLineage — the full graph of tasks, attempts,
 * and artifacts — rather than just the final output. They answer process
 * questions that outcome grading cannot:
 *
 * - Did the harness decompose the task into appropriate skills?
 * - Were intermediate artifacts well-formed?
 * - Did context compression preserve critical information?
 *
 * These graders produce warnings, not scores. They flag process issues for
 * human review rather than penalizing the final score. A harness that
 * produces a correct output via an unexpected process path is still correct.
 */

import { z } from "zod";
import { matchFact } from "./match-fact";

// ---------------------------------------------------------------------------
// Step grading schemas
// ---------------------------------------------------------------------------

export const StepGradeSchema = z.object({
  /** Which aspect of the run this grade covers */
  aspect: z.enum([
    "skill_decomposition",
    "artifact_quality",
    "context_compression",
    "retry_behavior",
    "hitl_appropriateness",
    "graph_assertion",
  ]),
  /** Pass, warn, or fail */
  severity: z.enum(["pass", "warn", "fail"]),
  /** Human-readable description of what was found */
  finding: z.string(),
  /** Which task/attempt this applies to (null for run-level findings) */
  taskId: z.string().optional(),
});
export type StepGrade = z.infer<typeof StepGradeSchema>;

export const StepGradingResultSchema = z.object({
  taskId: z.string(),
  grades: z.array(StepGradeSchema),
  /** Count of each severity level */
  summary: z.object({
    pass: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
  }),
});
export type StepGradingResult = z.infer<typeof StepGradingResultSchema>;

// ---------------------------------------------------------------------------
// Grader: Skill decomposition
// ---------------------------------------------------------------------------

/**
 * Check whether the harness invoked skills in the expected pattern.
 *
 * Two orthogonal assertions:
 * - `requiredSkills` must all appear — missing any is a `fail`.
 * - `forbiddenSkills` must not appear — any invocation is a `fail`.
 *
 * Skills outside both sets are neither required nor forbidden.
 */
export function gradeSkillDecomposition(
  invokedSkills: ReadonlyArray<string>,
  requiredSkills: ReadonlyArray<string>,
  forbiddenSkills: ReadonlyArray<string>,
): StepGrade {
  const missing = requiredSkills.filter((s) => !invokedSkills.includes(s));
  const violated = forbiddenSkills.filter((s) => invokedSkills.includes(s));

  if (missing.length === 0 && violated.length === 0) {
    if (requiredSkills.length === 0 && forbiddenSkills.length === 0) {
      return {
        aspect: "skill_decomposition",
        severity: "pass",
        finding: "No skill assertions defined for this task.",
      };
    }
    const parts: string[] = [];
    if (requiredSkills.length > 0) {
      parts.push(`all ${requiredSkills.length} required skill(s) invoked`);
    }
    if (forbiddenSkills.length > 0) {
      parts.push(`no forbidden skill(s) invoked`);
    }
    return {
      aspect: "skill_decomposition",
      severity: "pass",
      finding: parts.join("; "),
    };
  }

  const findings: string[] = [];
  if (missing.length > 0) {
    findings.push(`missing required skills: ${missing.join(", ")}`);
  }
  if (violated.length > 0) {
    findings.push(`forbidden skills invoked: ${violated.join(", ")}`);
  }
  findings.push(`invoked: ${invokedSkills.length > 0 ? invokedSkills.join(", ") : "(none)"}`);
  return {
    aspect: "skill_decomposition",
    severity: "fail",
    finding: findings.join("; "),
  };
}

// ---------------------------------------------------------------------------
// Grader: Context compression fidelity
// ---------------------------------------------------------------------------

/**
 * Check whether context compression dropped information that appears in
 * the reference facts. If a reference fact was present in an artifact but
 * absent from the compressed summary, the compression may have lost
 * critical information.
 */
export function gradeContextCompression(
  compressionApplied: boolean,
  compressedSummary: string | null,
  referenceFacts: ReadonlyArray<{ canonical: string; pattern?: string | undefined }>,
): StepGrade {
  if (!compressionApplied || !compressedSummary) {
    return {
      aspect: "context_compression",
      severity: "pass",
      finding: "No context compression applied.",
    };
  }

  const lostFacts = referenceFacts.filter((fact) => !matchFact(fact, compressedSummary));

  if (lostFacts.length === 0) {
    return {
      aspect: "context_compression",
      severity: "pass",
      finding: "All reference facts preserved after compression.",
    };
  }

  return {
    aspect: "context_compression",
    severity: "warn",
    finding: `${lostFacts.length} reference fact(s) not found in compressed summary. Compression may have lost critical information.`,
  };
}

// ---------------------------------------------------------------------------
// Grader: Retry behavior
// ---------------------------------------------------------------------------

/**
 * Check whether retries are productive. Multiple attempts on the same task
 * where all fail the same way suggests a configuration issue, not transient
 * failure.
 */
export function gradeRetryBehavior(
  totalOperations: number,
  successfulOperations: number,
): StepGrade {
  if (totalOperations <= 1) {
    return {
      aspect: "retry_behavior",
      severity: "pass",
      finding: "No retries needed.",
    };
  }

  if (successfulOperations === 0) {
    return {
      aspect: "retry_behavior",
      severity: "fail",
      finding: `${totalOperations} attempts, all failed. Likely a configuration or skill implementation issue, not a transient error.`,
    };
  }

  if (totalOperations > successfulOperations * 2) {
    return {
      aspect: "retry_behavior",
      severity: "warn",
      finding: `${totalOperations} attempts for ${successfulOperations} success(es). High retry rate.`,
    };
  }

  return {
    aspect: "retry_behavior",
    severity: "pass",
    finding: `${totalOperations} attempts, ${successfulOperations} succeeded. Acceptable retry rate.`,
  };
}
