import type {
  Artifact,
  HitlHandler,
  Operation,
  OperationPatch,
  Repository,
  RunPatch,
  Task,
  TaskPatch,
} from "@nicator/core";
import { generateId, now } from "@nicator/core";
import type { Anthropic } from "@nicator/sdk";
import { describe, expect, it, vi } from "vitest";

import { enforcePolicy } from "./policy.js";
import { createEmptyToolRegistry } from "./registries.js";
import type { HarnessConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Mock repo — minimal subset needed for policy tests
// ---------------------------------------------------------------------------

function createMockRepo() {
  const _runs = new Map<string, Record<string, unknown>>();
  const _tasks = new Map<string, Record<string, unknown>>();
  const _operations = new Map<string, Record<string, unknown>>();
  const _artifacts = new Map<string, Artifact>();

  return {
    _runs,
    _tasks,
    _operations,
    _artifacts,
    agents: {
      getDefinition: vi.fn(),
      createDefinition: vi.fn(),
      listDefinitions: vi.fn(),
      registerSkill: vi.fn(),
    },
    runs: {
      get: vi.fn(),
      create: vi.fn(),
      update(id: string, patch: RunPatch) {
        const existing = _runs.get(id);
        if (existing) _runs.set(id, { ...existing, ...patch });
        return Promise.resolve();
      },
      listRecent: vi.fn(),
    },
    tasks: {
      create(task: Task) {
        _tasks.set(task.id, { ...task });
        return Promise.resolve();
      },
      update(id: string, patch: TaskPatch) {
        const existing = _tasks.get(id);
        if (existing) _tasks.set(id, { ...existing, ...patch });
        return Promise.resolve();
      },
      getCount: vi.fn().mockResolvedValue(0),
      countCompletedByName(runId: string, subagentName: string) {
        return Promise.resolve(
          [..._tasks.values()].filter(
            (t) =>
              t["runId"] === runId &&
              t["subagentName"] === subagentName &&
              t["status"] === "completed",
          ).length,
        );
      },
      getForRun(runId: string) {
        return Promise.resolve(
          [..._tasks.values()].filter(
            (t) => t["runId"] === runId,
          ) as unknown as Task[],
        );
      },
    },
    operations: {
      create(operation: Operation) {
        _operations.set(operation.id, { ...operation });
        return Promise.resolve();
      },
      update(id: string, patch: OperationPatch) {
        const existing = _operations.get(id);
        if (existing) _operations.set(id, { ...existing, ...patch });
        return Promise.resolve();
      },
      getForTask(taskId: string, _runId: string) {
        return Promise.resolve(
          [..._operations.values()].filter(
            (o) => o["taskId"] === taskId,
          ) as unknown as Operation[],
        );
      },
    },
    artifacts: {
      create(artifact: Artifact) {
        _artifacts.set(artifact.id, { ...artifact });
        return Promise.resolve();
      },
      createAndLinkProduced: vi.fn().mockResolvedValue(undefined),
      linkProduced: vi.fn().mockResolvedValue(undefined),
      linkInputToRun: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      getIdsForOperation: vi.fn().mockResolvedValue([]),
      getForRun: vi.fn().mockResolvedValue([]),
      addConsumesEdge: vi.fn().mockResolvedValue(undefined),
    },
    compactions: { create: vi.fn().mockResolvedValue(undefined) },
    lineage: { getRunLineage: vi.fn() },
  };
}

const APPROVE_HITL: HitlHandler = {
  requestApproval: () => Promise.resolve("approved"),
};

const DENY_HITL: HitlHandler = {
  requestApproval: () => Promise.resolve("denied"),
};

function buildConfig(
  repo: ReturnType<typeof createMockRepo>,
  hitlHandler: HitlHandler = APPROVE_HITL,
): HarnessConfig {
  return {
    repo: repo as unknown as Repository,
    anthropic: {} as Anthropic,
    toolRegistry: createEmptyToolRegistry(),
    hitlHandler,
    env: { date: "2026-04-05" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enforcePolicy", () => {
  it("allows invocation with 'always' policy", async () => {
    const repo = createMockRepo();
    const config = buildConfig(repo);
    const runId = generateId();
    repo._runs.set(runId, { id: runId, status: "running" });

    await expect(
      enforcePolicy(
        {
          policy: { type: "always" },
          subagentName: "test-skill",
          toolInput: {},
          runId,
          rootTaskId: generateId(),
        },
        config,
      ),
    ).resolves.toBeUndefined();
  });

  it("denies invocation with 'never' policy", async () => {
    const repo = createMockRepo();
    const config = buildConfig(repo);

    await expect(
      enforcePolicy(
        {
          policy: { type: "never" },
          subagentName: "blocked-skill",
          toolInput: {},
          runId: generateId(),
          rootTaskId: generateId(),
        },
        config,
      ),
    ).rejects.toThrow("denied by policy");
  });

  it("approves with require_hitl_approval when human approves", async () => {
    const repo = createMockRepo();
    const runId = generateId();
    const rootTaskId = generateId();
    repo._runs.set(runId, { id: runId, status: "running" });

    const config = buildConfig(repo, APPROVE_HITL);

    await expect(
      enforcePolicy(
        {
          policy: {
            type: "require_hitl_approval",
            approverPrompt: "Allow {{skill_name}}?",
          },
          subagentName: "sensitive-skill",
          toolInput: { skill_name: "sensitive-skill" },
          runId,
          rootTaskId,
          maxOperationsPerTask: 3,
        },
        config,
      ),
    ).resolves.toBeUndefined();
  });

  it("denies with require_hitl_approval when human denies", async () => {
    const repo = createMockRepo();
    const runId = generateId();
    const rootTaskId = generateId();
    repo._runs.set(runId, { id: runId, status: "running" });

    const config = buildConfig(repo, DENY_HITL);

    await expect(
      enforcePolicy(
        {
          policy: {
            type: "require_hitl_approval",
            approverPrompt: "Allow?",
          },
          subagentName: "sensitive-skill",
          toolInput: {},
          runId,
          rootTaskId,
        },
        config,
      ),
    ).rejects.toThrow("denied by human approver");
  });

  it("allows with max_calls_per_run when under limit", async () => {
    const repo = createMockRepo();
    const runId = generateId();

    const config = buildConfig(repo);

    await expect(
      enforcePolicy(
        {
          policy: { type: "max_calls_per_run", limit: 3 },
          subagentName: "limited-skill",
          toolInput: {},
          runId,
          rootTaskId: generateId(),
        },
        config,
      ),
    ).resolves.toBeUndefined();
  });

  it("denies with max_calls_per_run when at limit", async () => {
    const repo = createMockRepo();
    const runId = generateId();

    // Simulate 3 completed skill tasks
    for (let index = 0; index < 3; index++) {
      const taskId = generateId();
      repo._tasks.set(taskId, {
        id: taskId,
        runId,
        role: "subagent",
        subagentName: "limited-skill",
        status: "completed",
        sequenceNumber: index + 1,
        createdAt: now(),
        updatedAt: now(),
      });
    }

    const config = buildConfig(repo);

    await expect(
      enforcePolicy(
        {
          policy: { type: "max_calls_per_run", limit: 3 },
          subagentName: "limited-skill",
          toolInput: {},
          runId,
          rootTaskId: generateId(),
        },
        config,
      ),
    ).rejects.toThrow("exceeded max_calls_per_run");
  });
});
