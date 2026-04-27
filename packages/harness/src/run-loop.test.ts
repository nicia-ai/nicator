/**
 * Integration tests for the agent run loop against a real TypeGraph-backed
 * Repository (in-memory libsql). The SDK is still mocked so tests do not
 * hit Anthropic, but every persistence operation goes through the production
 * Repository → TypeGraph → SQLite path.
 */
import type { Run } from "@nicator/core";
import {
  ANSWER_FROM_ARTIFACT_TOOL_NAME,
  buildArtifact,
  generateId,
  HUMAN_APPROVAL_SKILL_NAME,
  now,
  SKILL_TOOL_NAME,
} from "@nicator/core";
import { createBashTool, createWorkspace } from "@nicator/workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toolRegistryFromMap } from "./registries.js";
import { runAgent } from "./run-loop.js";
import {
  createTestHarness,
  getAllOperations,
  type TestHarness,
} from "./test-harness.js";
import type { HarnessConfig, ToolImplementation } from "./types.js";

// SDK mock — keeps the run loop off the network. complete() and
// parseAllToolUses() are injected with scripted responses per test.

vi.mock("@nicator/sdk", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock requires dynamic import
  const original = await importOriginal<typeof import("@nicator/sdk")>();
  const mockSubagentLoop = vi.fn();
  return {
    ...original,
    complete: vi.fn(),
    parseAllToolUses: vi.fn(),
    buildAgentTool: original.buildAgentTool,
    buildDirectToolDefinitions: original.buildDirectToolDefinitions,
    buildSkillTool: original.buildSkillTool,
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

/** Per-test setup: harness + agent definition + run, ready for runAgent(). */
async function newTestRun(
  harness: TestHarness,
  overrides: {
    skills?: ReadonlyArray<{
      name: string;
      version: string;
      policy?:
        | { type: "always" | "never" }
        | {
            type: "require_hitl_approval";
            approverPrompt: string;
          }
        | { type: "max_calls_per_run"; limit: number };
    }>;
    limits?: {
      maxTasksPerRun: number;
      maxOperationsPerTask: number;
      maxTokensPerRun: number;
    };
    autoFinalizeFromSubagent?: string;
  } = {},
): Promise<{ run: Run }> {
  // Seed any referenced skills so the definition's `uses` edges resolve
  await Promise.all(
    (overrides.skills ?? []).map((ref) =>
      harness.seedSkill({ name: ref.name, version: ref.version }),
    ),
  );
  const definition = await harness.seedDefinition({
    skills: overrides.skills ?? [],
    ...(overrides.autoFinalizeFromSubagent === undefined ?
      {}
    : { autoFinalizeFromSubagent: overrides.autoFinalizeFromSubagent }),
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
  });
  const run = await harness.seedRun(definition.id, { status: "pending" });
  return { run };
}

function expectRunStatus(
  harness: TestHarness,
  runId: string,
  status: "completed",
): Promise<(Run & { status: "completed" }) | undefined>;
function expectRunStatus(
  harness: TestHarness,
  runId: string,
  status: "failed",
): Promise<(Run & { status: "failed" }) | undefined>;
async function expectRunStatus(
  harness: TestHarness,
  runId: string,
  status: Run["status"],
): Promise<Run | undefined> {
  const run = await harness.repo.runs.get(runId);
  expect(run?.status).toBe(status);
  return run;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let harness: TestHarness;

beforeEach(async () => {
  vi.resetAllMocks();
  harness = await createTestHarness();
});

afterEach(() => {
  harness.dispose();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAgent — completion without tool use", () => {
  it("completes when the model returns text with no tool call", async () => {
    const { run } = await newTestRun(harness);

    mockedComplete.mockResolvedValueOnce(completeResult("Final answer"));
    mockedParseAllToolUses.mockReturnValueOnce([]);

    await runAgent(run.id, harness.config);

    const finishedRun = await expectRunStatus(harness, run.id, "completed");
    expect(finishedRun?.output).toBe("Final answer");
  });
});

describe("runAgent — direct tool calls", () => {
  it("creates child Task with Operation and Artifact for a direct tool call", async () => {
    const { run } = await newTestRun(harness);

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

    const config: HarnessConfig = { ...harness.config, toolRegistry };
    await runAgent(run.id, config);

    // Root task + child tool task
    const tasks = await harness.repo.tasks.getForRun(run.id);
    expect(tasks).toHaveLength(2);
    const rootTask = tasks.find((t) => t.role === "root");
    const toolTask = tasks.find((t) => t.role === "tool");
    expect(rootTask).toBeDefined();
    expect(toolTask).toBeDefined();
    expect(toolTask?.status).toBe("completed");

    // Operation created on child task
    const operations = await getAllOperations(harness.repo, run.id);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.status).toBe("succeeded");
    expect(operations[0]?.taskId).toBe(toolTask?.id);

    // Artifact created with tool result
    const artifacts = await harness.repo.artifacts.getForRun(run.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("web-search_result");

    // Tool was executed
    expect(toolImpl.execute).toHaveBeenCalledWith({ query: "test" });

    await expectRunStatus(harness, run.id, "completed");
  });

  it("marks operation as failed when tool throws", async () => {
    const { run } = await newTestRun(harness);

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

    const config: HarnessConfig = { ...harness.config, toolRegistry };
    await runAgent(run.id, config);

    const operations = await getAllOperations(harness.repo, run.id);
    expect(operations[0]?.status).toBe("failed");
    await expectRunStatus(harness, run.id, "completed");
  });

  it("completes immediately from answer_from_artifact using exact artifact content", async () => {
    const { run } = await newTestRun(harness);
    const taskId = generateId();
    const operationId = generateId();
    const artifact = await buildArtifact(
      "text",
      "synthesizer_output",
      "GAP-01 | HIGH | Exact artifact output",
    );
    const timestamp = now();

    await harness.repo.tasks.create({
      id: taskId,
      runId: run.id,
      role: "subagent",
      subagentName: "synthesizer",
      status: "completed",
      input: { task_input: "synthesize" },
      sequenceNumber: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await harness.repo.operations.create({
      id: operationId,
      taskId,
      runId: run.id,
      type: "tool_call",
      status: "succeeded",
      operationNumber: 1,
      input: { task_input: "synthesize" },
      output: { text: artifact.content },
      inputTokens: 0,
      outputTokens: 0,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    await harness.repo.artifacts.createAndLinkProduced(
      artifact,
      operationId,
      run.id,
    );

    mockedComplete.mockResolvedValueOnce(completeResult(""));
    mockedParseAllToolUses.mockReturnValueOnce([
      {
        toolName: ANSWER_FROM_ARTIFACT_TOOL_NAME,
        toolInput: { artifact_id: artifact.id },
        toolUseId: "tu_1",
      },
    ]);

    await runAgent(run.id, harness.config);

    const finishedRun = await expectRunStatus(harness, run.id, "completed");
    expect(finishedRun?.output).toBe("GAP-01 | HIGH | Exact artifact output");
  });

  it("can resolve answer_from_artifact by artifact_query", async () => {
    const { run } = await newTestRun(harness);
    const taskId = generateId();
    const operationId = generateId();
    const artifact = await buildArtifact(
      "text",
      "synthesizer_output",
      "GAP-02 | HIGH | Query-resolved artifact output",
    );
    const timestamp = now();

    await harness.repo.tasks.create({
      id: taskId,
      runId: run.id,
      role: "subagent",
      subagentName: "synthesizer",
      status: "completed",
      input: { task_input: "synthesize" },
      sequenceNumber: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await harness.repo.operations.create({
      id: operationId,
      taskId,
      runId: run.id,
      type: "tool_call",
      status: "succeeded",
      operationNumber: 1,
      input: { task_input: "synthesize" },
      output: { text: artifact.content },
      inputTokens: 0,
      outputTokens: 0,
      createdAt: timestamp,
      completedAt: timestamp,
    });
    await harness.repo.artifacts.createAndLinkProduced(
      artifact,
      operationId,
      run.id,
    );

    mockedComplete.mockResolvedValueOnce(completeResult(""));
    mockedParseAllToolUses.mockReturnValueOnce([
      {
        toolName: ANSWER_FROM_ARTIFACT_TOOL_NAME,
        toolInput: {
          artifact_query: { produced_by_subagent: "synthesizer", limit: 1 },
        },
        toolUseId: "tu_query_1",
      },
    ]);

    await runAgent(run.id, harness.config);

    const finishedRun = await expectRunStatus(harness, run.id, "completed");
    expect(finishedRun?.output).toBe(
      "GAP-02 | HIGH | Query-resolved artifact output",
    );
  });
});

describe("runAgent — artifact system tools", () => {
  it("treats malformed read_artifact input as a recoverable tool failure", async () => {
    const { run } = await newTestRun(harness);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Recovered"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "read_artifact",
          toolInput: {},
          toolUseId: "tu_bad_read_1",
        },
      ])
      .mockReturnValueOnce([]);

    await runAgent(run.id, harness.config);

    const tasks = await harness.repo.tasks.getForRun(run.id);
    const failedToolTask = tasks.find((t) => t.role === "tool");
    expect(failedToolTask?.status).toBe("failed");

    const operations = await getAllOperations(harness.repo, run.id);
    expect(operations).toHaveLength(0);

    const finishedRun = await expectRunStatus(harness, run.id, "completed");
    expect(finishedRun?.output).toBe("Recovered");
  });

  it("can look up artifacts by producer metadata", async () => {
    const { run } = await newTestRun(harness);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "lookup_artifacts",
          toolInput: { name_contains: "policy", include_input_artifacts: true },
          toolUseId: "tu_lookup_1",
        },
      ])
      .mockReturnValueOnce([]);

    const config: HarnessConfig = {
      ...harness.config,
      inputArtifacts: [
        {
          name: "policy-doc",
          type: "input_document",
          content: "policy content",
        },
      ],
    };
    await runAgent(run.id, config);

    const artifacts = await harness.repo.artifacts.getForRun(run.id);
    const lookupResult = artifacts.find(
      (a) => a.name === "lookup_artifacts_result",
    );
    expect(lookupResult).toBeDefined();
    expect(lookupResult?.content).toContain('"artifact_id"');
    expect(lookupResult?.content).toContain("policy-doc");
    await expectRunStatus(harness, run.id, "completed");
  });

  it("can write a coordinator checkpoint artifact", async () => {
    const { run } = await newTestRun(harness);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "write_artifact",
          toolInput: {
            name: "claim-registry",
            content: '{"artifact_ids":["a","b"]}',
            type: "json",
          },
          toolUseId: "tu_write_1",
        },
      ])
      .mockReturnValueOnce([]);

    await runAgent(run.id, harness.config);

    const artifacts = await harness.repo.artifacts.getForRun(run.id);
    const checkpoint = artifacts.find((a) => a.name === "claim-registry");
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.type).toBe("json");
    expect(checkpoint?.mimeType).toBe("application/json");
    expect(checkpoint?.content).toBe('{"artifact_ids":["a","b"]}');
    await expectRunStatus(harness, run.id, "completed");
  });

  it("treats malformed write_artifact input as a recoverable tool failure", async () => {
    const { run } = await newTestRun(harness);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Recovered"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "write_artifact",
          toolInput: { content: "missing name" },
          toolUseId: "tu_bad_write_1",
        },
      ])
      .mockReturnValueOnce([]);

    await runAgent(run.id, harness.config);

    const tasks = await harness.repo.tasks.getForRun(run.id);
    const failedToolTask = tasks.find((t) => t.role === "tool");
    expect(failedToolTask?.status).toBe("failed");

    const operations = await getAllOperations(harness.repo, run.id);
    expect(operations).toHaveLength(0);

    const finishedRun = await expectRunStatus(harness, run.id, "completed");
    expect(finishedRun?.output).toBe("Recovered");
  });

  it("treats malformed answer_from_artifact input as a recoverable tool failure", async () => {
    const { run } = await newTestRun(harness);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Recovered"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: ANSWER_FROM_ARTIFACT_TOOL_NAME,
          toolInput: {},
          toolUseId: "tu_bad_answer_1",
        },
      ])
      .mockReturnValueOnce([]);

    await runAgent(run.id, harness.config);

    const tasks = await harness.repo.tasks.getForRun(run.id);
    const failedToolTask = tasks.find((t) => t.role === "tool");
    expect(failedToolTask?.status).toBe("failed");

    const operations = await getAllOperations(harness.repo, run.id);
    expect(operations).toHaveLength(0);

    const finishedRun = await expectRunStatus(harness, run.id, "completed");
    expect(finishedRun?.output).toBe("Recovered");
  });
});

