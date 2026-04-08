import {
  type AgentDefinition,
  HarnessError,
  HUMAN_APPROVAL_SKILL_NAME,
  SPAWN_SUBAGENT_WITH_SKILL_TOOL_NAME,
} from "@nicator/core";
import type { ParsedToolUse } from "@nicator/sdk";
import { z } from "zod";

import { recordConsumesEdges } from "./operations.js";
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

function resolveArtifactIds(
  explicit: ReadonlyArray<string> | undefined,
  injected: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return explicit !== undefined && explicit.length > 0 ? explicit : injected;
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

export const SpawnSubagentWithSkillInputSchema = z.object({
  skill_name: z.string(),
  task_input: z.string(),
  artifact_ids: z.array(z.string()).optional(),
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
  if (tc.toolName === SPAWN_SUBAGENT_WITH_SKILL_TOOL_NAME) {
    const parsed = SpawnSubagentWithSkillInputSchema.safeParse(tc.toolInput);
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
// Skill activation handler
// ---------------------------------------------------------------------------

export async function handleSkillActivation(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const {
    runId,
    rootTaskId,
    definition,
    toolInput,
    injectedArtifactIds,
    config,
  } = options;
  const { repo, workspace } = config;

  const { skill_name, task_input, artifact_ids } =
    SpawnSubagentWithSkillInputSchema.parse(toolInput);

  const effectiveArtifactIds = resolveArtifactIds(
    artifact_ids,
    injectedArtifactIds,
  );

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

  return dispatchSubagent(options, {
    name: skill_name,
    taskInput: task_input,
    consumesArtifactIds: effectiveArtifactIds,
    systemPrompt: prompt,
    initialMessage: buildSubagentInput(task_input, artifactReferences),
    directToolImpls: config.toolRegistry.list(),
    extraTools: [READ_ARTIFACT_TOOL],
    outputArtifactName: `${skill_name}_output`,
    skillId: skill.id,
    ...(skill.maxIterations === undefined ?
      {}
    : { maxIterations: skill.maxIterations }),
    handleSpecialToolCall: handleReadArtifact,
  });
}

// ---------------------------------------------------------------------------
// Ad-hoc subagent spawn — agent constructs its own prompt
// ---------------------------------------------------------------------------

export const SpawnSubagentInputSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  task_input: z.string(),
  artifact_ids: z.array(z.string()).optional(),
});

export async function handleSubagentSpawn(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const { toolInput, injectedArtifactIds, config } = options;

  const { name, prompt, task_input, artifact_ids } =
    SpawnSubagentInputSchema.parse(toolInput);

  const effectiveArtifactIds = resolveArtifactIds(
    artifact_ids,
    injectedArtifactIds,
  );

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

async function loadArtifactReferences(
  repo: DispatchOptions["config"]["repo"],
  artifactIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<ArtifactRef>> {
  if (artifactIds.length === 0) return [];
  const artifacts = await Promise.all(
    artifactIds.map((id) => repo.artifacts.get(id)),
  );
  return artifacts
    .filter((a): a is NonNullable<typeof a> => a != undefined)
    .map((a) => ({ id: a.id, name: a.name, type: a.type }));
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
