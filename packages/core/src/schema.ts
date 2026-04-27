import { z } from "zod";

// ---------------------------------------------------------------------------
// Policy (used in AgentDefinition.skills)
// ---------------------------------------------------------------------------

export const PolicySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  z.object({ type: z.literal("never") }),
  z.object({
    type: z.literal("require_hitl_approval"),
    approverPrompt: z.string(),
  }),
  z.object({
    type: z.literal("max_calls_per_run"),
    limit: z.number().int().positive(),
  }),
]);
export type Policy = z.infer<typeof PolicySchema>;

// ---------------------------------------------------------------------------
// Context scoring weights
// ---------------------------------------------------------------------------

export const ContextWeightsSchema = z.object({
  recency: z.number().min(0).max(1).default(0.3),
  downstream: z.number().min(0).max(1).default(0.35),
  artifactType: z.number().min(0).max(1).default(0.15),
  retry: z.number().min(0).max(1).default(0.1),
  skillType: z.number().min(0).max(1).default(0.1),
});
export type ContextWeights = Readonly<z.infer<typeof ContextWeightsSchema>>;

export const DEFAULT_CONTEXT_WEIGHTS: ContextWeights = {
  recency: 0.3,
  downstream: 0.35,
  artifactType: 0.15,
  retry: 0.1,
  skillType: 0.1,
};

// ---------------------------------------------------------------------------
// Workspace — agent-level workspace configuration
// ---------------------------------------------------------------------------

export const WorkspaceSchema = z.object({
  /** Glob patterns for files to auto-capture as artifacts on run completion. */
  outputPaths: z.array(z.string()).default([]),
  /** Files to seed into the workspace before execution. */
  initialFiles: z.record(z.string(), z.string()).default({}),
});
export type WorkspaceDefinition = Readonly<z.infer<typeof WorkspaceSchema>>;

// ---------------------------------------------------------------------------
// AgentDefinition
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Skill reference — the relationship between a definition and a skill
// ---------------------------------------------------------------------------

export const SkillReferenceSchema = z.object({
  name: z.string(),
  version: z.string(),
  policy: PolicySchema.optional(),
});
export type SkillReference = Readonly<z.infer<typeof SkillReferenceSchema>>;

export const SubagentResultModeSchema = z.enum(["inline", "artifact_only"]);
export type SubagentResultMode = z.infer<typeof SubagentResultModeSchema>;

// ---------------------------------------------------------------------------
// AgentDefinition
// ---------------------------------------------------------------------------

/** Storage schema — what lives on the graph node. Skills are edges, not properties. */
export const AgentDefinitionStorageSchema = z.object({
  id: z.guid(),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string(),
  subagentResultMode: SubagentResultModeSchema.default("inline"),
  autoFinalizeFromSubagent: z.string().min(1).optional(),
  limits: z.object({
    maxTasksPerRun: z.number().int().positive().default(50),
    maxOperationsPerTask: z.number().int().positive().default(3),
    maxTokensPerRun: z.number().int().positive().default(500_000),
    contextWeights: ContextWeightsSchema.optional(),
  }),
  /** Workspace configuration (output capture patterns, seed files). */
  workspace: WorkspaceSchema.optional(),
  createdAt: z.iso.datetime(),
});

/** Domain schema — includes skills reconstructed from `uses` edges. */
export const AgentDefinitionSchema = AgentDefinitionStorageSchema.extend({
  skills: z.array(SkillReferenceSchema).readonly(),
});
export type AgentDefinition = Readonly<z.infer<typeof AgentDefinitionSchema>>;

// ---------------------------------------------------------------------------
// Run — storage schema (flat, used by TypeGraph) and domain union
// ---------------------------------------------------------------------------

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_hitl",
  "completed",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Flat storage schema — used by graph.ts for node definition. */
