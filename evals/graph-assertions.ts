/**
 * Graph assertions — structural predicates on the RunLineage.
 *
 * Each eval task can declare assertions about what MUST or MUST NOT appear
 * in the execution graph. These are cheap, deterministic, and test the
 * system prompt's effect on agent behavior (dispatch, HITL, ordering)
 * without needing an LLM judge.
 *
 * If an assertion can't be expressed against the graph, the graph model
 * is incomplete — so these assertions also serve as a completeness test
 * for the graph schema itself.
 */

import type { RunLineage } from "@nicator/core";
import {
  OperationTypeSchema,
  RunStatusSchema,
  TaskRoleSchema,
  TaskStatusSchema,
  assertNever,
  taskHasOperationType,
} from "@nicator/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Task matcher — selects tasks in the graph by field predicates
// ---------------------------------------------------------------------------

export const TaskMatcherSchema = z.object({
  /** Match tasks by role (root, tool, hitl, subagent). */
  role: TaskRoleSchema.optional(),
  /** Match delegated tasks by subagent name. */
  subagentName: z.string().optional(),
  /** Match tasks by status. */
  status: TaskStatusSchema.optional(),
  /** Match tasks that contain an operation of this type. */
  operationType: OperationTypeSchema.optional(),
});
export type TaskMatcher = z.infer<typeof TaskMatcherSchema>;

// ---------------------------------------------------------------------------
// Assertion schemas
// ---------------------------------------------------------------------------

const BaseAssertion = z.object({
  description: z.string(),
});

/** A task matching these criteria must exist in the graph. */
const TaskExistsSchema = BaseAssertion.extend({
  type: z.literal("task_exists"),
  match: TaskMatcherSchema,
});

/** No task matching these criteria should exist in the graph. */
const TaskAbsentSchema = BaseAssertion.extend({
  type: z.literal("task_absent"),
  match: TaskMatcherSchema,
});

/** A task matching `first` must have a lower sequenceNumber than one matching `then`. */
const TaskOrderSchema = BaseAssertion.extend({
  type: z.literal("task_order"),
  first: TaskMatcherSchema,
  then: TaskMatcherSchema,
});

/** The number of tasks matching these criteria must be within [min, max]. */
const TaskCountSchema = BaseAssertion.extend({
  type: z.literal("task_count"),
  match: TaskMatcherSchema,
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
});

/** The run must have this status. */
const RunStatusAssertionSchema = BaseAssertion.extend({
  type: z.literal("run_status"),
  status: RunStatusSchema,
});

/** An artifact produced by a task matching `task` must have content matching `pattern`. */
const ArtifactContentSchema = BaseAssertion.extend({
  type: z.literal("artifact_content"),
  task: TaskMatcherSchema,
  /** Regex pattern tested against artifact content (case-insensitive). */
  pattern: z.string(),
});

/** A task matching `consumer` must consume an artifact produced by a task matching `producer`. */
const ConsumesSchema = BaseAssertion.extend({
  type: z.literal("consumes"),
  consumer: TaskMatcherSchema,
  producer: TaskMatcherSchema,
});

/** A task matching `consumer` must NOT consume any artifact produced by a task matching `producer`. */
const ConsumesAbsentSchema = BaseAssertion.extend({
  type: z.literal("consumes_absent"),
  consumer: TaskMatcherSchema,
  producer: TaskMatcherSchema,
});

/** Total operations across tasks matching `task` must be within [min, max]. */
const OperationCountSchema = BaseAssertion.extend({
  type: z.literal("operation_count"),
  task: TaskMatcherSchema,
  /** Only count operations of this type (omit for all). */
  operationType: OperationTypeSchema.optional(),
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
});

/** The number of compaction records on the run must be within [min, max]. */
const CompactionCountSchema = BaseAssertion.extend({
  type: z.literal("compaction_count"),
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
});

/** The failed run's error message must match this pattern. */
const RunErrorSchema = BaseAssertion.extend({
  type: z.literal("run_error"),
  /** Regex pattern tested against run.error (case-insensitive). */
  pattern: z.string(),
});

