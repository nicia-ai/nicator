/**
 * Shared eval infrastructure — tool registries, skill manifests, and
 * project root used by runner.ts and sweep-weights.ts.
 */

import type { Tool } from "@nicator/core";
import { estimateTokens } from "@nicator/core";
import env from "@nicator/core/env";
import {
  loadSkillFixturesFromDir,
  toolRegistryFromMap,
  type ToolImplementation,
} from "@nicator/harness";
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
import { z } from "zod";
import type { SourceDocument } from "./schema";

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

// ---------------------------------------------------------------------------
// Document retrieval tool — delivers source content through tool results
// so that it flows through context scoring (not the initial prompt).
// ---------------------------------------------------------------------------

const RETRIEVE_DOCUMENT_TOOL: Tool = {
  name: "retrieve-document",
  version: "1.0.0",
  description:
    "Retrieve the full text of an internal document by its source ID. " +
    "Returns the document content. Use this to read each source document.",
  inputSchema: {
    type: "object",
    properties: {
      source_id: {
        type: "string",
        description: "The source document ID (e.g. 'src-1', 'src-2').",
      },
    },
    required: ["source_id"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Document title." },
      content: { type: "string", description: "Full document text." },
      tokenCount: {
        type: "integer",
        description: "Estimated token count.",
      },
    },
    required: ["title", "content", "tokenCount"],
  },
};

const RetrieveDocumentInput = z.object({
  source_id: z.string(),
});

/**
 * Create a retrieve-document tool backed by a set of source documents.
 * Each call returns one document's full content as a tool result,
 * which becomes a task artifact subject to context scoring.
 */
export function createDocumentRetrievalTool(
  sources: ReadonlyArray<SourceDocument>,
): ToolImplementation {
  const byId = new Map(sources.map((s) => [s.id, s]));

  return {
    tool: RETRIEVE_DOCUMENT_TOOL,
    async execute(input: unknown) {
      const parsed = RetrieveDocumentInput.parse(input);
      const doc = byId.get(parsed.source_id);
      if (!doc) {
        return {
          error: `Unknown source ID: "${parsed.source_id}". Available: ${[...byId.keys()].join(", ")}`,
        };
      }
      return {
        title: doc.title,
        content: doc.content,
        tokenCount: estimateTokens(doc.content),
      };
    },
  };
}
