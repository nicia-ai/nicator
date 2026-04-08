import type { HitlHandler, Repository } from "@nicator/core";
import { pickDefined, todayISO } from "@nicator/core";
import { createAnthropicClient } from "@nicator/sdk";
import type { Workspace } from "@nicator/workspace";

import type {
  HarnessConfig,
  InputDocument,
  Logger,
  RuntimeContext,
  ToolRegistry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Harness construction
// ---------------------------------------------------------------------------

export type CreateHarnessOptions = Readonly<{
  /** Anthropic API key. */
  apiKey: string;
  /** Pre-constructed Repository instance. */
  repo: Repository;
  /** Pre-constructed tool registry. */
  toolRegistry: ToolRegistry;
  /** HITL handler for human-approval tasks. */
  hitlHandler: HitlHandler;
  /** Runtime context injected into system prompt (date, platform, etc.) */
  env?: RuntimeContext;
  /** Optional logger. Defaults to no-op. */
  logger?: Logger;
  /** Input documents for multi-agent topologies (created as input artifacts). */
  inputDocuments?: ReadonlyArray<InputDocument>;
  /** Virtual workspace (filesystem + bash) for the run. */
  workspace?: Workspace;
  /** Optional compression callback. */
  onCompression?: (runId: string, summary: string) => void;
  /** Streaming text delta callback. When provided, enables streaming. */
  onTextDelta?: (delta: string) => void;
}>;

/**
 * Assemble a fully configured HarnessConfig from the provided options.
 * This is the single factory that CLI, worker, and evals all use.
 */
export function createHarness(options: CreateHarnessOptions): HarnessConfig {
  const client = createAnthropicClient(options.apiKey);

  const env: RuntimeContext = options.env ?? {
    date: todayISO(),
  };

  const config: HarnessConfig = {
    repo: options.repo,
    anthropic: client,
    toolRegistry: options.toolRegistry,
    hitlHandler: options.hitlHandler,
    env,
    ...pickDefined({
      inputDocuments: options.inputDocuments,
      workspace: options.workspace,
      logger: options.logger,
      onCompression: options.onCompression,
      onTextDelta: options.onTextDelta,
    }),
  };
  return config;
}
