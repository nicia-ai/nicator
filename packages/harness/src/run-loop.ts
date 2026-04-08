import {
  buildArtifact,
  CONTEXT_BUDGET_RATIO,
  DEFAULT_MAX_TOKENS,
  DISPATCH_GATHER_TIMEOUT_MS,
  estimateTokens,
  generateId,
  HarnessError,
  HUMAN_APPROVAL_SKILL_NAME,
  JSON_MIME_TYPE,
  MAX_CONTEXT_TOKENS,
  now,
  RECENT_TURN_BUDGET_RATIO,
  type Repository,
  SPAWN_SUBAGENT_TOOL_NAME,
  SPAWN_SUBAGENT_WITH_SKILL_TOOL_NAME,
  stringifyOutput,
  type Task,
} from "@nicator/core";
import type { ParsedToolUse } from "@nicator/sdk";
import {
  complete,
  completeStream,
  type MessageParam,
  parseAllToolUses,
} from "@nicator/sdk";

import { parseApprovalToolInput, requestHumanApproval } from "./approval.js";
import { resolveAgentCapabilities } from "./capabilities.js";
import { buildContext, compressOlderTurns } from "./context-builder.js";
import {
  createOperation,
  recordConsumesEdges,
  spawnChildTask,
} from "./operations.js";
import {
  handleReadArtifact,
  READ_ARTIFACT_TOOL_NAME,
} from "./read-artifact.js";
import {
  handleSkillActivation,
  handleSubagentSpawn,
  willRequireHitl,
} from "./skill-dispatch.js";
import { materializeSkills } from "./skill-loader.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type {
  ConversationState,
  DispatchOptions,
  DispatchResult,
  HarnessConfig,
  InputDocument,
  ToolImplementation,
} from "./types.js";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAgent(
  runId: string,
  config: HarnessConfig,
): Promise<void> {
  const { repo, anthropic } = config;

  try {
    const run = await repo.runs.get(runId);
    if (!run) throw new HarnessError("Run not found", "run_not_found");

    const definition = await repo.agents.getDefinition(
      run.agentDefinitionId,
      run.agentDefinitionVersion,
    );
    if (!definition) {
      throw new HarnessError(
        "Agent definition not found",
        "definition_not_found",
      );
    }

    await repo.runs.update(runId, { status: "running", updatedAt: now() });

    const rootTaskId = generateId();
    const rootTask: Task = {
      id: rootTaskId,
      runId,
      role: "root",
      status: "running",
      input: run.input,
      sequenceNumber: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await repo.tasks.create(rootTask);

    // Materialize skills into the workspace filesystem
    if (config.workspace) {
      await materializeSkills(repo, config.workspace);
    }

    // Ingest input documents as artifacts linked to the run
    if (config.inputDocuments && config.inputDocuments.length > 0) {
      await ingestInputDocuments(repo, runId, config.inputDocuments);
    }

    const { sdkTools, toolImpls, skills } = await resolveAgentCapabilities(
      config,
      definition,
    );

    // Observed failure: model enters a loop calling a failing tool (e.g. malformed
    // input it never corrects), burning tokens with zero progress. Three consecutive
    // all-fail iterations is the empirical threshold before useful recovery is unlikely.
    const MAX_CONSECUTIVE_FAILURES = 3;

    let taskSequenceNumber = 1;
    let totalTokens = run.totalTokensUsed;
    let consecutiveFailures = 0;

    const conversation: ConversationState = {
      historyMessage: undefined,
      recentMessages: [],
      recentTokenEstimate: 0,
      injectedArtifactIds: [],
      toolUseIdToTaskId: new Map(),
    };

    const pendingTasks = new Map<string, Promise<DispatchResult>>();
    const settledTaskIds = new Set<string>();

    while (true) {
      // Drain completed background tasks (O(settled) not O(pending)).
      // settledTaskIds is the *signal* that a promise resolved; the actual
      // synchronization point is the `await promise` below, which blocks
      // until dispatchToolCall returns — including all repository writes.
      // This means the lineage query in the subsequent context rebuild
      // will see the completed task's data.
      let backgroundTasksCompleted = false;
      for (const id of settledTaskIds) {
        const promise = pendingTasks.get(id);
        if (promise) {
          const result = await promise;
          totalTokens += result.additionalTokens;
          pendingTasks.delete(id);
          backgroundTasksCompleted = true;
        }
      }
      settledTaskIds.clear();
      // When background tasks complete, force a full context rebuild so
      // the model sees their results via the lineage-based context builder.
      // The recent multi-turn messages are discarded — they referenced
      // "Task in progress" placeholders that are now stale.
      if (backgroundTasksCompleted) {
        conversation.historyMessage = undefined;
        conversation.recentMessages = [];
        conversation.recentTokenEstimate = 0;
        await repo.runs.update(runId, {
          totalTokensUsed: totalTokens,
          updatedAt: now(),
        });
      }

      const taskCount = await repo.tasks.getCount(runId);

      // Resource exhaustion guard: without these limits, a model that over-decomposes
      // (spawning dozens of sub-tasks for a simple query) or generates verbose tool
      // results can run up unbounded API costs before producing any output.
      if (taskCount >= definition.limits.maxTasksPerRun) {
        throw new HarnessError(
          `Max tasks per run exceeded (${definition.limits.maxTasksPerRun})`,
          "limit_exceeded",
        );
      }

      if (totalTokens >= definition.limits.maxTokensPerRun) {
        throw new HarnessError(
          `Max tokens per run exceeded (${definition.limits.maxTokensPerRun})`,
          "limit_exceeded",
        );
      }

      const systemPrompt = buildSystemPrompt({
        definition,
        tools: toolImpls,
        skills,
        env: config.env,
        budget: {
          tokensUsed: totalTokens,
          tokenLimit: definition.limits.maxTokensPerRun,
          tasksUsed: taskCount,
          taskLimit: definition.limits.maxTasksPerRun,
        },
      });

      // Bootstrap context on first iteration
      if (conversation.historyMessage === undefined) {
        const lineage = await repo.lineage.getRunLineage(runId);
        if (!lineage) {
          throw new HarnessError("Run lineage not found", "run_not_found");
        }
        const { messages: bootstrapMessages, injectedArtifactIds } =
          await buildContext(run, definition, lineage, config);
        conversation.historyMessage = bootstrapMessages[0];
        conversation.injectedArtifactIds = [...injectedArtifactIds];
      }

      // Observed failure: without compression, long multi-turn runs hit the API
      // context window limit mid-conversation, causing an unrecoverable 400 error.
      // Compress older turns if recent messages exceed budget.
      const recentTurnBudget =
        Math.min(
          definition.limits.maxTokensPerRun * CONTEXT_BUDGET_RATIO,
          MAX_CONTEXT_TOKENS,
        ) * RECENT_TURN_BUDGET_RATIO;
      if (conversation.recentTokenEstimate > recentTurnBudget) {
        const compressed = await compressOlderTurns(
          conversation,
          config,
          runId,
          definition,
        );
        conversation.historyMessage = compressed.historyMessage;
        conversation.recentMessages = compressed.recentMessages;
        conversation.recentTokenEstimate = compressed.recentTokenEstimate;
        conversation.injectedArtifactIds = [...compressed.injectedArtifactIds];
        conversation.toolUseIdToTaskId = compressed.toolUseIdToTaskId;
      }

      const messages: MessageParam[] = [
        conversation.historyMessage,
        ...conversation.recentMessages,
      ].filter((m): m is MessageParam => m !== undefined);

      const result =
        config.onTextDelta ?
          await completeStream(anthropic, {
            system: systemPrompt,
            messages,
            tools: sdkTools,
            maxTokens: DEFAULT_MAX_TOKENS,
            onTextDelta: config.onTextDelta,
          })
        : await complete(anthropic, {
            system: systemPrompt,
            messages,
            tools: sdkTools,
            maxTokens: DEFAULT_MAX_TOKENS,
          });

      totalTokens += result.inputTokens + result.outputTokens;
      await repo.runs.update(runId, {
        totalTokensUsed: totalTokens,
        updatedAt: now(),
      });

      const toolCalls = parseAllToolUses(result.response);

      if (toolCalls.length === 0) {
        if (pendingTasks.size > 0) {
          // Background tasks still running — wait for next completion, then re-prompt
          await Promise.race(pendingTasks.values());
          continue;
        }
        // Capture workspace files as file_reference artifacts before completion
        if (config.workspace) {
          const snapshots = await config.workspace.captureOutputs();
          if (snapshots.length > 0) {
            // Workspace capture gets its own child task + operation so the
            // graph has proper provenance for file_reference artifacts.
            const captureTaskId = await spawnChildTask(
              repo,
              runId,
              rootTaskId,
              "tool",
              { captured: snapshots.length },
              taskCount + 1,
              "workspace_capture",
            );

            const captureOpId = generateId();
            const timestamp = now();

            await repo.operations.create({
              id: captureOpId,
              taskId: captureTaskId,
              runId,
              type: "tool_call",
              status: "succeeded",
              operationNumber: 1,
              input: { captured: snapshots.length },
              output: { files: snapshots.length },
              inputTokens: 0,
              outputTokens: 0,
              createdAt: timestamp,
              completedAt: timestamp,
            });

            // Parallelize hashing; sequential create for version chaining.
            const artifacts = await Promise.all(
              snapshots.map((snap) =>
                buildArtifact(
                  "file_reference",
                  snap.path.split("/").pop() ?? snap.path,
                  snap.content,
                  snap.mimeType,
                ),
              ),
            );
            for (const artifact of artifacts) {
              await repo.artifacts.createAndLinkProduced(
                artifact,
                captureOpId,
                runId,
              );
            }

            await repo.tasks.update(captureTaskId, {
              status: "completed",
              updatedAt: now(),
            });
          }
        }

        await repo.tasks.update(rootTaskId, {
          status: "completed",
          updatedAt: now(),
        });
        await repo.runs.update(runId, {
          status: "completed",
          output: result.text,
          updatedAt: now(),
          completedAt: now(),
        });
        return;
      }

      // Observed failure: two concurrent HITL requests both set run.status to
      // awaiting_hitl, then the first approval sets it back to running while the
      // second is still pending — leaving the run in an inconsistent state.
      // HITL dispatches must be sequential (they change run status).
      // This includes direct human-approval calls AND skill activations with
      // require_hitl_approval policy — both trigger requestHumanApproval which
      // sets run status to awaiting_hitl.
      const hitlCalls: ParsedToolUse[] = [];
      const concurrentCalls: ParsedToolUse[] = [];
      for (const tc of toolCalls) {
        if (willRequireHitl(tc, definition)) {
          hitlCalls.push(tc);
        } else {
          concurrentCalls.push(tc);
        }
      }

      // Pre-allocate sequence numbers for concurrent dispatch
      const baseSeq = taskSequenceNumber;

      // Dispatch concurrent calls in parallel with gather timeout
      const concurrentPromises = concurrentCalls.map((tc, index) =>
        dispatchToolCall({
          runId,
          rootTaskId,
          definition,
          toolName: tc.toolName,
          toolInput: tc.toolInput,
          toolUseId: tc.toolUseId,
          taskSequenceNumber: baseSeq + index,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          injectedArtifactIds: conversation.injectedArtifactIds,
          config,
        }),
      );

      const gathered = await gatherWithTimeout(
        concurrentPromises,
        DISPATCH_GATHER_TIMEOUT_MS,
      );

      // Build a map from toolUseId → result for ordering.
      // Fatal errors (e.g. policy_denied) are re-thrown to abort the run.
      const resultsByToolUseId = new Map<
        string,
        { result: DispatchResult | undefined; pending: boolean }
      >();

      for (const [index, tc] of concurrentCalls.entries()) {
        const outcome = gathered[index];
        const bgPromise = concurrentPromises[index];
        if (!outcome || !bgPromise) continue;
        if (outcome.status === "completed") {
          resultsByToolUseId.set(tc.toolUseId, {
            result: outcome.value,
            pending: false,
          });
        } else if (outcome.status === "errored") {
          // Errors that escape dispatchToolCall are fatal — re-throw
          throw outcome.error;
        } else {
          // Still running — add to background tasks
          pendingTasks.set(tc.toolUseId, bgPromise);
          void bgPromise.then(
            () => settledTaskIds.add(tc.toolUseId),
            () => settledTaskIds.add(tc.toolUseId),
          );
          resultsByToolUseId.set(tc.toolUseId, {
            result: undefined,
            pending: true,
          });
        }
      }

      // Dispatch HITL calls sequentially
      const hitlSeqStart = baseSeq + concurrentCalls.length;
      for (const [index, hitlCall] of hitlCalls.entries()) {
        const tc = hitlCall;
        const hitlResult = await dispatchToolCall({
          runId,
          rootTaskId,
          definition,
          toolName: tc.toolName,
          toolInput: tc.toolInput,
          toolUseId: tc.toolUseId,
          taskSequenceNumber: hitlSeqStart + index,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          injectedArtifactIds: conversation.injectedArtifactIds,
          config,
        });
        resultsByToolUseId.set(tc.toolUseId, {
          result: hitlResult,
          pending: false,
        });
      }

      // Advance sequence counter past all dispatched work
      taskSequenceNumber = baseSeq + concurrentCalls.length + hitlCalls.length;

      // Assemble tool_result blocks in original tool call order
      type ToolResultBlock = {
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      };
      const toolResultBlocks: ToolResultBlock[] = [];
      let batchFailures = 0;
      let batchSuccesses = 0;

      const tokensBeforeDispatch = totalTokens;
      for (const tc of toolCalls) {
        const entry = resultsByToolUseId.get(tc.toolUseId);
        if (!entry) continue;
        if (entry.pending) {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: tc.toolUseId,
            content: `Task in progress. Results will appear in context when complete.`,
          });
        } else if (entry.result) {
          const dr = entry.result;
          conversation.toolUseIdToTaskId.set(dr.toolUseId, dr.childTaskId);
          totalTokens += dr.additionalTokens;
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: dr.toolUseId,
            content: dr.toolResultContent,
            ...(dr.succeeded ? {} : { is_error: true }),
          });
          if (dr.succeeded) {
            batchSuccesses++;
          } else {
            batchFailures++;
          }
        }
      }

      // Circuit breaker: count at iteration level. Resets on any success so
      // partial-failure iterations (some tools succeed, some fail) don't accumulate.
      if (batchSuccesses > 0 || toolResultBlocks.length === 0) {
        consecutiveFailures = 0;
      } else if (batchFailures > 0 && batchSuccesses === 0) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          throw new HarnessError(
            `${MAX_CONSECUTIVE_FAILURES} consecutive iteration failures — aborting run`,
            "circuit_breaker",
          );
        }
      }

      // Append assistant turn + tool_result user message
      conversation.recentMessages.push(
        { role: "assistant", content: result.response.content },
        { role: "user", content: toolResultBlocks },
      );

      // Update token estimate for the new messages.
      // Use actual outputTokens for the assistant turn (exact from API)
      // and content-aware heuristic for tool_result content.
      const toolResultText = toolResultBlocks.map((b) => b.content).join("");
      conversation.recentTokenEstimate +=
        result.outputTokens + estimateTokens(toolResultText);

      if (totalTokens > tokensBeforeDispatch) {
        await repo.runs.update(runId, {
          totalTokensUsed: totalTokens,
          updatedAt: now(),
        });
      }
    }
  } catch (error: unknown) {
    const message =
      error instanceof HarnessError ? error.message
      : error instanceof Error ? error.message
      : String(error);

    await repo.runs.update(runId, {
      status: "failed",
      error: message,
      updatedAt: now(),
      completedAt: now(),
    });

    if (error instanceof HarnessError) throw error;
    throw new HarnessError(message, "skill_execution_failed", error);
  }
}

