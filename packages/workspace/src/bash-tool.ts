import type { Tool } from "@nicator/core";
import { z } from "zod";

import type { Workspace } from "./types.js";

// ---------------------------------------------------------------------------
// Tool manifest
// ---------------------------------------------------------------------------

export const BASH_TOOL_NAME = "bash" as const;
export const BASH_TOOL_VERSION = "1.0" as const;

export const bashManifest: Tool = {
  name: BASH_TOOL_NAME,
  version: BASH_TOOL_VERSION,
  description:
    "Execute a bash command in the agent workspace. The workspace is a " +
    "virtual filesystem with 79+ Unix commands: ls, cat, grep, sed, awk, " +
    "jq, sort, uniq, wc, head, tail, cut, tr, find, diff, base64, and more. " +
    "Files persist across calls within the same run. Use this for file " +
    "manipulation, data processing, and scripting tasks. " +
    "To save a file as a named output artifact, run: save_artifact <path> [name]",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute.",
      },
    },
    required: ["command"],
  },
  outputSchema: {
    type: "object",
    properties: {
      stdout: { type: "string" },
      stderr: { type: "string" },
      exitCode: { type: "number" },
    },
    required: ["stdout", "stderr", "exitCode"],
  },
};

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const BashInputSchema = z.object({
  command: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Tool implementation
//
// Returns { tool, execute } — structurally compatible with
// ToolImplementation from @nicator/harness without importing it,
// avoiding a circular dependency (workspace ↔ harness).
// ---------------------------------------------------------------------------

export function createBashTool(workspace: Workspace): Readonly<{
  tool: Tool;
  execute: (input: unknown) => Promise<unknown>;
}> {
  return {
    tool: bashManifest,
    async execute(input: unknown) {
      const { command } = BashInputSchema.parse(input);
      return workspace.exec(command);
    },
  };
}
