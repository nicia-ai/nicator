import type {
  AgentDefinition,
  Artifact,
  HitlHandler,
  Operation,
  OperationPatch,
  Repository,
  Run,
  RunPatch,
  Skill,
  Task,
  TaskPatch,
} from "@nicator/core";
import {
  generateId,
  HUMAN_APPROVAL_SKILL_NAME,
  normalizeHitlPrompt,
  now,
  SPAWN_SUBAGENT_WITH_SKILL_TOOL_NAME,
} from "@nicator/core";
import { makeDefinition, makeRun } from "@nicator/core/test-factories";
import type { Anthropic } from "@nicator/sdk";
import { createBashTool, createWorkspace } from "@nicator/workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyToolRegistry, toolRegistryFromMap } from "./registries.js";
import { runAgent } from "./run-loop.js";
import type { HarnessConfig, ToolImplementation } from "./types.js";

// ---------------------------------------------------------------------------
// Mock SDK
// ---------------------------------------------------------------------------

vi.mock("@nicator/sdk", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock requires dynamic import
  const original = await importOriginal<typeof import("@nicator/sdk")>();
  const mockSubagentLoop = vi.fn();
  return {
    ...original,
    complete: vi.fn(),
    parseAllToolUses: vi.fn(),
    buildDirectToolDefinitions: original.buildDirectToolDefinitions,
    buildSpawnSubagentTool: original.buildSpawnSubagentTool,
    buildSpawnSubagentWithSkillTool: original.buildSpawnSubagentWithSkillTool,
    runSkillLoop: mockSubagentLoop,
    runSubagentLoop: mockSubagentLoop,
    countTokens: vi.fn().mockResolvedValue(0),
  };
});

const { complete, parseAllToolUses, runSubagentLoop } =
  await import("@nicator/sdk");
const mockedComplete = vi.mocked(complete);
const mockedParseAllToolUses = vi.mocked(parseAllToolUses);
const mockedRunSubagentLoop = vi.mocked(runSubagentLoop);

// ---------------------------------------------------------------------------
// Mock repository (flat records to avoid discriminated union issues)
//
// Known limitations: this mock does not validate records against Zod schemas,
// enforce edge uniqueness, or check referential integrity. getRunLineage
// returns a simplified structure without real graph traversal. Tests using
// this mock verify the run loop's control flow but not its interaction with
// storage semantics (duplicate edges, missing nodes, constraint violations).
// Integration tests against a real Repository + TypeGraph instance are needed
// for storage-level correctness.
// ---------------------------------------------------------------------------

type FlatRecord = Record<string, unknown>;

