import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageCreateParamsBase,
  MessageCreateParamsNonStreaming,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import type { Skill } from "@nicator/core";
import {
  ANTHROPIC_OVERLOADED_STATUS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SKILL_MAX_ITERATIONS,
  HARNESS_MODEL,
  HarnessError,
  OVERLOAD_MAX_DELAY_MS,
  OVERLOAD_MAX_RETRIES,
  OVERLOAD_RETRY_DELAY_MS,
  SKILL_LOOP_TIMEOUT_MS,
  SPAWN_SUBAGENT_TOOL_NAME,
  SPAWN_SUBAGENT_WITH_SKILL_TOOL_NAME,
  stringifyOutput,
} from "@nicator/core";

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

type CompletionResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  response: Message;
};

function extractResult(response: Message): CompletionResult {
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    response,
  };
}

type CompletionParams = {
  system?: string;
  messages: ReadonlyArray<MessageParam>;
  tools?: ReadonlyArray<Tool>;
  maxTokens?: number;
  signal?: AbortSignal;
};

function buildApiParams(params: CompletionParams): MessageCreateParamsBase {
  return {
    model: HARNESS_MODEL,
    max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [...params.messages],
    ...(params.system === undefined ? {} : { system: params.system }),
    ...(params.tools === undefined ? {} : { tools: [...params.tools] }),
  };
}

function requestOptions(
  params: CompletionParams,
): { signal: AbortSignal } | undefined {
  return params.signal === undefined ? undefined : { signal: params.signal };
}

export async function complete(
  client: Anthropic,
  params: CompletionParams,
): Promise<CompletionResult> {
  const callApi = (): Promise<Message> =>
    client.messages.create(
      buildApiParams(params) as MessageCreateParamsNonStreaming,
      requestOptions(params),
    );

  const response = await callWithRetry(callApi);
  return extractResult(response);
}

export type OnTextDelta = (delta: string) => void;

export async function completeStream(
  client: Anthropic,
  params: CompletionParams & { onTextDelta: OnTextDelta },
): Promise<CompletionResult> {
  const callApi = async (): Promise<Message> => {
    const stream = client.messages.stream(
      buildApiParams(params),
      requestOptions(params),
    );
    stream.on("text", (delta) => params.onTextDelta(delta));
    return await stream.finalMessage();
  };

  const response = await callWithRetry(callApi);
  return extractResult(response);
}

// ---------------------------------------------------------------------------
// Token counting — exact count via Anthropic API
// ---------------------------------------------------------------------------

export async function countTokens(
  client: Anthropic,
  params: {
    system?: string;
    messages: ReadonlyArray<MessageParam>;
    tools?: ReadonlyArray<Tool>;
  },
): Promise<number> {
  const result = await client.messages.countTokens({
    model: HARNESS_MODEL,
    messages: [...params.messages],
    ...(params.system === undefined ? {} : { system: params.system }),
    ...(params.tools === undefined ? {} : { tools: [...params.tools] }),
  });
  return result.input_tokens;
}

// ---------------------------------------------------------------------------
// Subagent loop
// ---------------------------------------------------------------------------

export type SubagentLoopResult = Readonly<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  iterations: number;
}>;

export async function runSubagentLoop(
  client: Anthropic,
  params: {
    system: string;
    messages: MessageParam[];
    tools: Tool[];
    maxIterations?: number;
    maxTokens?: number;
    timeoutMs?: number;
    onToolCall?: (name: string, input: unknown) => Promise<unknown>;
  },
): Promise<SubagentLoopResult> {
  const maxIterations = params.maxIterations ?? DEFAULT_SKILL_MAX_ITERATIONS;
  const timeoutMs = params.timeoutMs ?? SKILL_LOOP_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const messages = [...params.messages];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (signal.aborted) {
        throw new HarnessError(
          `Subagent loop timed out after ${timeoutMs}ms`,
          "limit_exceeded",
        );
      }

      const result = await complete(client, {
        system: params.system,
        messages,
        ...(params.tools.length > 0 ? { tools: params.tools } : {}),
        maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
        signal,
      });

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;

      const toolBlock = result.response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      if (!toolBlock) {
        return {
          text: result.text,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          iterations: iteration,
        };
      }

      if (!params.onToolCall) {
        throw new HarnessError(
          "Skill loop received tool_use but no onToolCall handler provided",
          "skill_execution_failed",
        );
      }

      const toolOutput = await raceSignal(
        params.onToolCall(toolBlock.name, toolBlock.input),
        signal,
      );

      messages.push(
        { role: "assistant", content: result.response.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolBlock.id,
              content: stringifyOutput(toolOutput),
            },
          ],
        },
      );
    }

    throw new HarnessError(
      `Subagent loop exceeded maxIterations (${maxIterations})`,
      "limit_exceeded",
    );
  } catch (error: unknown) {
    if (error instanceof HarnessError) throw error;
    if (isAbortError(error)) {
      throw new HarnessError(
        `Subagent loop timed out after ${timeoutMs}ms`,
        "limit_exceeded",
        error,
      );
    }
    throw error;
  }
}

