import type {
  AgentDefinition,
  HitlHandler,
  InputDocument,
  Repository,
  Tool,
} from "@nicator/core";
import type { Anthropic, MessageParam } from "@nicator/sdk";
import type { Workspace } from "@nicator/workspace";

// ---------------------------------------------------------------------------
// Runtime context (injected by caller — CLI, Worker, eval runner)
// ---------------------------------------------------------------------------

export type RuntimeContext = Readonly<{
  /** ISO date string, e.g. "2026-04-05" */
  date: string;
  /** e.g. "darwin", "linux" */
  platform?: string;
  /** e.g. "cli", "worker" */
  runtime?: string;
}>;

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export type ToolImplementation = Readonly<{
  tool: Tool;
  execute: (input: unknown) => Promise<unknown>;
}>;

export type ToolRegistry = Readonly<{
  resolve: (name: string) => ToolImplementation | undefined;
  list: () => ReadonlyArray<ToolImplementation>;
  listTools: (
    names: ReadonlyArray<string>,
  ) => ReadonlyArray<ToolImplementation>;
}>;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export type Logger = Readonly<{
  info: (message: string) => void;
  error: (message: string) => void;
}>;

// ---------------------------------------------------------------------------
// Harness configuration
// ---------------------------------------------------------------------------

export type { InputDocument } from "@nicator/core";

export type HarnessConfig = Readonly<{
  repo: Repository;
  anthropic: Anthropic;
  toolRegistry: ToolRegistry;
  hitlHandler: HitlHandler;
  /** Runtime context injected into system prompt (date, platform, etc.) */
  env: RuntimeContext;
  /** Input documents provided at run creation. Created as input_document
   *  artifacts linked to the Run via has_input edges. Subagents can access
   *  them via artifact_ids. */
  inputDocuments?: ReadonlyArray<InputDocument>;
  /** Virtual workspace (filesystem + bash) for the run. When present, the
   *  harness captures output files as artifacts on run completion. */
  workspace?: Workspace;
  logger?: Logger;
  onCompression?: (runId: string, summary: string) => void;
  /** Called with each text delta during model response streaming.
   *  When provided, the run loop uses streaming API calls. */
  onTextDelta?: (delta: string) => void;
}>;

// ---------------------------------------------------------------------------
// Dispatch types — contract between run loop and dispatch handlers
// ---------------------------------------------------------------------------

export type DispatchOptions = Readonly<{
  runId: string;
  rootTaskId: string;
  definition: AgentDefinition;
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  taskSequenceNumber: number;
  inputTokens: number;
  outputTokens: number;
  injectedArtifactIds: ReadonlyArray<string>;
  config: HarnessConfig;
}>;

// ---------------------------------------------------------------------------
// Conversation state — sliding window across loop iterations
// ---------------------------------------------------------------------------

export type ConversationState = {
  /** Tiered historical context from older turns. */
  historyMessage: MessageParam | undefined;
  /** Recent multi-turn messages: assistant + user(tool_result) pairs. */
  recentMessages: MessageParam[];
  /** Estimated token count for recentMessages. */
  recentTokenEstimate: number;
  /** Artifact IDs whose metadata appears in the current message window.
   *  These are the artifacts the agent can read via read_artifact. */
  injectedArtifactIds: string[];
  /** Maps Anthropic tool_use_id to child task ID for score-aware compression. */
  toolUseIdToTaskId: Map<string, string>;
};

// ---------------------------------------------------------------------------
// Dispatch types — contract between run loop and dispatch handlers
// ---------------------------------------------------------------------------

export type DispatchResult = Readonly<{
  succeeded: boolean;
  /** Tokens consumed by delegated subagent execution not already counted by the outer complete() call. */
  additionalTokens: number;
  /** Serialized result content for tool_result assembly. */
  toolResultContent: string;
  /** The tool_use_id this result corresponds to. */
  toolUseId: string;
  /** Child task ID created for this dispatch. */
  childTaskId: string;
}>;
