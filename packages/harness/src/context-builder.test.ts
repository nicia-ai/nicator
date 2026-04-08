import type { ContextWeights, RunLineage } from "@nicator/core";
import {
  type AgentDefinition,
  type Artifact,
  generateId,
  now,
  type Operation,
  type Run,
  type Task,
} from "@nicator/core";
import {
  makeDefinition,
  makeRun,
  makeSkill,
} from "@nicator/core/test-factories";
import type { Anthropic } from "@nicator/sdk";
import { describe, expect, it, vi } from "vitest";

// Grab the mocked countTokens so we can control it per-test
const { countTokens: mockedCountTokens } = vi.hoisted(() => ({
  countTokens: vi.fn().mockResolvedValue(0),
}));

import {
  assignTiers,
  buildContext,
  compressOlderTurns,
  scoreTasks,
} from "./context-builder.js";
import type { ConversationState, HarnessConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Mock SDK for compression tests
// ---------------------------------------------------------------------------

vi.mock("@nicator/sdk", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock requires dynamic import
  const original = await importOriginal<typeof import("@nicator/sdk")>();
  return {
    ...original,
    complete: vi.fn().mockResolvedValue({
      text: "compressed summary",
      inputTokens: 100,
      outputTokens: 50,
      response: { content: [] },
    }),
    countTokens: mockedCountTokens,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = () => now();

const SKILL = makeSkill();

/**
 * Build a RunLineage with `count` completed tasks, each with one succeeded
 * attempt and one artifact. Tasks are numbered 1..count.
 */
function buildLineage(
  run: Run,
  definition: AgentDefinition,
  count: number,
): {
  lineage: RunLineage;
  artifactsBySeq: Map<number, Artifact>;
} {
  const artifactsBySeq = new Map<number, Artifact>();
  const tasks: RunLineage["tasks"][number][] = [];

  for (let seq = 1; seq <= count; seq++) {
    const taskId = generateId();
    const operationId = generateId();
    const artifactId = generateId();
    const t = ts();

    const task: Task = {
      id: taskId,
      runId: run.id,
      role: "subagent",
      subagentName: "test-skill",
      status: "completed",
      input: { query: `task-${seq}` },
      sequenceNumber: seq,
      createdAt: t,
      updatedAt: t,
    };

    const operation: Operation = {
      id: operationId,
      taskId,
      runId: run.id,
      type: "tool_call",
      status: "succeeded",
      operationNumber: 1,
      input: { query: `task-${seq}` },
      output: { result: `output-${seq}` },
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 200,
      createdAt: t,
      completedAt: t,
    };

    const artifact: Artifact = {
      id: artifactId,
      type: "text",
      name: `artifact-${seq}`,
      content: `content for task ${seq}`,
      contentHash: "test-hash",
      mimeType: "text/plain",
      createdAt: t,
    };

    artifactsBySeq.set(seq, artifact);

    tasks.push({
      task,
      skill: SKILL,
      consumedArtifactIds: [],
      operations: [{ operation, artifacts: [artifact] }],
    });
  }

  return {
    lineage: { run, definition, tasks, inputArtifacts: [], compactions: [] },
    artifactsBySeq,
  };
}

/**
 * Stub HarnessConfig — Anthropic client is never called when compression
 * doesn't trigger, so a cast is safe here.
 */
function stubConfig(): HarnessConfig {
  return {
    repo: {} as HarnessConfig["repo"],
    anthropic: {} as Anthropic,
    toolRegistry: {
      resolve: () => undefined,
      list: () => [],
      listTools: () => [],
    },
    hitlHandler: {
      requestApproval: () => Promise.resolve("approved"),
    },
    env: { date: "2026-01-01" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildContext — injectedArtifactIds", () => {
  it("excludes metadata-tier artifact IDs from injectedArtifactIds", async () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);

    // 20 tasks: the most recent will score highest (full/summary),
    // the oldest will score lowest (metadata). The exact tier boundaries
    // depend on the scoring weights and budget, but with 20 tasks
    // and default weights, some will definitely land in metadata.
    const { lineage, artifactsBySeq } = buildLineage(run, definition, 20);
    const config = stubConfig();

    const result = await buildContext(run, definition, lineage, config);

    // Collect all artifact IDs in the lineage
    const allArtifactIds = new Set<string>();
    for (const [, artifact] of artifactsBySeq) {
      allArtifactIds.add(artifact.id);
    }

    const injectedSet = new Set(result.injectedArtifactIds);
    expect(injectedSet.size).toBeGreaterThan(0);
    expect(injectedSet.size).toBeLessThan(allArtifactIds.size);

    // Every injected ID should be a valid artifact
    for (const id of injectedSet) {
      expect(allArtifactIds.has(id)).toBe(true);
    }

    // Excluded artifacts should be the ones mentioned only by count in
    // the metadata section, not by content. Verify the context text
    // references metadata tasks with artifact counts...
    const contextText =
      result.messages[0]?.role === "user" ?
        (result.messages[0].content as string)
      : "";
    expect(contextText).toContain("artifact(s)");

    // ...and that excluded IDs are specifically the ones NOT mentioned
    // by content in the output (they belong to low-scoring, early tasks).
    const excludedIds = [...allArtifactIds].filter(
      (id) => !injectedSet.has(id),
    );
    expect(excludedIds.length).toBeGreaterThan(0);
    // The earliest tasks (lowest sequence numbers) score lowest on recency
    // and should land in metadata tier. Verify excluded artifacts belong
    // to those early tasks.
    for (const id of excludedIds) {
      const match = [...artifactsBySeq.entries()].find(([, a]) => a.id === id);
      expect(match).toBeDefined();
      // Excluded tasks should have lower sequence numbers than most injected ones
      const [seq] = match ?? [];
      expect(seq).toBeLessThan(20);
    }
  });

  it("returns empty injectedArtifactIds for no completed tasks", async () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const lineage: RunLineage = {
      run,
      definition,
      tasks: [],
      inputArtifacts: [],
      compactions: [],
    };
    const config = stubConfig();

    const result = await buildContext(run, definition, lineage, config);
    expect(result.injectedArtifactIds).toHaveLength(0);
  });

  it("includes all artifact IDs when all tasks score above summary threshold", async () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);

    // 2 tasks — both will score high enough for full or summary tier
    const { lineage, artifactsBySeq } = buildLineage(run, definition, 2);
    const config = stubConfig();

    const result = await buildContext(run, definition, lineage, config);

    // With only 2 tasks, both should be in full or summary tier
    expect(result.injectedArtifactIds).toHaveLength(artifactsBySeq.size);
  });
});