export const runSkillLoop = runSubagentLoop;
export type SkillLoopResult = SubagentLoopResult;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Build Anthropic tool definitions from tool metadata.
 * These are real tools (web-search, web-fetch) directly available to the agent.
 */
export function buildDirectToolDefinitions(
  tools: ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: { type: "object"; [key: string]: unknown };
  }>,
): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/**
 * Build the spawn_subagent tool — the general-purpose subagent primitive.
 * The agent provides a prompt, task input, and optional artifact IDs.
 */
export function buildSpawnSubagentTool(): Tool {
  return {
    name: SPAWN_SUBAGENT_TOOL_NAME,
    description:
      "Spawn a subagent with a custom prompt. The subagent runs in its own " +
      "context window with the same tools you have. Use this to parallelize " +
      "work, isolate context for disparate operations, or delegate reasoning " +
      "tasks. The subagent's final text response is returned as the result.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Short name for this subagent (used for tracking and labels).",
        },
        prompt: {
          type: "string",
          description: "System prompt for the subagent.",
        },
        task_input: {
          type: "string",
          description:
            "The task description and any relevant context for the subagent.",
        },
        artifact_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional artifact IDs to make available to the subagent.",
        },
      },
      required: ["name", "prompt", "task_input"],
      additionalProperties: false,
    },
  };
}

/**
 * Build the spawn_subagent_with_skill tool — convenience for invoking a
 * pre-built skill. The skill provides the system prompt; the agent provides
 * the task input and optional artifacts.
 */
export function buildSpawnSubagentWithSkillTool(
  skills: ReadonlyArray<Skill>,
): Tool {
  const catalog = skills
    .map((s) => `- ${s.name}: ${s.description.trim()}`)
    .join("\n");

  return {
    name: SPAWN_SUBAGENT_WITH_SKILL_TOOL_NAME,
    description:
      "Spawn a subagent using a pre-built skill. The skill provides the system " +
      "prompt; you provide the task input and optional artifacts. The subagent " +
      "runs in its own context window with the same tools you have. " +
      "For simple, direct actions (a single web search, fetching a URL), prefer " +
      "calling tools directly instead.\n\nAvailable skills:\n" +
      catalog,
    input_schema: {
      type: "object" as const,
      properties: {
        skill_name: {
          type: "string",
          enum: skills.map((s) => s.name),
          description: "Name of the skill to activate.",
        },
        task_input: {
          type: "string",
          description:
            "The task description and any relevant context for the skill.",
        },
        artifact_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional artifact IDs to make available to the subagent.",
        },
      },
      required: ["skill_name", "task_input"],
      additionalProperties: false,
    },
  };
}

export type ParsedToolUse = Readonly<{
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
}>;

export function parseAllToolUses(
  response: Message,
): ReadonlyArray<ParsedToolUse> {
  return response.content
    .filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    )
    .map((block) => ({
      toolName: block.name,
      toolInput: block.input,
      toolUseId: block.id,
    }));
}

/** @deprecated Use {@link parseAllToolUses} to avoid silently dropping tool calls. */
export function parseToolUseWithId(
  response: Message,
): ParsedToolUse | undefined {
  const all = parseAllToolUses(response);
  return all[0];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Retry with jittered exponential backoff for Anthropic 529 (overloaded).
 *  Observed during batch eval runs: bursts of concurrent API calls trigger
 *  rate-limiting that clears within seconds. Jitter prevents thundering herd
 *  when multiple runs retry simultaneously. */
async function callWithRetry(
  callApi: () => Promise<Message>,
): Promise<Message> {
  for (let attempt = 0; attempt <= OVERLOAD_MAX_RETRIES; attempt++) {
    try {
      return await callApi();
    } catch (error: unknown) {
      if (!isOverloadedError(error) || attempt === OVERLOAD_MAX_RETRIES) {
        throw attempt === 0 ? error : (
            new HarnessError(
              `Model overloaded after ${attempt + 1} attempts`,
              "model_overloaded",
              error,
            )
          );
      }
      const baseDelay = OVERLOAD_RETRY_DELAY_MS * 2 ** attempt;
      const jitter = Math.random() * baseDelay * 0.5;
      await delay(Math.min(baseDelay + jitter, OVERLOAD_MAX_DELAY_MS));
    }
  }
  throw new HarnessError(
    `Model overloaded after ${OVERLOAD_MAX_RETRIES + 1} attempts`,
    "model_overloaded",
  );
}

function isOverloadedError(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    return error.status === ANTHROPIC_OVERLOADED_STATUS;
  }
  return false;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Anthropic.APIUserAbortError) return true;
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new DOMException("The operation was aborted.", "AbortError"),
    );
  }
  let cleanup: (() => void) | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const handler = () =>
        reject(new DOMException("The operation was aborted.", "AbortError"));
      signal.addEventListener("abort", handler, { once: true });
      cleanup = () => signal.removeEventListener("abort", handler);
    }),
  ]).finally(() => cleanup?.());
}

export {
  type Message,
  type MessageParam,
  type Tool,
} from "@anthropic-ai/sdk/resources/messages";
