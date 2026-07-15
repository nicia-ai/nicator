/**
 * Integration tests for skill dispatch and ad-hoc subagent spawn.
 *
 * These exercise handleSkillCall, handleAgentCall, and
 * willRequireHitl against a real TypeGraph-backed Repository so that
 * graph invariants (edge creation, policy ordering, artifact linkage)
 * are actually verified — not faked by a Map-based mock.
 */
import type { AgentDefinition } from "@nicator/core";
import {
  AGENT_TOOL_NAME,
  buildArtifact,
  HUMAN_APPROVAL_SKILL_NAME,
  SKILL_TOOL_NAME,
} from "@nicator/core";
import { makeDefinition } from "@nicator/core/test-factories";
import type * as NicatorSdk from "@nicator/sdk";
import { createWorkspace, type Workspace } from "@nicator/workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyToolRegistry, toolRegistryFromMap } from "./registries.js";
import {
  handleAgentCall,
  handleSkillCall,
  willRequireHitl,
} from "./skill-dispatch.js";
import { createTestHarness, type TestHarness } from "./test-harness.js";
import type { DispatchOptions, ToolImplementation } from "./types.js";

vi.mock("@nicator/sdk", async (importOriginal) => {
  const original = await importOriginal<typeof NicatorSdk>();
  return {
    ...original,
    runSubagentLoop: vi.fn(),
    runSkillLoop: vi.fn(),
    complete: vi.fn(),
    countTokens: vi.fn().mockResolvedValue(0),
  };
});

const { runSubagentLoop } = await import("@nicator/sdk");
const mockedRunSubagentLoop = vi.mocked(runSubagentLoop);

function mockSubagentResult(text: string) {
  mockedRunSubagentLoop.mockResolvedValueOnce({
    text,
    inputTokens: 120,
    outputTokens: 60,
    iterations: 1,
  });
}

type Cleanup = () => Promise<void>;

type SkillDispatchFixture = Readonly<{
  workspace: Workspace;
  definition: AgentDefinition;
  runId: string;
  rootTaskId: string;
}>;

let harness: TestHarness;
let cleanups: Cleanup[] = [];

function track<T extends { dispose: () => void | Promise<void> }>(thing: T): T {
  cleanups.push(async () => {
    await thing.dispose();
  });
  return thing;
}

async function setupSkillDispatch(
  h: TestHarness,
  options: {
    skillName?: string;
    policy?: AgentDefinition["skills"][number]["policy"];
    allowDirectTools?: boolean;
    allowReadArtifact?: boolean;
    maxIterations?: number;
    subagentResultMode?: AgentDefinition["subagentResultMode"];
  } = {},
): Promise<SkillDispatchFixture> {
  const skillName = options.skillName ?? "researcher";
  const workspace = track(await createWorkspace({ runId: "test-run" }));
  await h.seedSkill({
    name: skillName,
    version: "1.0.0",
    ...(options.allowDirectTools === undefined ?
      {}
    : { allowDirectTools: options.allowDirectTools }),
    ...(options.allowReadArtifact === undefined ?
      {}
    : { allowReadArtifact: options.allowReadArtifact }),
    ...(options.maxIterations === undefined ?
      {}
    : { maxIterations: options.maxIterations }),
    workspace,
  });
  const definition = await h.seedDefinition({
    ...(options.subagentResultMode === undefined ?
      {}
    : { subagentResultMode: options.subagentResultMode }),
    skills: [
      {
        name: skillName,
        version: "1.0.0",
        ...(options.policy === undefined ? {} : { policy: options.policy }),
      },
    ],
  });
  const { run, rootTaskId } = await h.seedRunWithRoot(definition.id);
  return { workspace, definition, runId: run.id, rootTaskId };
}

function buildDispatchOptions(
  h: TestHarness,
  fixture: SkillDispatchFixture,
  toolName: string,
  toolInput: unknown,
  overrides: Partial<DispatchOptions> = {},
): DispatchOptions {
  return {
    runId: fixture.runId,
    rootTaskId: fixture.rootTaskId,
    definition: fixture.definition,
    toolName,
    toolInput,
    toolUseId: "tu_test",
    taskSequenceNumber: 1,
    inputTokens: 100,
    outputTokens: 50,
    injectedArtifactIds: [],
    config: { ...h.config, workspace: fixture.workspace },
    ...overrides,
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  harness = await createTestHarness();
});

