import type { Store } from "@nicia-ai/typegraph";

import type { nicatorGraph } from "../graph.js";
import type {
  AgentDefinition,
  Artifact,
  Compaction,
  Operation,
  Run,
  Skill,
  Task,
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
