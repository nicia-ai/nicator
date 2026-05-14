import { zValidator } from "@hono/zod-validator";
import {
  AgentDefinitionSchema,
  CreateRunBodySchema,
  generateId,
  HarnessError,
  type HarnessErrorCode,
  HITL_DO_ORIGIN,
  now,
  type Repository,
  ResolveHitlBodySchema,
  type Run,
  RUN_EXECUTION_DO_ORIGIN,
} from "@nicator/core";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import type { Env } from "./env.js";
import { getRepo } from "./repo.js";

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const ERROR_STATUS: Record<HarnessErrorCode, ContentfulStatusCode> = {
  run_not_found: 404,
  artifact_not_found: 404,
  definition_not_found: 404,
  policy_denied: 403,
  limit_exceeded: 429,
  model_overloaded: 503,
  skill_not_found: 404,
  skill_execution_failed: 500,
  invalid_tool_call: 400,
  hitl_rejected: 403,
  circuit_breaker: 500,
  validation_error: 400,
  storage_error: 500,
};

// ---------------------------------------------------------------------------
// Validation error hook (shared by all zValidator calls)
// ---------------------------------------------------------------------------

const CreateDefinitionBodySchema = z.object({
  id: z.guid().optional(),
  version: z.number().int().positive().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  systemPrompt: z.string(),
  skills: z.array(z.unknown()).optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.iso.datetime().optional(),
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const api = new Hono<{ Bindings: Env; Variables: { repo: Repository } }>();

api.onError((error, c) => {
  if (error instanceof HarnessError) {
    const status = ERROR_STATUS[error.code];
    return c.json(
      { error: { code: error.code, message: error.message } },
      status,
    );
  }
  return c.json(
    { error: { code: "internal_error", message: error.message } },
    500,
  );
});

api.use("*", async (c, next) => {
  const repoInstance = await getRepo(c.env.DB);
  c.set("repo", repoInstance);
  await next();
});

function repo(c: { get: (key: "repo") => Repository }): Repository {
  return c.get("repo");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

api.get("/api/health", (c) => c.json({ ok: true }));

// -- Runs --

api.post("/api/runs", zValidator("json", CreateRunBodySchema), async (c) => {
  const body = c.req.valid("json");

  const definition = await repo(c).agents.getDefinition(
    body.agentDefinitionId,
    body.agentDefinitionVersion,
  );
  if (!definition) {
    return c.json(
      {
        error: {
          code: "definition_not_found",
          message: "Agent definition not found",
        },
      },
      404,
    );
  }

  const timestamp = now();
  const run: Run = {
    id: generateId(),
    agentDefinitionId: definition.id,
    agentDefinitionVersion: definition.version,
    status: "pending",
    input: body.input,
    totalTokensUsed: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await repo(c).runs.create(run);

  const doId = c.env.RUN_EXECUTION_DO.idFromName(run.id);
  const stub = c.env.RUN_EXECUTION_DO.get(doId);
  const startResp = await stub.fetch(`${RUN_EXECUTION_DO_ORIGIN}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: run.id,
      ...(body.inputArtifacts ? { inputArtifacts: body.inputArtifacts } : {}),
    }),
  });

  if (!startResp.ok) {
    const text = await startResp.text();
    return c.json({ error: { code: "storage_error", message: text } }, 500);
  }

  return c.json(run, 201);
});

api.get("/api/runs", async (c) => {
  const runs = await repo(c).runs.listRecent();
  return c.json(runs);
});

api.get("/api/runs/:id", async (c) => {
  const run = await repo(c).runs.get(c.req.param("id"));
  if (!run) {
    return c.json(
      { error: { code: "run_not_found", message: "Run not found" } },
      404,
    );
  }
  const tasks = await repo(c).tasks.getForRun(run.id);
  return c.json({ ...run, tasks });
});

api.get("/api/runs/:id/lineage", async (c) => {
  const lineage = await repo(c).lineage.getRunLineage(c.req.param("id"));
  if (!lineage) {
    return c.json(
      { error: { code: "run_not_found", message: "Run not found" } },
      404,
    );
  }
  return c.json(lineage);
});

api.get("/api/runs/:id/artifacts", async (c) => {
  const runId = c.req.param("id");
  const run = await repo(c).runs.get(runId);
  if (!run) {
    return c.json(
      { error: { code: "run_not_found", message: "Run not found" } },
      404,
    );
  }
  const artifacts = await repo(c).artifacts.getForRun(runId);
  return c.json(artifacts);
});

// -- Artifacts --

api.get("/api/artifacts/:id/provenance", async (c) => {
  const provenance = await repo(c).artifacts.getProvenance(c.req.param("id"));
  if (!provenance) {
    return c.json(
      {
        error: {
          code: "artifact_not_found",
          message: "Artifact not found",
        },
      },
      404,
    );
  }
  return c.json(provenance);
});

// -- Tasks --

api.get("/api/tasks/:id/operations", async (c) => {
  const runId = c.req.query("runId");
  if (!runId) {
    return c.json(
      {
        error: {
          code: "validation_error",
          message: "runId query parameter is required",
        },
      },
      400,
    );
  }
  const operations = await repo(c).operations.getForTask(
    c.req.param("id"),
    runId,
  );
  return c.json(operations);
});

// -- HITL --

api.post(
  "/api/hitl/resolve",
  zValidator("json", ResolveHitlBodySchema),
  async (c) => {
    const body = c.req.valid("json");

    const doId = c.env.HITL_DO.idFromName(body.runId);
    const stub = c.env.HITL_DO.get(doId);

    const resp = await stub.fetch(`${HITL_DO_ORIGIN}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: body.token,
        decision: body.decision,
        approved: body.approved,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return c.json(
        { error: { code: "hitl_rejected", message: text } },
        (resp.status || 500) as 400 | 403 | 404 | 500,
      );
    }

    return c.json({ ok: true });
  },
);

// -- Definitions --

api.get("/api/definitions", async (c) => {
  const definitions = await repo(c).agents.listDefinitions();
  return c.json(definitions);
});

api.post(
  "/api/definitions",
  zValidator("json", CreateDefinitionBodySchema),
  async (c) => {
    const body = c.req.valid("json");
    const parsed = AgentDefinitionSchema.safeParse({
      ...body,
      id: body.id ?? generateId(),
      version: body.version ?? 1,
      description: body.description ?? "",
      skills: body.skills ?? [],
      limits: body.limits ?? {
        maxTasksPerRun: 50,
        maxOperationsPerTask: 3,
        maxTokensPerRun: 500_000,
      },
      createdAt: body.createdAt ?? now(),
    });

    if (!parsed.success) {
      return c.json(
        { error: { code: "validation_error", message: parsed.error.message } },
        400,
      );
    }

    await repo(c).agents.createDefinition(parsed.data);
    return c.json(parsed.data, 201);
  },
);

export default api;

export { RunExecutionDurableObject } from "./run-execution-do.js";
export { HitlDurableObject } from "@nicator/hitl";
