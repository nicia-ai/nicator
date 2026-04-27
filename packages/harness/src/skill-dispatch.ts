import {
  AGENT_TOOL_NAME,
  type AgentDefinition,
  HarnessError,
  HUMAN_APPROVAL_SKILL_NAME,
  now,
  SKILL_TOOL_NAME,
} from "@nicator/core";
import type { ParsedToolUse } from "@nicator/sdk";
import { z } from "zod";

import {
  ArtifactQueryInputSchema,
  resolveArtifactQuery,
} from "./artifact-tools.js";
import { recordConsumesEdges, spawnChildTask } from "./operations.js";
import { enforcePolicy } from "./policy.js";
import {
  READ_ARTIFACT_TOOL,
  READ_ARTIFACT_TOOL_NAME,
  ReadArtifactInputSchema,
  resolveArtifact,
} from "./read-artifact.js";
import { loadSkillFromWorkspace } from "./skill-loader.js";
import type { SubagentToolCallContext } from "./subagent-dispatch.js";
import { dispatchSubagent } from "./subagent-dispatch.js";
import type { DispatchOptions, DispatchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Verify that every requested artifact_id exists in the graph.
 *
 * Models under multi-stage dispatch pressure will invent plausible-looking
 * UUIDs for downstream artifact_ids when they batch calls ahead of the
 * upstream artifacts actually existing. Accepting those silently creates
 * orphan child tasks with broken consumes edges. Fail loudly instead so
 * the model sees a tool error and can retry with real IDs from its context.
 */
const DISPATCH_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findMissingArtifactIds(
  repo: DispatchOptions["config"]["repo"],
  artifactIds: ReadonlyArray<string>,
): Promise<string[]> {
  if (artifactIds.length === 0) return [];
  const results = await Promise.all(
    artifactIds.map(async (id) => {
      if (!DISPATCH_UUID_RE.test(id)) return { id, exists: false };
      return { id, exists: (await repo.artifacts.get(id)) !== undefined };
    }),
  );
  return results.filter((r) => !r.exists).map((r) => r.id);
}

/**
 * Build a failed DispatchResult for a malformed tool input. The model
 * occasionally emits tool_use blocks with missing required fields; we
 * want the model to see the validation error as a tool result instead
 * of aborting the whole run.
 */
async function rejectDispatchForInvalidInput(
  options: DispatchOptions,
  toolName: string,
  error: z.ZodError,
): Promise<DispatchResult> {
  const {
    runId,
    rootTaskId,
    toolInput,
    toolUseId,
    taskSequenceNumber,
    config,
  } = options;
  const childTaskId = await spawnChildTask(
    config.repo,
    runId,
    rootTaskId,
    "tool",
    toolInput,
    taskSequenceNumber,
    toolName,
  );
  await config.repo.tasks.update(childTaskId, {
    status: "failed",
    updatedAt: now(),
  });
  const issues = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return {
    succeeded: false,
    additionalTokens: 0,
    toolResultContent:
      `Invalid ${toolName} tool input: ${issues}. Re-emit the call with ` +
      `all required fields populated.`,
    toolUseId,
    childTaskId,
  };
}

async function rejectDispatchForMissingArtifacts(
  options: DispatchOptions,
  missing: ReadonlyArray<string>,
  toolName: string,
): Promise<DispatchResult> {
  const {
    runId,
    rootTaskId,
    toolInput,
    toolUseId,
    taskSequenceNumber,
    config,
  } = options;
  const childTaskId = await spawnChildTask(
    config.repo,
    runId,
    rootTaskId,
    "tool",
    toolInput,
    taskSequenceNumber,
    toolName,
  );
  await config.repo.tasks.update(childTaskId, {
    status: "failed",
    updatedAt: now(),
  });
  const errorMessage =
    `Cannot dispatch: the following artifact_ids do not exist in the graph: ` +
    `${missing.map((id) => `"${id}"`).join(", ")}. ` +
    `Only use artifact_ids that appear in your "Completed Tasks" context. ` +
    `Do not invent UUIDs — if an upstream task has not completed yet, wait ` +
    `for it to appear in your context before referencing its output.`;
  return {
    succeeded: false,
    additionalTokens: 0,
    toolResultContent: errorMessage,
    toolUseId,
    childTaskId,
  };
}

async function rejectDispatchForEmptyArtifactQuery(
  options: DispatchOptions,
  toolName: string,
): Promise<DispatchResult> {
  const {
    runId,
    rootTaskId,
    toolInput,
    toolUseId,
    taskSequenceNumber,
    config,
  } = options;
  const childTaskId = await spawnChildTask(
    config.repo,
    runId,
    rootTaskId,
    "subagent",
    toolInput,
    taskSequenceNumber,
    toolName,
  );
  await config.repo.tasks.update(childTaskId, {
    status: "failed",
    updatedAt: now(),
  });
  return {
    succeeded: false,
    additionalTokens: 0,
    toolResultContent:
      "Artifact query matched no artifacts in the current run. Narrow the query only after the upstream stage has completed, or wait for the artifact to be created.",
    toolUseId,
    childTaskId,
  };
}

async function handleReadArtifact(
  name: string,
  innerToolInput: unknown,
  ctx: SubagentToolCallContext,
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  if (name !== READ_ARTIFACT_TOOL_NAME) return { handled: false };

  const parsed = ReadArtifactInputSchema.parse(innerToolInput);
  const result = await resolveArtifact(ctx.repo, parsed.artifact_id, ctx.runId);
  if (!("error" in result)) {
    await recordConsumesEdges(ctx.repo, ctx.childTaskId, [parsed.artifact_id]);
  }
  return { handled: true, result };
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const SkillToolInputSchema = z.object({
  skill_name: z.string(),
  task_input: z.string(),
  artifact_ids: z.array(z.string()).optional(),
  artifact_query: ArtifactQueryInputSchema.optional(),
});

/**
 * Single source of truth for predicting whether a tool call will trigger HITL.
 * Used by the run loop to partition calls into sequential (HITL) and concurrent
 * batches before dispatch. Must stay in sync with enforcePolicy — if a new
 * policy type requires HITL, add it here.
 */
export function willRequireHitl(
  tc: ParsedToolUse,
  definition: AgentDefinition,
): boolean {
  if (tc.toolName === HUMAN_APPROVAL_SKILL_NAME) return true;
  if (tc.toolName === SKILL_TOOL_NAME) {
    const parsed = SkillToolInputSchema.safeParse(tc.toolInput);
    if (parsed.success) {
      const skillRef = definition.skills.find(
        (s) => s.name === parsed.data.skill_name,
      );
      return skillRef?.policy?.type === "require_hitl_approval";
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Skill tool handler — activates a pre-registered skill
// ---------------------------------------------------------------------------

export async function handleSkillCall(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const { runId, rootTaskId, definition, toolInput, config } = options;
  const { repo, workspace } = config;

  const parsed = SkillToolInputSchema.safeParse(toolInput);
  if (!parsed.success) {
    return rejectDispatchForInvalidInput(
      options,
      SKILL_TOOL_NAME,
      parsed.error,
    );
  }
  const { skill_name, task_input, artifact_ids, artifact_query } = parsed.data;
  let effectiveArtifactIds: ReadonlyArray<string>;
  try {
    effectiveArtifactIds = await resolveDispatchArtifactIds(
      repo,
      runId,
      artifact_ids,
      artifact_query,
    );
  } catch (error) {
    if (error instanceof HarnessError && error.code === "validation_error") {
      return rejectDispatchForEmptyArtifactQuery(options, SKILL_TOOL_NAME);
    }
    throw error;
  }
  const missingArtifactIds = await findMissingArtifactIds(
    repo,
    effectiveArtifactIds,
  );
  if (missingArtifactIds.length > 0) {
    return rejectDispatchForMissingArtifacts(
      options,
      missingArtifactIds,
      SKILL_TOOL_NAME,
    );
  }

  const skillRef = definition.skills.find((s) => s.name === skill_name);
  const resolved = await repo.agents.resolveSkill(
    skill_name,
    skillRef?.version,
  );
  if (!resolved) {
    throw new HarnessError(
      `Skill "${skill_name}" not found in graph`,
      "skill_not_found",
    );
  }

  const { skill } = resolved;
  if (skillRef?.policy) {
    await enforcePolicy(
      {
        policy: skillRef.policy,
        subagentName: skill_name,
        toolInput: { task_input },
        runId,
        rootTaskId,
        maxOperationsPerTask: definition.limits.maxOperationsPerTask,
      },
      config,
    );
  }

  if (!workspace) {
    throw new HarnessError(
      "Workspace required for skill execution",
      "skill_execution_failed",
    );
  }

  const prompt = await loadSkillFromWorkspace(
    workspace,
    skill.name,
    skill.version,
  );
  const artifactReferences = await loadArtifactReferences(
    repo,
    effectiveArtifactIds,
  );
  const allowDirectToolAccess = skill.allowDirectTools;
  const allowReadArtifact = skill.allowDirectTools || skill.allowReadArtifact;

  return dispatchSubagent(options, {
    name: skill_name,
    taskInput: task_input,
    consumesArtifactIds: effectiveArtifactIds,
    systemPrompt: prompt,
    initialMessage: buildSubagentInput(task_input, artifactReferences),
    directToolImpls: allowDirectToolAccess ? config.toolRegistry.list() : [],
    ...(allowReadArtifact ? { extraTools: [READ_ARTIFACT_TOOL] } : {}),
    outputArtifactName: `${skill_name}_output`,
    skillId: skill.id,
    ...(skill.maxIterations === undefined ?
      {}
    : { maxIterations: skill.maxIterations }),
    handleSpecialToolCall: handleReadArtifact,
  });
}

// ---------------------------------------------------------------------------
// Agent tool handler — creates a custom-role agent with a user-written prompt
// ---------------------------------------------------------------------------

export const AgentToolInputSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  task_input: z.string(),
  artifact_ids: z.array(z.string()).optional(),
  artifact_query: ArtifactQueryInputSchema.optional(),
});

export async function handleAgentCall(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const { toolInput, config } = options;

  const parsed = AgentToolInputSchema.safeParse(toolInput);
  if (!parsed.success) {
    return rejectDispatchForInvalidInput(
      options,
      AGENT_TOOL_NAME,
      parsed.error,
    );
  }
  const { name, prompt, task_input, artifact_ids, artifact_query } =
    parsed.data;
  let effectiveArtifactIds: ReadonlyArray<string>;
  try {
    effectiveArtifactIds = await resolveDispatchArtifactIds(
      config.repo,
      options.runId,
      artifact_ids,
      artifact_query,
    );
  } catch (error) {
    if (error instanceof HarnessError && error.code === "validation_error") {
      return rejectDispatchForEmptyArtifactQuery(options, AGENT_TOOL_NAME);
    }
    throw error;
  }
  const missingArtifactIds = await findMissingArtifactIds(
    config.repo,
    effectiveArtifactIds,
  );
  if (missingArtifactIds.length > 0) {
    return rejectDispatchForMissingArtifacts(
      options,
      missingArtifactIds,
      AGENT_TOOL_NAME,
    );
  }

  const artifactReferences = await loadArtifactReferences(
    config.repo,
    effectiveArtifactIds,
  );

  return dispatchSubagent(options, {
    name,
    taskInput: task_input,
    consumesArtifactIds: effectiveArtifactIds,
    systemPrompt: prompt,
    initialMessage: buildSubagentInput(task_input, artifactReferences),
    directToolImpls: config.toolRegistry.list(),
    extraTools: [READ_ARTIFACT_TOOL],
    outputArtifactName: `${name}_output`,
    handleSpecialToolCall: handleReadArtifact,
  });
}

// ---------------------------------------------------------------------------
// Artifact metadata for subagent input (pull-based — content via read_artifact)
// ---------------------------------------------------------------------------

type ArtifactRef = Readonly<{ id: string; name: string; type: string }>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadArtifactReferences(
  repo: DispatchOptions["config"]["repo"],
  artifactIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<ArtifactRef>> {
  if (artifactIds.length === 0) return [];
  const validIds = artifactIds.filter((id) => UUID_RE.test(id));
  const artifacts = await Promise.all(
    validIds.map((id) => repo.artifacts.get(id)),
  );
  return artifacts
    .filter((a): a is NonNullable<typeof a> => a != undefined)
    .map((a) => ({ id: a.id, name: a.name, type: a.type }));
}

async function resolveDispatchArtifactIds(
  repo: DispatchOptions["config"]["repo"],
  runId: string,
  explicitArtifactIds: ReadonlyArray<string> | undefined,
  artifactQuery: z.infer<typeof ArtifactQueryInputSchema> | undefined,
): Promise<ReadonlyArray<string>> {
  const resolvedIds = new Set<string>(explicitArtifactIds);
  if (artifactQuery) {
    const matches = await resolveArtifactQuery({
      repo,
      runId,
      query: artifactQuery,
    });
    if (matches.length === 0) {
      throw new HarnessError(
        "Artifact query matched no artifacts in the current run.",
        "validation_error",
      );
    }
    for (const match of matches) {
      resolvedIds.add(match.artifact.id);
    }
  }
  return [...resolvedIds];
}

function buildSubagentInput(
  taskInput: string,
  artifactReferences: ReadonlyArray<ArtifactRef>,
): string {
  if (artifactReferences.length === 0) return taskInput;
  const lines = artifactReferences.map(
    (a) => `- artifact_id: ${a.id} | ${a.name} (${a.type})`,
  );
  return (
    `## Available artifacts\n` +
    `The following artifacts from prior tasks are available. Call read_artifact\n` +
    `to retrieve any you need.\n` +
    `${lines.join("\n")}\n\n` +
    `## Task\n\n${taskInput}`
  );
}
