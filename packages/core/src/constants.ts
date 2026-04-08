// ---------------------------------------------------------------------------
// System skill identifiers
// ---------------------------------------------------------------------------

export const HUMAN_APPROVAL_SKILL_NAME = "human-approval" as const;
export const SPAWN_SUBAGENT_TOOL_NAME = "spawn_subagent" as const;
export const SPAWN_SUBAGENT_WITH_SKILL_TOOL_NAME =
  "spawn_subagent_with_skill" as const;
export const TOOL_CALL_VERSION = "tool" as const;

// ---------------------------------------------------------------------------
// Token estimation
//
// Claude's tokenizer averages ~4 chars/token for English prose but is
// significantly denser for JSON, code, and structured text (~3 chars/token)
// due to punctuation, short keys, and braces each consuming a token.
// The content-aware estimator below picks a ratio based on a cheap sample.
// ---------------------------------------------------------------------------

export const CHARS_PER_TOKEN_PROSE = 4 as const;
export const CHARS_PER_TOKEN_STRUCTURED = 3 as const;

/** Fraction of non-alphanumeric, non-space characters that flips the
 *  estimate from prose to structured. Calibrated against Anthropic's
 *  count_tokens API on a mixed corpus of tool results. */
const STRUCTURED_PUNCTUATION_THRESHOLD = 0.3;

/** Sample size for the punctuation check — avoids scanning megabyte strings. */
const SAMPLE_SIZE = 512;

export function estimateTokens(text: string): number {
  const sampleLength = Math.min(text.length, SAMPLE_SIZE);
  let punctuation = 0;
  let index = 0;
  for (const char of text) {
    if (index >= sampleLength) break;
    const c = char.codePointAt(0) ?? 0;
    const isAlphanumericOrSpace =
      (c >= 97 && c <= 122) ||
      (c >= 65 && c <= 90) ||
      (c >= 48 && c <= 57) ||
      c === 32;
    if (!isAlphanumericOrSpace) punctuation++;
    index++;
  }
  const ratio =
    (
      sampleLength > 0 &&
      punctuation / sampleLength >= STRUCTURED_PUNCTUATION_THRESHOLD
    ) ?
      CHARS_PER_TOKEN_STRUCTURED
    : CHARS_PER_TOKEN_PROSE;
  return Math.ceil(text.length / ratio);
}

// ---------------------------------------------------------------------------
// Context injection tuning
// ---------------------------------------------------------------------------

export const CONTEXT_BUDGET_RATIO = 0.4 as const;
export const MAX_CONTEXT_TOKENS = 40_000 as const;
export const COMPRESSION_MAX_TOKENS = 1024 as const;

// ---------------------------------------------------------------------------
// Model defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TOKENS = 4096 as const;
export const HARNESS_MODEL = "claude-sonnet-4-6" as const;

// ---------------------------------------------------------------------------
// HITL
//
// Without timeouts, a run waiting for human approval hangs forever if the
// approver never responds. In production (Durable Objects) the 7-day window
// covers async workflows where an approver may be OOO. In the CLI, 5 minutes
// prevents a forgotten terminal from holding an API-key-bearing process open.
// ---------------------------------------------------------------------------

export const HITL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const CLI_HITL_TIMEOUT_MS = 5 * 60 * 1000;
export const HITL_DO_ORIGIN = "https://hitl.internal" as const;
export const RUN_EXECUTION_DO_ORIGIN =
  "https://run-execution.internal" as const;

// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------

export const ANTHROPIC_OVERLOADED_STATUS = 529 as const;
export const OVERLOAD_RETRY_DELAY_MS = 5000 as const;
export const OVERLOAD_MAX_RETRIES = 4 as const;
export const OVERLOAD_MAX_DELAY_MS = 60_000 as const;

// ---------------------------------------------------------------------------
// Skill loop
// ---------------------------------------------------------------------------

export const DEFAULT_SKILL_MAX_ITERATIONS = 10 as const;

/** Wall-clock timeout for inner skill/agent loops. Prevents a hung API call
 *  or slow tool from stalling the parent run indefinitely. 5 minutes is
 *  generous for any single skill invocation — most complete in under 60s. */
export const SKILL_LOOP_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Conversation sliding window
// ---------------------------------------------------------------------------

export const RECENT_TURN_BUDGET_RATIO = 0.5 as const;
export const DISPATCH_GATHER_TIMEOUT_MS = 10_000 as const;

// ---------------------------------------------------------------------------
// Default MIME type
// ---------------------------------------------------------------------------

export const DEFAULT_MIME_TYPE = "text/plain" as const;
export const JSON_MIME_TYPE = "application/json" as const;