describe("runAgent — bash tool dispatch", () => {
  it("executes a bash command and records Operation + Artifact", async () => {
    const { run } = await newTestRun(harness);

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

    const config: HarnessConfig = {
      ...harness.config,
      toolRegistry,
      workspace,
    };
    await runAgent(run.id, config);

    const tasks = await harness.repo.tasks.getForRun(run.id);
    const bashTask = tasks.find((t) => t.role === "tool");
    expect(bashTask).toBeDefined();
    expect(bashTask?.status).toBe("completed");

    const operations = await getAllOperations(harness.repo, run.id);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.status).toBe("succeeded");

    const artifacts = await harness.repo.artifacts.getForRun(run.id);
    const bashResult = artifacts.find((a) => a.name === "bash_result");
    expect(bashResult).toBeDefined();
    const content = JSON.parse(bashResult?.content ?? "{}") as {
      stdout: string;
      exitCode: number;
    };
    expect(content.stdout).toContain("hello from bash");
    expect(content.exitCode).toBe(0);

    await expectRunStatus(harness, run.id, "completed");
    await workspace.dispose();
  });

  it("records file_reference artifacts via save_artifact on completion", async () => {
    const { run } = await newTestRun(harness);

    const workspace = await createWorkspace({ runId: run.id });
    const bashTool = createBashTool(workspace);
    const toolRegistry = toolRegistryFromMap([["bash", bashTool]]);

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

    const config: HarnessConfig = {
      ...harness.config,
      toolRegistry,
      workspace,
    };
    await runAgent(run.id, config);

    const artifacts = await harness.repo.artifacts.getForRun(run.id);
    const bashResults = artifacts.filter((a) => a.name === "bash_result");
    const fileReferences = artifacts.filter((a) => a.type === "file_reference");

    expect(bashResults).toHaveLength(2);
    expect(fileReferences).toHaveLength(2);

    const reportArtifact = fileReferences.find((a) => a.name === "report.md");
    expect(reportArtifact).toBeDefined();
    expect(reportArtifact?.content).toContain("analysis results");
    expect(reportArtifact?.mimeType).toBe("text/markdown");

    const dataArtifact = fileReferences.find((a) => a.name === "data.json");
    expect(dataArtifact).toBeDefined();
    expect(dataArtifact?.content).toContain('"score": 42');

    await expectRunStatus(harness, run.id, "completed");
    await workspace.dispose();
  });
});