describe("buildContext — context text rendering", () => {
  it("includes full output for high-scoring tasks", async () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 3);
    const config = stubConfig();

    const result = await buildContext(run, definition, lineage, config);
    const contextText =
      result.messages[0]?.role === "user" ?
        (result.messages[0].content as string)
      : "";

    // Should contain the user request
    expect(contextText).toContain("User request: test input");
    // Should contain task headers
    expect(contextText).toContain("test-skill");
  });
});

describe("buildContext — custom contextWeights", () => {
  it("recency-only weights promote recent tasks and demote old ones", async () => {
    const recencyOnlyWeights: ContextWeights = {
      recency: 1,
      downstream: 0,
      artifactType: 0,
      retry: 0,
      skillType: 0,
    };
    const definition = makeDefinition({
      limits: {
        maxTasksPerRun: 50,
        maxOperationsPerTask: 3,
        maxTokensPerRun: 500_000,
        contextWeights: recencyOnlyWeights,
      },
    });
    const run = makeRun(definition.id);
    const { lineage, artifactsBySeq } = buildLineage(run, definition, 20);
    const config = stubConfig();

    const result = await buildContext(run, definition, lineage, config);
    const injected = new Set(result.injectedArtifactIds);

    // With pure recency scoring, the most recent tasks should be injected
    // and the earliest tasks excluded
    const latestArtifact = artifactsBySeq.get(20);
    const earliestArtifact = artifactsBySeq.get(1);
    expect(latestArtifact).toBeDefined();
    expect(earliestArtifact).toBeDefined();
    expect(injected.has(latestArtifact!.id)).toBe(true);
    expect(injected.has(earliestArtifact!.id)).toBe(false);
  });

  it("downstream-only weights promote consumed tasks regardless of recency", async () => {
    const downstreamOnlyWeights: ContextWeights = {
      recency: 0,
      downstream: 1,
      artifactType: 0,
      retry: 0,
      skillType: 0,
    };
    const definition = makeDefinition({
      limits: {
        maxTasksPerRun: 50,
        maxOperationsPerTask: 3,
        maxTokensPerRun: 500_000,
        contextWeights: downstreamOnlyWeights,
      },
    });
    const run = makeRun(definition.id);

    // Build lineage where task 1 (earliest) is consumed by task 20 (latest)
    const { lineage, artifactsBySeq } = buildLineage(run, definition, 20);

    // Wire a consumption edge: task 20 consumes task 1's artifact
    const earlyArtifact = artifactsBySeq.get(1);
    expect(earlyArtifact).toBeDefined();
    const lastTaskEntry = lineage.tasks.find(
      (entry) => entry.task.sequenceNumber === 20,
    );
    expect(lastTaskEntry).toBeDefined();

    // Mutate the lineage to add the consumption (buildLineage creates
    // no consumption edges by default)
    const updatedTasks = lineage.tasks.map((entry) =>
      entry.task.sequenceNumber === 20 ?
        {
          ...entry,
          consumedArtifactIds: [
            ...entry.consumedArtifactIds,
            earlyArtifact!.id,
          ],
        }
      : entry,
    );
    const updatedLineage: RunLineage = {
      ...lineage,
      tasks: updatedTasks,
    };

    const config = stubConfig();
    const result = await buildContext(run, definition, updatedLineage, config);
    const injected = new Set(result.injectedArtifactIds);

    // Task 1 is old but consumed — with downstream-only weights it should
    // still be injected
    expect(injected.has(earlyArtifact!.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compressOlderTurns — score-aware compression
// ---------------------------------------------------------------------------

/**
 * Build a ConversationState with N message pairs. Each pair is
 * [assistant(tool_use), user(tool_result)]. The tool_use_id for pair i
 * is `tool-use-${i}`.
 */
function buildConversation(
  pairCount: number,
  toolUseIdToTaskId?: Map<string, string>,
): ConversationState {
  const recentMessages: ConversationState["recentMessages"] = [];
  for (let index = 0; index < pairCount; index++) {
    recentMessages.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use" as const,
            id: `tool-use-${index}`,
            name: `tool-${index}`,
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: `tool-use-${index}`,
            content: `result from tool ${index} — ${"x".repeat(200)}`,
          },
        ],
      },
    );
  }
  return {
    historyMessage: undefined,
    recentMessages,
    recentTokenEstimate: pairCount * 200,
    injectedArtifactIds: [],
    toolUseIdToTaskId: toolUseIdToTaskId ?? new Map<string, string>(),
  };
}

function compressionConfig(lineage: RunLineage | undefined): HarnessConfig {
  return {
    repo: {
      lineage: {
        getRunLineage: vi.fn().mockResolvedValue(lineage ?? undefined),
      },
      compactions: {
        create: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as HarnessConfig["repo"],
    anthropic: {} as Anthropic,
    toolRegistry: {
      resolve: () => undefined,
      list: () => [],
      listTools: () => [],
    },
    hitlHandler: {
      requestApproval: () => Promise.resolve("approved"),
    },
    env: { date: "2026-01-01" },
  };
}

describe("compressOlderTurns — score-aware protection", () => {
  it("protects high-scoring task messages from compression", async () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);

    // 6 message pairs, midpoint = 3 → pairs 0,1,2 are "older"
    // Make task for pair 1 score high (HITL = always protected)
    const taskIdForPair1 = generateId();
    const toolUseIdToTaskId = new Map([["tool-use-1", taskIdForPair1]]);
    const state = buildConversation(6, toolUseIdToTaskId);

    // Build lineage where taskIdForPair1 is an HITL task
    const { lineage } = buildLineage(run, definition, 5);
    // Replace one task entry with our HITL task
    const hitlTask: RunLineage["tasks"][number] = {
      task: {
        id: taskIdForPair1,
        runId: run.id,
        role: "hitl",
        status: "completed",
        input: {},
        sequenceNumber: 2,
        createdAt: now(),
        updatedAt: now(),
      },
      skill: undefined,
      consumedArtifactIds: [],
      operations: [
        {
          operation: {
            id: generateId(),
            taskId: taskIdForPair1,
            runId: run.id,
            type: "hitl_response",
            status: "succeeded",
            operationNumber: 1,
            input: {},
            output: { decision: "approved" },
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 100,
            createdAt: now(),
            completedAt: now(),
          },
          artifacts: [
            {
              id: generateId(),
              type: "json",
              name: "hitl-decision",
              content: '{"approved":true}',
              contentHash: "test-hash",
              mimeType: "application/json",
              createdAt: now(),
            },
          ],
        },
      ],
    };
    const updatedLineage: RunLineage = {
      ...lineage,
      tasks: [...lineage.tasks, hitlTask],
    };

    const config = compressionConfig(updatedLineage);
    const result = await compressOlderTurns(state, config, run.id, definition);

    // Pair 1 (tool-use-1) should be in newerMessages, not compressed
    const keptToolUseIds = new Set<string>();
    for (const message of result.recentMessages) {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (
            typeof block === "object" &&
            "tool_use_id" in block &&
            typeof block.tool_use_id === "string"
          ) {
            keptToolUseIds.add(block.tool_use_id);
          }
        }
      }
    }
    expect(keptToolUseIds.has("tool-use-1")).toBe(true);
    // Pair 0 (unprotected, older) should have been compressed away
    expect(keptToolUseIds.has("tool-use-0")).toBe(false);
  });

  it("falls back to midpoint split when all older pairs are protected", async () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);

    // 4 pairs, midpoint = 2 → pairs 0,1 are "older"
    // Protect both pair 0 and pair 1
    const task0 = generateId();
    const task1 = generateId();
    const toolUseIdToTaskId = new Map([
      ["tool-use-0", task0],
      ["tool-use-1", task1],
    ]);
    const state = buildConversation(4, toolUseIdToTaskId);

    // Make both tasks HITL (always protected)
    const makeFakeHitlEntry = (
      id: string,
      seq: number,
    ): RunLineage["tasks"][number] => ({
      task: {
        id,
        runId: run.id,
        role: "hitl",
        status: "completed",
        input: {},
        sequenceNumber: seq,
        createdAt: now(),
        updatedAt: now(),
      },
      skill: undefined,
      consumedArtifactIds: [],
      operations: [
        {
          operation: {
            id: generateId(),
            taskId: id,
            runId: run.id,
            type: "hitl_response",
            status: "succeeded",
            operationNumber: 1,
            input: {},
            output: { decision: "approved" },
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 100,
            createdAt: now(),
            completedAt: now(),
          },
          artifacts: [],
        },
      ],
    });

    const { lineage } = buildLineage(run, definition, 2);
    const updatedLineage: RunLineage = {
      ...lineage,
      tasks: [
        ...lineage.tasks,
        makeFakeHitlEntry(task0, 10),
        makeFakeHitlEntry(task1, 11),
      ],
    };

    const config = compressionConfig(updatedLineage);
    const result = await compressOlderTurns(state, config, run.id, definition);

    // Should still compress something (fallback to midpoint)
    expect(result.recentMessages.length).toBeLessThan(
      state.recentMessages.length,
    );
    // History should contain compressed content
    expect(result.historyMessage).toBeDefined();
    const historyText =
      typeof result.historyMessage?.content === "string" ?
        result.historyMessage.content
      : "";
    expect(historyText).toContain("Compressed from");
  });

  it("behaves identically to midpoint split with empty toolUseIdToTaskId", async () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);

    const state = buildConversation(6); // Empty map by default
    const config = compressionConfig(undefined);

    const result = await compressOlderTurns(state, config, run.id, definition);

    // 6 pairs, midpoint = 3 → 3 pairs compressed, 3 kept
    // Each pair is 2 messages → 6 messages kept
    expect(result.recentMessages).toHaveLength(6);
  });

  it("falls back to midpoint split when lineage is unavailable", async () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);

    const toolUseIdToTaskId = new Map([["tool-use-0", "some-task-id"]]);
    const state = buildConversation(6, toolUseIdToTaskId);

    // null lineage — repo returns nothing
    const config = compressionConfig(undefined);

    const result = await compressOlderTurns(state, config, run.id, definition);

    // Should still compress (no protection without lineage)
    expect(result.recentMessages).toHaveLength(6);
    expect(result.toolUseIdToTaskId.has("tool-use-0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreTasks — deterministic unit tests
// ---------------------------------------------------------------------------

/** Weights that isolate a single scoring dimension (all others zeroed). */
function isolateWeight(dimension: keyof ContextWeights): ContextWeights {
  return {
    recency: 0,
    downstream: 0,
    artifactType: 0,
    retry: 0,
    skillType: 0,
    [dimension]: 1,
  };
}

const RECENCY_ONLY = isolateWeight("recency");
const DOWNSTREAM_ONLY = isolateWeight("downstream");
const ARTIFACT_TYPE_ONLY = isolateWeight("artifactType");
const RETRY_ONLY = isolateWeight("retry");
const SKILL_TYPE_ONLY = isolateWeight("skillType");

describe("scoreTasks — recency dimension", () => {
  it("scores tasks proportionally to sequence number", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 4);

    const scored = scoreTasks(lineage, RECENCY_ONLY);

    // 4 tasks with seq 1..4, maxSequence=4
    // Recency = seq/maxSeq: 0.25, 0.5, 0.75, 1.0
    // Sorted descending by score
    expect(scored).toHaveLength(4);
    expect(scored[0]!.score).toBeCloseTo(1); // seq 4
    expect(scored[1]!.score).toBeCloseTo(0.75); // seq 3
    expect(scored[2]!.score).toBeCloseTo(0.5); // seq 2
    expect(scored[3]!.score).toBeCloseTo(0.25); // seq 1
  });

  it("assigns score 1.0 to a single task", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 1);

    const scored = scoreTasks(lineage, RECENCY_ONLY);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.score).toBeCloseTo(1);
  });
});

