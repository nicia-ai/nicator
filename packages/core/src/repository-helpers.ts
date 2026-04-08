import type { NodeId } from "@nicia-ai/typegraph";

import { HarnessError } from "./errors.js";
import type {
  AgentDefinitionNode,
  ArtifactNode,
  OperationNode,
  RunNode,
  SkillNode,
  TaskNode,
} from "./graph.js";
import type {
  AgentDefinition,
  Artifact,
  Compaction,
  Operation,
  Policy,
  Run,
  Skill,
  SkillReference,
  Task,
} from "./schema.js";
import {
  AgentDefinitionSchema,
  ArtifactSchema,
  CompactionSchema,
  OperationSchema,
  RunSchema,
  SkillSchema,
  TaskSchema,
} from "./schema.js";
import { pickDefined } from "./utility.js";

// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(id: string, label: string): void {
  if (!UUID_RE.test(id)) {
    throw new HarnessError(
      `Invalid ${label}: "${id}" is not a valid UUID`,
      "validation_error",
    );
  }
}

// ---------------------------------------------------------------------------
// Branded ID casts — unavoidable interop with TypeGraph's branded NodeId<T>.
// Each function validates the UUID format before casting.
// ---------------------------------------------------------------------------

export function asRunNodeId(id: string): NodeId<typeof RunNode> {
  validateUuid(id, "RunId");
  return id as NodeId<typeof RunNode>;
}

export function asDefinitionNodeId(
  id: string,
): NodeId<typeof AgentDefinitionNode> {
  validateUuid(id, "AgentDefinitionId");
  return id as NodeId<typeof AgentDefinitionNode>;
}

export function asTaskNodeId(id: string): NodeId<typeof TaskNode> {
  validateUuid(id, "TaskId");
  return id as NodeId<typeof TaskNode>;
}

export function asOperationNodeId(id: string): NodeId<typeof OperationNode> {
  validateUuid(id, "OperationId");
  return id as NodeId<typeof OperationNode>;
}

export function asArtifactNodeId(id: string): NodeId<typeof ArtifactNode> {
  validateUuid(id, "ArtifactId");
  return id as NodeId<typeof ArtifactNode>;
}

export function asSkillNodeId(id: string): NodeId<typeof SkillNode> {
  return id as NodeId<typeof SkillNode>;
}

// ---------------------------------------------------------------------------
// Node → Entity mappers — Zod parse at the storage boundary ensures every
// value leaving the graph satisfies the domain schema.
// ---------------------------------------------------------------------------

export function toRun(
  node: unknown,
  agentDefinitionId: string,
  agentDefinitionVersion: number,
): Run {
  return RunSchema.parse({
    ...stripGraphMeta(node),
    agentDefinitionId,
    agentDefinitionVersion,
  });
}

export function toTask(
  node: unknown,
  runId: string,
  sequenceNumber: number,
  parentTaskId?: string,
): Task {
  return TaskSchema.parse({
    ...stripGraphMeta(node),
    runId,
    sequenceNumber,
    ...pickDefined({ parentTaskId }),
  });
}

export function toOperation(
  node: unknown,
  taskId: string,
  runId: string,
  operationNumber: number,
): Operation {
  return OperationSchema.parse({
    ...stripGraphMeta(node),
    taskId,
    runId,
    operationNumber,
  });
}

export function toArtifact(node: unknown): Artifact {
  return ArtifactSchema.parse(stripGraphMeta(node));
}

export function toSkill(node: unknown): Skill {
  return SkillSchema.parse(stripGraphMeta(node));
}

export function toSkillRef(row: {
  name: unknown;
  version: unknown;
  policy: unknown;
}): SkillReference {
  return {
    name: String(row.name),
    version: String(row.version),
    ...pickDefined({ policy: row.policy as Policy | undefined }),
  };
}

export function toCompaction(node: unknown, runId: string): Compaction {
  return CompactionSchema.parse({ ...stripGraphMeta(node), runId });
}

export function toAgentDefinition(
  node: unknown,
  skills: AgentDefinition["skills"] = [],
): AgentDefinition {
  return AgentDefinitionSchema.parse({ ...stripGraphMeta(node), skills });
}

/**
 * Strip TypeGraph internal properties (`kind`, `meta`) from a graph node,
 * returning a plain record suitable for Zod parsing.
 */
function stripGraphMeta(node: unknown): Record<string, unknown> {
  if (node == undefined || typeof node !== "object") {
    throw new HarnessError(
      "Expected a non-null object from store",
      "storage_error",
    );
  }
  const record = node as Record<string, unknown>;
  const { kind, meta, ...properties } = record;
  void kind;
  void meta;
  return properties;
}

// ---------------------------------------------------------------------------
// Subgraph lookup helpers — typed narrowing for indexed subgraph results
// ---------------------------------------------------------------------------

/** Minimal edge shape from TypeGraph 0.19+ indexed subgraph results. */
type SubgraphEdge = Readonly<{
  kind: string;
  fromId: unknown;
  toId: unknown;
  [key: string]: unknown;
}>;

/** Subgraph shape returned by TypeGraph 0.19+ `store.subgraph()`. */
type IndexedSubgraph = Readonly<{
  nodes: ReadonlyMap<string, { kind: string; id: unknown }>;
  adjacency: ReadonlyMap<string, ReadonlyMap<string, readonly SubgraphEdge[]>>;
  reverseAdjacency: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly SubgraphEdge[]>
  >;
}>;

/** Get a node from the subgraph's node map, narrowing by kind. */
export function getByKind<N extends { kind: string }, K extends N["kind"]>(
  map: ReadonlyMap<string, N>,
  kind: K,
  id: string,
): Extract<N, { kind: K }> | undefined {
  const n = map.get(id);
  return n?.kind === kind ? (n as Extract<N, { kind: K }>) : undefined;
}

/** Forward adjacency lookup: all edges of `kind` originating from `fromId`. */
export function edgesFrom(
  sg: IndexedSubgraph,
  kind: string,
  fromId: string,
): readonly SubgraphEdge[] {
  return sg.adjacency.get(fromId)?.get(kind) ?? [];
}

/** Reverse adjacency lookup: first edge of `kind` pointing to `toId`. */
export function reverseEdge(
  sg: IndexedSubgraph,
  kind: string,
  toId: string,
): SubgraphEdge | undefined {
  const edges = sg.reverseAdjacency.get(toId)?.get(kind);
  return edges?.[0];
}

/** Extract a numeric property from a subgraph edge (union type, needs narrowing). */
export function edgeNumber(edge: SubgraphEdge, key: string): number {
  return key in edge ? Number(edge[key]) : 0;
}

// ---------------------------------------------------------------------------
// Storage boundary wrapper — catches non-HarnessError exceptions and wraps
// them with a storage_error code so callers get consistent error types.
// ---------------------------------------------------------------------------

export async function storageOp<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError(
      `Storage operation failed: ${label}`,
      "storage_error",
      error,
    );
  }
}
