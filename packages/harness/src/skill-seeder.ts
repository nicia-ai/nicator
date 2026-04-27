import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Repository, Skill } from "@nicator/core";
import { buildArtifact, generateId } from "@nicator/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Fixture schema — the JSON shape in fixtures/skills/*.json
// ---------------------------------------------------------------------------

export const SkillFixtureSchema = z.object({
  name: z.string().min(1),
  version: z.string(),
  description: z.string(),
  allowDirectTools: z.boolean().default(true),
  allowReadArtifact: z.boolean().default(false),
  maxIterations: z.number().int().positive().optional(),
  prompt: z.string().min(1),
});
export type SkillFixture = z.infer<typeof SkillFixtureSchema>;

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

/** Load and validate skill fixtures from a directory of JSON files. */
export function loadSkillFixturesFromDir(dir: string): SkillFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) =>
      SkillFixtureSchema.parse(
        JSON.parse(readFileSync(resolve(dir, f), "utf8")),
      ),
    );
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Seed skills from fixture data into the graph. Idempotent — skips skills
 * that already exist (matched by name + version).
 */
export async function seedSkillsFromFixtures(
  repo: Repository,
  fixtures: ReadonlyArray<SkillFixture>,
): Promise<void> {
  await Promise.all(
    fixtures.map(async (fixture) => {
      const skill: Skill = {
        id: generateId(),
        name: fixture.name,
        version: fixture.version,
        description: fixture.description,
        allowDirectTools: fixture.allowDirectTools,
        allowReadArtifact: fixture.allowReadArtifact,
        ...(fixture.maxIterations === undefined ?
          {}
        : { maxIterations: fixture.maxIterations }),
      };

      const promptArtifact = await buildArtifact(
        "skill_prompt",
        `${fixture.name}/SKILL.md`,
        fixture.prompt,
      );
      await repo.agents.registerSkillWithPrompt(skill, promptArtifact);
    }),
  );
}