function createMockRepo() {
  const _runs = new Map<string, FlatRecord>();
  const _tasks = new Map<string, FlatRecord>();
  const _operations = new Map<string, FlatRecord>();
  const _artifacts = new Map<string, Artifact>();
  const _definitions = new Map<string, AgentDefinition>();
  const _skills = new Map<string, { skill: Skill; prompt: string }>();
  /** Track which operation produced which artifact (replaces operationId field). */
  const _artifactToOperation = new Map<string, string>();
  /** Track which task owns which artifact (replaces taskId field). */
  const _artifactToTask = new Map<string, string>();
  /** Track which run owns which artifact (replaces runId field). */
  const _artifactToRun = new Map<string, string>();

  const _linkSkill = vi.fn().mockResolvedValue(undefined);

  return {
    _runs,
    _tasks,
    _operations,
    _artifacts,
    _definitions,
    _skills,
    _artifactToOperation,
    _artifactToTask,
    _artifactToRun,
    _linkSkill,

    agents: {
      getDefinition(id: string) {
        return Promise.resolve(_definitions.get(id));
      },
      createDefinition(def: AgentDefinition) {
        _definitions.set(def.id, { ...def });
        return Promise.resolve();
      },
      listDefinitions() {
        return Promise.resolve([..._definitions.values()]);
      },
      registerSkill() {
        return Promise.resolve("mock-skill-id");
      },
      registerSkillWithPrompt() {
        return Promise.resolve("mock-skill-id");
      },
      resolveSkill(name: string) {
        return Promise.resolve(_skills.get(name));
      },
      listSkills() {
        return Promise.resolve([..._skills.values()].map((s) => s.skill));
      },
      listSkillsWithPrompts() {
        return Promise.resolve([..._skills.values()]);
      },
    },
    runs: {
      get(id: string) {
        return Promise.resolve((_runs.get(id) ?? undefined) as Run | undefined);
      },
      create(run: Run) {
        _runs.set(run.id, { ...run });
        return Promise.resolve();
      },
      update(id: string, patch: RunPatch) {
        const existing = _runs.get(id);
        if (existing) _runs.set(id, { ...existing, ...patch });
        return Promise.resolve();
      },
      listRecent() {
        return Promise.resolve([..._runs.values()] as unknown as Run[]);
      },
    },
    tasks: {
      create(task: Task) {
        _tasks.set(task.id, { ...task });
        return Promise.resolve();
      },
      linkSkill: _linkSkill,
      update(id: string, patch: TaskPatch) {
        const existing = _tasks.get(id);
        if (existing) _tasks.set(id, { ...existing, ...patch });
        return Promise.resolve();
      },
      getCount(runId: string) {
        return Promise.resolve(
          [..._tasks.values()].filter((t) => t["runId"] === runId).length,
        );
      },
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
      findHitlDecision(runId: string, prompt: string) {
        const normalizedPrompt = normalizeHitlPrompt(prompt);
        const runTasks = ([..._tasks.values()] as unknown as Task[]).filter(
          (t) =>
            t.runId === runId &&
            t.role === "hitl" &&
            (t.status === "completed" || t.status === "failed"),
        );
        for (const task of runTasks) {
          const ops = (
            [..._operations.values()] as unknown as Operation[]
          ).filter(
            (o) =>
              o.taskId === task.id &&
              o.type === "hitl_response" &&
              o.status === "succeeded",
          );
          for (const op of ops) {
            const opInput = op.input;
            if (
              typeof opInput === "object" &&
              opInput !== null &&
              "prompt" in opInput
            ) {
              const stored = (opInput as Record<string, unknown>)["prompt"];
              if (
                typeof stored === "string" &&
                normalizeHitlPrompt(stored) === normalizedPrompt
              ) {
                const artifact = [..._artifacts.entries()].find(
                  ([artId, a]) =>
                    _artifactToTask.get(artId) === task.id &&
                    a.type === "hitl_decision",
                )?.[1];
                if (artifact) {
                  return Promise.resolve({
                    taskId: task.id,
                    taskStatus: task.status as "completed" | "failed",
                    artifactId: artifact.id,
                    artifactContent: artifact.content,
                  });
                }
              }
            }
          }
        }
        return Promise.resolve(undefined);
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
            (a) => a["taskId"] === taskId,
          ) as unknown as Operation[],
        );
      },
    },
    artifacts: {
      create(artifact: Artifact) {
        _artifacts.set(artifact.id, { ...artifact });
        return Promise.resolve();
      },
      createAndLinkProduced(artifact: Artifact, operationId: string) {
        _artifacts.set(artifact.id, { ...artifact });
        _artifactToOperation.set(artifact.id, operationId);
        const op = _operations.get(operationId);
        if (op) {
          _artifactToTask.set(artifact.id, op["taskId"] as string);
          _artifactToRun.set(artifact.id, op["runId"] as string);
        }
        return Promise.resolve();
      },
      linkProduced(operationId: string, artifactId: string) {
        _artifactToOperation.set(artifactId, operationId);
        const op = _operations.get(operationId);
        if (op) {
          _artifactToTask.set(artifactId, op["taskId"] as string);
          _artifactToRun.set(artifactId, op["runId"] as string);
        }
        return Promise.resolve();
      },
      get(id: string) {
        return Promise.resolve(_artifacts.get(id));
      },
      getIdsForOperation(operationId: string) {
        return Promise.resolve(
          [..._artifacts.entries()]
            .filter(
              ([artId]) => _artifactToOperation.get(artId) === operationId,
            )
            .map(([artId]) => artId),
        );
      },
      getForRun(runId: string) {
        return Promise.resolve(
          [..._artifacts.entries()]
            .filter(([artId]) => _artifactToRun.get(artId) === runId)
            .map(([, art]) => art),
        );
      },
      getForRunByNames(runId: string, names: ReadonlyArray<string>) {
        const nameSet = new Set(names);
        return Promise.resolve(
          [..._artifacts.entries()]
            .filter(
              ([artId, art]) =>
                _artifactToRun.get(artId) === runId && nameSet.has(art.name),
            )
            .map(([, art]) => art),
        );
      },
      addConsumesEdge() {
        return Promise.resolve();
      },
    },
    compactions: {
      create() {
        return Promise.resolve();
      },
    },
    lineage: {
      getRunLineage(runId: string) {
        const run = _runs.get(runId) as unknown as Run | undefined;
        if (!run) return Promise.resolve(undefined);
        const def = _definitions.get(run.agentDefinitionId);
        if (!def) return Promise.resolve(undefined);
        const tasks = ([..._tasks.values()] as unknown as Task[])
          .filter((t) => t.runId === runId)
          .toSorted((a, b) => a.sequenceNumber - b.sequenceNumber)
          .map((task) => ({
            task,
            skill: undefined,
            consumedArtifactIds: [] as string[],
            operations: ([..._operations.values()] as unknown as Operation[])
              .filter((o) => o.taskId === task.id)
              .map((operation) => ({
                operation,
                artifacts: [..._artifacts.entries()]
                  .filter(
                    ([artId]) =>
                      _artifactToOperation.get(artId) === operation.id,
                  )
                  .map(([, art]) => art),
              })),
          }));
        return Promise.resolve({
          run,
          definition: def,
          tasks,
          inputArtifacts: [],
          compactions: [],
        });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TOKENS = { input: 100, output: 50 } as const;

function completeResult(text: string, tokens = DEFAULT_TOKENS) {
  return {
    text,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    response: {
      content: [{ type: "text" as const, text }],
    } as never,
  };
}

const NO_OP_HITL: HitlHandler = {
  requestApproval: () => Promise.resolve("approved"),
};

const DEFAULT_TOOL_RESULT: unknown = { data: "ok" };

function createMockToolImpl(
  name: string,
  result: unknown = DEFAULT_TOOL_RESULT,
): ToolImplementation {
  return {
    tool: {
      name,
      version: "1.0.0",
      description: `Mock ${name} tool`,
      inputSchema: { type: "object" as const, properties: {} },
      outputSchema: { type: "object" as const, properties: {} },
    },
    execute: vi.fn().mockResolvedValue(result),
  };
}

function createMockSkill(name: string): { skill: Skill; prompt: string } {
  return {
    skill: {
      id: `skill-${name}`,
      name,
      description: `Mock ${name} skill`,
      version: "1.0",
    },
    prompt: `You are a ${name} assistant. Follow these instructions.`,
  };
}

async function setupRun(
  repo: ReturnType<typeof createMockRepo>,
  definitionOverrides?: Partial<AgentDefinition>,
) {
  const definition = makeDefinition(definitionOverrides);
  await repo.agents.createDefinition(definition);
  const run = makeRun(definition.id, { status: "pending" }) as Run;
  await repo.runs.create(run);
  return { definition, run };
}

function buildConfig(
  repo: ReturnType<typeof createMockRepo>,
  overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
  return {
    repo: repo as unknown as Repository,
    anthropic: {} as Anthropic,
    toolRegistry: createEmptyToolRegistry(),
    hitlHandler: NO_OP_HITL,
    env: { date: "2026-01-01" },
    ...overrides,
  };
}

function getRunField(
  repo: ReturnType<typeof createMockRepo>,
  runId: string,
  field: string,
): unknown {
  return repo._runs.get(runId)?.[field];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAgent — completion without tool use", () => {
  it("completes when the model returns text with no tool call", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    mockedComplete.mockResolvedValueOnce(completeResult("Final answer"));
    mockedParseAllToolUses.mockReturnValueOnce([]);

    const config = buildConfig(repo);
    await runAgent(run.id, config);

    expect(getRunField(repo, run.id, "status")).toBe("completed");
    expect(getRunField(repo, run.id, "output")).toBe("Final answer");
  });
});

