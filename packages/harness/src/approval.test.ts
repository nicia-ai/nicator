/**
 * Integration tests for requestHumanApproval and parseApprovalToolInput
 * against a real TypeGraph-backed Repository.
 *
 * Covers the status-transition dance (running → awaiting_hitl → running),
 * operation creation, artifact linking, approved/denied decision parsing,
 * handler-throw paths, and tool input parsing.
 */
import type { HitlContext, HitlHandler } from "@nicator/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseApprovalToolInput, requestHumanApproval } from "./approval.js";
import { createTestHarness, type TestHarness } from "./test-harness.js";

type ApprovalFixture = Readonly<{
  runId: string;
  taskId: string;
  hitlContext: HitlContext;
}>;

async function seedApprovalFixture(h: TestHarness): Promise<ApprovalFixture> {
  const definition = await h.seedDefinition({ skills: [] });
  const { run, rootTaskId } = await h.seedRunWithRoot(definition.id);
  return {
    runId: run.id,
    taskId: rootTaskId,
    hitlContext: { runId: run.id, taskId: rootTaskId },
  };
}

function buildApprovalRequest(
  h: TestHarness,
  fixture: ApprovalFixture,
  overrides: { prompt?: string; hitlHandler?: HitlHandler } = {},
) {
  return {
    repo: h.repo,
    runId: fixture.runId,
    taskId: fixture.taskId,
    hitlContext: fixture.hitlContext,
    prompt: overrides.prompt ?? "Proceed with deletion?",
    operationNumber: 1,
    inputTokens: 0,
    outputTokens: 0,
    artifactName: "policy_approval",
    hitlHandler: overrides.hitlHandler ?? h.hitl,
  };
}

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("requestHumanApproval — status transitions", () => {
  it("transitions run status: running → awaiting_hitl → running", async () => {
    const fixture = await seedApprovalFixture(harness);

    let statusWhileApproving: string | undefined;
    const spyingHandler: HitlHandler = {
      async requestApproval() {
        const run = await harness.repo.runs.get(fixture.runId);
        statusWhileApproving = run?.status;
        return "approved";
      },
    };

    await requestHumanApproval(
      buildApprovalRequest(harness, fixture, { hitlHandler: spyingHandler }),
    );

    expect(statusWhileApproving).toBe("awaiting_hitl");
    const finalRun = await harness.repo.runs.get(fixture.runId);
    expect(finalRun?.status).toBe("running");
  });

  it("restores the run to 'running' even when the handler throws", async () => {
    const fixture = await seedApprovalFixture(harness);
    const failingHandler: HitlHandler = {
      requestApproval: () => Promise.reject(new Error("handler crashed")),
    };

    const result = await requestHumanApproval(
      buildApprovalRequest(harness, fixture, { hitlHandler: failingHandler }),
    );

    expect(result.approved).toBe(false);
    const run = await harness.repo.runs.get(fixture.runId);
    expect(run?.status).toBe("running");
  });
});