/** A subagent task matching `match` must have an `invokes` edge to a Skill node. */
const SkillInvokedSchema = BaseAssertion.extend({
  type: z.literal("skill_invoked"),
  match: TaskMatcherSchema,
  /** If provided, the invoked skill's name must match. */
  skillName: z.string().optional(),
  /** If provided, the invoked skill's version must match. */
  skillVersion: z.string().optional(),
});

/** The final run output must match or include an artifact produced by a task. */
const RunOutputMatchesArtifactSchema = BaseAssertion.extend({
  type: z.literal("run_output_matches_artifact"),
  task: TaskMatcherSchema,
  mode: z.enum(["exact", "contains"]).default("contains"),
});

export const GraphAssertionSchema = z.discriminatedUnion("type", [
  TaskExistsSchema,
  TaskAbsentSchema,
  TaskOrderSchema,
  TaskCountSchema,
  RunStatusAssertionSchema,
  ArtifactContentSchema,
  ConsumesSchema,
  ConsumesAbsentSchema,
  OperationCountSchema,
  CompactionCountSchema,
  RunErrorSchema,
  SkillInvokedSchema,
  RunOutputMatchesArtifactSchema,
]);
export type GraphAssertion = z.infer<typeof GraphAssertionSchema>;

// ---------------------------------------------------------------------------
// Assertion result
// ---------------------------------------------------------------------------

export type AssertionResult = Readonly<{
  assertion: GraphAssertion;
  passed: boolean;
  detail: string;
}>;

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

type TaskEntry = RunLineage["tasks"][number];

function matchesTask(matcher: TaskMatcher, entry: TaskEntry): boolean {
  if (matcher.role !== undefined && entry.task.role !== matcher.role) {
    return false;
  }
  if (
    matcher.subagentName !== undefined &&
    entry.task.subagentName !== matcher.subagentName
  ) {
    return false;
  }
  if (matcher.status !== undefined && entry.task.status !== matcher.status) {
    return false;
  }
  if (
    matcher.operationType !== undefined &&
    !taskHasOperationType(entry, matcher.operationType)
  ) {
    return false;
  }
  return true;
}

function findTasks(lineage: RunLineage, matcher: TaskMatcher): TaskEntry[] {
  return lineage.tasks.filter((entry) => matchesTask(matcher, entry));
}

function describeMatch(matcher: TaskMatcher): string {
  const parts: string[] = [];
  if (matcher.role !== undefined) parts.push(`role="${matcher.role}"`);
  if (matcher.subagentName !== undefined) parts.push(`subagentName="${matcher.subagentName}"`);
  if (matcher.status !== undefined) parts.push(`status="${matcher.status}"`);
  if (matcher.operationType !== undefined) parts.push(`operationType="${matcher.operationType}"`);
  return parts.length > 0 ? parts.join(", ") : "(any task)";
}

// ---------------------------------------------------------------------------
// Per-assertion evaluators
// ---------------------------------------------------------------------------

function evalTaskExists(assertion: z.infer<typeof TaskExistsSchema>, lineage: RunLineage): AssertionResult {
  const matches = findTasks(lineage, assertion.match);
  return {
    assertion,
    passed: matches.length > 0,
    detail:
      matches.length > 0
        ? `Found ${matches.length} task(s) matching ${describeMatch(assertion.match)}`
        : `No task found matching ${describeMatch(assertion.match)}`,
  };
}

function evalTaskAbsent(assertion: z.infer<typeof TaskAbsentSchema>, lineage: RunLineage): AssertionResult {
  const matches = findTasks(lineage, assertion.match);
  return {
    assertion,
    passed: matches.length === 0,
    detail:
      matches.length === 0
        ? `No task found matching ${describeMatch(assertion.match)} (as expected)`
        : `Found ${matches.length} unexpected task(s) matching ${describeMatch(assertion.match)}`,
  };
}