describe("runAgent — direct tool calls", () => {
  it("creates child Task with Operation and Artifact for a direct tool call", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    const toolImpl = createMockToolImpl("web-search", { results: [] });
    const toolRegistry = toolRegistryFromMap([["web-search", toolImpl]]);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "web-search",
          toolInput: { query: "test" },
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([]);

    const config = buildConfig(repo, { toolRegistry });
    await runAgent(run.id, config);

    // Root task + child tool task
    const tasks = [...repo._tasks.values()];
    expect(tasks).toHaveLength(2);
    const rootTask = tasks.find((t) => t["role"] === "root");
    const toolTask = tasks.find((t) => t["role"] === "tool");
    expect(rootTask).toBeDefined();
    expect(toolTask).toBeDefined();
    expect(toolTask?.["status"]).toBe("completed");

    // Operation created on child task
    const operations = [...repo._operations.values()];
    expect(operations).toHaveLength(1);
    expect(operations[0]?.["status"]).toBe("succeeded");
    expect(operations[0]?.["taskId"]).toBe(toolTask?.["id"]);

    // Artifact created with tool result
    const artifacts = [...repo._artifacts.values()];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("web-search_result");

    // Tool was executed
    expect(toolImpl.execute).toHaveBeenCalledWith({ query: "test" });

    // Run completed
    expect(getRunField(repo, run.id, "status")).toBe("completed");
  });

  it("marks operation as failed when tool throws", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    const failingTool = createMockToolImpl("web-search");
    (failingTool.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error"),
    );

    const toolRegistry = toolRegistryFromMap([["web-search", failingTool]]);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Recovered"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "web-search",
          toolInput: {},
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([]);

    const config = buildConfig(repo, { toolRegistry });
    await runAgent(run.id, config);

    // Root task still completes — individual operation failed
    const operations = [...repo._operations.values()];
    expect(operations[0]?.["status"]).toBe("failed");
    expect(getRunField(repo, run.id, "status")).toBe("completed");
  });
});

