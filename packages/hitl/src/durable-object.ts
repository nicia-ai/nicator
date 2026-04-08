import {
  HITL_TIMEOUT_MS,
  HitlPendingBodySchema,
  HitlResolveBodySchema,
} from "@nicator/core";

// ---------------------------------------------------------------------------
// Storage shapes
// ---------------------------------------------------------------------------

type PendingEntry = Readonly<{
  taskId: string;
  runId: string;
  prompt: string;
  context?: string;
  token: string;
  createdAt: string;
}>;

type Resolution = Readonly<{
  decision: string;
  approved: boolean;
}>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_LENGTH = 32;

// Storage key prefixes — all pending/resolved state lives in DO storage.
const PENDING_PREFIX = "pending:";
const TASK_TOKEN_PREFIX = "task_token:";
const RESOLVED_PREFIX = "resolved:";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// HitlDurableObject
// ---------------------------------------------------------------------------

export class HitlDurableObject implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly _env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/pending") {
      return this.handlePending(request);
    }

    if (request.method === "POST" && url.pathname === "/resolve") {
      return this.handleResolve(request);
    }

    // GET /status/:taskId
    if (request.method === "GET" && url.pathname.startsWith("/status/")) {
      const taskId = url.pathname.slice("/status/".length);
      return this.handleStatus(taskId);
    }

    return errorResponse("not found", 404);
  }

  // -------------------------------------------------------------------------
  // POST /pending
  // -------------------------------------------------------------------------

  private async handlePending(request: Request): Promise<Response> {
    const parseResult = HitlPendingBodySchema.safeParse(await request.json());
    if (!parseResult.success) {
      return errorResponse(parseResult.error.message, 400);
    }

    const { taskId, runId, prompt, context } = parseResult.data;

    const token = randomToken();
    const entry: PendingEntry = {
      taskId,
      runId,
      prompt,
      ...(context === undefined ? {} : { context }),
      token,
      createdAt: new Date().toISOString(),
    };

    await this.state.storage.put(`${PENDING_PREFIX}${token}`, entry);
    await this.state.storage.put(`${TASK_TOKEN_PREFIX}${taskId}`, token);

    // Schedule alarm for timeout. If an alarm is already set (from a prior
    // pending request on this DO), the new alarm replaces it only if sooner.
    const currentAlarm = await this.state.storage.getAlarm();
    const timeoutAt = Date.now() + HITL_TIMEOUT_MS;
    if (currentAlarm === null || timeoutAt < currentAlarm) {
      await this.state.storage.setAlarm(timeoutAt);
    }

    return jsonResponse({ token });
  }

  // -------------------------------------------------------------------------
  // POST /resolve
  // -------------------------------------------------------------------------

  private async handleResolve(request: Request): Promise<Response> {
    const parseResult = HitlResolveBodySchema.safeParse(await request.json());
    if (!parseResult.success) {
      return errorResponse(parseResult.error.message, 400);
    }

    const { token, decision, approved } = parseResult.data;

    const entry = await this.state.storage.get<PendingEntry>(
      `${PENDING_PREFIX}${token}`,
    );

    if (!entry) {
      return errorResponse("no pending request for this token", 404);
    }

    const resolution: Resolution = { decision, approved };
    await this.state.storage.put(
      `${RESOLVED_PREFIX}${entry.taskId}`,
      resolution,
    );
    await this.state.storage.delete(`${PENDING_PREFIX}${token}`);
    await this.state.storage.delete(`${TASK_TOKEN_PREFIX}${entry.taskId}`);

    return jsonResponse({ ok: true });
  }

  // -------------------------------------------------------------------------
  // GET /status/:taskId
  // -------------------------------------------------------------------------

  private async handleStatus(taskId: string): Promise<Response> {
    const resolution = await this.state.storage.get<Resolution>(
      `${RESOLVED_PREFIX}${taskId}`,
    );

    if (resolution) {
      return jsonResponse({
        resolved: true,
        decision: resolution.decision,
        approved: resolution.approved,
      });
    }

    // Check if there is still a pending entry for this task
    const token = await this.state.storage.get<string>(
      `${TASK_TOKEN_PREFIX}${taskId}`,
    );

    if (!token) {
      return errorResponse("no pending or resolved entry for this task", 404);
    }

    return jsonResponse({ resolved: false });
  }

  // -------------------------------------------------------------------------
  // Alarm — timeout all pending requests
  // -------------------------------------------------------------------------

  async alarm(): Promise<void> {
    const pending = await this.state.storage.list<PendingEntry>({
      prefix: PENDING_PREFIX,
    });

    const now = Date.now();
    let earliestFutureTimeout: number | undefined;

    for (const [key, entry] of pending) {
      const elapsed = now - new Date(entry.createdAt).getTime();

      if (elapsed >= HITL_TIMEOUT_MS) {
        const resolution: Resolution = {
          decision: "timeout",
          approved: false,
        };
        await this.state.storage.put(
          `${RESOLVED_PREFIX}${entry.taskId}`,
          resolution,
        );
        await this.state.storage.delete(key);
        await this.state.storage.delete(`${TASK_TOKEN_PREFIX}${entry.taskId}`);
      } else {
        const remaining = HITL_TIMEOUT_MS - elapsed;
        if (
          earliestFutureTimeout === undefined ||
          remaining < earliestFutureTimeout
        ) {
          earliestFutureTimeout = remaining;
        }
      }
    }

    if (earliestFutureTimeout !== undefined) {
      await this.state.storage.setAlarm(now + earliestFutureTimeout);
    }
  }
}
