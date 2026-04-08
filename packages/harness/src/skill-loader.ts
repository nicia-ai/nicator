import { dirname } from "node:path";

import type { Repository } from "@nicator/core";
import type { Workspace } from "@nicator/workspace";

function skillPath(name: string, version: string): string {
  return `/workspace/skills/${name}@${version}/SKILL.md`;
}

/**
 * Materialize all registered skills into the workspace filesystem.
 * Each version gets its own directory: `skills/[name]@[version]/SKILL.md`.
 */
export async function materializeSkills(
  repo: Repository,
  workspace: Workspace,
): Promise<void> {
  const skills = await repo.agents.listSkillsWithPrompts();

  for (const { skill, prompt } of skills) {
    const filePath = skillPath(skill.name, skill.version);
    await workspace.fs.mkdir(dirname(filePath), { recursive: true });
    await workspace.fs.writeFile(filePath, prompt);
  }
}

/**
 * Read a skill's prompt from the workspace filesystem.
 * Version-specific: reads from `skills/[name]@[version]/SKILL.md`.
 */
export async function loadSkillFromWorkspace(
  workspace: Workspace,
  skillName: string,
  skillVersion: string,
): Promise<string> {
  return workspace.fs.readFile(skillPath(skillName, skillVersion));
}