describe("runAgent — bash tool dispatch", () => {
  it("executes a bash command and records Operation + Artifact", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    const workspace = await createWorkspace({ runId: run.id });
    const bashTool = createBashTool(workspace);
    const toolRegistry = toolRegistryFromMap([["bash", bashTool]]);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "bash",
          toolInput: { command: 'echo "hello from bash"' },
          toolUseId: "tu_bash_1",
        },
      ])
      .mockReturnValueOnce([]);

    const config = buildConfig(repo, { toolRegistry, workspace });
    await runAgent(run.id, config);

    // Child task created for the bash tool dispatch
    const tasks = [...repo._tasks.values()];
    const bashTask = tasks.find((t) => t["role"] === "tool");
    expect(bashTask).toBeDefined();
    expect(bashTask?.["status"]).toBe("completed");

    // Operation recorded with succeeded status
    const operations = [...repo._operations.values()];
    expect(operations).toHaveLength(1);
    expect(operations[0]?.["status"]).toBe("succeeded");

    // Artifact contains the bash output
    const artifacts = [...repo._artifacts.values()];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("bash_result");
    const content = JSON.parse(artifacts[0]?.content ?? "{}") as {
      stdout: string;
      exitCode: number;
    };
    expect(content.stdout).toContain("hello from bash");
    expect(content.exitCode).toBe(0);

    expect(getRunField(repo, run.id, "status")).toBe("completed");
    await workspace.dispose();
  });

  it("records file_reference artifacts via save_artifact on completion", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    const workspace = await createWorkspace({ runId: run.id });
    const bashTool = createBashTool(workspace);
    const toolRegistry = toolRegistryFromMap([["bash", bashTool]]);

    // Iteration 1: model creates a file and promotes it
    // Iteration 2: model creates another file and promotes it
    // Iteration 3: model returns final text (no tool calls)
    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("All done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "bash",
          toolInput: {
            command:
              'echo "analysis results" > report.md && save_artifact report.md',
          },
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([
        {
          toolName: "bash",
          toolInput: {
            command:
              "echo '{\"score\": 42}' > data.json && save_artifact data.json",
          },
          toolUseId: "tu_2",
        },
      ])
      .mockReturnValueOnce([]);

    const config = buildConfig(repo, { toolRegistry, workspace });
    await runAgent(run.id, config);

    // 2 bash_result artifacts (from tool dispatch) + 2 file_reference artifacts (from auto-capture)
    const artifacts = [...repo._artifacts.values()];
    const bashResults = artifacts.filter((a) => a.name === "bash_result");
    const fileReferences = artifacts.filter((a) => a.type === "file_reference");

    expect(bashResults).toHaveLength(2);
    expect(fileReferences).toHaveLength(2);

    // file_reference artifacts contain the file content
    const reportArtifact = fileReferences.find((a) => a.name === "report.md");
    expect(reportArtifact).toBeDefined();
    expect(reportArtifact?.content).toContain("analysis results");
    expect(reportArtifact?.mimeType).toBe("text/markdown");

    const dataArtifact = fileReferences.find((a) => a.name === "data.json");
    expect(dataArtifact).toBeDefined();
    expect(dataArtifact?.content).toContain('"score": 42');

    expect(getRunField(repo, run.id, "status")).toBe("completed");
    await workspace.dispose();
  });
});

describe("runAgent — activate_skill", () => {
  it("dispatches to sub-loop and creates child Task with Operations", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo, {
      skills: [{ name: "researcher", version: "1.0.0" }],
    });

    const mockSkill = createMockSkill("researcher");
    repo._skills.set("researcher", mockSkill);
    const toolImpl = createMockToolImpl("web-search");
    const toolRegistry = toolRegistryFromMap([["web-search", toolImpl]]);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Final"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: SPAWN_SUBAGENT_WITH_SKILL_TOOL_NAME,
          toolInput: { skill_name: "researcher", task_input: "What is X?" },
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([]);

    mockedRunSubagentLoop.mockResolvedValueOnce({
      text: '{"summary": "X is Y", "sources": [], "searchesPerformed": 1}',
      inputTokens: 200,
      outputTokens: 100,
      iterations: 2,
    });

    const workspace = await createWorkspace({ runId: run.id });
    const config = buildConfig(repo, { toolRegistry, workspace });
    await runAgent(run.id, config);
    await workspace.dispose();

    // Two tasks: root (_root) + child (researcher)
    const tasks = [...repo._tasks.values()];
    expect(tasks).toHaveLength(2);
    const skillTask = tasks.find((t) => t["subagentName"] === "researcher");
    expect(skillTask).toBeDefined();
    expect(skillTask?.["status"]).toBe("completed");

    // dispatchSubagent created invokes edge via linkSkill
    expect(repo._linkSkill).toHaveBeenCalledExactlyOnceWith(
      skillTask?.["id"],
      mockSkill.skill.id,
    );

    // runSubagentLoop was called with skill prompt as system prompt
    expect(mockedRunSubagentLoop).toHaveBeenCalledOnce();
    const callArguments = mockedRunSubagentLoop.mock.calls[0]?.[1];
    expect(callArguments?.system).toBe(mockSkill.prompt);

    // Output artifact created
    const artifacts = [...repo._artifacts.values()];
    expect(artifacts.some((a) => a.name === "researcher_output")).toBe(true);

    expect(getRunField(repo, run.id, "status")).toBe("completed");
  });
});

