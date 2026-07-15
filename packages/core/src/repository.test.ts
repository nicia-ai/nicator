import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { nicatorGraph } from "./graph.js";
import { createRepository, type Repository } from "./repositories/index.js";
import type {
  AgentDefinition,
  Artifact,
  Operation,
  Run,
  Skill,
  Task,
} from "./schema.js";
import {
  makeArtifact,
  makeDefinition,
  makeOperation,
  makeRun,
  makeSkill,
  makeTask,
} from "./test-factories.js";
import { generateId } from "./utility.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// libsql's `file::memory:` gives every new connection its own empty database,
// and TypeGraph's transactional schema commit runs on a separate connection —
// so in-memory stores lose their schema. Each test repo gets a throwaway
// file in a shared temp dir instead, removed after the suite.
const testDbDir = mkdtempSync(join(tmpdir(), "nicator-core-test-"));

afterAll(() => {
  rmSync(testDbDir, { recursive: true, force: true });
});

async function createInMemoryRepo(): Promise<Repository> {
  const client = createClient({
    url: `file:${join(testDbDir, `${randomUUID()}.db`)}`,
  });
  const { backend } = await createLibsqlBackend(client);
  const [store] = await createStoreWithSchema(nicatorGraph, backend);
  return createRepository(store);
}

// ---------------------------------------------------------------------------
// Seed a complete run graph:
//   Definition → Run → Task1 (→ Skill, → Operation1 → Artifact1)
//                    → Task2 (→ Skill, → Operation2 → Artifact2, consumes Artifact1)
// ---------------------------------------------------------------------------

type SeededGraph = {
  repo: Repository;
  definition: AgentDefinition;
  run: Run;
  task1: Task;
  task2: Task;
  operation1: Operation;
  operation2: Operation;
  artifact1: Artifact;
  artifact2: Artifact;
  skill: Skill;
};

