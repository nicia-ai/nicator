import {
  assertNever,
  HarnessError,
  type Policy,
} from "@nicator/core";

import { requestHumanApproval } from "./approval.js";
import type { HarnessConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Policy enforcement — runs before skill Task creation.
//
// Critical ordering: policy checks MUST precede Task/Operation node creation.
// A denied action should leave no subagent Task or Operation in the graph. Early
// implementations created the Task first and rolled back on denial, which left
// orphan nodes and made the graph assertions unreliable.
//
// Return semantics:
//   - { allowed: true }  → proceed with dispatch
//   - { allowed: false } → recoverable denial; the caller returns a failed
//     DispatchResult so the model sees the error and can choose a different
//     approach. This applies to max_calls_per_run (soft limit) and
//     require_hitl_approval rejection (human said no).
//   - throw HarnessError  → fatal, aborts the run. Only for "never" policy
//     (hard contract violation — the definition author explicitly forbade
//     this skill).
// ---------------------------------------------------------------------------

export type PolicyDecision = Readonly<
  | { allowed: true }
  | { allowed: false; reason: string }
>;

export type PolicyContext = Readonly<{
  policy: Policy;
  subagentName: string;
  toolInput: unknown;
  runId: string;
  rootTaskId: string;
  maxOperationsPerTask?: number;
}>;

export async function enforcePolicy(
  ctx: PolicyContext,
  config: HarnessConfig,
): Promise<PolicyDecision> {
  const { policy, subagentName, toolInput, runId, rootTaskId } = ctx;
  const { repo } = config;

  switch (policy.type) {
    case "always": {
      return { allowed: true };
    }

    case "never": {
      throw new HarnessError(
        `Skill "${subagentName}" invocation denied by policy`,
        "policy_denied",
      );
    }

    case "require_hitl_approval": {
      const prompt = interpolatePrompt(policy.approverPrompt, toolInput);

      // Dedup: if the same normalized prompt was already decided in this run,
      // reuse the prior decision instead of re-asking the human.
      const prior = await repo.tasks.findHitlDecision(runId, prompt);
      if (prior) {
        if (prior.approved) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: `Skill "${subagentName}" denied by human approver (prior decision): ${prior.artifactContent}`,
        };
      }

      const rootOps = await repo.operations.getForTask(rootTaskId, runId);
      const policyOpNumber = rootOps.length + 1;

      const { approved, decision } = await requestHumanApproval({
        repo,
        runId,
        taskId: rootTaskId,
        hitlContext: { taskId: rootTaskId, runId, subagentName },
        prompt,
        operationNumber: policyOpNumber,
        ...(ctx.maxOperationsPerTask === undefined ?
          {}
        : { maxOperations: ctx.maxOperationsPerTask }),
        inputTokens: 0,
        outputTokens: 0,
        artifactName: "policy_approval",
        hitlHandler: config.hitlHandler,
      });

      if (!approved) {
        return {
          allowed: false,
          reason: `Skill "${subagentName}" denied by human approver: ${decision}`,
        };
      }
      return { allowed: true };
    }

    case "max_calls_per_run": {
      const completedCalls = await repo.tasks.countCompletedByName(
        runId,
        subagentName,
      );

      if (completedCalls >= policy.limit) {
        return {
          allowed: false,
          reason: `Skill "${subagentName}" exceeded max_calls_per_run limit (${policy.limit})`,
        };
      }
      return { allowed: true };
    }

    default: {
      const _exhaustive: never = policy;
      return assertNever(_exhaustive);
    }
  }
}

function interpolatePrompt(template: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return template;
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value: unknown = (input as Record<string, unknown>)[key];
    if (value === undefined) return `{{${key}}}`;
    return typeof value === "string" || typeof value === "number" ?
        String(value)
      : JSON.stringify(value);
  });
}
