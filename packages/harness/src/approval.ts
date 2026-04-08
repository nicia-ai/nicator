import type { HitlHandler, Repository } from "@nicator/core";
import {
  buildHitlPrompt,
  type HitlContext,
  HUMAN_APPROVAL_SKILL_NAME,
  now,
  parseApprovalDecision,
  stringifyOutput,
} from "@nicator/core";
import type { Tool } from "@nicator/sdk";
import { z } from "zod";

import { createOperation } from "./operations.js";

// ---------------------------------------------------------------------------
// Tool definition (presented to the LLM)
// ---------------------------------------------------------------------------

export const HUMAN_APPROVAL_TOOL: Tool = {
  name: HUMAN_APPROVAL_SKILL_NAME,
  description:
    "Request a decision or approval from a human before proceeding. " +
    "The run will pause until the human responds. Use when the task requires " +
    "judgment, authorization, or information that only a human can provide. " +
    "Be specific about what you need and why.",
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The question or decision you need the human to answer.",
      },
      context: {
        type: "string",
        description: "Relevant context the human needs to make the decision.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

export const HumanApprovalInputSchema = z.object({
  prompt: z.string(),
  context: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Approval request/result types
// ---------------------------------------------------------------------------

export type ApprovalRequest = Readonly<{
  repo: Repository;
  runId: string;
  taskId: string;
  hitlContext: HitlContext;
  prompt: string;
  operationNumber: number;
  maxOperations?: number;
  inputTokens: number;
  outputTokens: number;
  artifactName: string;
  hitlHandler: HitlHandler;
}>;

export type ApprovalResult = Readonly<{
  approved: boolean;
  decision: string;
}>;

// ---------------------------------------------------------------------------
// Shared approval flow — used by both agent-initiated and policy-gated paths
// ---------------------------------------------------------------------------

export async function requestHumanApproval(
  request: ApprovalRequest,
): Promise<ApprovalResult> {
  const { repo, runId, taskId, hitlContext, prompt, hitlHandler } = request;

  await repo.runs.update(runId, { status: "awaiting_hitl", updatedAt: now() });

  const { succeeded, result } = await createOperation({
    repo,
    runId,
    taskId,
    toolInput: { prompt },
    operationNumber: request.operationNumber,
    ...(request.maxOperations === undefined ?
      {}
    : { maxOperations: request.maxOperations }),
    inputTokens: request.inputTokens,
    outputTokens: request.outputTokens,
    type: "hitl_response",
    execute: () => hitlHandler.requestApproval(hitlContext, prompt),
    artifactType: "hitl_decision",
    artifactName: request.artifactName,
  });

  await repo.runs.update(runId, { status: "running", updatedAt: now() });

  const decision =
    succeeded && typeof result === "string" ?
      result
    : stringifyOutput(result ?? "");
  return {
    approved: succeeded && parseApprovalDecision(decision) === "approved",
    decision,
  };
}

// ---------------------------------------------------------------------------
// Agent-initiated approval (human-approval tool dispatch)
// ---------------------------------------------------------------------------

export function parseApprovalToolInput(toolInput: unknown): {
  prompt: string;
  fullPrompt: string;
} {
  const { prompt, context } = HumanApprovalInputSchema.parse(toolInput);
  return { prompt, fullPrompt: buildHitlPrompt(prompt, context) };
}