describe("scoreTasks — downstream dimension", () => {
  it("gives frontier tasks (no later tasks) a score of 1.0", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 3);

    const scored = scoreTasks(lineage, DOWNSTREAM_ONLY);
    // seq 3 is the frontier — downstream = 1.0
    const frontier = scored.find((s) => s.task.sequenceNumber === 3);
    expect(frontier!.score).toBeCloseTo(1);
  });

  it("gives unconsumed non-frontier tasks a score of 0", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    // 3 tasks, no consumption edges
    const { lineage } = buildLineage(run, definition, 3);

    const scored = scoreTasks(lineage, DOWNSTREAM_ONLY);
    // seq 1 has 2 later tasks, consumed by 0 → downstream = 0*0.5 + 0/2*0.5 = 0
    const oldest = scored.find((s) => s.task.sequenceNumber === 1);
    expect(oldest!.score).toBeCloseTo(0);
  });

  it("boosts an old task when consumed by a later task", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage, artifactsBySeq } = buildLineage(run, definition, 3);

    // Task 3 consumes task 1's artifact
    const art1 = artifactsBySeq.get(1)!;
    const updatedTasks = lineage.tasks.map((entry) =>
      entry.task.sequenceNumber === 3 ?
        { ...entry, consumedArtifactIds: [art1.id] }
      : entry,
    );
    const updatedLineage: RunLineage = { ...lineage, tasks: updatedTasks };

    const scored = scoreTasks(updatedLineage, DOWNSTREAM_ONLY);
    const task1 = scored.find((s) => s.task.sequenceNumber === 1)!;

    // laterTaskCount = 2 (tasks 2 and 3), consumedByCount = 1
    // downstream = min(1,1)*0.5 + (1/2)*0.5 = 0.5 + 0.25 = 0.75
    expect(task1.score).toBeCloseTo(0.75);
    expect(task1.consumedByTaskIds).toHaveLength(1);
  });

  it("gives full downstream score when consumed by all later tasks", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage, artifactsBySeq } = buildLineage(run, definition, 3);

    // Tasks 2 and 3 both consume task 1's artifact
    const art1 = artifactsBySeq.get(1)!;
    const updatedTasks = lineage.tasks.map((entry) =>
      entry.task.sequenceNumber >= 2 ?
        { ...entry, consumedArtifactIds: [art1.id] }
      : entry,
    );
    const updatedLineage: RunLineage = { ...lineage, tasks: updatedTasks };

    const scored = scoreTasks(updatedLineage, DOWNSTREAM_ONLY);
    const task1 = scored.find((s) => s.task.sequenceNumber === 1)!;

    // laterTaskCount = 2, consumedByCount = 2
    // downstream = min(2,1)*0.5 + (2/2)*0.5 = 0.5 + 0.5 = 1.0
    expect(task1.score).toBeCloseTo(1);
  });
});