describe("runAgent — activate_skill", () => {
  it("dispatches to sub-loop and creates child Task with invokes edge", async () => {
    const { run } = await newTestRun(harness, {
      skills: [{ name: "researcher", version: "1.0.0" }],
    });

    const toolImpl = createMockToolImpl("web-search");
    const toolRegistry = toolRegistryFromMap([["web-search", toolImpl]]);

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Final"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: SKILL_TOOL_NAME,
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
    const config: HarnessConfig = {
      ...harness.config,
      toolRegistry,
      workspace,
    };
    await runAgent(run.id, config);
    await workspace.dispose();

    // Two tasks: root + child (researcher)
    const tasks = await harness.repo.tasks.getForRun(run.id);
    expect(tasks).toHaveLength(2);
    const skillTask = tasks.find((t) => t.subagentName === "researcher");
    expect(skillTask).toBeDefined();
    expect(skillTask?.status).toBe("completed");

    // invokes edge is visible via lineage (skill resolved on the task entry)
    const lineage = await harness.repo.lineage.getRunLineage(run.id);
    const skillEntry = lineage!.tasks.find((t) => t.task.id === skillTask!.id);
    expect(skillEntry?.skill?.name).toBe("researcher");

    // runSubagentLoop was called with the skill prompt as system prompt
    expect(mockedRunSubagentLoop).toHaveBeenCalledOnce();
    const callArguments = mockedRunSubagentLoop.mock.calls[0]?.[1];
    expect(typeof callArguments?.system).toBe("string");
    expect(callArguments?.system).toContain("researcher");

    // Output artifact created
    const artifacts = await harness.repo.artifacts.getForRun(run.id);
    expect(artifacts.some((a) => a.name === "researcher_output")).toBe(true);

    await expectRunStatus(harness, run.id, "completed");
  });

  it("can auto-finalize from a configured subagent artifact without another coordinator turn", async () => {
    const { run } = await newTestRun(harness, {
      skills: [{ name: "synthesizer", version: "1.0.0" }],
      autoFinalizeFromSubagent: "synthesizer",
    });

    mockedComplete.mockResolvedValueOnce(completeResult(""));
    mockedParseAllToolUses.mockReturnValueOnce([
      {
        toolName: SKILL_TOOL_NAME,
        toolInput: {
          skill_name: "synthesizer",
          task_input: "Produce the final control-gap register.",
        },
        toolUseId: "tu_auto_finalize_1",
      },
    ]);
    mockedRunSubagentLoop.mockResolvedValueOnce({
      text: "GAP-10 | HIGH | Final output from synthesizer",
      inputTokens: 200,
      outputTokens: 100,
      iterations: 1,
    });

    const workspace = await createWorkspace({ runId: run.id });
    const config: HarnessConfig = {
      ...harness.config,
      workspace,
    };
    await runAgent(run.id, config);
    await workspace.dispose();

    expect(mockedComplete).toHaveBeenCalledOnce();

    const finishedRun = await expectRunStatus(harness, run.id, "completed");
    expect(finishedRun?.output).toBe(
      "GAP-10 | HIGH | Final output from synthesizer",
    );

    const tasks = await harness.repo.tasks.getForRun(run.id);
    expect(
      tasks.some(
        (t) =>
          t.role === "tool" &&
          t.subagentName === ANSWER_FROM_ARTIFACT_TOOL_NAME,
      ),
    ).toBe(false);
  });
});