function evalTaskOrder(assertion: z.infer<typeof TaskOrderSchema>, lineage: RunLineage): AssertionResult {
  const firstTasks = findTasks(lineage, assertion.first);
  const thenTasks = findTasks(lineage, assertion.then);

  if (firstTasks.length === 0) {
    return {
      assertion,
      passed: false,
      detail: `No task found matching 'first' (${describeMatch(assertion.first)})`,
    };
  }
  if (thenTasks.length === 0) {
    return {
      assertion,
      passed: false,
      detail: `No task found matching 'then' (${describeMatch(assertion.then)})`,
    };
  }

  // Earliest 'first' must precede earliest 'then'
  const earliestFirst = Math.min(...firstTasks.map((t) => t.task.sequenceNumber));
  const earliestThen = Math.min(...thenTasks.map((t) => t.task.sequenceNumber));
  const passed = earliestFirst < earliestThen;

  return {
    assertion,
    passed,
    detail: passed
      ? `Task ${describeMatch(assertion.first)} (seq ${earliestFirst}) preceded ${describeMatch(assertion.then)} (seq ${earliestThen})`
      : `Task ${describeMatch(assertion.first)} (seq ${earliestFirst}) did NOT precede ${describeMatch(assertion.then)} (seq ${earliestThen})`,
  };
}

function checkRange(
  count: number,
  min: number | undefined,
  max: number | undefined,
): { passed: boolean; rangeStr: string } {
  const passed =
    (min === undefined || count >= min) &&
    (max === undefined || count <= max);
  const rangeStr =
    min !== undefined && max !== undefined
      ? `[${min}, ${max}]`
      : min !== undefined
        ? `>= ${min}`
        : `<= ${max}`;
  return { passed, rangeStr };
}

function evalTaskCount(assertion: z.infer<typeof TaskCountSchema>, lineage: RunLineage): AssertionResult {
  const matches = findTasks(lineage, assertion.match);
  const count = matches.length;
  const { passed, rangeStr } = checkRange(count, assertion.min, assertion.max);

  return {
    assertion,
    passed,
    detail: `Found ${count} task(s) matching ${describeMatch(assertion.match)}; expected ${rangeStr}`,
  };
}

function evalRunStatus(assertion: z.infer<typeof RunStatusAssertionSchema>, lineage: RunLineage): AssertionResult {
  const passed = lineage.run.status === assertion.status;
  return {
    assertion,
    passed,
    detail: passed
      ? `Run status is "${assertion.status}" (as expected)`
      : `Run status is "${lineage.run.status}", expected "${assertion.status}"`,
  };
}

function evalArtifactContent(
  assertion: z.infer<typeof ArtifactContentSchema>,
  lineage: RunLineage,
): AssertionResult {
  const tasks = findTasks(lineage, assertion.task);
  if (tasks.length === 0) {
    return {
      assertion,
      passed: false,
      detail: `No task found matching ${describeMatch(assertion.task)}`,
    };
  }

  const regex = new RegExp(assertion.pattern, "i");
  for (const task of tasks) {
    for (const op of task.operations) {
      for (const artifact of op.artifacts) {
        if (regex.test(artifact.content)) {
          return {
            assertion,
            passed: true,
            detail: `Artifact "${artifact.name}" in task ${describeMatch(assertion.task)} matches /${assertion.pattern}/i`,
          };
        }
      }
    }
  }

  return {
    assertion,
    passed: false,
    detail: `No artifact in task(s) matching ${describeMatch(assertion.task)} contains /${assertion.pattern}/i`,
  };
}

/** Check whether any consumer task has a consumes edge to a producer's artifact. */
function hasConsumptionLink(
  lineage: RunLineage,
  consumer: TaskMatcher,
  producer: TaskMatcher,
): { consumers: TaskEntry[]; producers: TaskEntry[]; linked: boolean } {
  const consumers = findTasks(lineage, consumer);
  const producers = findTasks(lineage, producer);
  if (consumers.length === 0 || producers.length === 0) {
    return { consumers, producers, linked: false };
  }

  const producerArtifactIds = new Set<string>();
  for (const p of producers) {
    for (const op of p.operations) {
      for (const artifact of op.artifacts) {
        producerArtifactIds.add(artifact.id);
      }
    }
  }

  const linked = consumers.some((c) =>
    c.consumedArtifactIds.some((id) => producerArtifactIds.has(id)),
  );
  return { consumers, producers, linked };
}