describe("scoreTasks — artifact type dimension", () => {
  it("scores hitl_decision as 1.0, json as 0.8, file_reference as 0.6, text as 0.5", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 4);

    // Override artifact types: seq 1=file_reference, 2=text, 3=json, 4=hitl_decision
    const types: Record<number, Artifact["type"]> = {
      1: "file_reference",
      2: "text",
      3: "json",
      4: "hitl_decision",
    };
    const updatedTasks = lineage.tasks.map((entry) => {
      const artifactType = types[entry.task.sequenceNumber];
      if (!artifactType) return entry;
      return {
        ...entry,
        operations: entry.operations.map((opEntry) => ({
          ...opEntry,
          artifacts: opEntry.artifacts.map((a) => ({
            ...a,
            type: artifactType,
          })),
        })),
      };
    });
    const updatedLineage: RunLineage = { ...lineage, tasks: updatedTasks };

    const scored = scoreTasks(updatedLineage, ARTIFACT_TYPE_ONLY);
    const bySeq = (seq: number) =>
      scored.find((s) => s.task.sequenceNumber === seq)!;

    expect(bySeq(4).score).toBeCloseTo(1); // hitl_decision
    expect(bySeq(3).score).toBeCloseTo(0.8); // json
    expect(bySeq(1).score).toBeCloseTo(0.6); // file_reference
    expect(bySeq(2).score).toBeCloseTo(0.5); // text
  });

  it("scores 0 when task has no artifacts", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 1);

    // Remove artifacts from the succeeded operation
    const updatedTasks = lineage.tasks.map((entry) => ({
      ...entry,
      operations: entry.operations.map((opEntry) => ({
        ...opEntry,
        artifacts: [],
      })),
    }));
    const updatedLineage: RunLineage = { ...lineage, tasks: updatedTasks };

    const scored = scoreTasks(updatedLineage, ARTIFACT_TYPE_ONLY);
    expect(scored[0]!.score).toBeCloseTo(0);
  });
});

