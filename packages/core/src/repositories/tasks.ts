import {
  asRunNodeId,
  asSkillNodeId,
  asTaskNodeId,
  storageOp,
  toTask,
} from "../repository-helpers.js";
import type { Task, TaskPatch } from "../schema.js";
import {
  normalizeHitlPrompt,
  parseApprovalDecision,
  pickDefined,
} from "../utility.js";
import type { NicatorStore } from "./types.js";

export type HitlDecisionMatch = Readonly<{
  taskId: string;
  approved: boolean;
  artifactId: string;
  artifactContent: string;
}>;

export function createTaskRepo(store: NicatorStore) {
  return {
    async create(task: Task): Promise<void> {
      return storageOp("tasks.create", async () => {
        const taskNode = await store.nodes.Task.create(
          {
            role: task.role,
            subagentName: task.subagentName,
            status: task.status,
            input: task.input,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          },
          { id: task.id },
        );

        const runNode = await store.nodes.Run.getById(asRunNodeId(task.runId));
        if (runNode) {
          await store.edges.contains.create(runNode, taskNode, {
            sequenceNumber: task.sequenceNumber,
          });
        }

        if (task.parentTaskId) {
          const parentNode = await store.nodes.Task.getById(
            asTaskNodeId(task.parentTaskId),
          );
          if (parentNode) {
            await store.edges.spawns.create(parentNode, taskNode);
          }
        }
      });
    },

    async linkSkill(taskId: string, skillId: string): Promise<void> {
      return storageOp("tasks.linkSkill", async () => {
        const [taskNode, skillNode] = await Promise.all([
          store.nodes.Task.getById(asTaskNodeId(taskId)),
          store.nodes.Skill.getById(asSkillNodeId(skillId)),
        ]);
        if (taskNode && skillNode) {
          await store.edges.invokes.create(taskNode, skillNode);
        }
      });
    },

    async update(id: string, patch: TaskPatch): Promise<void> {
      return storageOp("tasks.update", async () => {
        const updates = pickDefined({
          status: patch.status,
          updatedAt: patch.updatedAt,
        });
        if (Object.keys(updates).length === 0) return;
        await store.nodes.Task.update(asTaskNodeId(id), updates);
      });
    },

    async countCompletedByName(
      runId: string,
      subagentName: string,
    ): Promise<number> {
      return storageOp("tasks.countCompletedByName", async () => {
        const results = await store
          .query()
          .from("Run", "r")
          .traverse("contains", "e")
          .to("Task", "t")
          .whereNode("r", (r) => r.id.eq(runId))
          .whereNode("t", (t) => t.subagentName.eq(subagentName))
          .whereNode("t", (t) => t.status.eq("completed"))
          .select((ctx) => ({ id: ctx.t.id }))
          .execute();
        return results.length;
      });
    },

    async getCount(runId: string): Promise<number> {
      return storageOp("tasks.getCount", async () => {
        const results = await store
          .query()
          .from("Run", "r")
          .traverse("contains", "e")
          .to("Task", "t")
          .whereNode("r", (r) => r.id.eq(runId))
          .select((ctx) => ({ id: ctx.t.id }))
          .execute();
        return results.length;
      });
    },

    async getForRun(runId: string): Promise<Task[]> {
      return storageOp("tasks.getForRun", async () => {
        const [results, spawnsResults] = await Promise.all([
          store
            .query()
            .from("Run", "r")
            .traverse("contains", "e")
            .to("Task", "t")
            .whereNode("r", (r) => r.id.eq(runId))
            .orderBy("e", "sequenceNumber", "asc")
            .select((ctx) => ({
              task: ctx.t,
              sequenceNumber: ctx.e.sequenceNumber,
            }))
            .execute(),
          store
            .query()
            .from("Run", "r")
            .traverse("contains", "c")
            .to("Task", "parent")
            .traverse("spawns", "s")
            .to("Task", "child")
            .whereNode("r", (r) => r.id.eq(runId))
            .select((ctx) => ({ parentId: ctx.parent, childId: ctx.child }))
            .execute(),
        ]);

        const parentMap = new Map<string, string>();
        for (const row of spawnsResults) {
          parentMap.set(String(row.childId.id), String(row.parentId.id));
        }

        return results.map((row) =>
          toTask(
            row.task,
            runId,
            Number(row.sequenceNumber),
            parentMap.get(String(row.task.id)),
          ),
        );
      });
    },

    /**
     * Find a prior HITL decision in this run whose normalized prompt matches.
     * Single graph traversal: Run → Task → Operation(hitl_response) → Artifact(hitl_decision).
     * Matches both agent-initiated HITL (child task with role "hitl") and
     * policy-gated HITL (operation on root task). Replaces the
     * O(tasks × operations × artifacts) loop.
     */
    async findHitlDecision(
      runId: string,
      prompt: string,
    ): Promise<HitlDecisionMatch | undefined> {
      return storageOp("tasks.findHitlDecision", async () => {
        const normalizedPrompt = normalizeHitlPrompt(prompt);

        // Single traversal: Run → Task → Operation → Artifact.
        // No role filter — hitl_response operations may live on either a
        // dedicated hitl child task (agent-initiated) or the root task
        // (policy-gated require_hitl_approval).
        const results = await store
          .query()
          .from("Run", "r")
          .traverse("contains", "ce")
          .to("Task", "t")
          .traverse("has_operation", "he")
          .to("Operation", "op")
          .traverse("produces", "pe")
          .to("Artifact", "art")
          .whereNode("r", (r) => r.id.eq(runId))
          .whereNode("op", (op) => op.type.eq("hitl_response"))
          .whereNode("op", (op) => op.status.eq("succeeded"))
          .whereNode("art", (art) => art.type.eq("hitl_decision"))
          .select((ctx) => ({
            task: ctx.t,
            operation: ctx.op,
            artifact: ctx.art,
          }))
          .execute();

        for (const row of results) {
          const opInput = row.operation.input as
            | Record<string, unknown>
            | null
            | undefined;
          if (
            typeof opInput === "object" &&
            opInput !== null &&
            "prompt" in opInput
          ) {
            const storedPrompt = opInput["prompt"];
            if (
              typeof storedPrompt === "string" &&
              normalizeHitlPrompt(storedPrompt) === normalizedPrompt
            ) {
              // The decision lives in the artifact content, not the task
              // status: policy-gated HITL records its operation on the root
              // task, which stays "running" for the life of the run. Parsing
              // the content mirrors how approval was derived when the
              // decision was recorded.
              const content = String(row.artifact.content);
              return {
                taskId: String(row.task.id),
                approved: parseApprovalDecision(content) === "approved",
                artifactId: String(row.artifact.id),
                artifactContent: content,
              };
            }
          }
        }

        return undefined;
      });
    },
  };
}