function evalConsumes(assertion: z.infer<typeof ConsumesSchema>, lineage: RunLineage): AssertionResult {
  const { consumers, producers, linked } = hasConsumptionLink(lineage, assertion.consumer, assertion.producer);

  if (consumers.length === 0) {
    return {
      assertion,
      passed: false,
      detail: `No consumer task found matching ${describeMatch(assertion.consumer)}`,
    };
  }
  if (producers.length === 0) {
    return {
      assertion,
      passed: false,
      detail: `No producer task found matching ${describeMatch(assertion.producer)}`,
    };
  }

  return {
    assertion,
    passed: linked,
    detail: linked
      ? `Task ${describeMatch(assertion.consumer)} consumes artifact from ${describeMatch(assertion.producer)}`
      : `No consumes edge found from ${describeMatch(assertion.consumer)} to artifacts of ${describeMatch(assertion.producer)}`,
  };
}

function evalConsumesAbsent(assertion: z.infer<typeof ConsumesAbsentSchema>, lineage: RunLineage): AssertionResult {
  const { consumers, producers, linked } = hasConsumptionLink(lineage, assertion.consumer, assertion.producer);

  // Vacuously true — if either side doesn't exist, no consumption is possible
  if (consumers.length === 0) {
    return {
      assertion,
      passed: true,
      detail: `No consumer task found matching ${describeMatch(assertion.consumer)} — no consumption possible`,
    };
  }
  if (producers.length === 0) {
    return {
      assertion,
      passed: true,
      detail: `No producer task found matching ${describeMatch(assertion.producer)} — no consumption possible`,
    };
  }

  return {
    assertion,
    passed: !linked,
    detail: linked
      ? `Task ${describeMatch(assertion.consumer)} consumes artifact from ${describeMatch(assertion.producer)} (scoped visibility violation)`
      : `No consumes edge from ${describeMatch(assertion.consumer)} to artifacts of ${describeMatch(assertion.producer)} (as expected)`,
  };
}

function evalOperationCount(
  assertion: z.infer<typeof OperationCountSchema>,
  lineage: RunLineage,
): AssertionResult {
  const tasks = findTasks(lineage, assertion.task);
  let count = 0;
  for (const task of tasks) {
    for (const op of task.operations) {
      if (assertion.operationType === undefined || op.operation.type === assertion.operationType) {
        count++;
      }
    }
  }

  const { passed, rangeStr } = checkRange(count, assertion.min, assertion.max);
  const typeStr = assertion.operationType ? ` of type "${assertion.operationType}"` : "";
  return {
    assertion,
    passed,
    detail: `Found ${count} operation(s)${typeStr} in task(s) matching ${describeMatch(assertion.task)}; expected ${rangeStr}`,
  };
}

function evalCompactionCount(
  assertion: z.infer<typeof CompactionCountSchema>,
  lineage: RunLineage,
): AssertionResult {
  const count = lineage.compactions.length;
  const { passed, rangeStr } = checkRange(count, assertion.min, assertion.max);
  return {
    assertion,
    passed,
    detail: `Found ${count} compaction(s); expected ${rangeStr}`,
  };
}

function evalRunError(
  assertion: z.infer<typeof RunErrorSchema>,
  lineage: RunLineage,
): AssertionResult {
  if (lineage.run.status !== "failed") {
    return {
      assertion,
      passed: false,
      detail: `Run status is "${lineage.run.status}", not "failed" — no error to match`,
    };
  }

  const regex = new RegExp(assertion.pattern, "i");
  const passed = regex.test(lineage.run.error);
  return {
    assertion,
    passed,
    detail: passed
      ? `Run error matches /${assertion.pattern}/i`
      : `Run error "${lineage.run.error}" does not match /${assertion.pattern}/i`,
  };
}