describe("scoreTasks — retry dimension", () => {
  it("scores proportionally to operation count capped at 3", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 1);

    // Add two more failed operations to the task (3 total)
    const entry = lineage.tasks[0]!;
    const extraOps = [1, 2].map((n) => ({
      operation: {
        id: generateId(),
        taskId: entry.task.id,
        runId: run.id,
        type: "tool_call" as const,
        status: "failed" as const,
        operationNumber: n + 1,
        input: {},
        inputTokens: 100,
        outputTokens: 50,
        error: "test error",
        latencyMs: 100,
        createdAt: ts(),
        completedAt: ts(),
      },
      artifacts: [] as Artifact[],
    }));
    const updatedTasks = [
      {
        ...entry,
        operations: [...entry.operations, ...extraOps],
      },
    ];
    const updatedLineage: RunLineage = { ...lineage, tasks: updatedTasks };

    const scored = scoreTasks(updatedLineage, RETRY_ONLY);
    // operationCount = 3, retry = min(3/3, 1) = 1.0
    expect(scored[0]!.score).toBeCloseTo(1);
    expect(scored[0]!.operationCount).toBe(3);
  });

  it("caps retry score at 1.0 even with more than 3 operations", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 1);

    const entry = lineage.tasks[0]!;
    const extraOps = [1, 2, 3, 4].map((n) => ({
      operation: {
        id: generateId(),
        taskId: entry.task.id,
        runId: run.id,
        type: "tool_call" as const,
        status: "failed" as const,
        operationNumber: n + 1,
        input: {},
        inputTokens: 100,
        outputTokens: 50,
        error: "test error",
        latencyMs: 100,
        createdAt: ts(),
        completedAt: ts(),
      },
      artifacts: [] as Artifact[],
    }));
    const updatedTasks = [
      { ...entry, operations: [...entry.operations, ...extraOps] },
    ];
    const updatedLineage: RunLineage = { ...lineage, tasks: updatedTasks };

    const scored = scoreTasks(updatedLineage, RETRY_ONLY);
    // operationCount = 5, retry = min(5/3, 1) = 1.0
    expect(scored[0]!.score).toBeCloseTo(1);
  });

  it("scores 1/3 for a single-operation task", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 1);

    const scored = scoreTasks(lineage, RETRY_ONLY);
    // operationCount = 1, retry = 1/3 ≈ 0.333
    expect(scored[0]!.score).toBeCloseTo(1 / 3);
  });
});