afterEach(async () => {
  harness.dispose();
  await Promise.all(cleanups.map((fn) => fn()));
  cleanups = [];
});

describe("willRequireHitl", () => {
  const baseDefinition: AgentDefinition = makeDefinition({
    skills: [
      { name: "safe-skill", version: "1.0.0", policy: { type: "always" } },
      {
        name: "gated-skill",
        version: "1.0.0",
        policy: {
          type: "require_hitl_approval",
          approverPrompt: "Allow {{task_input}}?",
        },
      },
      { name: "unpoliced-skill", version: "1.0.0" },
    ],
  });

  it("returns true for the human-approval tool", () => {
    expect(
      willRequireHitl(
        {
          toolName: HUMAN_APPROVAL_SKILL_NAME,
          toolInput: { prompt: "Proceed?" },
          toolUseId: "tu_1",
        },
        baseDefinition,
      ),
    ).toBe(true);
  });

  it("returns true when the target skill has require_hitl_approval policy", () => {
    expect(
      willRequireHitl(
        {
          toolName: SKILL_TOOL_NAME,
          toolInput: { skill_name: "gated-skill", task_input: "go" },
          toolUseId: "tu_1",
        },
        baseDefinition,
      ),
    ).toBe(true);
  });

  it("returns false when the target skill has 'always' policy", () => {
    expect(
      willRequireHitl(
        {
          toolName: SKILL_TOOL_NAME,
          toolInput: { skill_name: "safe-skill", task_input: "go" },
          toolUseId: "tu_1",
        },
        baseDefinition,
      ),
    ).toBe(false);
  });

  it("returns false when the target skill has no policy", () => {
    expect(
      willRequireHitl(
        {
          toolName: SKILL_TOOL_NAME,
          toolInput: { skill_name: "unpoliced-skill", task_input: "go" },
          toolUseId: "tu_1",
        },
        baseDefinition,
      ),
    ).toBe(false);
  });

  it("returns false when the skill is absent from the definition", () => {
    expect(
      willRequireHitl(
        {
          toolName: SKILL_TOOL_NAME,
          toolInput: { skill_name: "unknown", task_input: "go" },
          toolUseId: "tu_1",
        },
        baseDefinition,
      ),
    ).toBe(false);
  });

  it("returns false when the tool input is malformed", () => {
    expect(
      willRequireHitl(
        {
          toolName: SKILL_TOOL_NAME,
          toolInput: { wrong: "shape" },
          toolUseId: "tu_1",
        },
        baseDefinition,
      ),
    ).toBe(false);
  });

  it("returns false for unrelated tools", () => {
    expect(
      willRequireHitl(
        {
          toolName: "web-search",
          toolInput: { query: "anything" },
          toolUseId: "tu_1",
        },
        baseDefinition,
      ),
    ).toBe(false);
  });
});

