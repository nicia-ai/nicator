import type { AgentDefinition, Skill } from "@nicator/core";
import {
  buildDirectToolDefinitions,
  buildSpawnSubagentTool,
  buildSpawnSubagentWithSkillTool,
  type Tool,
} from "@nicator/sdk";

import { HUMAN_APPROVAL_TOOL } from "./approval.js";
import { READ_ARTIFACT_TOOL } from "./read-artifact.js";
import type { HarnessConfig, ToolImplementation } from "./types.js";

// ---------------------------------------------------------------------------
// Capability resolution — run once at run start
// ---------------------------------------------------------------------------

export type AgentCapabilities = Readonly<{
  sdkTools: Tool[];
  toolImpls: ReadonlyArray<ToolImplementation>;
  skills: ReadonlyArray<Skill>;
}>;

export async function resolveAgentCapabilities(
  config: HarnessConfig,
  definition: AgentDefinition,
): Promise<AgentCapabilities> {
  const toolImpls = config.toolRegistry.list();
  const skills = await resolveAvailableSkills(definition, config.repo);

  const sdkTools: Tool[] = [
    ...buildDirectToolDefinitions(
      toolImpls.map((impl) => ({
        name: impl.tool.name,
        description: impl.tool.description,
        inputSchema: impl.tool.inputSchema,
      })),
    ),
    buildSpawnSubagentTool(),
    ...(skills.length > 0 ? [buildSpawnSubagentWithSkillTool(skills)] : []),
    HUMAN_APPROVAL_TOOL,
    READ_ARTIFACT_TOOL,
  ];

  return { sdkTools, toolImpls, skills };
}

async function resolveAvailableSkills(
  definition: AgentDefinition,
  repo: HarnessConfig["repo"],
): Promise<Skill[]> {
  const resolvable = definition.skills.filter(
    (ref) => ref.policy?.type !== "never",
  );

  const results = await Promise.all(
    resolvable.map((ref) => repo.agents.resolveSkill(ref.name, ref.version)),
  );

  return results
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .map((r) => r.skill);
}