describe("scoreTasks — skill type dimension", () => {
  it("scores hitl_response operations as 1.0", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 1);

    const entry = lineage.tasks[0]!;
    const updatedTasks = [
      {
        ...entry,
        task: { ...entry.task, role: "hitl" as const },
        operations: [
          {
            operation: {
              ...entry.operations[0]!.operation,
              type: "hitl_response" as const,
            },
            artifacts: entry.operations[0]!.artifacts,
          },
        ],
      },
    ];
    const updatedLineage: RunLineage = { ...lineage, tasks: updatedTasks };

    const scored = scoreTasks(updatedLineage, SKILL_TYPE_ONLY);
    expect(scored[0]!.score).toBeCloseTo(1);
    expect(scored[0]!.isHitl).toBe(true);
  });

  it("scores skill activation with description as 0.7", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 1);

    // buildLineage already attaches SKILL (which has a description)
    const scored = scoreTasks(lineage, SKILL_TYPE_ONLY);
    expect(scored[0]!.score).toBeCloseTo(0.7);
  });

  it("scores tasks without skill description as 0.5", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 1);

    // Remove skill association
    const updatedTasks = lineage.tasks.map((entry) => ({
      ...entry,
      skill: undefined,
    }));
    const updatedLineage: RunLineage = { ...lineage, tasks: updatedTasks };

    const scored = scoreTasks(updatedLineage, SKILL_TYPE_ONLY);
    expect(scored[0]!.score).toBeCloseTo(0.5);
  });
});

