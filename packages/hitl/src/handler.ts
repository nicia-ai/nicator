import type { HitlContext, HitlHandler } from "@nicator/core";
import { HarnessError, HITL_DO_ORIGIN, HITL_TIMEOUT_MS } from "@nicator/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 30_000;
const BACKOFF_FACTOR = 1.5;

// ---------------------------------------------------------------------------
// CloudflareHitlHandler
// ---------------------------------------------------------------------------

export class CloudflareHitlHandler implements HitlHandler {
  constructor(
    private readonly doNamespace: DurableObjectNamespace,
    private readonly runId: string,
  ) {}

  async requestApproval(context: HitlContext, prompt: string): Promise<string> {
    const doId = this.doNamespace.idFromName(this.runId);
    const stub = this.doNamespace.get(doId);

    const pendingResp = await stub.fetch(`${HITL_DO_ORIGIN}/pending`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: context.taskId,
        runId: context.runId,
        prompt,
      }),
    });

    if (!pendingResp.ok) {
      const text = await pendingResp.text();
      throw new HarnessError(
        `HITL /pending failed (${String(pendingResp.status)}): ${text}`,
        "storage_error",
      );
    }

    await pendingResp.json();

    const startTime = Date.now();
    let interval = INITIAL_POLL_INTERVAL_MS;

    while (Date.now() - startTime < HITL_TIMEOUT_MS) {
      await sleep(interval);

      const statusResp = await stub.fetch(
        `${HITL_DO_ORIGIN}/status/${context.taskId}`,
      );

      if (!statusResp.ok) {
        if (statusResp.status === 404) {
          return "timeout";
        }
        throw new HarnessError(
          `HITL /status failed (${String(statusResp.status)}): ${await statusResp.text()}`,
          "storage_error",
        );
      }

      const status: { resolved: boolean; decision?: string } =
        await statusResp.json();

      if (status.resolved) {
        return status.decision ?? "timeout";
      }

      interval = Math.min(interval * BACKOFF_FACTOR, MAX_POLL_INTERVAL_MS);
    }

    return "timeout";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
