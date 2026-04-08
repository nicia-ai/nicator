import {
  asOperationNodeId,
  asTaskNodeId,
  storageOp,
  toOperation,
} from "../repository-helpers.js";
import type { Operation, OperationPatch } from "../schema.js";
import { OperationStorageSchema } from "../schema.js";
import { pickDefined } from "../utility.js";
import type { NicatorStore } from "./types.js";

export function createOperationRepo(store: NicatorStore) {
  return {
    async create(operation: Operation): Promise<void> {
      return storageOp("operations.create", async () => {
        const flat = OperationStorageSchema.parse(operation);
        const operationNode = await store.nodes.Operation.create(
          {
            type: flat.type,
            status: flat.status,
            input: flat.input,
            ...(flat.output === undefined ? {} : { output: flat.output }),
            ...(flat.error == undefined ? {} : { error: flat.error }),
            inputTokens: flat.inputTokens,
            outputTokens: flat.outputTokens,
            ...(flat.latencyMs == undefined ?
              {}
            : { latencyMs: flat.latencyMs }),
            createdAt: flat.createdAt,
            ...(flat.completedAt == undefined ?
              {}
            : { completedAt: flat.completedAt }),
          },
          { id: flat.id },
        );

        const taskNode = await store.nodes.Task.getById(
          asTaskNodeId(operation.taskId),
        );
        if (taskNode) {
          await store.edges.has_operation.create(taskNode, operationNode, {
            operationNumber: operation.operationNumber,
          });
        }
      });
    },

    async update(id: string, patch: OperationPatch): Promise<void> {
      return storageOp("operations.update", async () => {
        const updates = pickDefined({
          status: patch.status,
          output: patch.output,
          error: patch.error,
          inputTokens: patch.inputTokens,
          outputTokens: patch.outputTokens,
          latencyMs: patch.latencyMs,
          completedAt: patch.completedAt,
        });
        if (Object.keys(updates).length === 0) return;
        await store.nodes.Operation.update(asOperationNodeId(id), updates);
      });
    },

    async getForTask(taskId: string, runId: string): Promise<Operation[]> {
      return storageOp("operations.getForTask", async () => {
        const results = await store
          .query()
          .from("Task", "t")
          .traverse("has_operation", "e")
          .to("Operation", "op")
          .whereNode("t", (t) => t.id.eq(taskId))
          .orderBy("e", "operationNumber", "asc")
          .select((ctx) => ({
            operation: ctx.op,
            operationNumber: ctx.e.operationNumber,
          }))
          .execute();

        return results.map((row) =>
          toOperation(
            row.operation,
            taskId,
            runId,
            Number(row.operationNumber),
          ),
        );
      });
    },
  };
}