// ---------------------------------------------------------------------------
// Tool call dispatch
// ---------------------------------------------------------------------------

async function dispatchToolCall(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const { toolName, config } = options;

  if (toolName === HUMAN_APPROVAL_SKILL_NAME) {
    return handleHumanApproval(options);
  }

  if (toolName === READ_ARTIFACT_TOOL_NAME) {
    return handleReadArtifact(options);
  }

  if (toolName === SPAWN_SUBAGENT_WITH_SKILL_TOOL_NAME) {
    return handleSkillActivation(options);
  }

  if (toolName === SPAWN_SUBAGENT_TOOL_NAME) {
    return handleSubagentSpawn(options);
  }

  const toolImpl = config.toolRegistry.resolve(toolName);
  if (toolImpl) {
    return handleDirectToolCall(options, toolImpl);
  }

  throw new HarnessError(
    `Unknown tool "${toolName}" — not a registered tool, skill, or system tool`,
    "invalid_tool_call",
  );
}

// ---------------------------------------------------------------------------
// Direct tool call handler
// ---------------------------------------------------------------------------

async function handleDirectToolCall(
  options: DispatchOptions,
  toolImpl: ToolImplementation,
): Promise<DispatchResult> {
  const {
    runId,
    rootTaskId,
    toolName,
    toolInput,
    toolUseId,
    taskSequenceNumber,
    inputTokens,
    outputTokens,
    injectedArtifactIds,
    config,
  } = options;
  const { repo } = config;

  const childTaskId = await spawnChildTask(
    repo,
    runId,
    rootTaskId,
    "tool",
    toolInput,
    taskSequenceNumber,
    toolName,
  );
  await recordConsumesEdges(repo, childTaskId, injectedArtifactIds);

  const { succeeded, result, error } = await createOperation({
    repo,
    runId,
    taskId: childTaskId,
    toolInput,
    operationNumber: 1,
    maxOperations: options.definition.limits.maxOperationsPerTask,
    inputTokens,
    outputTokens,
    type: "tool_call",
    execute: () => toolImpl.execute(toolInput),
    artifactType: "json",
    artifactName: `${toolName}_result`,
    artifactMimeType: JSON_MIME_TYPE,
  });

  await repo.tasks.update(childTaskId, {
    status: succeeded ? "completed" : "failed",
    updatedAt: now(),
  });

  return {
    succeeded,
    additionalTokens: 0,
    toolResultContent:
      succeeded ? stringifyOutput(result) : (error ?? "Tool execution failed"),
    toolUseId,
    childTaskId,
  };
}