describe("scoreTasks — structural invariants", () => {
  it("excludes root tasks from scoring", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 2);

    // Add a root task
    const rootTask: RunLineage["tasks"][number] = {
      task: {
        id: generateId(),
        runId: run.id,
        role: "root",
        status: "completed",
        input: {},
        sequenceNumber: 0,
        createdAt: ts(),
        updatedAt: ts(),
      },
      skill: undefined,
      consumedArtifactIds: [],
      operations: [],
    };
    const updatedLineage: RunLineage = {
      ...lineage,
      tasks: [rootTask, ...lineage.tasks],
    };

    const scored = scoreTasks(updatedLineage, RECENCY_ONLY);
    // Root task should be excluded — only 2 scored
    expect(scored).toHaveLength(2);
    expect(scored.every((s) => s.task.role !== "root")).toBe(true);
  });

  it("excludes non-completed tasks from scoring", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 3);

    // Mark task 2 as failed
    const updatedTasks = lineage.tasks.map((entry) =>
      entry.task.sequenceNumber === 2 ?
        { ...entry, task: { ...entry.task, status: "failed" as const } }
      : entry,
    );
    const updatedLineage: RunLineage = { ...lineage, tasks: updatedTasks };

    const scored = scoreTasks(updatedLineage, RECENCY_ONLY);
    expect(scored).toHaveLength(2);
    expect(scored.every((s) => s.task.status === "completed")).toBe(true);
  });

  it("returns results sorted descending by score", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 10);

    const scored = scoreTasks(lineage, RECENCY_ONLY);
    for (let index = 1; index < scored.length; index++) {
      expect(scored[index - 1]!.score).toBeGreaterThanOrEqual(
        scored[index]!.score,
      );
    }
  });

  it("returns empty array for lineage with no tasks", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const lineage: RunLineage = {
      run,
      definition,
      tasks: [],
      inputArtifacts: [],
      compactions: [],
    };

    const scored = scoreTasks(lineage, RECENCY_ONLY);
    expect(scored).toHaveLength(0);
  });
});

describe("scoreTasks — combined default weights", () => {
  it("produces expected score for a known configuration", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    // 2 tasks, task 2 consumes task 1's artifact
    const { lineage, artifactsBySeq } = buildLineage(run, definition, 2);
    const art1 = artifactsBySeq.get(1)!;
    const updatedTasks = lineage.tasks.map((entry) =>
      entry.task.sequenceNumber === 2 ?
        { ...entry, consumedArtifactIds: [art1.id] }
      : entry,
    );
    const updatedLineage: RunLineage = { ...lineage, tasks: updatedTasks };

    const weights: ContextWeights = {
      recency: 0.3,
      downstream: 0.35,
      artifactType: 0.15,
      retry: 0.1,
      skillType: 0.1,
    };
    const scored = scoreTasks(updatedLineage, weights);

    // Task 2 (seq=2, frontier):
    //   recency = 2/2 = 1.0
    //   downstream = 1.0 (frontier)
    //   artifactType = 0.5 (text)
    //   retry = 1/3 ≈ 0.333
    //   skillType = 0.7 (has skill description)
    //   score = 1.0*0.3 + 1.0*0.35 + 0.5*0.15 + 0.333*0.1 + 0.7*0.1
    //         = 0.3 + 0.35 + 0.075 + 0.0333 + 0.07 = 0.8283
    const task2 = scored.find((s) => s.task.sequenceNumber === 2)!;
    expect(task2.score).toBeCloseTo(0.828, 2);

    // Task 1 (seq=1, consumed by task 2):
    //   recency = 1/2 = 0.5
    //   downstream: laterTaskCount=1, consumedByCount=1
    //     = min(1,1)*0.5 + (1/1)*0.5 = 1.0
    //   artifactType = 0.5 (text)
    //   retry = 1/3 ≈ 0.333
    //   skillType = 0.7
    //   score = 0.5*0.3 + 1.0*0.35 + 0.5*0.15 + 0.333*0.1 + 0.7*0.1
    //         = 0.15 + 0.35 + 0.075 + 0.0333 + 0.07 = 0.6783
    const task1 = scored.find((s) => s.task.sequenceNumber === 1)!;
    expect(task1.score).toBeCloseTo(0.678, 2);
  });
});

// ---------------------------------------------------------------------------
// assignTiers — deterministic unit tests
// ---------------------------------------------------------------------------

