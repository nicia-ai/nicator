import { z } from "zod";

export const HarnessErrorCodeSchema = z.enum([
  "model_overloaded",
  "skill_not_found",
  "skill_execution_failed",
  "policy_denied",
  "limit_exceeded",
  "invalid_tool_call",
  "hitl_rejected",
  "run_not_found",
  "artifact_not_found",
  "definition_not_found",
  "circuit_breaker",
  "validation_error",
  "storage_error",
]);
export type HarnessErrorCode = z.infer<typeof HarnessErrorCodeSchema>;

export class HarnessError extends Error {
  override readonly name = "HarnessError";

  constructor(
    message: string,
    public readonly code: HarnessErrorCode,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export function isHarnessError(error: unknown): error is HarnessError {
  return error instanceof HarnessError;
}
