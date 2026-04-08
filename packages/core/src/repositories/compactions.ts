import { asRunNodeId, storageOp } from "../repository-helpers.js";
import type { Compaction } from "../schema.js";
import type { NicatorStore } from "./types.js";

export function createCompactionRepo(store: NicatorStore) {
  return {
    async create(compaction: Compaction): Promise<void> {
      return storageOp("compactions.create", async () => {
        const compactionNode = await store.nodes.Compaction.create(
          {
            input: compaction.input,
            summary: compaction.summary,
            inputTokens: compaction.inputTokens,
            outputTokens: compaction.outputTokens,
            createdAt: compaction.createdAt,
          },
          { id: compaction.id },
        );

        const runNode = await store.nodes.Run.getById(
          asRunNodeId(compaction.runId),
        );
        if (runNode) {
          await store.edges.has_compaction.create(runNode, compactionNode);
        }
      });
    },
  };
}