describe("runAgent — human-approval", () => {
  it("creates child HITL Task with Operation for human-approval", async () => {
    const localHarness = await createTestHarness({
      hitl: { decisions: ["yes, approved"] },
    });
    try {
      const { run } = await newTestRun(localHarness);

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

      await runAgent(run.id, localHarness.config);

      expect(localHarness.hitl.calls).toHaveLength(1);

      // Root task + child HITL task
      const tasks = await localHarness.repo.tasks.getForRun(run.id);
      expect(tasks).toHaveLength(2);
      const hitlTask = tasks.find((t) => t.role === "hitl");
      expect(hitlTask).toBeDefined();
      expect(hitlTask?.status).toBe("completed");

      // HITL operation on child task
      const operations = await getAllOperations(localHarness.repo, run.id);
      expect(operations).toHaveLength(1);
      expect(operations[0]?.type).toBe("hitl_response");
      expect(operations[0]?.taskId).toBe(hitlTask?.id);

      const artifacts = await localHarness.repo.artifacts.getForRun(run.id);
      expect(artifacts.some((a) => a.type === "hitl_decision")).toBe(true);
    } finally {
      localHarness.dispose();
    }
  });
});

describe("runAgent — HITL + workspace interaction", () => {
  it("bash tool and human-approval coexist in the same run", async () => {
    const localHarness = await createTestHarness({
      hitl: { decisions: ["approved"] },
    });
    try {
      const { run } = await newTestRun(localHarness);
      const workspace = await createWorkspace({ runId: run.id });
      const bashTool = createBashTool(workspace);
      const toolRegistry = toolRegistryFromMap([["bash", bashTool]]);

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

      const config: HarnessConfig = {
        ...localHarness.config,
        toolRegistry,
        workspace,
      };
      await runAgent(run.id, config);

      const tasks = await localHarness.repo.tasks.getForRun(run.id);
      expect(tasks).toHaveLength(3);
      expect(tasks.filter((t) => t.role === "tool")).toHaveLength(1);
      expect(tasks.filter((t) => t.role === "hitl")).toHaveLength(1);

      const operations = await getAllOperations(localHarness.repo, run.id);
      const bashOp = operations.find((o) => o.type === "tool_call");
      expect(bashOp?.status).toBe("succeeded");
      const hitlOp = operations.find((o) => o.type === "hitl_response");
      expect(hitlOp?.status).toBe("succeeded");

      const artifacts = await localHarness.repo.artifacts.getForRun(run.id);
      expect(artifacts.some((a) => a.name === "bash_result")).toBe(true);
      expect(artifacts.some((a) => a.type === "hitl_decision")).toBe(true);

      expect(localHarness.hitl.calls).toHaveLength(1);
      await expectRunStatus(localHarness, run.id, "completed");
      await workspace.dispose();
    } finally {
      localHarness.dispose();
    }
  });
});

