import {
  asRunNodeId,
  edgeNumber,
  edgesFrom,
  getByKind,
  reverseEdge,
  storageOp,
  toAgentDefinition,
  toArtifact,
  toCompaction,
  toOperation,
  toRun,
  toSkill,
  toSkillRef,
  toTask,
} from "../repository-helpers.js";
import type { Artifact, Compaction } from "../schema.js";
import type { NicatorStore, RunLineage } from "./types.js";

export function createLineageRepo(store: NicatorStore) {
  return {
    async getRunLineage(runId: string): Promise<RunLineage | undefined> {
      return storageOp("lineage.getRunLineage", async () => {
        const sg = await store.subgraph(asRunNodeId(runId), {
          edges: [
            "instantiates",
            "uses",
            "contains",
            "spawns",
            "invokes",
            "has_operation",
            "produces",
            "consumes",
            "has_input",
            "has_compaction",
          ],
          maxDepth: 5,
        });

        if (!sg.root) return undefined;
        const runNode = sg.root;
        if (runNode.kind !== "Run") return undefined;

        const instEdge = edgesFrom(sg, "instantiates", runId)[0];
        if (!instEdge) return undefined;

        const defNode = getByKind(
          sg.nodes,
          "AgentDefinition",
          String(instEdge.toId),
        );
        if (!defNode) return undefined;

        const run = toRun(
          runNode,
          String(defNode.id),
          Number(instEdge["version"]),
        );

        const defId = String(defNode.id);
        const skillReferences = edgesFrom(sg, "uses", defId)
          .map((ue) => {
            const skillNode = getByKind(sg.nodes, "Skill", String(ue.toId));
            return skillNode ?
                toSkillRef({
                  name: skillNode.name,
                  version: skillNode.version,
                  policy: "policy" in ue ? ue["policy"] : undefined,
                })
              : undefined;
          })
          .filter((s): s is NonNullable<typeof s> => s !== undefined);

        const definition = toAgentDefinition(defNode, skillReferences);

        const containsEdges = edgesFrom(sg, "contains", runId).toSorted(
          (a, b) =>
            edgeNumber(a, "sequenceNumber") - edgeNumber(b, "sequenceNumber"),
        );

        const tasks: RunLineage["tasks"][number][] = [];

        for (const ce of containsEdges) {
          const taskId = String(ce.toId);
          const taskNode = getByKind(sg.nodes, "Task", taskId);
          if (!taskNode) continue;

          const parentEdge = reverseEdge(sg, "spawns", taskId);
          const sequenceNumber = edgeNumber(ce, "sequenceNumber");
          const task = toTask(
            taskNode,
            runId,
            sequenceNumber,
            parentEdge ? String(parentEdge.fromId) : undefined,
          );

          const invokeEdge = edgesFrom(sg, "invokes", taskId)[0];
          const skillNode =
            invokeEdge ?
              getByKind(sg.nodes, "Skill", String(invokeEdge.toId))
            : undefined;
          const skill = skillNode ? toSkill(skillNode) : undefined;

          const consumedArtifactIds = edgesFrom(sg, "consumes", taskId).map(
            (edge) => String(edge.toId),
          );

          const operationEdges = edgesFrom(
            sg,
            "has_operation",
            taskId,
          ).toSorted(
            (a, b) =>
              edgeNumber(a, "operationNumber") -
              edgeNumber(b, "operationNumber"),
          );

          const operations = operationEdges
            .map((oe) => {
              const operationId = String(oe.toId);
              const operationNode = getByKind(
                sg.nodes,
                "Operation",
                operationId,
              );
              if (!operationNode) return undefined;

              const opNumber = edgeNumber(oe, "operationNumber");
              const operation = toOperation(
                operationNode,
                taskId,
                runId,
                opNumber,
              );
              const artifacts = edgesFrom(sg, "produces", operationId)
                .map((pe) => {
                  const artNode = getByKind(
                    sg.nodes,
                    "Artifact",
                    String(pe.toId),
                  );
                  return artNode ? toArtifact(artNode) : undefined;
                })
                .filter((a): a is Artifact => a !== undefined);

              return { operation, artifacts };
            })
            .filter(
              (entry): entry is NonNullable<typeof entry> =>
                entry !== undefined,
            );

          tasks.push({ task, skill, consumedArtifactIds, operations });
        }

        const inputArtifacts: Artifact[] = edgesFrom(sg, "has_input", runId)
          .map((ie) => {
            const artNode = getByKind(sg.nodes, "Artifact", String(ie.toId));
            return artNode ? toArtifact(artNode) : undefined;
          })
          .filter((a): a is Artifact => a !== undefined);

        const compactions: Compaction[] = edgesFrom(sg, "has_compaction", runId)
          .map((ce) => {
            const node = getByKind(sg.nodes, "Compaction", String(ce.toId));
            return node ? toCompaction(node, runId) : undefined;
          })
          .filter((c): c is Compaction => c !== undefined);

        return { run, definition, tasks, inputArtifacts, compactions };
      });
    },
  };
}
