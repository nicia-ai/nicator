/**
 * Shared eval infrastructure — tool registries, skill manifests, and
 * project root used by runner.ts and sweep-weights.ts.
 */

import type { InputArtifact } from "@nicator/core";
import env from "@nicator/core/env";
import {
  loadSkillFixturesFromDir,
  toolRegistryFromMap,
  type ToolImplementation,
} from "@nicator/harness";

import type { SourceDocument } from "./schema";
import { createWebFetchTool } from "@nicator/tool-web-fetch";
import { webFetchManifest } from "@nicator/tool-web-fetch/manifest";
import { createWebSearchTool } from "@nicator/tool-web-search";
import { webSearchManifest } from "@nicator/tool-web-search/manifest";
import {
  createBashTool,
  createWorkspace,
  type Workspace,
} from "@nicator/workspace";
import { resolve } from "path";

export const EVAL_PROJECT_ROOT = resolve(__dirname, "..");

export const EVAL_TOOL_REGISTRY = toolRegistryFromMap([
  ["web-search", createWebSearchTool(webSearchManifest, env.BRAVE_API_KEY)],
  ["web-fetch", createWebFetchTool(webFetchManifest)],
]);

/** Create a fresh workspace + bash tool for an eval run. */
export async function createEvalWorkspace(
  runId: string,
  overrides?: {
    outputPaths?: ReadonlyArray<string>;
    initialFiles?: Readonly<Record<string, string>>;
  },
): Promise<{ workspace: Workspace; bashTool: ToolImplementation }> {
  const workspace = await createWorkspace({
    runId,
    ...(overrides?.outputPaths ? { outputPaths: overrides.outputPaths } : {}),
    ...(overrides?.initialFiles
      ? { initialFiles: overrides.initialFiles }
      : {}),
  });
  return { workspace, bashTool: createBashTool(workspace) };
}

export function loadSkillFixtures() {
  return loadSkillFixturesFromDir(resolve(EVAL_PROJECT_ROOT, "fixtures/skills"));
}

export function toSeededInputArtifacts(
  docs: ReadonlyArray<SourceDocument>,
): InputArtifact[] {
  return docs.map((s) => ({
    name: s.title,
    type: "input_document",
    content: s.content,
  }));
}

export function buildInputArtifactPreamble(count: number): string {
  return (
    `You have access to ${count} input document(s) seeded as artifacts. ` +
    `Use the \`read_artifact\` tool to fetch each one by its artifact_id ` +
    `(shown in your context).`
  );
}