describe("handleSkillCall — happy path", () => {
  it("creates child Task, Operation, Artifact, invokes edge, and spawns edge", async () => {
    const fixture = await setupSkillDispatch(harness);
    mockSubagentResult("Here is the research summary.");

    const result = await handleSkillCall(
      buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
        skill_name: "researcher",
        task_input: "What is X?",
      }),
    );

    expect(result.succeeded).toBe(true);
    expect(result.toolResultContent).toContain("Here is the research summary.");
    expect(result.toolResultContent).toMatch(
      /output_artifact_id: [0-9a-f-]{36}/,
    );

    const lineage = await harness.repo.lineage.getRunLineage(fixture.runId);
    const childEntry = lineage!.tasks.find((t) => t.task.role === "subagent");
    expect(childEntry).toBeDefined();
    expect(childEntry!.task.subagentName).toBe("researcher");
    expect(childEntry!.task.status).toBe("completed");
    expect(childEntry!.task.parentTaskId).toBe(fixture.rootTaskId);
    expect(childEntry!.skill?.name).toBe("researcher");
    expect(childEntry!.operations).toHaveLength(1);
    expect(childEntry!.operations[0]!.operation.status).toBe("succeeded");
    expect(childEntry!.operations[0]!.artifacts).toHaveLength(1);
    expect(childEntry!.operations[0]!.artifacts[0]!.name).toBe(
      "researcher_output",
    );
  });

  it("can return artifact metadata without inlining the child output text", async () => {
    const fixture = await setupSkillDispatch(harness, {
      subagentResultMode: "artifact_only",
    });
    mockSubagentResult("Here is the research summary.");

    const result = await handleSkillCall(
      buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
        skill_name: "researcher",
        task_input: "What is X?",
      }),
    );

    expect(result.succeeded).toBe(true);
    expect(result.toolResultContent).not.toContain(
      "Here is the research summary.",
    );
    expect(result.toolResultContent).toContain(
      'Subagent "researcher" completed successfully.',
    );
    expect(result.toolResultContent).toContain("subagent_name: researcher");
    expect(result.toolResultContent).toContain("Use read_artifact");
    expect(result.toolResultContent).toMatch(
      /output_artifact_id: [0-9a-f-]{36}/,
    );
  });

  it("passes the workspace-loaded skill prompt as the subagent system prompt", async () => {
    const fixture = await setupSkillDispatch(harness);
    mockSubagentResult("ok");

    // Overwrite the default prompt so the assertion proves the prompt was
    // read from the workspace filesystem, not re-derived from graph state.
    await fixture.workspace.fs.writeFile(
      "/workspace/skills/researcher@1.0.0/SKILL.md",
      "CUSTOM PROMPT FROM WORKSPACE",
    );

    await handleSkillCall(
      buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
        skill_name: "researcher",
        task_input: "go",
      }),
    );

    const call = mockedRunSubagentLoop.mock.calls[0]?.[1];
    expect(call?.system).toBe("CUSTOM PROMPT FROM WORKSPACE");
  });

  it("respects skill.maxIterations when forwarding to runSubagentLoop", async () => {
    const fixture = await setupSkillDispatch(harness, { maxIterations: 2 });
    mockSubagentResult("ok");

    await handleSkillCall(
      buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
        skill_name: "researcher",
        task_input: "go",
      }),
    );

    const call = mockedRunSubagentLoop.mock.calls[0]?.[1];
    expect(call?.maxIterations).toBe(2);
  });

  it("does not expose any tools when a skill disables direct tool access", async () => {
    const fixture = await setupSkillDispatch(harness, {
      allowDirectTools: false,
    });
    mockSubagentResult("ok");

    await handleSkillCall(
      buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
        skill_name: "researcher",
        task_input: "go",
      }),
    );

    const call = mockedRunSubagentLoop.mock.calls[0]?.[1];
    expect(call?.tools).toEqual([]);
  });

  it("can expose only read_artifact when a skill disables direct tools but allows artifact reads", async () => {
    const fixture = await setupSkillDispatch(harness, {
      allowDirectTools: false,
      allowReadArtifact: true,
    });
    mockSubagentResult("ok");

    await handleSkillCall(
      buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
        skill_name: "researcher",
        task_input: "go",
      }),
    );

    const call = mockedRunSubagentLoop.mock.calls[0]?.[1];
    expect(call?.tools.map((tool) => tool.name)).toEqual(["read_artifact"]);
  });
});

