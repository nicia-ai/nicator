import {
  ANSWER_FROM_ARTIFACT_TOOL_NAME,
  buildArtifact,
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
import { resolveArtifact } from "./read-artifact.js";
import type { DispatchOptions, DispatchResult } from "./types.js";

export const LOOKUP_ARTIFACTS_TOOL_NAME = "lookup_artifacts";
export const WRITE_ARTIFACT_TOOL_NAME = "write_artifact";

const ArtifactQuerySchemaShape = {
  name_contains: z.string().trim().min(1).optional(),
  type: z
    .enum([
      "text",
      "json",
      "file_reference",
      "hitl_decision",
      "skill_prompt",
      "skill_asset",
      "input_document",
    ])
    .optional(),
  produced_by_subagent: z.string().trim().min(1).optional(),
  task_role: z.enum(["root", "tool", "hitl", "subagent"]).optional(),
  include_input_artifacts: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
} as const;

export const LOOKUP_ARTIFACTS_TOOL: Tool = {
  name: LOOKUP_ARTIFACTS_TOOL_NAME,
  description:
    "List artifacts in the current run by metadata filters. Returns exact " +
    "artifact IDs plus producer metadata so you can recover IDs after " +
    "context compression instead of copying UUIDs from memory.",
  input_schema: {
    type: "object",
    properties: {
      name_contains: {
        type: "string",
        description: "Case-insensitive substring match on artifact name.",
      },
      type: {
        type: "string",
        enum: [
          "text",
          "json",
          "file_reference",
          "hitl_decision",
          "skill_prompt",
          "skill_asset",
          "input_document",
        ],
        description: "Optional artifact type filter.",
      },
      produced_by_subagent: {
        type: "string",
        description: "Filter to artifacts produced by a named subagent.",
      },
      task_role: {
        type: "string",
        enum: ["root", "tool", "hitl", "subagent"],
        description: "Filter to artifacts produced by tasks of a given role.",
      },
      include_input_artifacts: {
        type: "boolean",
        description:
          "Whether to include seeded input artifacts in the results. Defaults to true.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum number of artifacts to return. Defaults to 20.",
      },
    },
    additionalProperties: false,
  },
};

export const WRITE_ARTIFACT_TOOL: Tool = {
  name: WRITE_ARTIFACT_TOOL_NAME,
  description:
    "Create a first-class artifact directly from text or JSON content. Use " +
    "this to checkpoint registries, plans, or intermediate structured state " +
    "without relying on conversational memory or the workspace.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Artifact name to store in the run graph.",
      },
      content: {
        type: "string",
        description: "Full artifact content to persist.",
      },
      type: {
        type: "string",
        enum: ["text", "json"],
        description: "Artifact type. Defaults to text.",
      },
      mime_type: {
        type: "string",
        description: "Optional MIME type override.",
      },
    },
    required: ["name", "content"],
    additionalProperties: false,
  },
};

export const ANSWER_FROM_ARTIFACT_TOOL: Tool = {
  name: ANSWER_FROM_ARTIFACT_TOOL_NAME,
  description:
    "Complete the run using the exact content of an artifact as the final " +
    "answer. Use this when a downstream stage already produced the final " +
    "output and you should not reconstruct or paraphrase it from memory.",
  input_schema: {
    type: "object",
    properties: {
      artifact_id: {
        type: "string",
        description:
          "Artifact ID whose full content should become the final answer.",
      },
      artifact_query: {
        type: "object",
        properties: {
          name_contains: {
            type: "string",
            description: "Case-insensitive substring match on artifact name.",
          },
          type: {
            type: "string",
            enum: [
              "text",
              "json",
              "file_reference",
              "hitl_decision",
              "skill_prompt",
              "skill_asset",
              "input_document",
            ],
            description: "Optional artifact type filter.",
          },
          produced_by_subagent: {
            type: "string",
            description: "Filter to artifacts produced by a named subagent.",
          },
          task_role: {
            type: "string",
            enum: ["root", "tool", "hitl", "subagent"],
            description:
              "Filter to artifacts produced by tasks of a given role.",
          },
          include_input_artifacts: {
            type: "boolean",
            description:
              "Whether to include seeded input artifacts in the results. Defaults to true.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description:
              "Maximum number of artifacts to return. Defaults to 20.",
          },
        },
        additionalProperties: false,
        description:
          "Resolve the final answer artifact by graph-backed metadata instead of copying a UUID from memory.",
      },
    },
    description:
      "Provide exactly one of artifact_id or artifact_query. artifact_query must resolve to exactly one artifact.",
    additionalProperties: false,
  },
};

