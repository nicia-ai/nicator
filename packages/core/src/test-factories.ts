/**
 * Shared test fixture factories for agent harness entities.
 * Not exported from the package index — only imported by test files.
 */
import type {
  AgentDefinition,
  Artifact,
  Operation,
  Run,
  Skill,
  Task,
} from "./schema.js";
import { generateId, now } from "./utility.js";

const ts = () => now();

export function makeDefinition(
  overrides?: Partial<AgentDefinition>,
): AgentDefinition {
  return {
    id: generateId(),
    version: 1,
    name: "test-agent",
    description: "Test agent definition",
    systemPrompt: "You are a test agent.",
    subagentResultMode: "inline",
    autoFinalizeFromSubagent: undefined,
    skills: [{ name: "test-skill", version: "1.0.0" }],
    limits: {
      maxTasksPerRun: 50,
      maxOperationsPerTask: 3,
      maxTokensPerRun: 500_000,
    },
    createdAt: ts(),
    ...overrides,
  };
}

export function makeRun(
  definitionId: string,
  overrides?: Partial<Run>,
): Run & { status: "running" } {
  return {
    id: generateId(),
    agentDefinitionId: definitionId,
    agentDefinitionVersion: 1,
    status: "running",
    input: "test input",
    totalTokensUsed: 0,
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  } as Run & { status: "running" };
}

export function makeTask(
  runId: string,
  seq: number,
  overrides?: Partial<Task>,
): Task & { status: "completed" } {
  return {
    id: generateId(),
    runId,
    role: "subagent",
    subagentName: "test-skill",
    status: "completed",
    input: { query: `task-${seq}` },
    sequenceNumber: seq,
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  } as Task & { status: "completed" };
}

export function makeOperation(
  taskId: string,
  runId: string,
  number_: number,
  overrides?: Partial<Operation>,
): Operation & { status: "succeeded" } {
  const t = ts();
  return {
    id: generateId(),
    taskId,
    runId,
    type: "tool_call",
    status: "succeeded",
    operationNumber: number_,
    input: { query: "test" },
    output: { result: `output-${number_}` },
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 200,
    createdAt: t,
    completedAt: t,
    ...overrides,
  } as Operation & { status: "succeeded" };
}

export function makeArtifact(overrides?: Partial<Artifact>): Artifact {
  return {
    id: generateId(),
    type: "text",
    name: "test-artifact",
    content: "test content",
    contentHash: "placeholder-hash",
    mimeType: "text/plain",
    createdAt: ts(),
    ...overrides,
  };
}

export function makeSkill(name = "test-skill", version = "1.0.0"): Skill {
  return {
    id: generateId(),
    name,
    version,
    description: "A test skill",
    allowDirectTools: true,
    allowReadArtifact: false,
  };
}