describe("handleSkillCall — errors", () => {
  it("throws skill_not_found when the skill is absent from the graph", async () => {
    const workspace = track(await createWorkspace({ runId: "run" }));
    const definition = await harness.seedDefinition({ skills: [] });
    const { run, rootTaskId } = await harness.seedRunWithRoot(definition.id);

    await expect(
      handleSkillCall({
        runId: run.id,
        rootTaskId,
        definition,
        toolName: SKILL_TOOL_NAME,
        toolInput: { skill_name: "ghost", task_input: "go" },
        toolUseId: "tu_1",
        taskSequenceNumber: 1,
        inputTokens: 0,
        outputTokens: 0,
        injectedArtifactIds: [],
        config: { ...harness.config, workspace },
      }),
    ).rejects.toThrow(/not found/);

    const tasks = await harness.repo.tasks.getForRun(run.id);
    expect(tasks.filter((t) => t.role === "subagent")).toHaveLength(0);
  });

  it("throws when policy is 'never' — leaving no subagent Task or Operation", async () => {
    const fixture = await setupSkillDispatch(harness, {
      policy: { type: "never" },
    });

    await expect(
      handleSkillCall(
        buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
          skill_name: "researcher",
          task_input: "go",
        }),
      ),
    ).rejects.toThrow(/denied by policy/);

    const tasks = await harness.repo.tasks.getForRun(fixture.runId);
    expect(tasks.filter((t) => t.role === "subagent")).toHaveLength(0);
    expect(mockedRunSubagentLoop).not.toHaveBeenCalled();
  });

  it("throws when workspace is missing", async () => {
    const fixture = await setupSkillDispatch(harness);
    const options = buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
      skill_name: "researcher",
      task_input: "go",
    });
    const { workspace: _dropped, ...configNoWs } = options.config;
    void _dropped;

    await expect(
      handleSkillCall({ ...options, config: configNoWs }),
    ).rejects.toThrow(/Workspace required/);
  });

  it("runs approval-gated skill only after the human approves", async () => {
    harness.hitl.enqueue("approved, go ahead");
    const fixture = await setupSkillDispatch(harness, {
      policy: {
        type: "require_hitl_approval",
        approverPrompt: "Approve: {{task_input}}",
      },
    });
    mockSubagentResult("done");

    await handleSkillCall(
      buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
        skill_name: "researcher",
        task_input: "do it",
      }),
    );

    expect(harness.hitl.calls).toHaveLength(1);
    expect(harness.hitl.calls[0]!.prompt).toBe("Approve: do it");

    const tasks = await harness.repo.tasks.getForRun(fixture.runId);
    expect(tasks.filter((t) => t.role === "subagent")).toHaveLength(1);
  });

  it("returns recoverable denial when approval-gated skill is rejected by human", async () => {
    const customHarness = track(
      await createTestHarness({ hitl: { defaultDecision: "no, rejected" } }),
    );
    const fixture = await setupSkillDispatch(customHarness, {
      policy: {
        type: "require_hitl_approval",
        approverPrompt: "Approve?",
      },
    });

    const result = await handleSkillCall(
      buildDispatchOptions(customHarness, fixture, SKILL_TOOL_NAME, {
        skill_name: "researcher",
        task_input: "go",
      }),
    );

    expect(result.succeeded).toBe(false);
    expect(result.toolResultContent).toMatch(/denied by human approver/);

    const tasks = await customHarness.repo.tasks.getForRun(fixture.runId);
    expect(tasks.filter((t) => t.role === "subagent")).toHaveLength(0);
    expect(mockedRunSubagentLoop).not.toHaveBeenCalled();
  });

  it("returns recoverable denial when max_calls_per_run limit is exceeded", async () => {
    const fixture = await setupSkillDispatch(harness, {
      policy: { type: "max_calls_per_run", limit: 1 },
    });
    mockSubagentResult("first call ok");

    // First call succeeds
    const first = await handleSkillCall(
      buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
        skill_name: "researcher",
        task_input: "first",
      }),
    );
    expect(first.succeeded).toBe(true);

    // Second call should be denied — recoverable, not a throw
    const second = await handleSkillCall(
      buildDispatchOptions(harness, fixture, SKILL_TOOL_NAME, {
        skill_name: "researcher",
        task_input: "second",
      }),
    );

    expect(second.succeeded).toBe(false);
    expect(second.toolResultContent).toMatch(/exceeded max_calls_per_run/);

    const tasks = await harness.repo.tasks.getForRun(fixture.runId);
    const subagentTasks = tasks.filter((t) => t.role === "subagent");
    expect(subagentTasks).toHaveLength(1);
    expect(subagentTasks[0]!.status).toBe("completed");
  });
});