// ---------------------------------------------------------------------------
// Human-approval handler
// ---------------------------------------------------------------------------

async function handleHumanApproval(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const {
    runId,
    rootTaskId,
    toolInput,
    toolUseId,
    taskSequenceNumber,
    injectedArtifactIds,
    inputTokens,
    outputTokens,
    config,
  } = options;

  const { fullPrompt } = parseApprovalToolInput(toolInput);

  const match = await config.repo.tasks.findHitlDecision(runId, fullPrompt);
  if (match) {
    const approved = match.taskStatus === "completed";
    const childTaskId = await spawnChildTask(
      config.repo,
      runId,
      rootTaskId,
      "hitl",
      toolInput,
      taskSequenceNumber,
    );
    await recordConsumesEdges(config.repo, childTaskId, [
      ...injectedArtifactIds,
      match.artifactId,
    ]);
    await config.repo.tasks.update(childTaskId, {
      status: approved ? "completed" : "failed",
      updatedAt: now(),
    });
    return {
      succeeded: approved,
      additionalTokens: 0,
      toolResultContent: match.artifactContent,
      toolUseId,
      childTaskId,
    };
  }

  const childTaskId = await spawnChildTask(
    config.repo,
    runId,
    rootTaskId,
    "hitl",
    toolInput,
    taskSequenceNumber,
  );
  await recordConsumesEdges(config.repo, childTaskId, injectedArtifactIds);

  const { approved, decision } = await requestHumanApproval({
    repo: config.repo,
    runId,
    taskId: childTaskId,
    hitlContext: { taskId: childTaskId, runId },
    prompt: fullPrompt,
    operationNumber: 1,
    maxOperations: options.definition.limits.maxOperationsPerTask,
    inputTokens,
    outputTokens,
    artifactName: "hitl_decision",
    hitlHandler: config.hitlHandler,
  });

  await config.repo.tasks.update(childTaskId, {
    status: approved ? "completed" : "failed",
    updatedAt: now(),
  });

  return {
    succeeded: approved,
    additionalTokens: 0,
    toolResultContent: decision,
    toolUseId,
    childTaskId,
  };
}

