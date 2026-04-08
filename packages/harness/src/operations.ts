import type { Repository } from "@nicator/core";
import {
  buildArtifact,
  generateId,
  HarnessError,
  isHarnessError,
  now,
  type Operation,
  stringifyOutput,
  type Task,
  type TaskRole,
} from "@nicator/core";

// ---------------------------------------------------------------------------
// Child Task creation — shared factory for all dispatch handlers
// ---------------------------------------------------------------------------

export async function spawnChildTask(
  repo: Repository,
  runId: string,
  parentTaskId: string,
  role: TaskRole,
  input: unknown,
  sequenceNumber: number,
  subagentName?: string,
): Promise<string> {
  const childTaskId = generateId();
  const task: Task = {
    id: childTaskId,
    runId,
    parentTaskId,
    role,
    ...(subagentName === undefined ? {} : { subagentName }),
    status: role === "subagent" ? "pending" : "running",
    input,
    sequenceNumber,
    createdAt: now(),
    updatedAt: now(),
  };
  await repo.tasks.create(task);
  return childTaskId;
}

// ---------------------------------------------------------------------------
// Operation creation — shared infrastructure for all dispatch handlers
// ---------------------------------------------------------------------------

export type CreateOperationOptions = Readonly<{
  repo: Repository;
  runId: string;
  taskId: string;
  toolInput: unknown;
  operationNumber: number;
  maxOperations?: number;
  inputTokens: number;
  outputTokens: number;
  type: "tool_call" | "hitl_response";
  execute: () => Promise<unknown>;
  artifactType: "json" | "text" | "hitl_decision";
  artifactName: string;
  artifactMimeType?: string;
}>;

/** Observed failure: a tool call that returns a partial/ambiguous result causes
 *  the model to retry the same call repeatedly within a single task, spiraling
 *  into dozens of operations before any other task gets a chance to run. */
function enforceOperationLimit(
  operationNumber: number,
  maxOperations: number | undefined,
): void {
  if (maxOperations !== undefined && operationNumber > maxOperations) {
    throw new HarnessError(
      `Max operations per task exceeded (${maxOperations})`,
      "limit_exceeded",
    );
  }
}

export async function createOperation(
  options: CreateOperationOptions,
): Promise<{ succeeded: boolean; result?: unknown; error?: string }> {
  const { repo, runId, taskId, operationNumber, maxOperations } = options;

  enforceOperationLimit(operationNumber, maxOperations);

  const operationId = generateId();
  const operation: Operation = {
    id: operationId,
    taskId,
    runId,
    type: options.type,
    status: "running",
    operationNumber,
    input: options.toolInput,
    inputTokens: options.inputTokens,
    outputTokens: options.outputTokens,
    createdAt: now(),
  };
  await repo.operations.create(operation);

  try {
    const startMs = Date.now();
    const result = await options.execute();
    const latencyMs = Date.now() - startMs;
    const resultString = stringifyOutput(result);

    const artifact = await buildArtifact(
      options.artifactType,
      options.artifactName,
      resultString,
      options.artifactMimeType,
    );
    await Promise.all([
      repo.operations.update(operationId, {
        status: "succeeded",
        output: result,
        latencyMs,
        completedAt: now(),
      }),
      repo.artifacts.createAndLinkProduced(artifact, operationId),
    ]);
    return { succeeded: true, result };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await repo.operations.update(operationId, {
      status: "failed",
      error: errorMessage,
      completedAt: now(),
    });
    if (isHarnessError(error)) throw error;
    return { succeeded: false, error: errorMessage };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function recordConsumesEdges(
  repo: Repository,
  taskId: string,
  artifactIds: readonly string[],
): Promise<void> {
  await Promise.all(
    artifactIds.map((artId) => repo.artifacts.addConsumesEdge(taskId, artId)),
  );
}
