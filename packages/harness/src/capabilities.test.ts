import type { Repository, Skill } from "@nicator/core";
import { makeDefinition } from "@nicator/core/test-factories";
import type { Anthropic } from "@nicator/sdk";
import { describe, expect, it, vi } from "vitest";

import { resolveAgentCapabilities } from "./capabilities.js";
import { createEmptyToolRegistry, toolRegistryFromMap } from "./registries.js";
import type { HarnessConfig, ToolImplementation } from "./types.js";

function createMockToolImpl(name: string): ToolImplementation {
  return {
    tool: {
      name,
      version: "1.0.0",
      description: `Mock ${name} tool`,
      inputSchema: { type: "object" as const, properties: {} },
      outputSchema: { type: "object" as const, properties: {} },
    },
    execute: () => Promise.resolve({ ok: true }),
  };
}

function createMockRepo(
  skills: Map<string, { skill: Skill; prompt: string }> = new Map(),
): Repository {
  return {
    agents: {
      resolveSkill: vi.fn((name: string) => Promise.resolve(skills.get(name))),
    },
  } as unknown as Repository;
}

function buildConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    repo: createMockRepo(),
    anthropic: {} as Anthropic,
    toolRegistry: createEmptyToolRegistry(),
    hitlHandler: { requestApproval: () => Promise.resolve("approved") },
    env: { date: "2026-04-05" },
    ...overrides,
  };
}

describe("resolveAgentCapabilities", () => {
  it("resolves available skills from definition", async () => {
    const skill: Skill = {
      id: "skill-id",
      name: "researcher",
      description: "Research skill",
      version: "1.0",
      allowDirectTools: true,
      allowReadArtifact: false,
    };

    const skills = new Map([["researcher", { skill, prompt: "Do research." }]]);
    const repo = createMockRepo(skills);

    const definition = makeDefinition({
      skills: [{ name: "researcher", version: "1.0" }],
    });

    const config = buildConfig({ repo });
    const caps = await resolveAgentCapabilities(config, definition);

    expect(caps.skills).toHaveLength(1);
    expect(caps.skills[0]!.name).toBe("researcher");
  });

  it("skips skills with 'never' policy", async () => {
    const skill: Skill = {
      id: "skill-id",
      name: "blocked-skill",
      description: "Should be skipped",
      version: "1.0",
      allowDirectTools: true,
      allowReadArtifact: false,
    };

    const skills = new Map([["blocked-skill", { skill, prompt: "Blocked." }]]);
    const repo = createMockRepo(skills);

    const definition = makeDefinition({
      skills: [
        { name: "blocked-skill", version: "1.0", policy: { type: "never" } },
      ],
    });

    const config = buildConfig({ repo });
    const caps = await resolveAgentCapabilities(config, definition);
    expect(caps.skills).toHaveLength(0);
  });

  it("includes agent tool regardless of skills", async () => {
    const definition = makeDefinition({ skills: [] });
    const config = buildConfig();
    const caps = await resolveAgentCapabilities(config, definition);

    const toolNames = caps.sdkTools.map((t) => t.name);
    expect(toolNames).toContain("agent");
    expect(toolNames).toContain("read_artifact");
    expect(toolNames).toContain("lookup_artifacts");
    expect(toolNames).toContain("write_artifact");
    expect(toolNames).toContain("answer_from_artifact");
  });

  it("includes skill tool when skills exist", async () => {
    const skill: Skill = {
      id: "skill-id",
      name: "researcher",
      description: "Research skill",
      version: "1.0",
      allowDirectTools: true,
      allowReadArtifact: false,
    };

    const skills = new Map([["researcher", { skill, prompt: "Do research." }]]);
    const repo = createMockRepo(skills);

    const definition = makeDefinition({
      skills: [{ name: "researcher", version: "1.0" }],
    });

    const config = buildConfig({ repo });
    const caps = await resolveAgentCapabilities(config, definition);

    const toolNames = caps.sdkTools.map((t) => t.name);
    expect(toolNames).toContain("skill");
  });

  it("omits skill tool when no skills available", async () => {
    const definition = makeDefinition({ skills: [] });
    const config = buildConfig();
    const caps = await resolveAgentCapabilities(config, definition);

    const toolNames = caps.sdkTools.map((t) => t.name);
    expect(toolNames).not.toContain("skill");
  });

  it("includes registered tools in SDK tool list", async () => {
    const toolRegistry = toolRegistryFromMap([
      ["web-search", createMockToolImpl("web-search")],
    ]);
    const definition = makeDefinition({ skills: [] });
    const config = buildConfig({ toolRegistry });
    const caps = await resolveAgentCapabilities(config, definition);

    const toolNames = caps.sdkTools.map((t) => t.name);
    expect(toolNames).toContain("web-search");
  });
});
