import type { Repository } from "@nicator/core";
import {
  buildArtifact,
  generateId,
  isHarnessError,
  JSON_MIME_TYPE,
  now,
  type Operation,
  stringifyOutput,
} from "@nicator/core";
import { runSubagentLoop, type Tool } from "@nicator/sdk";

import {
  createOperation,
  recordConsumesEdges,
  spawnChildTask,
} from "./operations.js";
import type {
  DispatchOptions,
  DispatchResult,
  ToolImplementation,
} from "./types.js";

export type SubagentToolCallContext = Readonly<{
  childTaskId: string;
  repo: Repository;
  maxOperationsPerTask: number;
  runId: string;
}>;

type SpecialToolCallResult =
  | Readonly<{ handled: true; result: unknown }>
  | Readonly<{ handled: false }>;

export type SubagentRuntimeSpec = Readonly<{
  name: string;
  taskInput: string;
  consumesArtifactIds: ReadonlyArray<string>;
  systemPrompt: string;
  initialMessage: string;
  directToolImpls: ReadonlyArray<ToolImplementation>;
  extraTools?: ReadonlyArray<Tool>;
  maxIterations?: number;
  outputArtifactName: string;
  /** Skill node ID — if provided, creates an `invokes` edge after task spawn. */
  skillId?: string;
  handleSpecialToolCall?: (
    name: string,
    toolInput: unknown,
    ctx: SubagentToolCallContext,
  ) => Promise<SpecialToolCallResult>;
}>;

export async function dispatchSubagent(
  options: DispatchOptions,
  spec: SubagentRuntimeSpec,
): Promise<DispatchResult> {
  const {
    runId,
    rootTaskId,
    toolUseId,
    taskSequenceNumber,
    inputTokens,
    outputTokens,
    definition,
    config,
  } = options;
  const { repo, anthropic } = config;

  const childTaskId = await spawnChildTask(
    repo,
    runId,
    rootTaskId,
    "subagent",
    { task_input: spec.taskInput },
    taskSequenceNumber,
    spec.name,
  );
  await Promise.all([
    recordConsumesEdges(repo, childTaskId, spec.consumesArtifactIds),
    spec.skillId ? repo.tasks.linkSkill(childTaskId, spec.skillId) : undefined,
  ]);

  const operationId = generateId();
  const operation: Operation = {
    id: operationId,
    taskId: childTaskId,
    runId,
    type: "tool_call",
    status: "running",
    operationNumber: 1,
    input: { task_input: spec.taskInput },
    inputTokens,
    outputTokens,
    createdAt: now(),
  };
  await repo.operations.create(operation);
  await repo.tasks.update(childTaskId, { status: "running", updatedAt: now() });

  // Build tool array and lookup map in a single pass over directToolImpls.
  const toolMap = new Map<string, ToolImplementation>();
  const tools: Tool[] = spec.directToolImpls.map((impl) => {
    toolMap.set(impl.tool.name, impl);
    return {
      name: impl.tool.name,
      description: impl.tool.description,
      input_schema: impl.tool.inputSchema,
    };
  });
  if (spec.extraTools) tools.push(...spec.extraTools);

  // Primary operation is #1; inner tool calls start at #2.
  let operationCounter = 1;
  const startMs = Date.now();

  try {
    const result = await runSubagentLoop(anthropic, {
      system: spec.systemPrompt,
      messages: [{ role: "user", content: spec.initialMessage }],
      tools,
      ...(spec.maxIterations === undefined ?
        {}
      : { maxIterations: spec.maxIterations }),
      onToolCall: async (
        name: string,
        innerToolInput: unknown,
      ): Promise<unknown> => {
        const ctx: SubagentToolCallContext = {
          childTaskId,
          repo,
          maxOperationsPerTask: definition.limits.maxOperationsPerTask,
          runId,
        };

        if (spec.handleSpecialToolCall) {
          const special = await spec.handleSpecialToolCall(
            name,
            innerToolInput,
            ctx,
          );
          if (special.handled) return special.result;
        }

        const impl = toolMap.get(name);
        if (!impl) {
          return { error: `Unknown tool: ${name}` };
        }

        const { result: innerResult } = await createOperation({
          repo,
          runId,
          taskId: childTaskId,
          toolInput: innerToolInput,
          operationNumber: ++operationCounter,
          maxOperations: definition.limits.maxOperationsPerTask,
          inputTokens: 0,
          outputTokens: 0,
          type: "tool_call",
          execute: () => impl.execute(innerToolInput),
          artifactType: "json",
          artifactName: `${name}_result`,
          artifactMimeType: JSON_MIME_TYPE,
        });
        return innerResult;
      },
    });

    await Promise.all([
      repo.operations.update(operationId, {
        status: "succeeded",
        output: { text: result.text },
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Date.now() - startMs,
        completedAt: now(),
      }),
      createOutputArtifact(
        repo,
        spec.outputArtifactName,
        result.text,
        operationId,
      ),
    ]);
    await repo.tasks.update(childTaskId, {
      status: "completed",
      updatedAt: now(),
    });

    return {
      succeeded: true,
      additionalTokens: result.inputTokens + result.outputTokens,
      toolResultContent: result.text,
      toolUseId,
      childTaskId,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await repo.operations.update(operationId, {
      status: "failed",
      error: errorMessage,
      completedAt: now(),
    });

    const innerOps = await repo.operations.getForTask(childTaskId, runId);
    const partialResults: string[] = [];
    for (const op of innerOps) {
      if (op.id === operationId) continue;
      if (op.status === "succeeded" && op.output !== undefined) {
        partialResults.push(stringifyOutput(op.output));
      }
    }

    await Promise.all([
      partialResults.length > 0 ?
        createOutputArtifact(
          repo,
          `${spec.outputArtifactName}_partial`,
          partialResults.join("\n---\n"),
          operationId,
        )
      : undefined,
      repo.tasks.update(childTaskId, {
        status: "failed",
        updatedAt: now(),
      }),
    ]);

    if (isHarnessError(error)) throw error;

    const partialNote =
      partialResults.length > 0 ?
        ` (${partialResults.length} partial result(s) preserved)`
      : "";
    return {
      succeeded: false,
      additionalTokens: 0,
      toolResultContent: `${errorMessage}${partialNote}`,
      toolUseId,
      childTaskId,
    };
  }
}

async function createOutputArtifact(
  repo: Repository,
  name: string,
  content: string,
  operationId: string,
): Promise<void> {
  const artifact = await buildArtifact("text", name, content);
  await repo.artifacts.createAndLinkProduced(artifact, operationId);
}