describe("handleSkillCall — artifacts", () => {
  it("prefers explicit artifact_ids over injected ones", async () => {
    const fixture = await setupSkillDispatch(harness);
    mockSubagentResult("done");

    const explicitArtifact = await buildArtifact(
      "text",
      "explicit",
      "EXPLICIT",
    );
    await harness.repo.artifacts.create(explicitArtifact);
    const injectedArtifact = await buildArtifact(
      "text",
      "injected",
      "INJECTED",
    );
    await harness.repo.artifacts.create(injectedArtifact);

    await handleSkillCall(
      buildDispatchOptions(
        harness,
        fixture,
        SKILL_TOOL_NAME,
        {
          skill_name: "researcher",
          task_input: "summarize",
          artifact_ids: [explicitArtifact.id],
        },
        { injectedArtifactIds: [injectedArtifact.id] },
      ),
    );

    const call = mockedRunSubagentLoop.mock.calls[0]?.[1];
    const firstMessage = call?.messages[0]?.content as string;
    expect(firstMessage).toContain(explicitArtifact.id);
    expect(firstMessage).toContain("explicit");
    expect(firstMessage).not.toContain(injectedArtifact.id);
  });

  it("does NOT fall back to injected artifact_ids when none are explicit", async () => {
    // Scoped visibility: children must only see artifacts the coordinator
    // explicitly grants via artifact_ids. Auto-inheriting the parent's
    // available artifacts leaks sibling outputs across fan-out patterns
    // (e.g. debate coordinators where bull/bear must not see each other).
    const fixture = await setupSkillDispatch(harness);
    mockSubagentResult("done");

    const injected = await buildArtifact("text", "injected", "INJECTED");
    await harness.repo.artifacts.create(injected);

    await handleSkillCall(
      buildDispatchOptions(
        harness,
        fixture,
        SKILL_TOOL_NAME,
        { skill_name: "researcher", task_input: "summarize" },
        { injectedArtifactIds: [injected.id] },
      ),
    );

    const firstMessage = mockedRunSubagentLoop.mock.calls[0]?.[1].messages[0]
      ?.content as string;
    expect(firstMessage).not.toContain(injected.id);
  });
});