describe("runAgent — human-approval", () => {
  it("creates child HITL Task with Operation for human-approval", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: HUMAN_APPROVAL_SKILL_NAME,
          toolInput: { prompt: "Proceed?" },
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([]);

    const approvalSpy = vi.fn().mockResolvedValue("yes, approved");
    const config = buildConfig(repo, {
      hitlHandler: { requestApproval: approvalSpy },
    });
    await runAgent(run.id, config);

    expect(approvalSpy).toHaveBeenCalledOnce();

    // Root task + child HITL task
    const tasks = [...repo._tasks.values()];
    expect(tasks).toHaveLength(2);
    const hitlTask = tasks.find((t) => t["role"] === "hitl");
    expect(hitlTask).toBeDefined();
    expect(hitlTask?.["status"]).toBe("completed");

    // HITL operation on child task
    const operations = [...repo._operations.values()];
    expect(operations).toHaveLength(1);
    expect(operations[0]?.["type"]).toBe("hitl_response");
    expect(operations[0]?.["taskId"]).toBe(hitlTask?.["id"]);

    const artifacts = [...repo._artifacts.values()];
    expect(artifacts.some((a) => a.type === "hitl_decision")).toBe(true);
  });
});

describe("runAgent — HITL + workspace interaction", () => {
  it("bash tool and human-approval coexist in the same run", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    const workspace = await createWorkspace({ runId: run.id });
    const bashTool = createBashTool(workspace);
    const toolRegistry = toolRegistryFromMap([["bash", bashTool]]);

    // Iteration 1: model calls bash to create a file
    // Iteration 2: model requests human approval
    // Iteration 3: model finishes
    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("All done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "bash",
          toolInput: { command: 'echo "data" > result.txt' },
          toolUseId: "tu_bash",
        },
      ])
      .mockReturnValueOnce([
        {
          toolName: HUMAN_APPROVAL_SKILL_NAME,
          toolInput: { prompt: "Proceed with submission?" },
          toolUseId: "tu_hitl",
        },
      ])
      .mockReturnValueOnce([]);

    const approvalSpy = vi.fn().mockResolvedValue("approved");
    const config = buildConfig(repo, {
      toolRegistry,
      workspace,
      hitlHandler: { requestApproval: approvalSpy },
    });
    await runAgent(run.id, config);

    // Should have root + bash tool task + HITL task = 3
    const tasks = [...repo._tasks.values()];
    expect(tasks).toHaveLength(3);
    expect(tasks.filter((t) => t["role"] === "tool")).toHaveLength(1);
    expect(tasks.filter((t) => t["role"] === "hitl")).toHaveLength(1);

    // Bash operation succeeded
    const bashOp = [...repo._operations.values()].find(
      (o) => o["type"] === "tool_call",
    );
    expect(bashOp?.["status"]).toBe("succeeded");

    // HITL operation succeeded
    const hitlOp = [...repo._operations.values()].find(
      (o) => o["type"] === "hitl_response",
    );
    expect(hitlOp?.["status"]).toBe("succeeded");

    // Both artifact types present
    const artifacts = [...repo._artifacts.values()];
    expect(artifacts.some((a) => a.name === "bash_result")).toBe(true);
    expect(artifacts.some((a) => a.type === "hitl_decision")).toBe(true);

    expect(approvalSpy).toHaveBeenCalledOnce();
    expect(getRunField(repo, run.id, "status")).toBe("completed");
    await workspace.dispose();
  });
});