async function seedGraph(): Promise<SeededGraph> {
  const repo = await createInMemoryRepo();

  const skill = makeSkill();
  const skillNodeId = await repo.agents.registerSkill(skill);

  const definition = makeDefinition();
  await repo.agents.createDefinition(definition);

  const run = makeRun(definition.id);
  await repo.runs.create(run);

  const task1 = makeTask(run.id, 1);
  await repo.tasks.create(task1);
  await repo.tasks.linkSkill(task1.id, skillNodeId);

  const operation1 = makeOperation(task1.id, run.id, 1);
  await repo.operations.create(operation1);

  const artifact1 = makeArtifact({
    name: "research-results",
    content: "findings from task 1",
  });
  await repo.artifacts.create(artifact1);
  await repo.artifacts.linkProduced(operation1.id, artifact1.id);

  const task2 = makeTask(run.id, 2);
  await repo.tasks.create(task2);
  await repo.tasks.linkSkill(task2.id, skillNodeId);
  await repo.artifacts.addConsumesEdge(task2.id, artifact1.id);

  const operation2 = makeOperation(task2.id, run.id, 1);
  await repo.operations.create(operation2);

  const artifact2 = makeArtifact({
    name: "synthesis",
    content: "synthesized from task 1 output",
  });
  await repo.artifacts.create(artifact2);
  await repo.artifacts.linkProduced(operation2.id, artifact2.id);

  return {
    repo,
    definition,
    run,
    task1,
    task2,
    operation1,
    operation2,
    artifact1,
    artifact2,
    skill,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Repository — subgraph traversals", () => {
  let g: SeededGraph;

  beforeEach(async () => {
    g = await seedGraph();
  });

  // -------------------------------------------------------------------------
  // getArtifact — provenance chain via bidirectional subgraph
  // -------------------------------------------------------------------------

  describe("getArtifact", () => {
    it("returns artifact by id", async () => {
      const result = await g.repo.artifacts.get(g.artifact1.id);
      expect(result).not.toBeUndefined();
      expect(result!.id).toBe(g.artifact1.id);
      expect(result!.name).toBe("research-results");
    });

    it("returns a second artifact", async () => {
      const result = await g.repo.artifacts.get(g.artifact2.id);
      expect(result).not.toBeUndefined();
      expect(result!.id).toBe(g.artifact2.id);
    });

    it("returns null for a nonexistent artifact", async () => {
      const result = await g.repo.artifacts.get(generateId());
      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getRunLineage — full subgraph in one CTE
  // -------------------------------------------------------------------------

  describe("getRunLineage", () => {
    it("returns the complete run lineage with all nested entities", async () => {
      const lineage = await g.repo.lineage.getRunLineage(g.run.id);
      expect(lineage).not.toBeUndefined();

      // Run
      expect(lineage!.run.id).toBe(g.run.id);
      expect(lineage!.run.agentDefinitionId).toBe(g.definition.id);
      expect(lineage!.run.agentDefinitionVersion).toBe(1);

      // Definition
      expect(lineage!.definition.id).toBe(g.definition.id);
      expect(lineage!.definition.name).toBe("test-agent");
    });

    it("returns tasks ordered by sequenceNumber", async () => {
      const lineage = await g.repo.lineage.getRunLineage(g.run.id);
      expect(lineage!.tasks).toHaveLength(2);
      expect(lineage!.tasks[0]!.task.sequenceNumber).toBe(1);
      expect(lineage!.tasks[1]!.task.sequenceNumber).toBe(2);
    });

    it("resolves skill for each task", async () => {
      const lineage = await g.repo.lineage.getRunLineage(g.run.id);
      for (const entry of lineage!.tasks) {
        expect(entry.skill).not.toBeUndefined();
        expect(entry.skill!.name).toBe("test-skill");
        expect(entry.skill!.version).toBe("1.0.0");
      }
    });

    it("resolves operations and their artifacts per task", async () => {
      const lineage = await g.repo.lineage.getRunLineage(g.run.id);

      const t1 = lineage!.tasks[0]!;
      expect(t1.operations).toHaveLength(1);
      expect(t1.operations[0]!.operation.id).toBe(g.operation1.id);
      expect(t1.operations[0]!.artifacts).toHaveLength(1);
      expect(t1.operations[0]!.artifacts[0]!.id).toBe(g.artifact1.id);

      const t2 = lineage!.tasks[1]!;
      expect(t2.operations).toHaveLength(1);
      expect(t2.operations[0]!.operation.id).toBe(g.operation2.id);
      expect(t2.operations[0]!.artifacts).toHaveLength(1);
      expect(t2.operations[0]!.artifacts[0]!.id).toBe(g.artifact2.id);
    });

    it("tracks consumes edges as consumedArtifactIds", async () => {
      const lineage = await g.repo.lineage.getRunLineage(g.run.id);
      // Task 1 consumes nothing
      expect(lineage!.tasks[0]!.consumedArtifactIds).toHaveLength(0);
      // Task 2 consumes artifact1
      expect(lineage!.tasks[1]!.consumedArtifactIds).toContain(g.artifact1.id);
    });

    it("returns null for a nonexistent run", async () => {
      expect(await g.repo.lineage.getRunLineage(generateId())).toBeUndefined();
    });

    it("handles a task with multiple operations", async () => {
      const operation1b = makeOperation(g.task1.id, g.run.id, 2, {
        status: "failed",
        error: "transient failure",
        output: undefined,
      } as Partial<Operation>);
      await g.repo.operations.create(operation1b);

      const lineage = await g.repo.lineage.getRunLineage(g.run.id);
      const t1 = lineage!.tasks[0]!;
      expect(t1.operations).toHaveLength(2);
      expect(t1.operations[0]!.operation.operationNumber).toBe(1);
      expect(t1.operations[1]!.operation.operationNumber).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // getArtifactProvenance — bidirectional subgraph with consumers
  // -------------------------------------------------------------------------

  describe("getArtifactProvenance", () => {
    it("traces the full provenance chain from artifact to run", async () => {
      const prov = await g.repo.artifacts.getProvenance(g.artifact1.id);
      expect(prov).not.toBeUndefined();

      expect(prov!.artifact.id).toBe(g.artifact1.id);
      expect(prov!.operation?.id).toBe(g.operation1.id);
      expect(prov!.task?.id).toBe(g.task1.id);
      expect(prov!.run?.id).toBe(g.run.id);
      expect(prov!.run?.agentDefinitionId).toBe(g.definition.id);
    });

    it("includes consumer tasks in consumedBy", async () => {
      const prov = await g.repo.artifacts.getProvenance(g.artifact1.id);
      expect(prov!.consumedBy).toHaveLength(1);
      expect(prov!.consumedBy[0]!.id).toBe(g.task2.id);
    });

    it("returns empty consumedBy for an unconsumed artifact", async () => {
      const prov = await g.repo.artifacts.getProvenance(g.artifact2.id);
      expect(prov).not.toBeUndefined();
      expect(prov!.consumedBy).toHaveLength(0);
    });

    it("returns null for a nonexistent artifact", async () => {
      expect(
        await g.repo.artifacts.getProvenance(generateId()),
      ).toBeUndefined();
    });
  });

  describe("lookupForRun", () => {
    it("filters produced artifacts by subagent name and returns producer metadata", async () => {
      const matches = await g.repo.artifacts.lookupForRun(g.run.id, {
        producedBySubagent: g.task1.subagentName ?? "test-skill",
      });

      expect(matches).toHaveLength(2);
      expect(matches[0]?.producerTask?.subagentName).toBe(g.task1.subagentName);
      expect(matches[0]?.artifact.id).toBe(g.artifact2.id);
      expect(matches[1]?.artifact.id).toBe(g.artifact1.id);
    });

    it("includes seeded input artifacts when requested", async () => {
      const inputArtifact = makeArtifact({
        type: "input_document",
        name: "seeded-policy",
        content: "seed input",
      });
      await g.repo.artifacts.create(inputArtifact);
      await g.repo.artifacts.linkInputToRun(g.run.id, inputArtifact.id);

      const matches = await g.repo.artifacts.lookupForRun(g.run.id, {
        nameContains: "seeded",
      });

      expect(matches).toHaveLength(1);
      expect(matches[0]?.artifact.id).toBe(inputArtifact.id);
      expect(matches[0]?.source).toBe("input");
      expect(matches[0]?.producerTask).toBeUndefined();
    });

    it("excludes input_ingestion-produced artifacts when includeInputArtifacts is false", async () => {
      // Mirror the shape ingestInputArtifacts creates: a synthetic
      // "input_ingestion" tool task that *produces* each seeded artifact
      // and a has_input edge on the Run. Both edges exist in prod runs,
      // so excluding inputs means excluding the produced twin as well.
      const ingestionTask = makeTask(g.run.id, 0);
      const ingestionTaskWithName = {
        ...ingestionTask,
        role: "tool" as const,
        subagentName: "input_ingestion",
      };
      await g.repo.tasks.create(ingestionTaskWithName);
      const ingestionOp = makeOperation(ingestionTaskWithName.id, g.run.id, 1);
      await g.repo.operations.create(ingestionOp);

      const seeded = makeArtifact({
        type: "input_document",
        name: "seeded-policy",
        content: "seed input",
      });
      await g.repo.artifacts.create(seeded);
      await g.repo.artifacts.linkProduced(ingestionOp.id, seeded.id);
      await g.repo.artifacts.linkInputToRun(g.run.id, seeded.id);

      // With include_input_artifacts:false, the seeded input must not
      // leak back through the produced-edges path.
      const matches = await g.repo.artifacts.lookupForRun(g.run.id, {
        nameContains: "seeded",
        includeInputArtifacts: false,
      });
      expect(matches).toHaveLength(0);

      // With include_input_artifacts:true, the same artifact is returned
      // exactly once (dedup across the produced + input paths).
      const withInputs = await g.repo.artifacts.lookupForRun(g.run.id, {
        nameContains: "seeded",
        includeInputArtifacts: true,
      });
      expect(withInputs).toHaveLength(1);
      expect(withInputs[0]?.artifact.id).toBe(seeded.id);
    });
  });
});

// ---------------------------------------------------------------------------
// CRUD methods — verify basic operations that the subgraph methods rely on
// ---------------------------------------------------------------------------

describe("Repository — CRUD operations", () => {
  let repo: Repository;

  beforeEach(async () => {
    repo = await createInMemoryRepo();
    // Skills must exist before definitions reference them
    await repo.agents.registerSkill(makeSkill());
  });

  it("round-trips an agent definition", async () => {
    const def = makeDefinition();
    await repo.agents.createDefinition(def);
    const loaded = await repo.agents.getDefinition(def.id);
    expect(loaded).not.toBeUndefined();
    expect(loaded!.name).toBe(def.name);
  });

  it("round-trips a run with definition edge", async () => {
    const def = makeDefinition();
    await repo.agents.createDefinition(def);
    const run = makeRun(def.id);
    await repo.runs.create(run);

    const loaded = await repo.runs.get(run.id);
    expect(loaded).not.toBeUndefined();
    expect(loaded!.agentDefinitionId).toBe(def.id);
    expect(loaded!.agentDefinitionVersion).toBe(1);
  });

  it("lists tasks for a run in sequence order", async () => {
    const def = makeDefinition();
    await repo.agents.createDefinition(def);
    const run = makeRun(def.id);
    await repo.runs.create(run);

    const t3 = makeTask(run.id, 3);
    const t1 = makeTask(run.id, 1);
    const t2 = makeTask(run.id, 2);
    // Insert out of order to verify sorting
    await repo.tasks.create(t3);
    await repo.tasks.create(t1);
    await repo.tasks.create(t2);

    const tasks = await repo.tasks.getForRun(run.id);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.sequenceNumber).toBe(1);
    expect(tasks[1]!.sequenceNumber).toBe(2);
    expect(tasks[2]!.sequenceNumber).toBe(3);
  });

  it("lists operations for a task in operation order", async () => {
    const def = makeDefinition();
    await repo.agents.createDefinition(def);
    const run = makeRun(def.id);
    await repo.runs.create(run);
    const task = makeTask(run.id, 1);
    await repo.tasks.create(task);

    const a2 = makeOperation(task.id, run.id, 2);
    const a1 = makeOperation(task.id, run.id, 1);
    await repo.operations.create(a2);
    await repo.operations.create(a1);

    const operations = await repo.operations.getForTask(task.id, run.id);
    expect(operations).toHaveLength(2);
    expect(operations[0]!.operationNumber).toBe(1);
    expect(operations[1]!.operationNumber).toBe(2);
  });

  it("getArtifactsForRun returns all artifacts via chained traversal", async () => {
    const def = makeDefinition();
    await repo.agents.createDefinition(def);
    const run = makeRun(def.id);
    await repo.runs.create(run);
    const task = makeTask(run.id, 1);
    await repo.tasks.create(task);
    const operation = makeOperation(task.id, run.id, 1);
    await repo.operations.create(operation);

    const a1 = makeArtifact({ name: "a1" });
    const a2 = makeArtifact({ name: "a2" });
    await repo.artifacts.create(a1);
    await repo.artifacts.linkProduced(operation.id, a1.id);
    await repo.artifacts.create(a2);
    await repo.artifacts.linkProduced(operation.id, a2.id);

    const artifacts = await repo.artifacts.getForRun(run.id);
    expect(artifacts).toHaveLength(2);
    const names = artifacts.map((a) => a.name).toSorted();
    expect(names).toEqual(["a1", "a2"]);
  });
});
