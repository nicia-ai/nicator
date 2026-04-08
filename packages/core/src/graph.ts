import { defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { defineEdgeIndex, defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { z } from "zod";

import {
  AgentDefinitionStorageSchema,
  ArtifactSchema,
  CompactionStorageSchema,
  OperationStorageSchema,
  PolicySchema,
  RunStorageSchema,
  SkillSchema,
  TaskStorageSchema,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export const AgentDefinitionNode = defineNode("AgentDefinition", {
  schema: AgentDefinitionStorageSchema.omit({ id: true }),
  description: "Versioned blueprint for an agent",
});

export const RunNode = defineNode("Run", {
  schema: RunStorageSchema.omit({
    id: true,
    agentDefinitionId: true,
    agentDefinitionVersion: true,
  }),
  description: "A single execution of an agent definition",
});

export const TaskNode = defineNode("Task", {
  schema: TaskStorageSchema.omit({ id: true }),
  description: "A schedulable delegated work unit within a run",
});

export const OperationNode = defineNode("Operation", {
  schema: OperationStorageSchema.omit({ id: true }),
  description: "An atomic recorded action within a task",
});

export const ArtifactNode = defineNode("Artifact", {
  schema: ArtifactSchema.omit({ id: true }),
  description: "A named, typed content node",
});

export const SkillNode = defineNode("Skill", {
  schema: SkillSchema.omit({ id: true }),
  description: "A versioned, callable capability",
});

export const CompactionNode = defineNode("Compaction", {
  schema: CompactionStorageSchema.omit({ id: true }),
  description: "A context compression transformation within a run",
});

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

const instantiatesEdge = defineEdge("instantiates", {
  schema: z.object({ version: z.number().int().positive() }),
  description: "Which definition version a run uses",
  from: [RunNode],
  to: [AgentDefinitionNode],
});

const containsEdge = defineEdge("contains", {
  schema: z.object({ sequenceNumber: z.number().int().nonnegative() }),
  description: "Run contains tasks in emergence order",
  from: [RunNode],
  to: [TaskNode],
});

const spawnsEdge = defineEdge("spawns", {
  description:
    "Task spawns a child task (subagent/delegated-work relationship)",
  from: [TaskNode],
  to: [TaskNode],
});

const invokesEdge = defineEdge("invokes", {
  description: "Subagent task invokes a specific skill version",
  from: [TaskNode],
  to: [SkillNode],
});

const hasOperationEdge = defineEdge("has_operation", {
  schema: z.object({ operationNumber: z.number().int().positive() }),
  description: "Task has operations (1-indexed)",
  from: [TaskNode],
  to: [OperationNode],
});

const producesEdge = defineEdge("produces", {
  description: "Operation produces an artifact",
  from: [OperationNode],
  to: [ArtifactNode],
});

const consumesEdge = defineEdge("consumes", {
  description: "Task consumed an artifact as input (created at injection time)",
  from: [TaskNode],
  to: [ArtifactNode],
});

const usesEdge = defineEdge("uses", {
  schema: z.object({ policy: PolicySchema.optional() }),
  description: "AgentDefinition uses a skill (with optional policy)",
  from: [AgentDefinitionNode],
  to: [SkillNode],
});

const hasInputEdge = defineEdge("has_input", {
  description: "Run has a user-supplied input artifact",
  from: [RunNode],
  to: [ArtifactNode],
});

const hasDefinitionEdge = defineEdge("has_definition", {
  description: "Skill's prompt artifact",
  from: [SkillNode],
  to: [ArtifactNode],
});

const hasAssetEdge = defineEdge("has_asset", {
  description: "Skill's supporting file artifact",
  from: [SkillNode],
  to: [ArtifactNode],
});

const supersedesEdge = defineEdge("supersedes", {
  description:
    "Artifact version chain — newer artifact supersedes an older one",
  from: [ArtifactNode],
  to: [ArtifactNode],
});

const hasCompactionEdge = defineEdge("has_compaction", {
  description: "Run has a context compaction record",
  from: [RunNode],
  to: [CompactionNode],
});

// ---------------------------------------------------------------------------
// Indexes — properties used in whereNode filters and orderBy clauses
// ---------------------------------------------------------------------------

// Not exported individually — the inferred types reference internal TypeGraph
// symbols. Consumers access these via the nodeIndexes array.
const _runStatusIndex = defineNodeIndex(RunNode, { fields: ["status"] });
const _runCreatedAtIndex = defineNodeIndex(RunNode, { fields: ["createdAt"] });
const _taskStatusIndex = defineNodeIndex(TaskNode, { fields: ["status"] });
const _operationStatusIndex = defineNodeIndex(OperationNode, {
  fields: ["status"],
});
const _skillNameIndex = defineNodeIndex(SkillNode, { fields: ["name"] });
const _defCreatedAtIndex = defineNodeIndex(AgentDefinitionNode, {
  fields: ["createdAt"],
});
const _artifactContentHashIndex = defineNodeIndex(ArtifactNode, {
  fields: ["contentHash"],
});

// Edge indexes — directional indexes optimize traversal joins by prefixing
// the join key (from_id for "out", to_id for "in") ahead of the property key.
const _containsSeqOutIndex = defineEdgeIndex(containsEdge, {
  fields: ["sequenceNumber"],
  direction: "out",
});
const _hasOperationNumberOutIndex = defineEdgeIndex(hasOperationEdge, {
  fields: ["operationNumber"],
  direction: "out",
});

// ---------------------------------------------------------------------------
// Graph definition
// ---------------------------------------------------------------------------

export const nicatorGraph = defineGraph({
  id: "nicator",
  nodes: {
    AgentDefinition: { type: AgentDefinitionNode },
    Run: { type: RunNode, onDelete: "cascade" },
    Task: { type: TaskNode, onDelete: "cascade" },
    Operation: { type: OperationNode, onDelete: "cascade" },
    Artifact: { type: ArtifactNode, onDelete: "cascade" },
    Skill: {
      type: SkillNode,
      unique: [
        {
          name: "skill_name_version",
          fields: ["name", "version"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Compaction: { type: CompactionNode, onDelete: "cascade" },
  },
  edges: {
    instantiates: {
      type: instantiatesEdge,
      from: [RunNode],
      to: [AgentDefinitionNode],
    },
    contains: { type: containsEdge, from: [RunNode], to: [TaskNode] },
    spawns: { type: spawnsEdge, from: [TaskNode], to: [TaskNode] },
    invokes: { type: invokesEdge, from: [TaskNode], to: [SkillNode] },
    has_operation: {
      type: hasOperationEdge,
      from: [TaskNode],
      to: [OperationNode],
    },
    produces: {
      type: producesEdge,
      from: [OperationNode],
      to: [ArtifactNode],
    },
    uses: {
      type: usesEdge,
      from: [AgentDefinitionNode],
      to: [SkillNode],
    },
    consumes: { type: consumesEdge, from: [TaskNode], to: [ArtifactNode] },
    has_input: { type: hasInputEdge, from: [RunNode], to: [ArtifactNode] },
    has_definition: {
      type: hasDefinitionEdge,
      from: [SkillNode],
      to: [ArtifactNode],
    },
    has_asset: {
      type: hasAssetEdge,
      from: [SkillNode],
      to: [ArtifactNode],
    },
    supersedes: {
      type: supersedesEdge,
      from: [ArtifactNode],
      to: [ArtifactNode],
    },
    has_compaction: {
      type: hasCompactionEdge,
      from: [RunNode],
      to: [CompactionNode],
    },
  },
});
