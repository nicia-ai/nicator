/**
 * Integration tests for policy enforcement against a real TypeGraph-backed
 * Repository. Exercises the policy-before-operation invariant: a denied
 * invocation leaves no subagent Task or Operation in the graph.
 */
import { generateId } from "@nicator/core";
import { makeTask } from "@nicator/core/test-factories";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enforcePolicy } from "./policy.js";
import { createTestHarness, type TestHarness } from "./test-harness.js";

let harness: TestHarness;

async function seedRun(h: TestHarness) {
  const definition = await h.seedDefinition({ skills: [] });
  return h.seedRunWithRoot(definition.id);
}

beforeEach(async () => {
  harness = await createTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("enforcePolicy", () => {
  it("allows invocation with 'always' policy", async () => {
    const { run, rootTaskId } = await seedRun(harness);

    await expect(
      enforcePolicy(
        {
          policy: { type: "always" },
          subagentName: "test-skill",
          toolInput: {},
          runId: run.id,
          rootTaskId,
        },
        harness.config,
      ),
    ).resolves.toBeUndefined();
  });

  it("denies invocation with 'never' policy", async () => {
    const { run, rootTaskId } = await seedRun(harness);

    await expect(
      enforcePolicy(
        {
          policy: { type: "never" },
          subagentName: "blocked-skill",
          toolInput: {},
          runId: run.id,
          rootTaskId,
        },
        harness.config,
      ),
    ).rejects.toThrow("denied by policy");
  });

  it("approves with require_hitl_approval when human approves", async () => {
    harness.hitl.enqueue("approved");
    const { run, rootTaskId } = await seedRun(harness);

    await expect(
      enforcePolicy(
        {
          policy: {
            type: "require_hitl_approval",
            approverPrompt: "Allow {{skill_name}}?",
          },
          subagentName: "sensitive-skill",
          toolInput: { skill_name: "sensitive-skill" },
          runId: run.id,
          rootTaskId,
          maxOperationsPerTask: 3,
        },
        harness.config,
      ),
    ).resolves.toBeUndefined();

    const operations = await harness.repo.operations.getForTask(
      rootTaskId,
      run.id,
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]!.type).toBe("hitl_response");
    expect(operations[0]!.status).toBe("succeeded");
  });

  it("denies with require_hitl_approval when human denies", async () => {
    const denyHarness = await createTestHarness({
      hitl: { defaultDecision: "denied" },
    });
    try {
      const { run, rootTaskId } = await seedRun(denyHarness);
      await expect(
        enforcePolicy(
          {
            policy: {
              type: "require_hitl_approval",
              approverPrompt: "Allow?",
            },
            subagentName: "sensitive-skill",
            toolInput: {},
            runId: run.id,
            rootTaskId,
          },
          denyHarness.config,
        ),
      ).rejects.toThrow("denied by human approver");
    } finally {
      denyHarness.dispose();
    }
  });

  it("interpolates approver prompt template variables", async () => {
    const { run, rootTaskId } = await seedRun(harness);

    await enforcePolicy(
      {
        policy: {
          type: "require_hitl_approval",
          approverPrompt: "Allow {{skill_name}} with {{command}}?",
        },
        subagentName: "runner",
        toolInput: { skill_name: "runner", command: "rm -rf /" },
        runId: run.id,
        rootTaskId,
      },
      harness.config,
    );

    expect(harness.hitl.calls[0]!.prompt).toBe("Allow runner with rm -rf /?");
  });

  it("allows with max_calls_per_run when under limit", async () => {
    const { run, rootTaskId } = await seedRun(harness);

    await expect(
      enforcePolicy(
        {
          policy: { type: "max_calls_per_run", limit: 3 },
          subagentName: "limited-skill",
          toolInput: {},
          runId: run.id,
          rootTaskId,
        },
        harness.config,
      ),
    ).resolves.toBeUndefined();
  });

  it("denies with max_calls_per_run when at limit", async () => {
    const { run, rootTaskId } = await seedRun(harness);

    for (let index = 0; index < 3; index++) {
      const task = makeTask(run.id, index + 1, {
        id: generateId(),
        role: "subagent",
        subagentName: "limited-skill",
        status: "completed",
        parentTaskId: rootTaskId,
      });
      await harness.repo.tasks.create(task);
    }

    await expect(
      enforcePolicy(
        {
          policy: { type: "max_calls_per_run", limit: 3 },
          subagentName: "limited-skill",
          toolInput: {},
          runId: run.id,
          rootTaskId,
        },
        harness.config,
      ),
    ).rejects.toThrow("exceeded max_calls_per_run");
  });

  it("counts only tasks of the same subagentName toward max_calls_per_run", async () => {
    const { run, rootTaskId } = await seedRun(harness);

    for (let index = 0; index < 3; index++) {
      const task = makeTask(run.id, index + 1, {
        id: generateId(),
        role: "subagent",
        subagentName: "other-skill",
        status: "completed",
        parentTaskId: rootTaskId,
      });
      await harness.repo.tasks.create(task);
    }

    await expect(
      enforcePolicy(
        {
          policy: { type: "max_calls_per_run", limit: 3 },
          subagentName: "limited-skill",
          toolInput: {},
          runId: run.id,
          rootTaskId,
        },
        harness.config,
      ),
    ).resolves.toBeUndefined();
  });
});
