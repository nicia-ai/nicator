import { makeDefinition } from "@nicator/core/test-factories";
import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "./system-prompt.js";
import type { ToolImplementation } from "./types.js";

function mockTool(name: string): ToolImplementation {
  return {
    tool: {
      name,
      version: "1.0.0",
      description: `The ${name} tool`,
      inputSchema: { type: "object" as const },
      outputSchema: { type: "object" as const },
    },
    execute: () => Promise.resolve({}),
  };
}

describe("buildSystemPrompt", () => {
  it("includes all sections when tools and skills are present", () => {
    const prompt = buildSystemPrompt({
      definition: makeDefinition(),
      tools: [mockTool("web-search")],
      skills: [
        {
          id: "skill-researcher",
          name: "researcher",
          description: "Research things",
          version: "1.0",
        },
      ],
      env: { date: "2026-04-05", platform: "darwin" },
      budget: {
        tokensUsed: 1000,
        tokenLimit: 500_000,
        tasksUsed: 2,
        taskLimit: 50,
      },
    });

    expect(prompt).toContain("<identity>");
    expect(prompt).toContain("<environment>");
    expect(prompt).toContain("2026-04-05");
    expect(prompt).toContain("darwin");
    expect(prompt).toContain("<instructions>");
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("web-search");
    expect(prompt).toContain("<skills>");
    expect(prompt).toContain("researcher");
    expect(prompt).toContain("<hitl>");
    expect(prompt).toContain("<constraints>");
    expect(prompt).toContain("1,000");
    expect(prompt).toContain("<output>");
  });

  it("omits tools section when no tools", () => {
    const prompt = buildSystemPrompt({
      definition: makeDefinition(),
      tools: [],
      skills: [],
      env: { date: "2026-04-05" },
      budget: {
        tokensUsed: 0,
        tokenLimit: 100_000,
        tasksUsed: 0,
        taskLimit: 10,
      },
    });

    expect(prompt).not.toContain("<tools>");
    expect(prompt).not.toContain("<skills>");
    expect(prompt).toContain("<identity>");
    expect(prompt).toContain("<constraints>");
  });

  it("omits instructions when systemPrompt is empty", () => {
    const prompt = buildSystemPrompt({
      definition: makeDefinition({ systemPrompt: "   " }),
      tools: [],
      skills: [],
      env: { date: "2026-04-05" },
      budget: {
        tokensUsed: 0,
        tokenLimit: 100_000,
        tasksUsed: 0,
        taskLimit: 10,
      },
    });

    expect(prompt).not.toContain("<instructions>");
  });
});