// ---------------------------------------------------------------------------
// Concurrency utilities
// ---------------------------------------------------------------------------

type GatherOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "errored"; error: unknown }
  | { status: "pending" };

/**
 * Observed failure: a slow external tool (e.g. web search timing out at the
 * upstream service) blocks the entire batch indefinitely, stalling the run
 * loop. The timeout lets fast tools resolve and re-prompt the model while
 * slow ones continue in the background.
 */
async function gatherWithTimeout<T>(
  promises: ReadonlyArray<Promise<T>>,
  timeoutMs: number,
): Promise<GatherOutcome<T>[]> {
  if (promises.length === 0) return [];

  const results: GatherOutcome<T>[] = Array.from({ length: promises.length });
  const settled = new Set<number>();

  const trackers = promises.map(async (p, index) => {
    try {
      const value = await p;
      results[index] = { status: "completed", value };
    } catch (error: unknown) {
      results[index] = { status: "errored", error };
    }
    settled.add(index);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  await Promise.race([Promise.allSettled(trackers), timeoutPromise]);
  if (timer !== undefined) clearTimeout(timer);

  for (let index = 0; index < promises.length; index++) {
    if (!settled.has(index)) {
      results[index] = { status: "pending" };
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Input document ingestion — creates input_document artifacts linked to the run
// ---------------------------------------------------------------------------

async function ingestInputDocuments(
  repo: Repository,
  runId: string,
  documents: ReadonlyArray<InputDocument>,
): Promise<void> {
  await Promise.all(
    documents.map(async (document) => {
      const artifact = await buildArtifact(
        "input_document",
        document.id,
        document.content,
      );
      await repo.artifacts.create(artifact);
      await repo.artifacts.linkInputToRun(runId, artifact.id);
    }),
  );
}