describe("runAgent — HITL deduplication", () => {
  it("reuses an existing HITL decision instead of asking again", async () => {
    const localHarness = await createTestHarness({
      hitl: { defaultDecision: "yes, approved" },
    });
    try {
      const { run } = await newTestRun(localHarness);

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

      await runAgent(run.id, localHarness.config);

      // Human should only be asked once — second call is deduped
      expect(localHarness.hitl.calls).toHaveLength(1);
    } finally {
      localHarness.dispose();
    }
  });

  it("deduplicates prompts with different whitespace and capitalization", async () => {
    const localHarness = await createTestHarness({
      hitl: { defaultDecision: "yes, approved" },
    });
    try {
      const { run } = await newTestRun(localHarness);

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

      await runAgent(run.id, localHarness.config);

      // Normalized prompts match → human asked only once
      expect(localHarness.hitl.calls).toHaveLength(1);
    } finally {
      localHarness.dispose();
    }
  });

  it("asks separately for genuinely different prompts", async () => {
    const localHarness = await createTestHarness({
      hitl: { defaultDecision: "yes, approved" },
    });
    try {
      const { run } = await newTestRun(localHarness);

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

      await runAgent(run.id, localHarness.config);

      expect(localHarness.hitl.calls).toHaveLength(2);
    } finally {
      localHarness.dispose();
    }
  });
});

