import { describe, it, expect } from "vitest";
import type { RunLineage, TaskRole, Skill } from "@nicator/core";
import { TOOL_CALL_VERSION } from "@nicator/core";
import { evaluateAssertions, type GraphAssertion } from "./graph-assertions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLineage(
  overrides: Partial<{
    runStatus: string;
    runError: string;
    tasks: Array<{
      role?: TaskRole;
      subagentName?: string;
      skill?: Skill;
      status: string;
      sequenceNumber: number;
      consumedArtifactIds?: string[];
      artifacts?: Array<{ id: string; name: string; content: string; type: string }>;
    }>;
  }> = {},
): RunLineage {
  const tasks = (overrides.tasks ?? []).map((t, i) => ({
    task: {
      id: `task-${i}`,
      runId: "run-1",
      role: t.role ?? (t.subagentName ? "subagent" as const : "root" as const),
      ...(t.subagentName !== undefined ? { subagentName: t.subagentName } : {}),
      status: t.status ?? "completed",
      input: {},
      sequenceNumber: t.sequenceNumber ?? i,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    skill: t.skill ?? undefined,
    consumedArtifactIds: t.consumedArtifactIds ?? [],
    operations: [
      {
        operation: {
          id: `op-${i}`,
          taskId: `task-${i}`,
          runId: "run-1",
          type: "tool_call" as const,
          status: "succeeded" as const,
          operationNumber: 1,
          input: {},
          output: {},
          inputTokens: 0,
          outputTokens: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.000Z",
        },
        artifacts: (t.artifacts ?? []).map((a) => ({
          id: a.id,
          type: a.type as "text",
          name: a.name,
          content: a.content,
          contentHash: "test-hash",
          mimeType: "text/plain",
          createdAt: "2026-01-01T00:00:00.000Z",
        })),
      },
    ],
  }));

  return {
    run: {
      id: "run-1",
      agentDefinitionId: "def-1",
      agentDefinitionVersion: 1,
      status: (overrides.runStatus ?? "completed") as "completed",
      input: "test",
      output: "done",
      ...(overrides.runError !== undefined ? { error: overrides.runError } : {}),
      totalTokensUsed: 100,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
    },
    definition: {
      id: "def-1",
      version: 1,
      name: "test",
      description: "test",
      systemPrompt: "test",
      skills: [],
      limits: { maxTasksPerRun: 10, maxOperationsPerTask: 3, maxTokensPerRun: 100000 },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    tasks,
    inputArtifacts: [],
    compactions: [],
  } as unknown as RunLineage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("graph assertions", () => {
  describe("task_exists", () => {
    it("passes when matching task exists", () => {
      const lineage = makeLineage({
        tasks: [{ subagentName: "web-search", status: "completed", sequenceNumber: 0 }],
      });
      const [result] = evaluateAssertions(
        [{ type: "task_exists", match: { subagentName: "web-search" }, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("matches by role and subagentName", () => {
      const lineage = makeLineage({
        tasks: [{
          subagentName: "judge",
          status: "completed",
          sequenceNumber: 0,
        }],
      });
      const [result] = evaluateAssertions(
        [{ type: "task_exists", match: { role: "subagent", subagentName: "judge" }, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails when no matching task", () => {
      const lineage = makeLineage({
        tasks: [{ subagentName: "web-fetch", status: "completed", sequenceNumber: 0 }],
      });
      const [result] = evaluateAssertions(
        [{ type: "task_exists", match: { subagentName: "web-search" }, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });

  describe("task_absent", () => {
    it("passes when no matching task", () => {
      const lineage = makeLineage({
        tasks: [{ subagentName: "web-search", status: "completed", sequenceNumber: 0 }],
      });
      const [result] = evaluateAssertions(
        [{ type: "task_absent", match: { subagentName: "researcher" }, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails when matching task exists", () => {
      const lineage = makeLineage({
        tasks: [{ subagentName: "researcher", status: "completed", sequenceNumber: 0 }],
      });
      const [result] = evaluateAssertions(
        [{ type: "task_absent", match: { subagentName: "researcher" }, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });

  describe("task_order", () => {
    it("passes when first precedes then", () => {
      const lineage = makeLineage({
        tasks: [
          { subagentName: "human-approval", status: "completed", sequenceNumber: 0 },
          { subagentName: "researcher", status: "completed", sequenceNumber: 1 },
        ],
      });
      const [result] = evaluateAssertions(
        [{
          type: "task_order",
          first: { subagentName: "human-approval" },
          then: { subagentName: "researcher" },
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails when order is reversed", () => {
      const lineage = makeLineage({
        tasks: [
          { subagentName: "researcher", status: "completed", sequenceNumber: 0 },
          { subagentName: "human-approval", status: "completed", sequenceNumber: 1 },
        ],
      });
      const [result] = evaluateAssertions(
        [{
          type: "task_order",
          first: { subagentName: "human-approval" },
          then: { subagentName: "researcher" },
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });

    it("fails when first task is missing", () => {
      const lineage = makeLineage({
        tasks: [
          { subagentName: "researcher", status: "completed", sequenceNumber: 0 },
        ],
      });
      const [result] = evaluateAssertions(
        [{
          type: "task_order",
          first: { subagentName: "human-approval" },
          then: { subagentName: "researcher" },
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });

  describe("task_count", () => {
    it("passes within range", () => {
      const lineage = makeLineage({
        tasks: [
          { subagentName: "web-search", status: "completed", sequenceNumber: 0 },
          { subagentName: "web-search", status: "completed", sequenceNumber: 1 },
        ],
      });
      const [result] = evaluateAssertions(
        [{ type: "task_count", match: { subagentName: "web-search" }, min: 1, max: 3, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails below min", () => {
      const lineage = makeLineage({ tasks: [] });
      const [result] = evaluateAssertions(
        [{ type: "task_count", match: { subagentName: "web-search" }, min: 1, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });

    it("fails above max", () => {
      const lineage = makeLineage({
        tasks: [
          { subagentName: "web-search", status: "completed", sequenceNumber: 0 },
          { subagentName: "web-search", status: "completed", sequenceNumber: 1 },
          { subagentName: "web-search", status: "completed", sequenceNumber: 2 },
        ],
      });
      const [result] = evaluateAssertions(
        [{ type: "task_count", match: { subagentName: "web-search" }, max: 2, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });

  describe("run_status", () => {
    it("passes on match", () => {
      const lineage = makeLineage({ runStatus: "completed" });
      const [result] = evaluateAssertions(
        [{ type: "run_status", status: "completed", description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails on mismatch", () => {
      const lineage = makeLineage({ runStatus: "failed" });
      const [result] = evaluateAssertions(
        [{ type: "run_status", status: "completed", description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });

  describe("artifact_content", () => {
    it("passes when artifact matches pattern", () => {
      const lineage = makeLineage({
        tasks: [{

          subagentName: "human-approval",
          status: "completed",
          sequenceNumber: 0,
          artifacts: [{ id: "art-1", name: "decision", content: "approved: yes, proceed", type: "hitl_decision" }],
        }],
      });
      const [result] = evaluateAssertions(
        [{
          type: "artifact_content",
          task: { subagentName: "human-approval" },
          pattern: "approved",
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails when no artifact matches", () => {
      const lineage = makeLineage({
        tasks: [{

          subagentName: "human-approval",
          status: "completed",
          sequenceNumber: 0,
          artifacts: [{ id: "art-1", name: "decision", content: "rejected", type: "hitl_decision" }],
        }],
      });
      const [result] = evaluateAssertions(
        [{
          type: "artifact_content",
          task: { subagentName: "human-approval" },
          pattern: "approved",
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });

  describe("consumes", () => {
    it("passes when consumption edge exists", () => {
      const lineage = makeLineage({
        tasks: [
          {
  
            subagentName: "web-search",
            status: "completed",
            sequenceNumber: 0,
            artifacts: [{ id: "art-1", name: "result", content: "data", type: "json" }],
          },
          {
  
            subagentName: "researcher",
            status: "completed",
            sequenceNumber: 1,
            consumedArtifactIds: ["art-1"],
          },
        ],
      });
      const [result] = evaluateAssertions(
        [{
          type: "consumes",
          consumer: { subagentName: "researcher" },
          producer: { subagentName: "web-search" },
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails when no consumption edge", () => {
      const lineage = makeLineage({
        tasks: [
          {
  
            subagentName: "web-search",
            status: "completed",
            sequenceNumber: 0,
            artifacts: [{ id: "art-1", name: "result", content: "data", type: "json" }],
          },
          {
  
            subagentName: "researcher",
            status: "completed",
            sequenceNumber: 1,
            consumedArtifactIds: [],
          },
        ],
      });
      const [result] = evaluateAssertions(
        [{
          type: "consumes",
          consumer: { subagentName: "researcher" },
          producer: { subagentName: "web-search" },
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });

  describe("skill_invoked", () => {
    const testSkill: Skill = {
      id: "skill-1",
      name: "researcher",
      version: "1.0.0",
      description: "Research skill",
      allowDirectTools: true,
      allowReadArtifact: false,
    };

    it("passes when task has invokes edge to skill", () => {
      const lineage = makeLineage({
        tasks: [{

          subagentName: "researcher",
          skill: testSkill,
          status: "completed",
          sequenceNumber: 0,
        }],
      });
      const [result] = evaluateAssertions(
        [{ type: "skill_invoked", match: { subagentName: "researcher" }, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails when task has no invokes edge", () => {
      const lineage = makeLineage({
        tasks: [{

          subagentName: "researcher",
          status: "completed",
          sequenceNumber: 0,
        }],
      });
      const [result] = evaluateAssertions(
        [{ type: "skill_invoked", match: { subagentName: "researcher" }, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });

    it("matches on skillName", () => {
      const lineage = makeLineage({
        tasks: [{

          subagentName: "researcher",
          skill: testSkill,
          status: "completed",
          sequenceNumber: 0,
        }],
      });
      const [pass] = evaluateAssertions(
        [{ type: "skill_invoked", match: { subagentName: "researcher" }, skillName: "researcher", description: "test" }],
        lineage,
      );
      expect(pass?.passed).toBe(true);

      const [fail] = evaluateAssertions(
        [{ type: "skill_invoked", match: { subagentName: "researcher" }, skillName: "summarizer", description: "test" }],
        lineage,
      );
      expect(fail?.passed).toBe(false);
    });

    it("matches on skillVersion", () => {
      const lineage = makeLineage({
        tasks: [{

          subagentName: "researcher",
          skill: testSkill,
          status: "completed",
          sequenceNumber: 0,
        }],
      });
      const [fail] = evaluateAssertions(
        [{ type: "skill_invoked", match: { subagentName: "researcher" }, skillVersion: "2.0.0", description: "test" }],
        lineage,
      );
      expect(fail?.passed).toBe(false);
    });

    it("fails when no matching task", () => {
      const lineage = makeLineage({ tasks: [] });
      const [result] = evaluateAssertions(
        [{ type: "skill_invoked", match: { subagentName: "researcher" }, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });

  describe("operation_count", () => {
    it("passes when operation count is within range", () => {
      const lineage = makeLineage({
        tasks: [
          { subagentName: "researcher", status: "completed", sequenceNumber: 1 },
        ],
      });
      // Add two more operations to the first task
      const taskEntry = lineage.tasks[0]!;
      const ops = taskEntry.operations as Array<(typeof taskEntry.operations)[number]>;
      ops.push(
        { ...ops[0]!, operation: { ...ops[0]!.operation, id: "op-extra-1", operationNumber: 2 }, artifacts: [] },
        { ...ops[0]!, operation: { ...ops[0]!.operation, id: "op-extra-2", operationNumber: 3 }, artifacts: [] },
      );
      const [result] = evaluateAssertions(
        [{
          type: "operation_count",
          task: { subagentName: "researcher" },
          min: 2,
          max: 5,
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails when count exceeds max", () => {
      const lineage = makeLineage({
        tasks: [
          { subagentName: "researcher", status: "completed", sequenceNumber: 1 },
        ],
      });
      const [result] = evaluateAssertions(
        [{
          type: "operation_count",
          task: { subagentName: "researcher" },
          max: 0,
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });

    it("filters by operation type", () => {
      const lineage = makeLineage({
        tasks: [
          { subagentName: "researcher", status: "completed", sequenceNumber: 1 },
        ],
      });
      // Default operation type is tool_call; filtering for hitl_response should find 0
      const [result] = evaluateAssertions(
        [{
          type: "operation_count",
          task: { subagentName: "researcher" },
          operationType: "hitl_response",
          min: 1,
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });

  describe("compaction_count", () => {
    it("passes when compaction count is within range", () => {
      const lineage = makeLineage();
      const mutable = lineage as unknown as { compactions: Array<unknown> };
      mutable.compactions = [
        { id: "comp-1", runId: "run-1", input: "text", summary: "summary", inputTokens: 100, outputTokens: 50, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "comp-2", runId: "run-1", input: "text2", summary: "summary2", inputTokens: 100, outputTokens: 50, createdAt: "2026-01-01T00:00:00.000Z" },
      ];
      const [result] = evaluateAssertions(
        [{ type: "compaction_count", min: 1, max: 3, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails when no compactions and min requires some", () => {
      const lineage = makeLineage();
      const [result] = evaluateAssertions(
        [{ type: "compaction_count", min: 1, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });

    it("passes when asserting zero compactions on empty", () => {
      const lineage = makeLineage();
      const [result] = evaluateAssertions(
        [{ type: "compaction_count", max: 0, description: "test" }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });
  });

  describe("run_error", () => {
    it("passes when error matches pattern", () => {
      const lineage = makeLineage({
        runStatus: "failed",
        runError: "Max tasks per run exceeded (2)",
      });
      const [result] = evaluateAssertions(
        [{
          type: "run_error",
          pattern: "max tasks",
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails when run is not failed", () => {
      const lineage = makeLineage({ runStatus: "completed" });
      const [result] = evaluateAssertions(
        [{
          type: "run_error",
          pattern: "anything",
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });

    it("fails when error does not match pattern", () => {
      const lineage = makeLineage({
        runStatus: "failed",
        runError: "circuit_breaker triggered",
      });
      const [result] = evaluateAssertions(
        [{
          type: "run_error",
          pattern: "limit_exceeded",
          description: "test",
        }],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });

  describe("run_output_matches_artifact", () => {
    it("passes when run output includes the artifact content", () => {
      const lineage = makeLineage({
        tasks: [
          {
            subagentName: "synthesizer",
            status: "completed",
            sequenceNumber: 1,
            artifacts: [
              {
                id: "art-1",
                name: "synthesizer_output",
                content: "GAP-01 | HIGH | Disaster Recovery",
                type: "text",
              },
            ],
          },
        ],
      });
      (lineage.run as { output: string }).output =
        "GAP-01 | HIGH | Disaster Recovery\nDocs: NCE-POL-008, NCE-AUD-004";

      const [result] = evaluateAssertions(
        [
          {
            type: "run_output_matches_artifact",
            task: { subagentName: "synthesizer" },
            mode: "contains",
            description: "test",
          },
        ],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("passes on exact normalized match", () => {
      const lineage = makeLineage({
        tasks: [
          {
            subagentName: "synthesizer",
            status: "completed",
            sequenceNumber: 1,
            artifacts: [
              {
                id: "art-1",
                name: "synthesizer_output",
                content: "GAP-01 | HIGH | Disaster Recovery\nDocs: A, B",
                type: "text",
              },
            ],
          },
        ],
      });
      (lineage.run as { output: string }).output =
        "GAP-01 | HIGH | Disaster Recovery  Docs: A, B";

      const [result] = evaluateAssertions(
        [
          {
            type: "run_output_matches_artifact",
            task: { subagentName: "synthesizer" },
            mode: "exact",
            description: "test",
          },
        ],
        lineage,
      );
      expect(result?.passed).toBe(true);
    });

    it("fails when run output diverges from the artifact", () => {
      const lineage = makeLineage({
        tasks: [
          {
            subagentName: "synthesizer",
            status: "completed",
            sequenceNumber: 1,
            artifacts: [
              {
                id: "art-1",
                name: "synthesizer_output",
                content: "GAP-01 | HIGH | Disaster Recovery",
                type: "text",
              },
            ],
          },
        ],
      });
      (lineage.run as { output: string }).output =
        "Executive summary only.";

      const [result] = evaluateAssertions(
        [
          {
            type: "run_output_matches_artifact",
            task: { subagentName: "synthesizer" },
            mode: "contains",
            description: "test",
          },
        ],
        lineage,
      );
      expect(result?.passed).toBe(false);
    });
  });
});
