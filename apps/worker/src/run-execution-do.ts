import type { InputDocument, Repository } from "@nicator/core";
import { now, todayISO } from "@nicator/core";
import { runAgent, toolRegistryFromMap } from "@nicator/harness";
import { CloudflareHitlHandler } from "@nicator/hitl";
import { createAnthropicClient } from "@nicator/sdk";
import { createWebFetchTool } from "@nicator/tool-web-fetch";
import { webFetchManifest } from "@nicator/tool-web-fetch/manifest";
import { createWebSearchTool } from "@nicator/tool-web-search";
import { webSearchManifest } from "@nicator/tool-web-search/manifest";
import { createBashTool } from "@nicator/workspace";
import { createWorkerWorkspace } from "@nicator/workspace/worker";

import type { Env } from "./env.js";
import { getRepo } from "./repo.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StartBody = Readonly<{
  runId: string;
  inputDocuments?: ReadonlyArray<InputDocument>;
}>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often the in-process timer writes a heartbeat to DO storage. Two
 *  writes land per STALE_THRESHOLD_MS window — enough margin for jitter. */
const HEARTBEAT_WRITE_MS = 20_000;

/** How often the alarm checks whether the heartbeat is still fresh. */
const HEARTBEAT_CHECK_MS = 30_000;

/** If the heartbeat is older than this, the run is considered orphaned. */
const STALE_THRESHOLD_MS = 60_000;

const RUN_ID_KEY = "runId";
const HEARTBEAT_KEY = "heartbeat";

// ---------------------------------------------------------------------------
// RunExecutionDurableObject
//
// Owns the lifecycle of a single Run. The HTTP route handler creates the Run
// record in D1 and delegates execution here. The DO provides:
//
//   1. Heartbeat-based crash detection — a periodic alarm checks whether the
//      in-process heartbeat timer is still writing. If the isolate is evicted
//      mid-run, the heartbeat goes stale and the alarm marks the run as failed.
//
//   2. Per-run isolation — each run gets its own DO instance (keyed by run ID),
//      so a crash in one run cannot affect another.
//
//   3. A foundation for future enhancements: WebSocket status streaming,
//      durable workspace storage (agentfs on DO SQLite), and step-based
//      resumption via alarm-driven continuation.
// ---------------------------------------------------------------------------

export class RunExecutionDurableObject implements DurableObject {
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/start") {
      return this.handleStart(request);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    const entries = await this.ctx.storage.get([HEARTBEAT_KEY, RUN_ID_KEY]);
    const heartbeat = entries.get(HEARTBEAT_KEY) as number | undefined;
    const runId = entries.get(RUN_ID_KEY) as string | undefined;

    if (!runId) {
      await this.ctx.storage.deleteAll();
      return;
    }

    if (
      heartbeat !== undefined &&
      Date.now() - heartbeat < STALE_THRESHOLD_MS
    ) {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_CHECK_MS);
      return;
    }

    await this.markOrphaned(runId);
  }

  // -------------------------------------------------------------------------
  // POST /start
  // -------------------------------------------------------------------------

  private async handleStart(request: Request): Promise<Response> {
    // Internal-only endpoint — caller (index.ts) validates with Zod.
    const body = (await request.json()) as StartBody;

    await this.ctx.storage.put({
      [RUN_ID_KEY]: body.runId,
      [HEARTBEAT_KEY]: Date.now(),
    });
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_CHECK_MS);

    this.ctx.waitUntil(this.execute(body));

    return Response.json({ ok: true });
  }

  // -------------------------------------------------------------------------
  // Run execution
  // -------------------------------------------------------------------------

  private async execute(body: StartBody): Promise<void> {
    this.heartbeatTimer = setInterval(() => {
      this.ctx.storage.put(HEARTBEAT_KEY, Date.now()).catch(() => {
        // Swallowed — a missed heartbeat write is tolerable. If writes fail
        // persistently the heartbeat goes stale and the alarm handles cleanup.
      });
    }, HEARTBEAT_WRITE_MS);

    try {
      const repo = await this.getRepo();
      const run = await repo.runs.get(body.runId);
      if (!run) {
        await repo.runs.update(body.runId, {
          status: "failed",
          updatedAt: now(),
        });
        return;
      }

      const definition = await repo.agents.getDefinition(
        run.agentDefinitionId,
        run.agentDefinitionVersion,
      );
      if (!definition) {
        await repo.runs.update(body.runId, {
          status: "failed",
          updatedAt: now(),
        });
        return;
      }

      const client = createAnthropicClient(this.env.ANTHROPIC_API_KEY);
      const hitlHandler = new CloudflareHitlHandler(this.env.HITL_DO, run.id);

      const workspace = await createWorkerWorkspace({
        runId: run.id,
        ...(definition.workspace?.outputPaths ?
          { outputPaths: definition.workspace.outputPaths }
        : {}),
        ...(definition.workspace?.initialFiles ?
          { initialFiles: definition.workspace.initialFiles }
        : {}),
      });

      const toolRegistry = toolRegistryFromMap([
        [
          "web-search",
          createWebSearchTool(webSearchManifest, this.env.BRAVE_API_KEY),
        ],
        ["web-fetch", createWebFetchTool(webFetchManifest)],
        ["bash", createBashTool(workspace)],
      ]);

      try {
        await runAgent(run.id, {
          repo,
          anthropic: client,
          toolRegistry,
          workspace,
          hitlHandler,
          ...(body.inputDocuments ?
            { inputDocuments: body.inputDocuments }
          : {}),
          env: { date: todayISO(), runtime: "worker" },
        });
      } finally {
        await workspace.dispose();
      }
    } finally {
      this.stopHeartbeat();
      await this.ctx.storage.deleteAll();
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async markOrphaned(runId: string): Promise<void> {
    try {
      const repo = await this.getRepo();
      const run = await repo.runs.get(runId);
      if (run && run.status !== "completed" && run.status !== "failed") {
        await repo.runs.update(runId, { status: "failed", updatedAt: now() });
      }
    } finally {
      await this.ctx.storage.deleteAll();
    }
  }

  private getRepo(): Promise<Repository> {
    return getRepo(this.env.DB);
  }
}