export const RunStorageSchema = z.object({
  id: z.guid(),
  agentDefinitionId: z.guid(),
  agentDefinitionVersion: z.number().int().positive(),
  status: RunStatusSchema,
  input: z.string(),
  output: z.string().optional(),
  error: z.string().optional(),
  totalTokensUsed: z.number().int().nonnegative().default(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
});

const RunBaseFields = z.object({
  id: z.guid(),
  agentDefinitionId: z.guid(),
  agentDefinitionVersion: z.number().int().positive(),
  input: z.string(),
  totalTokensUsed: z.number().int().nonnegative().default(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Domain schema — discriminated union that prevents invalid state combinations. */
export const RunSchema = z.discriminatedUnion("status", [
  RunBaseFields.extend({ status: z.literal("pending") }),
  RunBaseFields.extend({ status: z.literal("running") }),
  RunBaseFields.extend({ status: z.literal("awaiting_hitl") }),
  RunBaseFields.extend({
    status: z.literal("completed"),
    output: z.string(),
    completedAt: z.iso.datetime(),
  }),
  RunBaseFields.extend({
    status: z.literal("failed"),
    error: z.string(),
    completedAt: z.iso.datetime(),
  }),
]);
export type Run = Readonly<z.infer<typeof RunSchema>>;

// ---------------------------------------------------------------------------
// Task — storage schema and domain union
// ---------------------------------------------------------------------------

export const TaskRoleSchema = z.enum(["root", "tool", "hitl", "subagent"]);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export const TaskStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_hitl",
  "completed",
  "failed",
  "skipped",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Storage schema — what lives on the graph node. Parent relationships
 *  (runId, parentTaskId) and positional data (sequenceNumber) live on edges. */
export const TaskStorageSchema = z.object({
  id: z.guid(),
  role: TaskRoleSchema,
  subagentName: z.string().optional(),
  status: TaskStatusSchema,
  input: z.unknown(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const TaskBaseFields = z.object({
  id: z.guid(),
  runId: z.guid(),
  parentTaskId: z.guid().optional(),
  role: TaskRoleSchema,
  /** Human-meaningful label for the delegated worker. */
  subagentName: z.string().optional(),
  input: z.unknown(),
  sequenceNumber: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Domain schema — all variants structurally identical, but enables exhaustive switch. */
export const TaskSchema = z.discriminatedUnion("status", [
  TaskBaseFields.extend({ status: z.literal("pending") }),
  TaskBaseFields.extend({ status: z.literal("running") }),
  TaskBaseFields.extend({ status: z.literal("awaiting_hitl") }),
  TaskBaseFields.extend({ status: z.literal("completed") }),
  TaskBaseFields.extend({ status: z.literal("failed") }),
  TaskBaseFields.extend({ status: z.literal("skipped") }),
]);
export type Task = Readonly<z.infer<typeof TaskSchema>>;

// ---------------------------------------------------------------------------
// Operation — storage schema and domain union
// ---------------------------------------------------------------------------

export const OperationStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "abandoned",
]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OperationTypeSchema = z.enum(["tool_call", "hitl_response"]);
export type OperationType = z.infer<typeof OperationTypeSchema>;

/** Storage schema — what lives on the graph node. Parent relationships
 *  (taskId, runId) and positional data (operationNumber) live on edges.
 *  The domain type includes them as computed fields. */
export const OperationStorageSchema = z.object({
  id: z.guid(),
  type: OperationTypeSchema,
  status: OperationStatusSchema,
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative().optional(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
});

const OperationBaseFields = z.object({
  id: z.guid(),
  taskId: z.guid(),
  runId: z.guid(),
  type: OperationTypeSchema,
  operationNumber: z.number().int().positive(),
  input: z.unknown(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  createdAt: z.iso.datetime(),
});

/** Domain schema — discriminated union that prevents invalid state combinations. */
export const OperationSchema = z.discriminatedUnion("status", [
  OperationBaseFields.extend({
    status: z.literal("running"),
    latencyMs: z.number().int().nonnegative().optional(),
  }),
  OperationBaseFields.extend({
    status: z.literal("succeeded"),
    output: z.unknown(),
    latencyMs: z.number().int().nonnegative().optional(),
    completedAt: z.iso.datetime(),
  }),
  OperationBaseFields.extend({
    status: z.literal("failed"),
    error: z.string(),
    latencyMs: z.number().int().nonnegative().optional(),
    completedAt: z.iso.datetime(),
  }),
  OperationBaseFields.extend({
    status: z.literal("abandoned"),
    completedAt: z.iso.datetime(),
  }),
]);
export type Operation = Readonly<z.infer<typeof OperationSchema>>;

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

const JsonSchemaObjectSchema = z.looseObject({
  type: z.literal("object"),
});

/** Graph-storable skill metadata. Prompt content is a linked Artifact. */
export const SkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string(),
  description: z.string(),
  allowDirectTools: z.boolean().default(true),
  allowReadArtifact: z.boolean().default(false),
  maxIterations: z.number().int().positive().optional(),
});
export type Skill = Readonly<z.infer<typeof SkillSchema>>;

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const ToolSchema = z.object({
  name: z.string().min(1),
  version: z.string(),
  description: z.string(),
  inputSchema: JsonSchemaObjectSchema,
  outputSchema: JsonSchemaObjectSchema,
});
export type Tool = Readonly<z.infer<typeof ToolSchema>>;

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export const ArtifactTypeSchema = z.enum([
  "text",
  "json",
  "file_reference",
  "hitl_decision",
  "skill_prompt",
  "skill_asset",
  "input_document",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactSchema = z.object({
  id: z.guid(),
  type: ArtifactTypeSchema,
  name: z.string(),
  content: z.string(),
  contentHash: z.string(),
  mimeType: z.string().default("text/plain"),
  createdAt: z.iso.datetime(),
});
export type Artifact = Readonly<z.infer<typeof ArtifactSchema>>;

// ---------------------------------------------------------------------------
// Compaction — a context compression transformation
// ---------------------------------------------------------------------------

export const CompactionStorageSchema = z.object({
  id: z.guid(),
  input: z.string(),
  summary: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
/** Domain type — includes runId reconstructed from has_compaction edge. */
export const CompactionSchema = CompactionStorageSchema.extend({
  runId: z.guid(),
});
export type Compaction = Readonly<z.infer<typeof CompactionSchema>>;

// ---------------------------------------------------------------------------
// API request schemas (trust boundary validation)
// ---------------------------------------------------------------------------

/**
 * Artifact seeded into a run at startup, before any agent work begins.
 *
 * These are the inputs the agent should be able to fetch on demand via
 * `read_artifact` — typically source documents, but any artifact type
 * is supported (code files, structured JSON, file references, etc.).
 * Defaults to `input_document` when type is omitted.
 */
export const InputArtifactSchema = z.object({
  name: z.string().min(1),
  type: ArtifactTypeSchema.default("input_document"),
  content: z.string(),
  mimeType: z.string().optional(),
});
export type InputArtifact = Readonly<z.infer<typeof InputArtifactSchema>>;

export const CreateRunBodySchema = z.object({
  agentDefinitionId: z.guid(),
  agentDefinitionVersion: z.number().int().positive().optional(),
  input: z.string().min(1),
  inputArtifacts: z.array(InputArtifactSchema).optional(),
});
export type CreateRunBody = Readonly<z.infer<typeof CreateRunBodySchema>>;

export const ResolveHitlBodySchema = z.object({
  token: z.string().min(1),
  decision: z.string(),
  approved: z.boolean(),
  runId: z.guid(),
});
export type ResolveHitlBody = Readonly<z.infer<typeof ResolveHitlBodySchema>>;

export const HitlPendingBodySchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  prompt: z.string().min(1),
  context: z.string().optional(),
});
export type HitlPendingBody = Readonly<z.infer<typeof HitlPendingBodySchema>>;

export const HitlResolveBodySchema = z.object({
  token: z.string().min(1),
  decision: z.string(),
  approved: z.boolean(),
});
export type HitlResolveBody = Readonly<z.infer<typeof HitlResolveBodySchema>>;

// ---------------------------------------------------------------------------
// Patch types — standalone, not derived from discriminated unions.
// Used by repository.updateRun/updateTask/updateOperation for partial updates.
// ---------------------------------------------------------------------------

export type RunPatch = Readonly<
  Partial<{
    status: RunStatus;
    output: string;
    error: string;
    totalTokensUsed: number;
    updatedAt: string;
    completedAt: string;
  }>
>;

export type TaskPatch = Readonly<
  Partial<{
    status: TaskStatus;
    updatedAt: string;
  }>
>;

export type OperationPatch = Readonly<
  Partial<{
    status: OperationStatus;
    output: unknown;
    error: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    completedAt: string;
  }>
>;

// ---------------------------------------------------------------------------
// All status unions (for UI exhaustiveness)
// ---------------------------------------------------------------------------

export type AllStatuses = RunStatus | TaskStatus | OperationStatus;
