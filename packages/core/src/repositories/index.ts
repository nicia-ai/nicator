import { createAgentRepo } from "./agents.js";
import { createArtifactRepo } from "./artifacts.js";
import { createCompactionRepo } from "./compactions.js";
import { createLineageRepo } from "./lineage.js";
import { createOperationRepo } from "./operations.js";
import { createRunRepo } from "./runs.js";
import { createTaskRepo } from "./tasks.js";
import type { NicatorStore } from "./types.js";

export type { HitlDecisionMatch } from "./tasks.js";
export type { ArtifactProvenance, NicatorStore, RunLineage } from "./types.js";

export function createRepository(store: NicatorStore) {
  return {
    agents: createAgentRepo(store),
    runs: createRunRepo(store),
    tasks: createTaskRepo(store),
    operations: createOperationRepo(store),
    artifacts: createArtifactRepo(store),
    compactions: createCompactionRepo(store),
    lineage: createLineageRepo(store),
  };
}

export type Repository = ReturnType<typeof createRepository>;
