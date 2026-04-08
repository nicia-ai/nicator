import type { Repository } from "@nicator/core";
import {
  isHarnessError,
  JSON_MIME_TYPE,
  now,
  stringifyOutput,
} from "@nicator/core";
import type { Tool } from "@nicator/sdk";
import { z } from "zod";

import {
  createOperation,
  recordConsumesEdges,
  spawnChildTask,
} from "./operations.js";
import type { DispatchOptions, DispatchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Tool definition (presented to the LLM)
// ---------------------------------------------------------------------------

export const READ_ARTIFACT_TOOL_NAME = "read_artifact";

export const READ_ARTIFACT_TOOL: Tool = {
  name: READ_ARTIFACT_TOOL_NAME,
  description:
    "Retrieve the full content of an artifact by its ID. Your context " +
    "includes a summary of completed task artifacts with IDs and previews. " +
    "Call this tool to read the complete content when you need it.",
  input_schema: {
    type: "object",
    properties: {
      artifact_id: {
        type: "string",
        description: "The artifact ID to retrieve.",
      },
    },
    required: ["artifact_id"],
    additionalProperties: false,
  },
};

export const ReadArtifactInputSchema = z.object({
  artifact_id: z.string(),
});

type ResolvedArtifact = Readonly<{
  artifact_id: string;
  name: string;
  type: string;
  content: string;
}>;

/**
 * Fetch and validate an artifact by ID, scoped to a run.
 * Returns the artifact data or an error object. Never throws for
 * expected failures (not found, wrong run, invalid ID).
 */
export async function resolveArtifact(
  repo: Repository,
  artifactId: string,
  runId: string,
  knownRunArtifactIds?: ReadonlyArray<string>,
): Promise<ResolvedArtifact | { error: string }> {
  try {
    const artifact = await repo.artifacts.get(artifactId);
    if (!artifact) {
      return { error: `Artifact not found: "${artifactId}"` };
    }

    // Fast path: if the artifact was surfaced by the context builder,
    // it's already verified as belonging to this run.
    const knownOwned = knownRunArtifactIds?.includes(artifactId) ?? false;
    if (!knownOwned) {
      const owned = await repo.artifacts.belongsToRun(artifactId, runId);
      if (!owned) {
        return { error: `Artifact "${artifactId}" belongs to a different run` };
      }
    }

    return {
      artifact_id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      content: artifact.content,
    };
  } catch (error: unknown) {
    if (isHarnessError(error)) throw error;
    return {
      error: `Invalid artifact_id: "${artifactId}". Use artifact IDs shown in your context (UUID format), not source document IDs.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Dispatch handler
// ---------------------------------------------------------------------------

export async function handleReadArtifact(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const {
    runId,
    rootTaskId,
    toolInput,
    toolUseId,
    taskSequenceNumber,
    inputTokens,
    outputTokens,
    injectedArtifactIds,
    config,
  } = options;
  const { repo } = config;

  const { artifact_id } = ReadArtifactInputSchema.parse(toolInput);

  const childTaskId = await spawnChildTask(
    repo,
    runId,
    rootTaskId,
    "tool",
    toolInput,
    taskSequenceNumber,
    READ_ARTIFACT_TOOL_NAME,
  );

  const { succeeded, result, error } = await createOperation({
    repo,
    runId,
    taskId: childTaskId,
    toolInput,
    operationNumber: 1,
    maxOperations: 1,
    inputTokens,
    outputTokens,
    type: "tool_call",
    execute: () =>
      resolveArtifact(repo, artifact_id, runId, injectedArtifactIds),
    artifactType: "json",
    artifactName: `read_artifact_${artifact_id}`,
    artifactMimeType: JSON_MIME_TYPE,
  });

  // Only record consumes edge if the artifact was actually read successfully.
  // resolveArtifact returns { error } for ownership failures, which the
  // operation still treats as "succeeded" (tool errors are results, not exceptions).
  const readSucceeded =
    succeeded &&
    result != undefined &&
    typeof result === "object" &&
    !("error" in result);
  if (readSucceeded) {
    await recordConsumesEdges(repo, childTaskId, [artifact_id]);
  }

  await repo.tasks.update(childTaskId, {
    status: succeeded ? "completed" : "failed",
    updatedAt: now(),
  });

  return {
    succeeded,
    additionalTokens: 0,
    toolResultContent:
      succeeded ? stringifyOutput(result) : (error ?? "Read artifact failed"),
    toolUseId,
    childTaskId,
  };
}
