// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

/** Model used for baseline (single-call) eval runs */
export const BASELINE_MODEL = "claude-sonnet-4-6" as const;

/** Model used for the LLM judge (pairwise comparison + calibration) */
export const JUDGE_MODEL = "claude-opus-4-6" as const;

// ---------------------------------------------------------------------------
// Eval metadata
// ---------------------------------------------------------------------------

export const HARNESS_VERSION = "0.1.0" as const;

// ---------------------------------------------------------------------------
// Default eval agent definition
// ---------------------------------------------------------------------------

export const DEFAULT_EVAL_SYSTEM_PROMPT =
  "You are a knowledge work analyst. Answer the question based on the provided source documents. " +
  "Be faithful to the sources. Do not add information not present in the provided documents.";

export const DEFAULT_EVAL_SKILLS = [
  { name: "researcher", version: "1.0.0" },
] as const;
