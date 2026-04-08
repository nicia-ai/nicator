import { assertNever, HarnessError, type Policy } from "@nicator/core";

import { requestHumanApproval } from "./approval.js";
import type { HarnessConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Policy enforcement — runs before skill Task creation.
//
// Critical ordering: policy checks MUST precede Task/Operation node creation.
// A denied action should leave no trace in the execution graph. Early
// implementations created the Task first and rolled back on denial, which left
// orphan nodes and made the graph assertions unreliable.
// ---------------------------------------------------------------------------

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
): Promise<void> {
  const { policy, subagentName, toolInput, runId, rootTaskId } = ctx;
  const { repo } = config;

  switch (policy.type) {
    case "always": {
      return;
    }

    case "never": {
      throw new HarnessError(
        `Skill "${subagentName}" invocation denied by policy`,
        "policy_denied",
      );
    }

    case "require_hitl_approval": {
      const prompt = interpolatePrompt(policy.approverPrompt, toolInput);
      // Query actual root-task operation count from the repo
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
        throw new HarnessError(
          `Skill "${subagentName}" denied by human approver: ${decision}`,
          "hitl_rejected",
        );
      }
      return;
    }

    case "max_calls_per_run": {
      const completedCalls = await repo.tasks.countCompletedByName(
        runId,
        subagentName,
      );

      if (completedCalls >= policy.limit) {
        throw new HarnessError(
          `Skill "${subagentName}" exceeded max_calls_per_run limit (${policy.limit})`,
          "policy_denied",
        );
      }
      return;
    }

    default: {
      const _exhaustive: never = policy;
      assertNever(_exhaustive);
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
