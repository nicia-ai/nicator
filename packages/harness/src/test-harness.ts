/**
 * Shared integration test harness. Spins up a real TypeGraph-backed Repository
 * (in-memory libsql) plus a stub HitlHandler so tests can exercise storage
 * invariants — Zod validation, edge uniqueness, referential integrity — that
 * hand-rolled Map-based mocks silently skipped.
 *
 * Not exported from the package index; consumed directly by *.test.ts files.
 */
import type {
  AgentDefinition,
  HitlContext,
  HitlHandler,
  Operation,
  Repository,
  Run,
  Skill,
  Task,
} from "@nicator/core";
import { buildArtifact, generateId, now } from "@nicator/core";
import { makeDefinition, makeRun } from "@nicator/core/test-factories";
import type { Anthropic } from "@nicator/sdk";
import type { Workspace } from "@nicator/workspace";

import { createLocalRepo } from "./local-repo.js";
import { createEmptyToolRegistry } from "./registries.js";
import { materializeSkills } from "./skill-loader.js";
import type { HarnessConfig, ToolRegistry } from "./types.js";

type HitlCall = Readonly<{ context: HitlContext; prompt: string }>;

export type StubHitlHandler = HitlHandler &
  Readonly<{
    calls: ReadonlyArray<HitlCall>;
    /** Enqueue an additional decision after construction. */
    enqueue(decision: string): void;
  }>;

export type StubHitlOptions = Readonly<{
  /** Decisions to return on successive requestApproval calls. */
  decisions?: ReadonlyArray<string>;
  /** Response when the queue runs dry. */
  defaultDecision?: string;
}>;

export function createStubHitlHandler(
  options: StubHitlOptions = {},
): StubHitlHandler {
  const queue: string[] = [...(options.decisions ?? [])];
  const calls: HitlCall[] = [];

  return {
    calls,
    enqueue(decision: string): void {
      queue.push(decision);
    },
    requestApproval(context: HitlContext, prompt: string): Promise<string> {
      calls.push({ context, prompt });
      const next = queue.shift() ?? options.defaultDecision ?? "approved";
      return Promise.resolve(next);
    },
  };
}

export type SeedSkillOptions = Readonly<{
  name?: string;
  version?: string;
  description?: string;
  allowDirectTools?: boolean;
  allowReadArtifact?: boolean;
  prompt?: string;
  maxIterations?: number;
  /** When present, the skill's SKILL.md is materialized here. */
  workspace?: Workspace;
}>;

export type SeededSkill = Readonly<{ skill: Skill; skillNodeId: string }>;

export type TestHarness = Readonly<{
  repo: Repository;
  hitl: StubHitlHandler;
  config: HarnessConfig;
  dispose: () => void;
  seedSkill(options?: SeedSkillOptions): Promise<SeededSkill>;
  seedDefinition(
    overrides?: Partial<AgentDefinition>,
  ): Promise<AgentDefinition>;
  seedRun(definitionId: string, overrides?: Partial<Run>): Promise<Run>;
  seedRunWithRoot(
    definitionId: string,
    overrides?: Partial<Run>,
  ): Promise<{ run: Run; rootTaskId: string }>;
}>;

export type CreateTestHarnessOptions = Readonly<{
  toolRegistry?: ToolRegistry;
  hitl?: StubHitlOptions;
  /** Override the stub entirely (e.g. for error-injection handlers). */
  hitlHandler?: HitlHandler;
  workspace?: Workspace;
}>;

export async function createTestHarness(
  options: CreateTestHarnessOptions = {},
): Promise<TestHarness> {
  const { repo, client } = await createLocalRepo(":memory:");
  const stubHitl = createStubHitlHandler(options.hitl ?? {});
  const hitlHandler = options.hitlHandler ?? stubHitl;

  const config: HarnessConfig = {
    repo,
    anthropic: {} as Anthropic,
    toolRegistry: options.toolRegistry ?? createEmptyToolRegistry(),
    hitlHandler,
    env: { date: "2026-01-01" },
    ...(options.workspace === undefined ?
      {}
    : { workspace: options.workspace }),
  };

  async function seedSkill(
    seedOptions: SeedSkillOptions = {},
  ): Promise<SeededSkill> {
    const name = seedOptions.name ?? "test-skill";
    const version = seedOptions.version ?? "1.0.0";
    const description = seedOptions.description ?? "A test skill";
    const prompt =
      seedOptions.prompt ?? `You are a ${name} assistant. Do the thing.`;

    const skill: Skill = {
      id: generateId(),
      name,
      version,
      description,
      allowDirectTools: seedOptions.allowDirectTools ?? true,
      allowReadArtifact: seedOptions.allowReadArtifact ?? false,
      ...(seedOptions.maxIterations === undefined ?
        {}
      : { maxIterations: seedOptions.maxIterations }),
    };
    const promptArtifact = await buildArtifact(
      "skill_prompt",
      `${name}/SKILL.md`,
      prompt,
    );
    const skillNodeId = await repo.agents.registerSkillWithPrompt(
      skill,
      promptArtifact,
    );

    if (seedOptions.workspace) {
      await materializeSkills(repo, seedOptions.workspace);
    }

    return { skill: { ...skill, id: skillNodeId }, skillNodeId };
  }

  async function seedDefinition(
    overrides?: Partial<AgentDefinition>,
  ): Promise<AgentDefinition> {
    const definition = makeDefinition({ skills: [], ...overrides });
    await repo.agents.createDefinition(definition);
    return definition;
  }

  async function seedRun(
    definitionId: string,
    overrides?: Partial<Run>,
  ): Promise<Run> {
    const run = makeRun(definitionId, {
      status: "running",
      ...overrides,
    }) as Run;
    await repo.runs.create(run);
    return run;
  }

  async function seedRunWithRoot(
    definitionId: string,
    overrides?: Partial<Run>,
  ): Promise<{ run: Run; rootTaskId: string }> {
    const run = await seedRun(definitionId, overrides);
    const rootTaskId = generateId();
    const rootTask: Task = {
      id: rootTaskId,
      runId: run.id,
      role: "root",
      status: "running",
      input: run.input,
      sequenceNumber: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await repo.tasks.create(rootTask);
    return { run, rootTaskId };
  }

  return {
    repo,
    hitl: stubHitl,
    config,
    dispose: () => client.close(),
    seedSkill,
    seedDefinition,
    seedRun,
    seedRunWithRoot,
  };
}

/**
 * Fetch all operations for a run by fanning out across its tasks.
 * Shared across test files to avoid re-defining the same traversal.
 */
export async function getAllOperations(
  repo: Repository,
  runId: string,
): Promise<ReadonlyArray<Operation>> {
  const tasks = await repo.tasks.getForRun(runId);
  const perTask = await Promise.all(
    tasks.map((t) => repo.operations.getForTask(t.id, runId)),
  );
  return perTask.flat();
}