describe("runAgent — HITL deduplication", () => {
  it("reuses an existing HITL decision instead of asking again", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    // First call: model asks for approval (creates HITL task + decision)
    // Second call: model asks the same question → should be deduped
    // Third call: model finishes
    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: HUMAN_APPROVAL_SKILL_NAME,
          toolInput: { prompt: "Proceed with deletion?" },
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([
        {
          toolName: HUMAN_APPROVAL_SKILL_NAME,
          toolInput: { prompt: "Proceed with deletion?" },
          toolUseId: "tu_2",
        },
      ])
      .mockReturnValueOnce([]);

    const approvalSpy = vi.fn().mockResolvedValue("yes, approved");
    const config = buildConfig(repo, {
      hitlHandler: { requestApproval: approvalSpy },
    });
    await runAgent(run.id, config);

    // Human should only be asked once — second call is deduped
    expect(approvalSpy).toHaveBeenCalledOnce();
  });

  it("deduplicates prompts with different whitespace and capitalization", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: HUMAN_APPROVAL_SKILL_NAME,
          toolInput: { prompt: "Proceed with deletion?" },
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([
        {
          toolName: HUMAN_APPROVAL_SKILL_NAME,
          toolInput: { prompt: "  proceed  with  DELETION?  " },
          toolUseId: "tu_2",
        },
      ])
      .mockReturnValueOnce([]);

    const approvalSpy = vi.fn().mockResolvedValue("yes, approved");
    const config = buildConfig(repo, {
      hitlHandler: { requestApproval: approvalSpy },
    });
    await runAgent(run.id, config);

    // Normalized prompts match → human asked only once
    expect(approvalSpy).toHaveBeenCalledOnce();
  });

  it("asks separately for genuinely different prompts", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: HUMAN_APPROVAL_SKILL_NAME,
          toolInput: { prompt: "Proceed with deletion?" },
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([
        {
          toolName: HUMAN_APPROVAL_SKILL_NAME,
          toolInput: { prompt: "Should I also update the database?" },
          toolUseId: "tu_2",
        },
      ])
      .mockReturnValueOnce([]);

    const approvalSpy = vi.fn().mockResolvedValue("yes, approved");
    const config = buildConfig(repo, {
      hitlHandler: { requestApproval: approvalSpy },
    });
    await runAgent(run.id, config);

    // Different questions → human asked twice
    expect(approvalSpy).toHaveBeenCalledTimes(2);
  });
});

describe("runAgent — policy enforcement", () => {
  it("denies skill activation when policy is 'never'", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo, {
      skills: [
        { name: "researcher", version: "1.0.0", policy: { type: "never" } },
      ],
    });

    const mockSkill = createMockSkill("researcher");
    repo._skills.set("researcher", mockSkill);

    mockedComplete.mockResolvedValueOnce(completeResult(""));
    mockedParseAllToolUses.mockReturnValueOnce([
      {
        toolName: SPAWN_SUBAGENT_WITH_SKILL_TOOL_NAME,
        toolInput: { skill_name: "researcher", task_input: "test" },
        toolUseId: "tu_1",
      },
    ]);

    const config = buildConfig(repo);
    await expect(runAgent(run.id, config)).rejects.toThrow("policy");
    expect(getRunField(repo, run.id, "status")).toBe("failed");
  });
});

describe("runAgent — circuit breaker", () => {
  it("aborts after 3 consecutive failures", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    const failingTool = createMockToolImpl("web-search");
    (failingTool.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("fail"),
    );

    const toolRegistry = toolRegistryFromMap([["web-search", failingTool]]);

    for (let index = 0; index < 3; index++) {
      mockedComplete.mockResolvedValueOnce(completeResult(""));
      mockedParseAllToolUses.mockReturnValueOnce([
        {
          toolName: "web-search",
          toolInput: {},
          toolUseId: `tu_${index}`,
        },
      ]);
    }

    const config = buildConfig(repo, { toolRegistry });
    await expect(runAgent(run.id, config)).rejects.toThrow(
      "consecutive iteration failures",
    );
    expect(getRunField(repo, run.id, "status")).toBe("failed");
  });
});

describe("runAgent — limits", () => {
  it("fails when maxTokensPerRun exceeded", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo, {
      limits: {
        maxTasksPerRun: 50,
        maxOperationsPerTask: 1,
        maxTokensPerRun: 100,
      },
    });

    const toolImpl = createMockToolImpl("web-search");
    const toolRegistry = toolRegistryFromMap([["web-search", toolImpl]]);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult(""));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "web-search",
          toolInput: {},
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([
        {
          toolName: "web-search",
          toolInput: {},
          toolUseId: "tu_2",
        },
      ]);

    const config = buildConfig(repo, { toolRegistry });
    await expect(runAgent(run.id, config)).rejects.toThrow("Max tokens");
    expect(getRunField(repo, run.id, "status")).toBe("failed");
  });
});

describe("runAgent — error handling", () => {
  it("fails when definition not found", async () => {
    const repo = createMockRepo();
    const run: Run = {
      id: generateId(),
      agentDefinitionId: generateId(),
      agentDefinitionVersion: 1,
      status: "pending",
      input: "test",
      totalTokensUsed: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await repo.runs.create(run);

    const config = buildConfig(repo);
    await expect(runAgent(run.id, config)).rejects.toThrow(
      "definition not found",
    );
    expect(getRunField(repo, run.id, "status")).toBe("failed");
  });

  it("fails when run ID does not exist", async () => {
    const repo = createMockRepo();
    const config = buildConfig(repo);
    await expect(runAgent(generateId(), config)).rejects.toThrow(
      "Run not found",
    );
  });

  it("throws on unknown tool name", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    mockedComplete.mockResolvedValueOnce(completeResult(""));
    mockedParseAllToolUses.mockReturnValueOnce([
      {
        toolName: "nonexistent",
        toolInput: {},
        toolUseId: "tu_1",
      },
    ]);

    const config = buildConfig(repo);
    await expect(runAgent(run.id, config)).rejects.toThrow("Unknown tool");
    expect(getRunField(repo, run.id, "status")).toBe("failed");
  });
});

