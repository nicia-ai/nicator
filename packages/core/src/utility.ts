import type {
  Artifact,
  ArtifactType,
  OperationType,
  Policy,
  Task,
} from "./schema.js";

export function now(): string {
  return new Date().toISOString();
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function generateId(): string {
  return globalThis.crypto.randomUUID();
}

export async function sha256(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function buildArtifact(
  type: ArtifactType,
  name: string,
  content: string,
  mimeType = "text/plain",
): Promise<Artifact> {
  return {
    id: generateId(),
    type,
    name,
    content,
    contentHash: await sha256(content),
    mimeType,
    createdAt: now(),
  };
}

export function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export type ApprovalDecision = "approved" | "rejected" | "unclear";

export function parseApprovalDecision(decision: string): ApprovalDecision {
  const lower = decision.toLowerCase();
  if (lower.includes("approve") || lower.includes("yes") || lower === "y") {
    return "approved";
  }
  if (lower.includes("reject") || lower.includes("no") || lower === "n") {
    return "rejected";
  }
  return "unclear";
}

export function buildHitlPrompt(prompt: string, context?: string): string {
  return context ? `${prompt}\n\nContext: ${context}` : prompt;
}

export type HitlContext = Readonly<{
  taskId: string;
  runId: string;
  subagentName?: string;
}>;

export type HitlHandler = Readonly<{
  requestApproval: (context: HitlContext, prompt: string) => Promise<string>;
}>;

/** Normalize for dedup — NOT semantic similarity, just formatting differences. */
export function normalizeHitlPrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replaceAll(/\s+/g, " ")
    .trim()
    .replaceAll(/[?.!,;:]+$/g, "");
}

export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${String(value)}`);
}

export function pickDefined<T extends Record<string, unknown>>(
  object: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export function taskLabel(task: Pick<Task, "role" | "subagentName">): string {
  return task.role === "root" ? "root" : (task.subagentName ?? task.role);
}

export function taskHasOperationType(
  entry: Readonly<{
    operations: ReadonlyArray<
      Readonly<{ operation: Readonly<{ type: OperationType }> }>
    >;
  }>,
  type: OperationType,
): boolean {
  return entry.operations.some((o) => o.operation.type === type);
}

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

/**
 * Single source of truth for whether a policy requires HITL before dispatch.
 * Used by willRequireHitl (run-loop partition) and enforcePolicy (execution).
 * The exhaustive switch ensures new Policy variants produce a compile-time
 * error here if not handled — eliminating the manual sync hazard.
 */
export function policyRequiresHitl(policy: Policy): boolean {
  switch (policy.type) {
    case "always": {
      return false;
    }
    case "never": {
      return false;
    }
    case "require_hitl_approval": {
      return true;
    }
    case "max_calls_per_run": {
      return false;
    }
    default: {
      const _exhaustive: never = policy;
      return assertNever(_exhaustive);
    }
  }
}