describe("handleAgentCall", () => {
  it("creates a subagent Task with no invokes edge and uses the supplied prompt", async () => {
    const definition = await harness.seedDefinition({ skills: [] });
    const { run, rootTaskId } = await harness.seedRunWithRoot(definition.id);
    mockSubagentResult("ad-hoc result");

    const result = await handleAgentCall({
      runId: run.id,
      rootTaskId,
      definition,
      toolName: AGENT_TOOL_NAME,
      toolInput: {
        name: "summarizer",
        prompt: "You are a summarizer.",
        task_input: "summarize this",
      },
      toolUseId: "tu_adhoc",
      taskSequenceNumber: 1,
      inputTokens: 0,
      outputTokens: 0,
      injectedArtifactIds: [],
      config: harness.config,
    });
    expect(result.succeeded).toBe(true);

    const lineage = await harness.repo.lineage.getRunLineage(run.id);
    const childEntry = lineage!.tasks.find(
      (t) => t.task.subagentName === "summarizer",
    );
    expect(childEntry?.task.role).toBe("subagent");
    expect(childEntry?.task.status).toBe("completed");
    // ad-hoc spawn must not create an invokes edge to any Skill
    expect(childEntry?.skill).toBeUndefined();

    const call = mockedRunSubagentLoop.mock.calls[0]?.[1];
    expect(call?.system).toBe("You are a summarizer.");
  });

  it("can resolve downstream artifacts by artifact_query", async () => {
    const definition = await harness.seedDefinition({ skills: [] });
    const { run, rootTaskId } = await harness.seedRunWithRoot(definition.id);
    const taskId = "11111111-1111-4111-8111-111111111111";
    const operationId = "22222222-2222-4222-8222-222222222222";
    const artifact = await buildArtifact(
      "text",
      "extract-claims_output",
      "claims content",
    );
    const timestamp = "2026-04-14T22:00:00.000Z";

    await harness.repo.tasks.create({
      id: taskId,
      runId: run.id,
      role: "subagent",
      subagentName: "extract-claims",
      status: "completed",
      input: { task_input: "extract" },
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
      input: { task_input: "extract" },
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
    mockSubagentResult("ad-hoc result");

    const result = await handleAgentCall({
      runId: run.id,
      rootTaskId,
      definition,
      toolName: AGENT_TOOL_NAME,
      toolInput: {
        name: "control-mapper",
        prompt: "You are a control mapper.",
        task_input: "build the matrix",
        artifact_query: { produced_by_subagent: "extract-claims", limit: 1 },
      },
      toolUseId: "tu_query",
      taskSequenceNumber: 2,
      inputTokens: 0,
      outputTokens: 0,
      injectedArtifactIds: [],
      config: harness.config,
    });

    expect(result.succeeded).toBe(true);
    const call = mockedRunSubagentLoop.mock.calls[0]?.[1];
    const firstMessage = call?.messages[0]?.content as string;
    expect(firstMessage).toContain(artifact.id);
    expect(firstMessage).toContain("extract-claims_output");
  });

  it("forwards parent tools (from the registry) to the spawned subagent", async () => {
    const toolImpl: ToolImplementation = {
      tool: {
        name: "web-search",
        version: "1.0.0",
        description: "search",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: {} },
      },
      execute: vi.fn().mockResolvedValue({ ok: true }),
    };
    const toolRegistry = toolRegistryFromMap([["web-search", toolImpl]]);

    const customHarness = track(await createTestHarness({ toolRegistry }));
    const definition = await customHarness.seedDefinition({ skills: [] });
    const { run, rootTaskId } = await customHarness.seedRunWithRoot(
      definition.id,
    );
    mockSubagentResult("done");

    await handleAgentCall({
      runId: run.id,
      rootTaskId,
      definition,
      toolName: AGENT_TOOL_NAME,
      toolInput: { name: "helper", prompt: "prompt", task_input: "go" },
      toolUseId: "tu_1",
      taskSequenceNumber: 1,
      inputTokens: 0,
      outputTokens: 0,
      injectedArtifactIds: [],
      config: customHarness.config,
    });

    const call = mockedRunSubagentLoop.mock.calls[0]?.[1];
    const toolNames = call?.tools.map((t) => t.name);
    expect(toolNames).toContain("web-search");
    expect(toolNames).toContain("read_artifact");
  });

  it("does not forward agent/skill dispatch tools to a spawned subagent", async () => {
    // Subagents must not be able to recursively spawn further subagents.
    // This is enforced structurally: `agent` and `skill` are built only by
    // `resolveAgentCapabilities` at the root coordinator level and are not
    // part of `config.toolRegistry`. Lock it in with a test so a future
    // refactor doesn't quietly leak the dispatch tools downward.
    const toolRegistry = toolRegistryFromMap([]);
    const customHarness = track(await createTestHarness({ toolRegistry }));
    const definition = await customHarness.seedDefinition({ skills: [] });
    const { run, rootTaskId } = await customHarness.seedRunWithRoot(
      definition.id,
    );
    mockSubagentResult("done");

    await handleAgentCall({
      runId: run.id,
      rootTaskId,
      definition,
      toolName: AGENT_TOOL_NAME,
      toolInput: { name: "helper", prompt: "prompt", task_input: "go" },
      toolUseId: "tu_no_recurse",
      taskSequenceNumber: 1,
      inputTokens: 0,
      outputTokens: 0,
      injectedArtifactIds: [],
      config: customHarness.config,
    });

    const call = mockedRunSubagentLoop.mock.calls[0]?.[1];
    const toolNames = call?.tools.map((t) => t.name) ?? [];
    expect(toolNames).not.toContain("agent");
    expect(toolNames).not.toContain("skill");
  });
});

describe("handleSkillCall — tool inheritance", () => {
  it("forwards an empty tool list when no parent tools exist", async () => {
    const fixture = await setupSkillDispatch(harness);
    mockSubagentResult("ok");

    await handleSkillCall(
      buildDispatchOptions(
        harness,
        fixture,
        SKILL_TOOL_NAME,
        { skill_name: "researcher", task_input: "go" },
        {
          config: {
            ...harness.config,
            workspace: fixture.workspace,
            toolRegistry: createEmptyToolRegistry(),
          },
        },
      ),
    );

    const call = mockedRunSubagentLoop.mock.calls[0]?.[1];
    expect(call?.tools.map((t) => t.name)).toEqual(["read_artifact"]);
  });
});