describe("runAgent — multi-turn messages", () => {
  it("passes growing message arrays to complete() across iterations", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    const toolImpl = createMockToolImpl("web-search", { results: [] });
    const toolRegistry = toolRegistryFromMap([["web-search", toolImpl]]);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Final answer"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "web-search",
          toolInput: { query: "first" },
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([
        {
          toolName: "web-search",
          toolInput: { query: "second" },
          toolUseId: "tu_2",
        },
      ])
      .mockReturnValueOnce([]);

    const config = buildConfig(repo, { toolRegistry });
    await runAgent(run.id, config);

    // First call: just the bootstrap user message
    const firstCallMessages = mockedComplete.mock.calls[0]?.[1]?.messages;
    expect(firstCallMessages).toHaveLength(1);

    // Second call: bootstrap + assistant + tool_result (3 messages)
    const secondCallMessages = mockedComplete.mock.calls[1]?.[1]?.messages;
    expect(secondCallMessages).toHaveLength(3);

    // Third call: bootstrap + 2 × (assistant + tool_result) = 5 messages
    const thirdCallMessages = mockedComplete.mock.calls[2]?.[1]?.messages;
    expect(thirdCallMessages).toHaveLength(5);

    expect(getRunField(repo, run.id, "status")).toBe("completed");
  });
});

describe("runAgent — concurrent dispatch", () => {
  it("dispatches multiple tool calls concurrently", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    const searchImpl = createMockToolImpl("web-search", { results: [] });
    const fetchImpl = createMockToolImpl("web-fetch", { html: "<p>hi</p>" });
    const toolRegistry = toolRegistryFromMap([
      ["web-search", searchImpl],
      ["web-fetch", fetchImpl],
    ]);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "web-search",
          toolInput: { query: "test" },
          toolUseId: "tu_1",
        },
        {
          toolName: "web-fetch",
          toolInput: { url: "http://example.com" },
          toolUseId: "tu_2",
        },
      ])
      .mockReturnValueOnce([]);

    const config = buildConfig(repo, { toolRegistry });
    await runAgent(run.id, config);

    // Both tools executed
    expect(searchImpl.execute).toHaveBeenCalledOnce();
    expect(fetchImpl.execute).toHaveBeenCalledOnce();

    // Root + 2 child tasks
    const tasks = [...repo._tasks.values()];
    expect(tasks).toHaveLength(3);
    expect(tasks.filter((t) => t["role"] === "tool")).toHaveLength(2);

    // Second call includes tool_result blocks for both
    const secondCallMessages = mockedComplete.mock.calls[1]?.[1]?.messages;
    expect(secondCallMessages).toBeDefined();
    const lastUserMessage = secondCallMessages?.at(-1);
    expect(Array.isArray(lastUserMessage?.content)).toBe(true);
    const toolResults = lastUserMessage?.content as unknown[];
    expect(toolResults).toHaveLength(2);

    expect(getRunField(repo, run.id, "status")).toBe("completed");
  });

  it("circuit breaker: partial failure does not trip", async () => {
    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    const successTool = createMockToolImpl("web-search", { results: [] });
    const failTool = createMockToolImpl("web-fetch");
    (failTool.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error"),
    );
    const toolRegistry = toolRegistryFromMap([
      ["web-search", successTool],
      ["web-fetch", failTool],
    ]);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Recovered"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        { toolName: "web-search", toolInput: {}, toolUseId: "tu_1" },
        { toolName: "web-fetch", toolInput: {}, toolUseId: "tu_2" },
      ])
      .mockReturnValueOnce([]);

    const config = buildConfig(repo, { toolRegistry });
    await runAgent(run.id, config);

    // Run completed despite one failure — circuit breaker didn't trip
    expect(getRunField(repo, run.id, "status")).toBe("completed");
  });
});

