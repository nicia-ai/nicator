import type { Store } from "@nicia-ai/typegraph";

import type { nicatorGraph } from "../graph.js";
import type {
  AgentDefinition,
  Artifact,
  ArtifactType,
  Compaction,
  Operation,
  Run,
  Skill,
  Task,
  TaskRole,
} from "../schema.js";

export type NicatorStore = Store<typeof nicatorGraph>;

export type RunLineage = Readonly<{
  run: Run;
  definition: AgentDefinition;
  tasks: ReadonlyArray<
    Readonly<{
      task: Task;
      skill: Skill | undefined;
      consumedArtifactIds: ReadonlyArray<string>;
      operations: ReadonlyArray<
        Readonly<{
          operation: Operation;
          artifacts: ReadonlyArray<Artifact>;
        }>
      >;
    }>
  >;
  inputArtifacts: ReadonlyArray<Artifact>;
  compactions: ReadonlyArray<Compaction>;
}>;

export type ArtifactProvenance = Readonly<{
  artifact: Artifact;
  operation?: Operation;
  task?: Task;
  run?: Run;
  consumedBy: ReadonlyArray<Task>;
}>;

export type ArtifactLookupFilters = Readonly<{
  nameContains?: string;
  type?: ArtifactType;
  producedBySubagent?: string;
  taskRole?: TaskRole;
  includeInputArtifacts?: boolean;
  limit?: number;
}>;

export type ArtifactLookupEntry = Readonly<{
  artifact: Artifact;
  source: "produced" | "input";
  producerTask?: Task;
}>;