function evalSkillInvoked(
  assertion: z.infer<typeof SkillInvokedSchema>,
  lineage: RunLineage,
): AssertionResult {
  const tasks = findTasks(lineage, assertion.match);
  if (tasks.length === 0) {
    return {
      assertion,
      passed: false,
      detail: `No task found matching ${describeMatch(assertion.match)}`,
    };
  }

  for (const entry of tasks) {
    if (!entry.skill) {
      return {
        assertion,
        passed: false,
        detail: `Task ${describeMatch(assertion.match)} has no invokes edge to a Skill node`,
      };
    }
    if (assertion.skillName !== undefined && entry.skill.name !== assertion.skillName) {
      return {
        assertion,
        passed: false,
        detail: `Task ${describeMatch(assertion.match)} invokes skill "${entry.skill.name}", expected "${assertion.skillName}"`,
      };
    }
    if (assertion.skillVersion !== undefined && entry.skill.version !== assertion.skillVersion) {
      return {
        assertion,
        passed: false,
        detail: `Task ${describeMatch(assertion.match)} invokes skill version "${entry.skill.version}", expected "${assertion.skillVersion}"`,
      };
    }
  }

  const skillDesc = tasks[0]!.skill!;
  return {
    assertion,
    passed: true,
    detail: `${tasks.length} task(s) matching ${describeMatch(assertion.match)} invoke skill "${skillDesc.name}@${skillDesc.version}"`,
  };
}

function normalizeForComparison(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function evalRunOutputMatchesArtifact(
  assertion: z.infer<typeof RunOutputMatchesArtifactSchema>,
  lineage: RunLineage,
): AssertionResult {
  if (lineage.run.status !== "completed") {
    return {
      assertion,
      passed: false,
      detail: `Run status is "${lineage.run.status}", not "completed"`,
    };
  }

  const tasks = findTasks(lineage, assertion.task);
  if (tasks.length === 0) {
    return {
      assertion,
      passed: false,
      detail: `No task found matching ${describeMatch(assertion.task)}`,
    };
  }

  const runOutput = normalizeForComparison(lineage.run.output);
  for (const task of tasks) {
    for (const op of task.operations) {
      for (const artifact of op.artifacts) {
        const artifactContent = normalizeForComparison(artifact.content);
        const passed =
          assertion.mode === "exact" ?
            runOutput === artifactContent
          : runOutput.includes(artifactContent);
        if (passed) {
          return {
            assertion,
            passed: true,
            detail:
              assertion.mode === "exact" ?
                `Run output matches artifact "${artifact.name}" from ${describeMatch(assertion.task)}`
              : `Run output includes artifact "${artifact.name}" from ${describeMatch(assertion.task)}`,
          };
        }
      }
    }
  }

  return {
    assertion,
    passed: false,
    detail:
      assertion.mode === "exact" ?
        `Run output does not exactly match any artifact from ${describeMatch(assertion.task)}`
      : `Run output does not include any artifact content from ${describeMatch(assertion.task)}`,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function evaluateAssertions(
  assertions: ReadonlyArray<GraphAssertion>,
  lineage: RunLineage,
): AssertionResult[] {
  return assertions.map((assertion) => {
    switch (assertion.type) {
      case "task_exists":
        return evalTaskExists(assertion, lineage);
      case "task_absent":
        return evalTaskAbsent(assertion, lineage);
      case "task_order":
        return evalTaskOrder(assertion, lineage);
      case "task_count":
        return evalTaskCount(assertion, lineage);
      case "run_status":
        return evalRunStatus(assertion, lineage);
      case "artifact_content":
        return evalArtifactContent(assertion, lineage);
      case "consumes":
        return evalConsumes(assertion, lineage);
      case "consumes_absent":
        return evalConsumesAbsent(assertion, lineage);
      case "operation_count":
        return evalOperationCount(assertion, lineage);
      case "compaction_count":
        return evalCompactionCount(assertion, lineage);
      case "run_error":
        return evalRunError(assertion, lineage);
      case "skill_invoked":
        return evalSkillInvoked(assertion, lineage);
      case "run_output_matches_artifact":
        return evalRunOutputMatchesArtifact(assertion, lineage);
      default:
        assertNever(assertion);
    }
  });
}
