import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { HarnessError } from "@nicator/core";
import { describe, expect, it, vi } from "vitest";

import { completeStream, runSkillLoop } from "./sdk.js";

function textBlock(text: string): ContentBlock {
  return { type: "text", text } as unknown as ContentBlock;
}

function toolUseBlock(id: string, name: string, input: unknown): ContentBlock {
  return { type: "tool_use", id, name, input } as unknown as ContentBlock;
}

function createMockClient(
  responses: ReadonlyArray<Partial<Anthropic.Message>>,
): Anthropic {
  let callIndex = 0;
  return {
    messages: {
      create: vi.fn((_params: unknown, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        const response = responses[callIndex++];
        return Promise.resolve({
          id: `msg_${callIndex}`,
          type: "message" as const,
          role: "assistant" as const,
          content: [textBlock("done")],
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn" as const,
          stop_sequence: undefined,
          usage: { input_tokens: 10, output_tokens: 5 },
          ...response,
        });
      }),
    },
  } as unknown as Anthropic;
}

/** Mock client where create() hangs until the signal aborts. */
function createHangingMockClient(): Anthropic {
  return {
    messages: {
      create: vi.fn(
        (_params: unknown, options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted) {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
              return;
            }
            signal?.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
          }),
      ),
    },
  } as unknown as Anthropic;
}

describe("runSkillLoop", () => {
  it("returns on first non-tool response", async () => {
    const client = createMockClient([{ content: [textBlock("hello")] }]);

    const result = await runSkillLoop(client, {
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });

    expect(result.text).toBe("hello");
    expect(result.iterations).toBe(1);
  });

  it("throws HarnessError with limit_exceeded on timeout", async () => {
    const client = createHangingMockClient();

    const promise = runSkillLoop(client, {
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      timeoutMs: 50,
    });

    await expect(promise).rejects.toBeInstanceOf(HarnessError);
    await expect(promise).rejects.toHaveProperty("code", "limit_exceeded");
  });

  it("throws HarnessError when tool call exceeds timeout", async () => {
    const client = createMockClient([
      { content: [toolUseBlock("tu_1", "slow-tool", {})] },
    ]);

    const promise = runSkillLoop(client, {
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "slow-tool",
          description: "hangs",
          input_schema: { type: "object" as const, properties: {} },
        },
      ],
      timeoutMs: 50,
      onToolCall: () => new Promise((resolve) => setTimeout(resolve, 60_000)),
    });

    await expect(promise).rejects.toBeInstanceOf(HarnessError);
    await expect(promise).rejects.toHaveProperty("code", "limit_exceeded");
  });
});

// ---------------------------------------------------------------------------
// completeStream tests
// ---------------------------------------------------------------------------

type TextListener = (delta: string, snapshot: string) => void;

function createMockStreamMessage(
  finalMessage: Partial<Anthropic.Message>,
  textDeltas: string[],
) {
  return {
    messages: {
      stream: vi.fn(() => {
        const listeners = new Map<string, TextListener[]>();
        const mockStream = {
          on(event: string, listener: TextListener) {
            const existing = listeners.get(event) ?? [];
            existing.push(listener);
            listeners.set(event, existing);
            return mockStream;
          },
          finalMessage() {
            const textListeners = listeners.get("text") ?? [];
            let snapshot = "";
            for (const delta of textDeltas) {
              snapshot += delta;
              for (const listener of textListeners) {
                listener(delta, snapshot);
              }
            }
            return Promise.resolve({
              id: "msg_1",
              type: "message" as const,
              role: "assistant" as const,
              content: [textBlock(snapshot)],
              model: "claude-sonnet-4-6",
              stop_reason: "end_turn" as const,
              stop_sequence: undefined,
              usage: { input_tokens: 20, output_tokens: 15 },
              ...finalMessage,
            });
          },
        };
        return mockStream;
      }),
    },
  } as unknown as Anthropic;
}

describe("completeStream", () => {
  it("delivers text deltas and returns final result", async () => {
    const deltas = ["Hello", " ", "world"];
    const client = createMockStreamMessage({}, deltas);
    const received: string[] = [];

    const result = await completeStream(client, {
      system: "test",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 1024,
      onTextDelta: (delta) => received.push(delta),
    });

    expect(received).toEqual(["Hello", " ", "world"]);
    expect(result.text).toBe("Hello world");
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(15);
  });

  it("returns tool_use blocks in final message", async () => {
    const client = createMockStreamMessage(
      { content: [toolUseBlock("tu_1", "web-search", { query: "test" })] },
      [],
    );
    const received: string[] = [];

    const result = await completeStream(client, {
      system: "test",
      messages: [{ role: "user", content: "search for test" }],
      tools: [
        {
          name: "web-search",
          description: "search",
          input_schema: { type: "object" as const, properties: {} },
        },
      ],
      maxTokens: 1024,
      onTextDelta: (delta) => received.push(delta),
    });

    expect(received).toEqual([]);
    const toolBlock = result.response.content.find(
      (b) => b.type === "tool_use",
    );
    expect(toolBlock).toBeDefined();
  });
});