describe("runAgent — policy enforcement", () => {
  it("denies skill activation when policy is 'never'", async () => {
    const { run } = await newTestRun(harness, {
      skills: [
        { name: "researcher", version: "1.0.0", policy: { type: "never" } },
      ],
    });

    mockedComplete.mockResolvedValueOnce(completeResult(""));
    mockedParseAllToolUses.mockReturnValueOnce([
      {
        toolName: SKILL_TOOL_NAME,
        toolInput: { skill_name: "researcher", task_input: "test" },
        toolUseId: "tu_1",
      },
    ]);

    // Workspace required for skill dispatch path
    const workspace = await createWorkspace({ runId: run.id });
    const config: HarnessConfig = { ...harness.config, workspace };
    await expect(runAgent(run.id, config)).rejects.toThrow("policy");
    await expectRunStatus(harness, run.id, "failed");
    await workspace.dispose();
  });
});

describe("runAgent — circuit breaker", () => {
  it("aborts after 3 consecutive failures", async () => {
    const { run } = await newTestRun(harness);

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

    const config: HarnessConfig = { ...harness.config, toolRegistry };
    await expect(runAgent(run.id, config)).rejects.toThrow(
      "consecutive iteration failures",
    );
    await expectRunStatus(harness, run.id, "failed");
  });
});

