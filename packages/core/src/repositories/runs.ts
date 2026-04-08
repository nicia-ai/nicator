import {
  asDefinitionNodeId,
  asRunNodeId,
  storageOp,
  toRun,
} from "../repository-helpers.js";
import type { Run, RunPatch } from "../schema.js";
import { RunStorageSchema } from "../schema.js";
import { pickDefined } from "../utility.js";
import type { NicatorStore } from "./types.js";

export function createRunRepo(store: NicatorStore) {
  return {
    async get(id: string): Promise<Run | undefined> {
      return storageOp("runs.get", async () => {
        const node = await store.nodes.Run.getById(asRunNodeId(id));
        if (!node) return undefined;

        const edges = await store
          .query()
          .from("Run", "r")
          .traverse("instantiates", "e")
          .to("AgentDefinition", "d")
          .whereNode("r", (r) => r.id.eq(id))
          .select((ctx) => ({ definitionId: ctx.d.id, version: ctx.e.version }))
          .execute();

        const edge = edges[0];
        if (!edge) return undefined;

        return toRun(node, String(edge.definitionId), Number(edge.version));
      });
    },

    async create(run: Run): Promise<void> {
      return storageOp("runs.create", async () => {
        const flat = RunStorageSchema.parse(run);
        const runNode = await store.nodes.Run.create(
          {
            status: flat.status,
            input: flat.input,
            ...(flat.output == undefined ? {} : { output: flat.output }),
            ...(flat.error == undefined ? {} : { error: flat.error }),
            totalTokensUsed: flat.totalTokensUsed,
            createdAt: flat.createdAt,
            updatedAt: flat.updatedAt,
            ...(flat.completedAt == undefined ?
              {}
            : { completedAt: flat.completedAt }),
          },
          { id: flat.id },
        );

        const definitionNode = await store.nodes.AgentDefinition.getById(
          asDefinitionNodeId(run.agentDefinitionId),
        );
        if (definitionNode) {
          // Edge version is derived from the definition node — single source of truth
          await store.edges.instantiates.create(runNode, definitionNode, {
            version: definitionNode.version,
          });
        }
      });
    },

    async update(id: string, patch: RunPatch): Promise<void> {
      return storageOp("runs.update", async () => {
        const updates = pickDefined({
          status: patch.status,
          output: patch.output,
          error: patch.error,
          totalTokensUsed: patch.totalTokensUsed,
          updatedAt: patch.updatedAt,
          completedAt: patch.completedAt,
        });
        if (Object.keys(updates).length === 0) return;
        await store.nodes.Run.update(asRunNodeId(id), updates);
      });
    },

    async listRecent(limit = 50): Promise<Run[]> {
      return storageOp("runs.listRecent", async () => {
        const results = await store
          .query()
          .from("Run", "r")
          .traverse("instantiates", "e")
          .to("AgentDefinition", "d")
          .orderBy("r", "createdAt", "desc")
          .select((ctx) => ({
            run: ctx.r,
            definitionId: ctx.d.id,
            version: ctx.e.version,
          }))
          .paginate({ first: limit });

        return results.data.map((row) =>
          toRun(row.run, String(row.definitionId), Number(row.version)),
        );
      });
    },
  };
}