export const ArtifactQueryInputSchema = z.object(ArtifactQuerySchemaShape);

const LookupArtifactsInputSchema = ArtifactQueryInputSchema;

const WriteArtifactInputSchema = z.object({
  name: z.string().trim().min(1),
  content: z.string(),
  type: z.enum(["text", "json"]).default("text"),
  mime_type: z.string().trim().min(1).optional(),
});

const AnswerFromArtifactInputSchema = z
  .object({
    artifact_id: z.string().optional(),
    artifact_query: ArtifactQueryInputSchema.optional(),
  })
  .refine(
    (value) =>
      (value.artifact_id === undefined ? 0 : 1) +
        (value.artifact_query === undefined ? 0 : 1) ===
      1,
    "Provide exactly one of artifact_id or artifact_query.",
  );

type FinalArtifactContent = Readonly<{
  artifact_id: string;
  name: string;
  type: string;
  content: string;
}>;

async function rejectToolForInvalidInput(
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
      `the required fields and valid values.`,
    toolUseId,
    childTaskId,
  };
}

function preview(content: string): string {
  const normalized = content.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= 160 ?
      normalized
    : `${normalized.slice(0, 157)}...`;
}

export async function resolveArtifactQuery(
  options: Readonly<{
    repo: DispatchOptions["config"]["repo"];
    runId: string;
    query: z.infer<typeof ArtifactQueryInputSchema>;
  }>,
) {
  const { repo, runId, query } = options;
  return repo.artifacts.lookupForRun(runId, {
    ...(query.name_contains === undefined ?
      {}
    : { nameContains: query.name_contains }),
    ...(query.type === undefined ? {} : { type: query.type }),
    ...(query.produced_by_subagent === undefined ?
      {}
    : { producedBySubagent: query.produced_by_subagent }),
    ...(query.task_role === undefined ? {} : { taskRole: query.task_role }),
    ...(query.include_input_artifacts === undefined ?
      {}
    : { includeInputArtifacts: query.include_input_artifacts }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  });
}

export async function handleLookupArtifacts(
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
    config,
  } = options;

  const parsed = LookupArtifactsInputSchema.safeParse(toolInput);
  if (!parsed.success) {
    return rejectToolForInvalidInput(
      options,
      LOOKUP_ARTIFACTS_TOOL_NAME,
      parsed.error,
    );
  }
  const childTaskId = await spawnChildTask(
    config.repo,
    runId,
    rootTaskId,
    "tool",
    toolInput,
    taskSequenceNumber,
    LOOKUP_ARTIFACTS_TOOL_NAME,
  );
  const { succeeded, result, error } = await createOperation({
    repo: config.repo,
    runId,
    taskId: childTaskId,
    toolInput,
    operationNumber: 1,
    maxOperations: options.definition.limits.maxOperationsPerTask,
    inputTokens,
    outputTokens,
    type: "tool_call",
    execute: async () => {
      const matches = await resolveArtifactQuery({
        repo: config.repo,
        runId,
        query: parsed.data,
      });

      return {
        count: matches.length,
        artifacts: matches.map((match) => ({
          artifact_id: match.artifact.id,
          name: match.artifact.name,
          type: match.artifact.type,
          source: match.source,
          preview: preview(match.artifact.content),
          ...(match.producerTask === undefined ?
            {}
          : {
              producer_task: {
                task_id: match.producerTask.id,
                role: match.producerTask.role,
                ...(match.producerTask.subagentName === undefined ?
                  {}
                : { subagent_name: match.producerTask.subagentName }),
                sequence_number: match.producerTask.sequenceNumber,
              },
            }),
        })),
      };
    },
    artifactType: "json",
    artifactName: `${LOOKUP_ARTIFACTS_TOOL_NAME}_result`,
    artifactMimeType: JSON_MIME_TYPE,
  });

  await config.repo.tasks.update(childTaskId, {
    status: succeeded ? "completed" : "failed",
    updatedAt: now(),
  });

  return {
    succeeded,
    additionalTokens: 0,
    toolResultContent:
      succeeded ? stringifyOutput(result) : (error ?? "Artifact lookup failed"),
    toolUseId,
    childTaskId,
  };
}