describe("runAgent — background task lifecycle", () => {
  it("returns 'in progress' for slow dispatch and surfaces result after completion", async () => {
    vi.useFakeTimers();

    const repo = createMockRepo();
    const { run } = await setupRun(repo);

    // Fast tool resolves immediately
    const fastTool = createMockToolImpl("web-search", { results: [] });

    // Slow tool takes 15s (exceeds DISPATCH_GATHER_TIMEOUT_MS = 10s)
    let resolveSlowTool!: (value: unknown) => void;
    const slowToolPromise = new Promise<unknown>((resolve) => {
      resolveSlowTool = resolve;
    });
    const slowTool: ToolImplementation = {
      tool: {
        name: "slow-fetch",
        version: "1.0.0",
        description: "Slow tool",
        inputSchema: { type: "object" as const, properties: {} },
        outputSchema: { type: "object" as const, properties: {} },
      },
      execute: vi.fn().mockReturnValue(slowToolPromise),
    };
    const toolRegistry = toolRegistryFromMap([
      ["web-search", fastTool],
      ["slow-fetch", slowTool],
    ]);

    // Iteration 1: model requests both tools
    // Iteration 2: after gather timeout, model sees fast result + "in progress"
    //              model returns no tool calls (waiting for background)
    // Iteration 3: slow tool completes, context rebuilt, model finishes
    mockedComplete
      .mockResolvedValueOnce(completeResult("")) // iteration 1
      .mockResolvedValueOnce(completeResult("")) // iteration 2: still waiting
      .mockResolvedValueOnce(completeResult("All done")); // iteration 3: sees results
    mockedParseAllToolUses
      .mockReturnValueOnce([
        { toolName: "web-search", toolInput: {}, toolUseId: "tu_1" },
        { toolName: "slow-fetch", toolInput: {}, toolUseId: "tu_2" },
      ])
      .mockReturnValueOnce([]) // iteration 2: no actions, but background pending
      .mockReturnValueOnce([]); // iteration 3: done

    const config = buildConfig(repo, { toolRegistry });
    const runPromise = runAgent(run.id, config);

    // Flush microtasks so the fast tool's sha256 (Web Crypto) resolves
    // before we advance past the gather timeout.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    // Advance past the gather timeout (10s) so slow-fetch becomes "pending"
    await vi.advanceTimersByTimeAsync(11_000);

    // Now resolve the slow tool
    resolveSlowTool({ data: "slow result" });

    // Let microtasks settle (including sha256 for the slow tool result)
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);

    vi.useRealTimers();
    await runPromise;

    // Both tools were executed
    expect(fastTool.execute).toHaveBeenCalledOnce();
    expect(slowTool.execute).toHaveBeenCalledOnce();

    // Iteration 2 should have the "in progress" tool_result
    const secondCallMessages = mockedComplete.mock.calls[1]?.[1]?.messages;
    expect(secondCallMessages).toBeDefined();
    const lastUserMessage = secondCallMessages?.at(-1);
    expect(Array.isArray(lastUserMessage?.content)).toBe(true);
    const inProgress = (
      lastUserMessage!.content as Array<{ content?: string }>
    ).find(
      (b) => typeof b.content === "string" && b.content.includes("in progress"),
    );
    expect(inProgress).toBeDefined();

    // Iteration 3: context was rebuilt (history message reset)
    // so messages array has just 1 message (fresh buildContext)
    const thirdCallMessages = mockedComplete.mock.calls[2]?.[1]?.messages;
    expect(thirdCallMessages).toHaveLength(1);

    // Run completed
    expect(getRunField(repo, run.id, "status")).toBe("completed");
  });
});

describe("runAgent — compression", () => {
  it("triggers compression when recent messages exceed budget", async () => {
    const repo = createMockRepo();
    // Budget: maxTokensPerRun(1500) × CONTEXT_BUDGET_RATIO(0.4) = 600 token context.
    // Recent turn budget: 600 × RECENT_TURN_BUDGET_RATIO(0.5) = 300 tokens.
    // Tool result: 2000 chars of prose → estimateTokens = 500 → exceeds 300 after 1 iteration.
    // Compression triggers at start of iter 2.
    const { run } = await setupRun(repo, {
      limits: {
        maxTasksPerRun: 50,
        maxOperationsPerTask: 10,
        maxTokensPerRun: 1500,
      },
    });

    const toolImpl = createMockToolImpl("web-search", {
      results: "x".repeat(2000),
    });
    const toolRegistry = toolRegistryFromMap([["web-search", toolImpl]]);

    // Mock ordering: iter1-main, compression, iter2-main
    mockedComplete
      .mockResolvedValueOnce(completeResult("")) // iter 1 main
      .mockResolvedValueOnce(completeResult("Summary")) // compression
      .mockResolvedValueOnce(completeResult("Done")); // iter 2 main
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "web-search",
          toolInput: {},
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([]);

    const config = buildConfig(repo, { toolRegistry });
    await runAgent(run.id, config);

    expect(getRunField(repo, run.id, "status")).toBe("completed");

    // Compression should have created a compaction record
    // (the mock repo doesn't store compactions, but we can verify complete()
    // was called with the compression system prompt)
    const compressionCall = mockedComplete.mock.calls.find(
      (call) =>
        typeof call[1]?.system === "string" &&
        call[1].system.includes("compression"),
    );
    expect(compressionCall).toBeDefined();
  });
});