describe("runAgent — limits", () => {
  it("fails when maxTokensPerRun exceeded", async () => {
    const { run } = await newTestRun(harness, {
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

    const config: HarnessConfig = { ...harness.config, toolRegistry };
    await expect(runAgent(run.id, config)).rejects.toThrow("Max tokens");
    await expectRunStatus(harness, run.id, "failed");
  });
});

describe("runAgent — error handling", () => {
  it("fails when run ID does not exist", async () => {
    await expect(runAgent(generateId(), harness.config)).rejects.toThrow(
      "Run not found",
    );
  });

  it("throws on unknown tool name", async () => {
    const { run } = await newTestRun(harness);

    mockedComplete.mockResolvedValueOnce(completeResult(""));
    mockedParseAllToolUses.mockReturnValueOnce([
      {
        toolName: "nonexistent",
        toolInput: {},
        toolUseId: "tu_1",
      },
    ]);

    await expect(runAgent(run.id, harness.config)).rejects.toThrow(
      "Unknown tool",
    );
    await expectRunStatus(harness, run.id, "failed");
  });
});

describe("runAgent — multi-turn messages", () => {
  it("passes growing message arrays to complete() across iterations", async () => {
    const { run } = await newTestRun(harness);

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

    const config: HarnessConfig = { ...harness.config, toolRegistry };
    await runAgent(run.id, config);

    const firstCallMessages = mockedComplete.mock.calls[0]?.[1]?.messages;
    expect(firstCallMessages).toHaveLength(1);

    const secondCallMessages = mockedComplete.mock.calls[1]?.[1]?.messages;
    expect(secondCallMessages).toHaveLength(3);

    const thirdCallMessages = mockedComplete.mock.calls[2]?.[1]?.messages;
    expect(thirdCallMessages).toHaveLength(5);

    await expectRunStatus(harness, run.id, "completed");
  });
});

describe("runAgent — concurrent dispatch", () => {
  it("dispatches multiple tool calls concurrently", async () => {
    const { run } = await newTestRun(harness);

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

    const config: HarnessConfig = { ...harness.config, toolRegistry };
    await runAgent(run.id, config);

    expect(searchImpl.execute).toHaveBeenCalledOnce();
    expect(fetchImpl.execute).toHaveBeenCalledOnce();

    const tasks = await harness.repo.tasks.getForRun(run.id);
    expect(tasks).toHaveLength(3);
    expect(tasks.filter((t) => t.role === "tool")).toHaveLength(2);

    const secondCallMessages = mockedComplete.mock.calls[1]?.[1]?.messages;
    expect(secondCallMessages).toBeDefined();
    const lastUserMessage = secondCallMessages?.at(-1);
    expect(Array.isArray(lastUserMessage?.content)).toBe(true);
    const toolResults = lastUserMessage?.content as unknown[];
    expect(toolResults).toHaveLength(2);

    await expectRunStatus(harness, run.id, "completed");
  });

  it("circuit breaker: partial failure does not trip", async () => {
    const { run } = await newTestRun(harness);

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

    const config: HarnessConfig = { ...harness.config, toolRegistry };
    await runAgent(run.id, config);

    expect(successTool.execute).toHaveBeenCalledOnce();
    expect(failTool.execute).toHaveBeenCalledOnce();
    await expectRunStatus(harness, run.id, "completed");
  });
});

describe("runAgent — background task lifecycle", () => {
  it("returns 'in progress' for slow dispatch and surfaces result after completion", async () => {
    vi.useFakeTimers();

    const { run } = await newTestRun(harness);

    const fastTool = createMockToolImpl("web-search", { results: [] });

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

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("All done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        { toolName: "web-search", toolInput: {}, toolUseId: "tu_1" },
        { toolName: "slow-fetch", toolInput: {}, toolUseId: "tu_2" },
      ])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);

    const config: HarnessConfig = { ...harness.config, toolRegistry };
    const runPromise = runAgent(run.id, config);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(11_000);

    resolveSlowTool({ data: "slow result" });

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);

    vi.useRealTimers();
    await runPromise;

    expect(fastTool.execute).toHaveBeenCalledOnce();
    expect(slowTool.execute).toHaveBeenCalledOnce();

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

    const thirdCallMessages = mockedComplete.mock.calls[2]?.[1]?.messages;
    expect(thirdCallMessages).toHaveLength(1);

    await expectRunStatus(harness, run.id, "completed");
  });
});

describe("runAgent — compression", () => {
  it("triggers compression when recent messages exceed budget", async () => {
    const { run } = await newTestRun(harness, {
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

    mockedComplete
      .mockResolvedValueOnce(completeResult(""))
      .mockResolvedValueOnce(completeResult("Summary"))
      .mockResolvedValueOnce(completeResult("Done"));
    mockedParseAllToolUses
      .mockReturnValueOnce([
        {
          toolName: "web-search",
          toolInput: {},
          toolUseId: "tu_1",
        },
      ])
      .mockReturnValueOnce([]);

    const config: HarnessConfig = { ...harness.config, toolRegistry };
    await runAgent(run.id, config);

    await expectRunStatus(harness, run.id, "completed");

    const compressionCall = mockedComplete.mock.calls.find(
      (call) =>
        typeof call[1]?.system === "string" &&
        call[1].system.includes("compression"),
    );
    expect(compressionCall).toBeDefined();
  });
});