describe("assignTiers", () => {
  it("assigns HITL tasks to full tier regardless of score", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 1);

    // Make it an HITL task with a low recency score
    const entry = lineage.tasks[0]!;
    const hitlLineage: RunLineage = {
      ...lineage,
      tasks: [
        {
          ...entry,
          operations: [
            {
              operation: {
                ...entry.operations[0]!.operation,
                type: "hitl_response" as const,
              },
              artifacts: entry.operations[0]!.artifacts,
            },
          ],
        },
      ],
    };

    // Use weights that would give a low score
    const scored = scoreTasks(hitlLineage, RECENCY_ONLY);
    const tiered = assignTiers(scored, 100_000);
    expect(tiered[0]!.tier).toBe("full");
  });

  it("assigns high-scoring tasks to full tier and low-scoring to metadata", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 10);

    const scored = scoreTasks(lineage, RECENCY_ONLY);
    // Large budget so full tier isn't constrained by tokens
    const tiered = assignTiers(scored, 1_000_000);

    // Highest-scoring tasks (score >= 0.7) → full
    const fullTasks = tiered.filter((t) => t.tier === "full");
    const metadataTasks = tiered.filter((t) => t.tier === "metadata");

    // With recency-only: scores are 0.1, 0.2, ..., 1.0
    // >= 0.7: tasks with seq 7,8,9,10 → 4 full
    // >= 0.3: tasks with seq 3,4,5,6 → 4 summary
    // < 0.3: tasks with seq 1,2 → 2 metadata
    expect(fullTasks).toHaveLength(4);
    expect(metadataTasks).toHaveLength(2);
    for (const t of fullTasks) {
      expect(t.score).toBeGreaterThanOrEqual(0.7);
    }
    for (const t of metadataTasks) {
      expect(t.score).toBeLessThan(0.3);
    }
  });

  it("demotes full-tier tasks to summary when token budget is exceeded", () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 5);

    const scored = scoreTasks(lineage, RECENCY_ONLY);
    // Tiny budget: full budget = 100 * 0.6 = 60 tokens
    // Each task estimates ~7 tokens ("output-N" result), so only ~8 fit
    const tiered = assignTiers(scored, 100);

    const fullTasks = tiered.filter((t) => t.tier === "full");
    const totalFullTokens = fullTasks.reduce(
      (sum, t) => sum + t.estimatedTokens,
      0,
    );
    // Full tier should respect the 60% budget
    expect(totalFullTokens).toBeLessThanOrEqual(100 * 0.6 + 1);
  });
});

// ---------------------------------------------------------------------------
// buildContext — countTokens validation
// ---------------------------------------------------------------------------

describe("buildContext — countTokens validation", () => {
  it("demotes full-tier tasks when actual tokens exceed budget", async () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);

    // 10 tasks: with default weights, recent tasks land in full tier
    const { lineage } = buildLineage(run, definition, 10);
    const config = stubConfig();

    // First call (default): countTokens returns 0, so no demotion
    const baseline = await buildContext(run, definition, lineage, config);
    const baselineInjected = new Set(baseline.injectedArtifactIds);

    // Now mock countTokens to report way over budget → triggers demotion
    mockedCountTokens.mockResolvedValueOnce(999_999);

    const demoted = await buildContext(run, definition, lineage, config);
    const demotedInjected = new Set(demoted.injectedArtifactIds);

    // The demoted result should have fewer injected artifacts (some
    // full-tier tasks got demoted to summary, which still has metadata,
    // but the oldest/lowest-scoring tasks may have lost their artifacts)
    expect(demotedInjected.size).toBeLessThanOrEqual(baselineInjected.size);
  });

  it("does not demote HITL tasks even when over budget", async () => {
    const definition = makeDefinition();
    const run = makeRun(definition.id);
    const { lineage } = buildLineage(run, definition, 3);

    // Make task 2 an HITL task
    const entry = lineage.tasks[1]!;
    const hitlEntry: RunLineage["tasks"][number] = {
      ...entry,
      task: { ...entry.task, role: "hitl" as const },
      operations: [
        {
          operation: {
            ...entry.operations[0]!.operation,
            type: "hitl_response" as const,
          },
          artifacts: entry.operations[0]!.artifacts,
        },
      ],
    };
    const updatedLineage: RunLineage = {
      ...lineage,
      tasks: [lineage.tasks[0]!, hitlEntry, lineage.tasks[2]!],
    };

    // Over budget
    mockedCountTokens.mockResolvedValueOnce(999_999);

    const config = stubConfig();
    const result = await buildContext(run, definition, updatedLineage, config);

    // HITL task's artifact should still be injected
    const hitlArtifactId = hitlEntry.operations[0]!.artifacts[0]!.id;
    expect(result.injectedArtifactIds).toContain(hitlArtifactId);
  });
});