describe("requestHumanApproval — graph state", () => {
  it("creates a hitl_response Operation with a hitl_decision Artifact on success", async () => {
    const fixture = await seedApprovalFixture(harness);
    harness.hitl.enqueue("yes, approved");

    const result = await requestHumanApproval(
      buildApprovalRequest(harness, fixture),
    );

    expect(result.approved).toBe(true);
    expect(result.decision).toBe("yes, approved");

    const operations = await harness.repo.operations.getForTask(
      fixture.taskId,
      fixture.runId,
    );
    expect(operations).toHaveLength(1);
    const op = operations[0]!;
    expect(op.type).toBe("hitl_response");
    expect(op.status).toBe("succeeded");
    expect(op.operationNumber).toBe(1);

    const lineage = await harness.repo.lineage.getRunLineage(fixture.runId);
    const taskEntry = lineage!.tasks.find((t) => t.task.id === fixture.taskId);
    const artifacts = taskEntry?.operations[0]?.artifacts ?? [];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.type).toBe("hitl_decision");
    expect(artifacts[0]!.name).toBe("policy_approval");
    expect(artifacts[0]!.content).toBe("yes, approved");
  });

  it("marks the Operation 'failed' when the handler throws", async () => {
    const fixture = await seedApprovalFixture(harness);
    const failingHandler: HitlHandler = {
      requestApproval: () => Promise.reject(new Error("timeout")),
    };

    await requestHumanApproval(
      buildApprovalRequest(harness, fixture, { hitlHandler: failingHandler }),
    );

    const operations = await harness.repo.operations.getForTask(
      fixture.taskId,
      fixture.runId,
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]!.status).toBe("failed");
  });

  it("passes prompt + hitlContext through to the handler verbatim", async () => {
    const fixture = await seedApprovalFixture(harness);
    const seen: { ctx?: HitlContext; prompt?: string } = {};
    const capturingHandler: HitlHandler = {
      requestApproval(ctx, prompt) {
        seen.ctx = ctx;
        seen.prompt = prompt;
        return Promise.resolve("approved");
      },
    };

    await requestHumanApproval(
      buildApprovalRequest(harness, fixture, {
        hitlHandler: capturingHandler,
        prompt: "Delete everything?",
      }),
    );

    expect(seen.prompt).toBe("Delete everything?");
    expect(seen.ctx).toEqual(fixture.hitlContext);
  });
});

describe("requestHumanApproval — decision parsing", () => {
  it.each([
    ["approved", true],
    ["yes, go ahead", true],
    ["APPROVE", true],
    ["rejected", false],
    ["no", false],
    ["denied, do not proceed", false],
    ["maybe later", false],
  ])("decision %j → approved=%s", async (decision, expected) => {
    const localHarness = await createTestHarness({
      hitl: { defaultDecision: decision },
    });
    const fixture = await seedApprovalFixture(localHarness);

    const result = await requestHumanApproval(
      buildApprovalRequest(localHarness, fixture),
    );

    expect(result.approved).toBe(expected);
    expect(result.decision).toBe(decision);
    localHarness.dispose();
  });
});

describe("requestHumanApproval — handler return shapes", () => {
  it("stringifies non-string handler output via stringifyOutput", async () => {
    const fixture = await seedApprovalFixture(harness);
    // HitlHandler is typed Promise<string>, but the approval code must
    // defensively stringify non-string values from third-party handlers.
    const handler: HitlHandler = {
      requestApproval: () =>
        Promise.resolve({ decision: "approved" } as unknown as string),
    };

    const result = await requestHumanApproval(
      buildApprovalRequest(harness, fixture, { hitlHandler: handler }),
    );

    expect(result.decision).toBe('{"decision":"approved"}');
    expect(result.approved).toBe(true);
  });
});

describe("parseApprovalToolInput", () => {
  it("parses a valid prompt-only input", () => {
    const parsed = parseApprovalToolInput({ prompt: "Proceed?" });
    expect(parsed.prompt).toBe("Proceed?");
    expect(parsed.fullPrompt).toBe("Proceed?");
  });

  it("includes context in the fullPrompt", () => {
    const parsed = parseApprovalToolInput({
      prompt: "Delete file?",
      context: "The file is /etc/passwd",
    });
    expect(parsed.prompt).toBe("Delete file?");
    expect(parsed.fullPrompt).toContain("Delete file?");
    expect(parsed.fullPrompt).toContain("The file is /etc/passwd");
  });

  it("throws on missing prompt", () => {
    expect(() => parseApprovalToolInput({})).toThrow();
  });

  it("throws on malformed input", () => {
    expect(() => parseApprovalToolInput(undefined)).toThrow();
    expect(() => parseApprovalToolInput("just a string")).toThrow();
    expect(() => parseApprovalToolInput({ prompt: 42 })).toThrow();
  });
});