export async function handleWriteArtifact(
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

  const parsed = WriteArtifactInputSchema.safeParse(toolInput);
  if (!parsed.success) {
    return rejectToolForInvalidInput(
      options,
      WRITE_ARTIFACT_TOOL_NAME,
      parsed.error,
    );
  }
  const childTaskId = await spawnChildTask(
    config.repo,
    runId,
    rootTaskId,
    "tool",
    toolInput,
    taskSequenceNumber,
    WRITE_ARTIFACT_TOOL_NAME,
  );
  const mimeType =
    parsed.data.mime_type ??
    (parsed.data.type === "json" ? "application/json" : "text/plain");
  const artifact = await buildArtifact(
    parsed.data.type,
    parsed.data.name,
    parsed.data.content,
    mimeType,
  );
  const byteLength = new TextEncoder().encode(parsed.data.content).byteLength;

  const { succeeded, result, error } = await createOperation({
    repo: config.repo,
    runId,
    taskId: childTaskId,
    toolInput,
    operationNumber: 1,
    maxOperations: options.definition.limits.maxOperationsPerTask,
    inputTokens,
    outputTokens,
    type: "tool_call",
    execute: async (operationId) => {
      if (parsed.data.type === "json") {
        JSON.parse(parsed.data.content);
      }
      await config.repo.artifacts.createAndLinkProduced(
        artifact,
        operationId,
        runId,
      );
      for (const artifactId of injectedArtifactIds) {
        await config.repo.artifacts.addConsumesEdge(childTaskId, artifactId);
      }
      return {
        artifact_id: artifact.id,
        name: artifact.name,
        type: artifact.type,
        mime_type: artifact.mimeType,
        bytes: byteLength,
      };
    },
    artifactType: "json",
    artifactName: `${WRITE_ARTIFACT_TOOL_NAME}_result`,
    artifactMimeType: JSON_MIME_TYPE,
  });

  await config.repo.tasks.update(childTaskId, {
    status: succeeded ? "completed" : "failed",
    updatedAt: now(),
  });

  return {
    succeeded,
    additionalTokens: 0,
    toolResultContent:
      succeeded ? stringifyOutput(result) : (error ?? "Artifact write failed"),
    toolUseId,
    childTaskId,
  };
}

async function resolveAnswerArtifactId(
  input: z.infer<typeof AnswerFromArtifactInputSchema>,
  repo: DispatchOptions["config"]["repo"],
  runId: string,
): Promise<string> {
  if (input.artifact_id !== undefined) return input.artifact_id;
  if (!input.artifact_query) {
    throw new Error("answer_from_artifact requires artifact_query.");
  }
  const matches = await resolveArtifactQuery({
    repo,
    runId,
    query: input.artifact_query,
  });
  if (matches.length > 1) {
    throw new Error(
      `Artifact query matched ${matches.length} artifacts; narrow the query or set limit: 1.`,
    );
  }
  const match = matches[0];
  if (!match) {
    throw new Error("Artifact query matched no artifacts.");
  }
  return match.artifact.id;
}

export async function handleAnswerFromArtifact(
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

  const parsed = AnswerFromArtifactInputSchema.safeParse(toolInput);
  if (!parsed.success) {
    return rejectToolForInvalidInput(
      options,
      ANSWER_FROM_ARTIFACT_TOOL_NAME,
      parsed.error,
    );
  }

  const childTaskId = await spawnChildTask(
    config.repo,
    runId,
    rootTaskId,
    "tool",
    toolInput,
    taskSequenceNumber,
    ANSWER_FROM_ARTIFACT_TOOL_NAME,
  );

  const { succeeded, result, error } = await createOperation({
    repo: config.repo,
    runId,
    taskId: childTaskId,
    toolInput,
    operationNumber: 1,
    maxOperations: 1,
    inputTokens,
    outputTokens,
    type: "tool_call",
    execute: async () => {
      const artifactId = await resolveAnswerArtifactId(
        parsed.data,
        config.repo,
        runId,
      );
      return resolveArtifact(
        config.repo,
        artifactId,
        runId,
        injectedArtifactIds,
      );
    },
    artifactType: "json",
    artifactName: `${ANSWER_FROM_ARTIFACT_TOOL_NAME}_result`,
    artifactMimeType: JSON_MIME_TYPE,
  });

  const resolved =
    (
      succeeded &&
      result != undefined &&
      typeof result === "object" &&
      !("error" in result)
    ) ?
      (result as FinalArtifactContent)
    : undefined;

  if (resolved) {
    await recordConsumesEdges(config.repo, childTaskId, [resolved.artifact_id]);
  }

  await config.repo.tasks.update(childTaskId, {
    status: resolved ? "completed" : "failed",
    updatedAt: now(),
  });

  return {
    succeeded: resolved !== undefined,
    additionalTokens: 0,
    toolResultContent:
      resolved ?
        `Final answer submitted from artifact "${resolved.name}" (${resolved.artifact_id}).`
      : (error ?? "Answer-from-artifact failed"),
    toolUseId,
    childTaskId,
    ...(resolved === undefined ? {} : { finalOutputText: resolved.content }),
  };
}
