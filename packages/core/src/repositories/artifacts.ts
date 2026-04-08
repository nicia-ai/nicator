import {
  asArtifactNodeId,
  asOperationNodeId,
  asRunNodeId,
  asTaskNodeId,
  edgeNumber,
  edgesFrom,
  getByKind,
  reverseEdge,
  storageOp,
  toArtifact,
  toOperation,
  toRun,
  toTask,
} from "../repository-helpers.js";
import type { Artifact, Operation, Run, Task } from "../schema.js";
import type { ArtifactProvenance } from "./types.js";
import type { NicatorStore } from "./types.js";

export function createArtifactRepo(store: NicatorStore) {
  const repo = {
    async create(artifact: Artifact): Promise<void> {
      return storageOp("artifacts.create", async () => {
        await store.nodes.Artifact.create(
          {
            type: artifact.type,
            name: artifact.name,
            content: artifact.content,
            contentHash: artifact.contentHash,
            mimeType: artifact.mimeType,
            createdAt: artifact.createdAt,
          },
          { id: artifact.id },
        );
      });
    },

    /**
     * Create an artifact and link it to the producing operation in one call.
     * If an artifact with the same contentHash already exists in the run,
     * links the existing node instead of creating a duplicate. If an artifact
     * with the same name but different content exists, creates a new version
     * and links it via a `supersedes` edge.
     */
    async createAndLinkProduced(
      artifact: Artifact,
      operationId: string,
      runId?: string,
    ): Promise<void> {
      return storageOp("artifacts.createAndLinkProduced", async () => {
        const opNode = await store.nodes.Operation.getById(
          asOperationNodeId(operationId),
        );
        if (!opNode) return;

        // Content-address dedup: if an identical artifact exists in this run,
        // just link the existing node to the operation.
        if (runId) {
          const existing = await findByContentHashInRun(
            runId,
            artifact.contentHash,
          );
          if (existing) {
            await store.edges.produces.create(opNode, existing);
            return;
          }
        }

        const artNode = await store.nodes.Artifact.create(
          {
            type: artifact.type,
            name: artifact.name,
            content: artifact.content,
            contentHash: artifact.contentHash,
            mimeType: artifact.mimeType,
            createdAt: artifact.createdAt,
          },
          { id: artifact.id },
        );

        await store.edges.produces.create(opNode, artNode);

        // Version chain: if a prior artifact with the same name exists in this
        // run, link new → old via supersedes.
        if (runId) {
          const previous = await findLatestByNameInRun(
            runId,
            artifact.name,
            artifact.id,
          );
          if (previous) {
            await store.edges.supersedes.create(artNode, previous);
          }
        }
      });
    },

    async linkProduced(operationId: string, artifactId: string): Promise<void> {
      return storageOp("artifacts.linkProduced", async () => {
        const opNode = await store.nodes.Operation.getById(
          asOperationNodeId(operationId),
        );
        const artNode = await store.nodes.Artifact.getById(
          asArtifactNodeId(artifactId),
        );
        if (!opNode || !artNode) {
          console.warn(
            `linkProduced: missing node — operation=${operationId} (${opNode ? "found" : "missing"}), artifact=${artifactId} (${artNode ? "found" : "missing"})`,
          );
          return;
        }
        await store.edges.produces.create(opNode, artNode);
      });
    },

    async linkInputToRun(runId: string, artifactId: string): Promise<void> {
      return storageOp("artifacts.linkInputToRun", async () => {
        const runNode = await store.nodes.Run.getById(asRunNodeId(runId));
        const artNode = await store.nodes.Artifact.getById(
          asArtifactNodeId(artifactId),
        );
        if (runNode && artNode) {
          await store.edges.has_input.create(runNode, artNode);
        }
      });
    },

    /**
     * Check if an artifact belongs to a run (via produces chain or has_input).
     * Run-independent artifacts (skill_prompt, skill_asset) return true for any run.
     */
    async belongsToRun(artifactId: string, runId: string): Promise<boolean> {
      return storageOp("artifacts.belongsToRun", async () => {
        const artifact = await store.nodes.Artifact.getById(
          asArtifactNodeId(artifactId),
        );
        if (!artifact) return false;

        // Skill artifacts are run-independent
        if (
          artifact.type === "skill_prompt" ||
          artifact.type === "skill_asset"
        ) {
          return true;
        }

        const [producedMatch, inputMatch] = await Promise.all([
          store
            .query()
            .from("Run", "r")
            .traverse("contains", "ce")
            .to("Task", "t")
            .traverse("has_operation", "he")
            .to("Operation", "op")
            .traverse("produces", "pe")
            .to("Artifact", "art")
            .whereNode("r", (r) => r.id.eq(runId))
            .whereNode("art", (a) => a.id.eq(artifactId))
            .select((ctx) => ({ id: ctx.art.id }))
            .execute(),
          store
            .query()
            .from("Run", "r")
            .traverse("has_input", "ie")
            .to("Artifact", "art")
            .whereNode("r", (r) => r.id.eq(runId))
            .whereNode("art", (a) => a.id.eq(artifactId))
            .select((ctx) => ({ id: ctx.art.id }))
            .execute(),
        ]);

        return producedMatch.length > 0 || inputMatch.length > 0;
      });
    },

    async get(id: string): Promise<Artifact | undefined> {
      return storageOp("artifacts.get", async () => {
        const node = await store.nodes.Artifact.getById(asArtifactNodeId(id));
        if (!node) return undefined;
        return toArtifact(node);
      });
    },

    async getIdsForOperation(operationId: string): Promise<string[]> {
      return storageOp("artifacts.getIdsForOperation", async () => {
        const results = await store
          .query()
          .from("Operation", "op")
          .traverse("produces", "pe")
          .to("Artifact", "art")
          .whereNode("op", (op) => op.id.eq(operationId))
          .select((ctx) => ({ id: ctx.art.id }))
          .execute();

        return results.map((row) => String(row.id));
      });
    },

    async getForRun(runId: string): Promise<Artifact[]> {
      return storageOp("artifacts.getForRun", async () => {
        const [producedResults, inputResults] = await Promise.all([
          store
            .query()
            .from("Run", "r")
            .traverse("contains", "ce")
            .to("Task", "t")
            .traverse("has_operation", "he")
            .to("Operation", "op")
            .traverse("produces", "pe")
            .to("Artifact", "art")
            .whereNode("r", (r) => r.id.eq(runId))
            .select((ctx) => ({ artifact: ctx.art }))
            .execute(),
          store
            .query()
            .from("Run", "r")
            .traverse("has_input", "ie")
            .to("Artifact", "art")
            .whereNode("r", (r) => r.id.eq(runId))
            .select((ctx) => ({ artifact: ctx.art }))
            .execute(),
        ]);

        return [...producedResults, ...inputResults].map((row) =>
          toArtifact(row.artifact),
        );
      });
    },

    async getForRunByNames(
      runId: string,
      names: ReadonlyArray<string>,
    ): Promise<Artifact[]> {
      if (names.length === 0) return [];
      return storageOp("artifacts.getForRunByNames", async () => {
        const [producedResults, inputResults] = await Promise.all([
          store
            .query()
            .from("Run", "r")
            .traverse("contains", "ce")
            .to("Task", "t")
            .traverse("has_operation", "he")
            .to("Operation", "op")
            .traverse("produces", "pe")
            .to("Artifact", "art")
            .whereNode("r", (r) => r.id.eq(runId))
            .whereNode("art", (art) => art.name.in(names))
            .select((ctx) => ({ artifact: ctx.art }))
            .execute(),
          store
            .query()
            .from("Run", "r")
            .traverse("has_input", "ie")
            .to("Artifact", "art")
            .whereNode("r", (r) => r.id.eq(runId))
            .whereNode("art", (art) => art.name.in(names))
            .select((ctx) => ({ artifact: ctx.art }))
            .execute(),
        ]);

        return [...producedResults, ...inputResults].map((row) =>
          toArtifact(row.artifact),
        );
      });
    },

    async addConsumesEdge(taskId: string, artifactId: string): Promise<void> {
      return storageOp("artifacts.addConsumesEdge", async () => {
        const taskNode = await store.nodes.Task.getById(asTaskNodeId(taskId));
        const artifactNode = await store.nodes.Artifact.getById(
          asArtifactNodeId(artifactId),
        );
        if (!taskNode || !artifactNode) {
          console.warn(
            `addConsumesEdge: missing node — task=${taskId} (${taskNode ? "found" : "missing"}), artifact=${artifactId} (${artifactNode ? "found" : "missing"})`,
          );
          return;
        }
        await store.edges.consumes.create(taskNode, artifactNode);
      });
    },

    async getProvenance(
      artifactId: string,
    ): Promise<ArtifactProvenance | undefined> {
      return storageOp("artifacts.getProvenance", async () => {
        const sg = await store.subgraph(asArtifactNodeId(artifactId), {
          edges: [
            "produces",
            "has_operation",
            "contains",
            "instantiates",
            "has_input",
            "has_definition",
            "has_asset",
          ],
          direction: "both",
          maxDepth: 4,
        });

        if (!sg.root) return undefined;
        const artNode = sg.root.kind === "Artifact" ? sg.root : undefined;
        if (!artNode) return undefined;
        const artifact = toArtifact(artNode);

        // Walk the production chain: Artifact ←produces— Operation ←has_operation— Task ←contains— Run
        let operation: Operation | undefined;
        let task: Task | undefined;
        let run: Run | undefined;

        const productionEdge = reverseEdge(sg, "produces", artifactId);
        if (productionEdge) {
          const opId = String(productionEdge.fromId);
          const opNode = getByKind(sg.nodes, "Operation", opId);
          if (opNode) {
            const hoEdge = reverseEdge(sg, "has_operation", opId);
            if (hoEdge) {
              const tId = String(hoEdge.fromId);
              const tNode = getByKind(sg.nodes, "Task", tId);
              if (tNode) {
                const ceEdge = reverseEdge(sg, "contains", tId);
                if (ceEdge) {
                  const rId = String(ceEdge.fromId);
                  const rNode = getByKind(sg.nodes, "Run", rId);
                  if (rNode) {
                    const instEdge = edgesFrom(sg, "instantiates", rId)[0];
                    if (instEdge) {
                      const defNode = getByKind(
                        sg.nodes,
                        "AgentDefinition",
                        String(instEdge.toId),
                      );
                      if (defNode) {
                        run = toRun(
                          rNode,
                          String(defNode.id),
                          Number(instEdge["version"]),
                        );
                      }
                    }
                  }
                  task = toTask(
                    tNode,
                    run?.id ?? rId,
                    edgeNumber(ceEdge, "sequenceNumber"),
                  );
                }
              }
              operation = toOperation(
                opNode,
                task?.id ?? "",
                run?.id ?? "",
                edgeNumber(hoEdge, "operationNumber"),
              );
            }
          }
        }

        // Determine the owning run (via production chain or has_input edge)
        const inputEdge =
          run ? undefined : reverseEdge(sg, "has_input", artifactId);
        const runId =
          run?.id ?? (inputEdge ? String(inputEdge.fromId) : undefined);

        let consumedBy: Task[] = [];
        if (runId) {
          const consumerResults = await store
            .query()
            .from("Run", "r")
            .traverse("contains", "ce")
            .to("Task", "t")
            .traverse("consumes", "e")
            .to("Artifact", "a")
            .whereNode("r", (r) => r.id.eq(runId))
            .whereNode("a", (a) => a.id.eq(artifactId))
            .select((ctx) => ({
              task: ctx.t,
              sequenceNumber: ctx.ce.sequenceNumber,
            }))
            .execute();
          consumedBy = consumerResults.map((row) =>
            toTask(row.task, runId, Number(row.sequenceNumber)),
          );
        }

        return {
          artifact,
          ...(operation === undefined ? {} : { operation }),
          ...(task === undefined ? {} : { task }),
          ...(run === undefined ? {} : { run }),
          consumedBy,
        };
      });
    },
  };

  // ---------------------------------------------------------------------------
  // Content-address and version-chain helpers (closure over store)
  // ---------------------------------------------------------------------------

  /** Resolve a query result to a live graph node for edge creation. */
  async function resolveArtifactNode(
    results: ReadonlyArray<{ node: { id: unknown } }>,
  ) {
    const first = results[0];
    if (!first) return undefined;
    return store.nodes.Artifact.getById(
      asArtifactNodeId(String(first.node.id)),
    );
  }

  async function findByContentHashInRun(runId: string, contentHash: string) {
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
      .whereNode("art", (a) => a.contentHash.eq(contentHash))
      .select((ctx) => ({ node: ctx.art }))
      .execute();
    return resolveArtifactNode(results);
  }

  async function findLatestByNameInRun(
    runId: string,
    name: string,
    excludeId: string,
  ) {
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
      .whereNode("art", (a) => a.name.eq(name))
      .select((ctx) => ({ node: ctx.art }))
      .execute();

    const candidates = results.filter((r) => String(r.node.id) !== excludeId);
    if (candidates.length === 0) return undefined;

    // ISO 8601 timestamps sort lexicographically
    candidates.sort((a, b) =>
      String(b.node.createdAt).localeCompare(String(a.node.createdAt)),
    );
    return resolveArtifactNode(candidates);
  }

  return repo;
}
