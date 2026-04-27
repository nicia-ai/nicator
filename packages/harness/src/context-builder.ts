import type { RunLineage } from "@nicator/core";
import {
  type AgentDefinition,
  type Artifact,
  type ArtifactType,
  COMPRESSION_MAX_TOKENS,
  CONTEXT_BUDGET_RATIO,
  type ContextWeights,
  DEFAULT_CONTEXT_WEIGHTS,
  estimateTokens,
  generateId,
  MAX_CONTEXT_TOKENS,
  now,
  type Operation,
  type Run,
  stringifyOutput,
  type Task,
  taskHasOperationType,
  taskLabel,
} from "@nicator/core";
import type { MessageParam } from "@nicator/sdk";
import { complete, countTokens } from "@nicator/sdk";

import type { ConversationState, HarnessConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScoredTask = Readonly<{
  task: Task;
  score: number;
  succeededOperation: Operation | undefined;
  serializedOutput: string | undefined;
  estimatedTokens: number;
  artifacts: ReadonlyArray<Artifact>;
  consumedByTaskIds: ReadonlyArray<string>;
  skillDescription: string | undefined;
  operationCount: number;
  isHitl: boolean;
}>;

export type Tier = "full" | "summary" | "metadata";

export type TieredTask = ScoredTask & Readonly<{ tier: Tier }>;

export type BuiltContext = Readonly<{
  messages: ReadonlyArray<MessageParam>;
  /** Artifact IDs whose metadata is surfaced in context (full + summary tiers).
   *  These are the artifacts the agent can read via read_artifact. */
  injectedArtifactIds: ReadonlyArray<string>;
}>;

// ---------------------------------------------------------------------------
// Score weights
//
// Each completed task is scored 0–1 across five dimensions, then combined
// via a weighted sum. The weights control which tasks survive context
// trimming when the window fills up.
//
//   downstream (0.35) — Tasks whose artifacts are consumed by later tasks
//       are structurally load-bearing; dropping them risks incoherent
//       context. Highest weight because this is the only signal derived
//       from the graph structure rather than metadata.
//
//   recency (0.30) — The model needs recent context to maintain coherence.
//       Second-highest because staleness is the most common cause of
//       the model repeating work or contradicting prior results.
//
//   artifactType (0.15) — HITL decisions and structured JSON are denser
//       information per token than free text or file references.
//       Tie-breaker weight; distinguishes tasks with equal recency/downstream.
//
//   retry (0.10) — Tasks that required multiple attempts indicate difficulty;
//       the model benefits from seeing what finally succeeded. Low weight
//       because most tasks succeed on the first attempt.
//
//   skillType (0.10) — HITL and researcher tasks carry externally-sourced
//       information the model cannot reconstruct. Low weight because the
//       other signals usually correlate (HITL tasks also score high on
//       artifactType and downstream).
//
// Validation status: empirically validated via `pnpm eval:sweep-weights`.
// Defaults is the only config that succeeds on both ctx-003 (asymmetric
// dependency chain, 60K budget) and ctx-004 (flat deps, 50K budget).
// Three configs fail on ctx-004's tight budget: recency-heavy (55K/50K
// token limit), no-downstream (52K/50K), and recency-only (artifact
// error). downstream-heavy is the most token-efficient single dimension
// (30-31K), confirming the graph structure signal's value. See
// evals/results/sweep-weights-*.md for full comparison tables.
//
// Defaults are defined in ContextWeightsSchema (packages/core/src/schema.ts)
// and can be overridden per AgentDefinition via limits.contextWeights.
// ---------------------------------------------------------------------------

const RETRY_CAP = 3;

// Artifact type scores — file_reference is ranked above text because
// workspace files are explicitly promoted via save_artifact, indicating
// the agent considered them important output.
const ARTIFACT_SCORES: Readonly<Record<ArtifactType, number>> = {
  hitl_decision: 1,
  input_document: 0.9,
  json: 0.8,
  file_reference: 0.6,
  text: 0.5,
  skill_prompt: 0,
  skill_asset: 0,
};

// Skill type scores
const SKILL_SCORE_HITL = 1;
const SKILL_SCORE_SKILL_ACTIVATION = 0.7;
const SKILL_SCORE_DEFAULT = 0.5;

// ---------------------------------------------------------------------------
// Tier budget ratios (of total token budget)
// ---------------------------------------------------------------------------

const FULL_BUDGET_RATIO = 0.6;
const SUMMARY_BUDGET_RATIO = 0.85;

const FULL_TIER_THRESHOLD = 0.7;
const SUMMARY_TIER_THRESHOLD = 0.3;

const COMPRESSION_INPUT_TRUNCATE_CHARS = 1000;
const ARTIFACT_PREVIEW_CHARS = 120;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreTasks(
  lineage: RunLineage,
  weights: ContextWeights,
): ScoredTask[] {
  // Build artifact → producer task mapping
  const artifactToProducer = new Map<string, string>();
  for (const entry of lineage.tasks) {
    for (const opEntry of entry.operations) {
      for (const artifact of opEntry.artifacts) {
        artifactToProducer.set(artifact.id, entry.task.id);
      }
    }
  }

  // Build reverse consumption map: producerTaskId → Set<consumingTaskId>
  const consumedByMap = new Map<string, Set<string>>();
  for (const entry of lineage.tasks) {
    for (const artId of entry.consumedArtifactIds) {
      const producerId = artifactToProducer.get(artId);
      if (producerId === undefined) continue;
      let consumers = consumedByMap.get(producerId);
      if (!consumers) {
        consumers = new Set<string>();
        consumedByMap.set(producerId, consumers);
      }
      consumers.add(entry.task.id);
    }
  }

  // Filter scorable tasks: completed child tasks only. The root task is a
  // pure coordinator with no operations or artifacts — scoring it produces
  // a near-zero score that always lands in metadata tier as dead weight.
  const scorableEntries = lineage.tasks.filter(
    (entry) => entry.task.status === "completed" && entry.task.role !== "root",
  );

  const maxSequence = scorableEntries.reduce(
    (max, entry) => Math.max(max, entry.task.sequenceNumber),
    0,
  );

  const scored: ScoredTask[] = [];

  for (const entry of scorableEntries) {
    const { task } = entry;
    const succeededEntry = entry.operations.find(
      (a) => a.operation.status === "succeeded",
    );
    const succeededOperation =
      succeededEntry?.operation.status === "succeeded" ?
        succeededEntry.operation
      : undefined;
    const artifacts = succeededEntry?.artifacts ?? [];

    const consumers = consumedByMap.get(task.id);
    const consumedByTaskIds = consumers ? [...consumers] : [];
    const consumedByCount = consumedByTaskIds.length;

    // Recency
    const recency = maxSequence > 0 ? task.sequenceNumber / maxSequence : 1;

    // Downstream consumption — how much later work depends on this task's output
    const laterTaskCount = scorableEntries.filter(
      (other) => other.task.sequenceNumber > task.sequenceNumber,
    ).length;

    let downstream: number;
    // eslint-disable-next-line unicorn/prefer-ternary -- comment documents the branch
    if (laterTaskCount === 0) {
      // Frontier task — most important
      downstream = 1;
    } else {
      // Score based on actual consumption, not mere sequencing.
      // First term: binary — does anything consume this task's output?
      // Second term: what fraction of later tasks consume it?
      downstream =
        Math.min(consumedByCount, 1) * 0.5 +
        (consumedByCount / laterTaskCount) * 0.5;
    }

    // Artifact type
    const artifactType =
      artifacts.length > 0 ?
        Math.max(...artifacts.map((a) => ARTIFACT_SCORES[a.type]))
      : 0;

    // Retry signal
    const operationCount = entry.operations.length;
    const retry = Math.min(operationCount / RETRY_CAP, 1);

    const hasHitlOp = taskHasOperationType(entry, "hitl_response");

    const skillType =
      hasHitlOp ? SKILL_SCORE_HITL
      : entry.skill?.description ? SKILL_SCORE_SKILL_ACTIVATION
      : SKILL_SCORE_DEFAULT;

    const score =
      recency * weights.recency +
      downstream * weights.downstream +
      artifactType * weights.artifactType +
      retry * weights.retry +
      skillType * weights.skillType;

    const serializedOutput =
      succeededOperation?.output === undefined ?
        undefined
      : stringifyOutput(succeededOperation.output);

    scored.push({
      task,
      score,
      succeededOperation,
      serializedOutput,
      estimatedTokens: serializedOutput ? estimateTokens(serializedOutput) : 0,
      artifacts,
      consumedByTaskIds,
      skillDescription: entry.skill?.description ?? undefined,
      operationCount,
      isHitl: hasHitlOp,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Task IDs whose conversation messages should be protected from compression. */
function getProtectedTaskIds(
  lineage: RunLineage,
  weights: ContextWeights,
): Set<string> {
  const scored = scoreTasks(lineage, weights);
  const ids = new Set<string>();
  for (const entry of scored) {
    if (entry.isHitl || entry.score >= FULL_TIER_THRESHOLD) {
      ids.add(entry.task.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tier assignment
// ---------------------------------------------------------------------------

export function assignTiers(
  scored: ScoredTask[],
  tokenBudget: number,
): TieredTask[] {
  const fullBudget = tokenBudget * FULL_BUDGET_RATIO;
  let fullTokensUsed = 0;

  const tiered: TieredTask[] = [];
  const deferred: ScoredTask[] = [];

  // HITL decisions always get full tier
  for (const entry of scored) {
    if (entry.isHitl) {
      fullTokensUsed += entry.estimatedTokens;
      tiered.push({ ...entry, tier: "full" });
    } else {
      deferred.push(entry);
    }
  }

  // Walk remaining in score order
  for (const entry of deferred) {
    if (
      entry.score >= FULL_TIER_THRESHOLD &&
      fullTokensUsed + entry.estimatedTokens <= fullBudget
    ) {
      tiered.push({ ...entry, tier: "full" });
      fullTokensUsed += entry.estimatedTokens;
    } else if (entry.score >= SUMMARY_TIER_THRESHOLD) {
      tiered.push({ ...entry, tier: "summary" });
    } else {
      tiered.push({ ...entry, tier: "metadata" });
    }
  }

  // Demote lowest-scoring full entries if budget exceeded
  if (fullTokensUsed > fullBudget) {
    const fullEntries = tiered
      .filter((t) => t.tier === "full" && !t.isHitl)
      .toSorted((a, b) => a.score - b.score);

    for (const entry of fullEntries) {
      if (fullTokensUsed <= fullBudget) break;
      const index = tiered.indexOf(entry);
      if (index !== -1) {
        tiered[index] = { ...entry, tier: "summary" };
        fullTokensUsed -= entry.estimatedTokens;
      }
    }
  }

  return tiered;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderArtifactMetadata(
  artifacts: ReadonlyArray<Artifact>,
  includePreview: boolean,
): string {
  if (artifacts.length === 0) return "";
  const lines = artifacts.map((a) => {
    const base = `  - artifact_id: ${a.id} | ${a.name} (${a.type})`;
    if (!includePreview) return base;
    const preview =
      a.content.length > ARTIFACT_PREVIEW_CHARS ?
        a.content.slice(0, ARTIFACT_PREVIEW_CHARS) + "..."
      : a.content;
    // Collapse newlines in preview for compact display
    return `${base}\n    Preview: "${preview.replaceAll("\n", " ")}"`;
  });
  return `Artifacts (call read_artifact to view full content):\n${lines.join("\n")}`;
}

function renderContext(
  run: Run,
  tiered: TieredTask[],
  compressedSummary: string | undefined,
): { contextText: string; injectedArtifactIds: string[] } {
  const injectedArtifactIds: string[] = [];

  for (const entry of tiered) {
    if (entry.tier === "metadata") continue;
    for (const artifact of entry.artifacts) {
      injectedArtifactIds.push(artifact.id);
    }
  }

  const bySequence = (a: TieredTask, b: TieredTask) =>
    a.task.sequenceNumber - b.task.sequenceNumber;

  const fullTasks = tiered
    .filter((t) => t.tier === "full")
    .toSorted(bySequence);
  const summaryTasks = tiered
    .filter((t) => t.tier === "summary")
    .toSorted(bySequence);
  const metadataTasks = tiered
    .filter((t) => t.tier === "metadata")
    .toSorted(bySequence);

  const detailCount = fullTasks.length + summaryTasks.length;
  const totalCount = tiered.length;

  const parts: string[] = [
    `User request: ${run.input}`,
    "",
    `## Completed Tasks (${totalCount} total, ${detailCount} in detail)`,
    "",
  ];

  for (const entry of fullTasks) {
    parts.push(
      `### Task #${entry.task.sequenceNumber}: ${taskLabel(entry.task)}`,
    );
    if (entry.isHitl && entry.serializedOutput !== undefined) {
      // HITL decisions are small and always decision-critical — inline them.
      parts.push(entry.serializedOutput);
    } else if (entry.artifacts.length > 0) {
      parts.push(renderArtifactMetadata(entry.artifacts, true));
    }
    parts.push("");
  }

  if (compressedSummary === undefined) {
    for (const entry of summaryTasks) {
      parts.push(
        `### Task #${entry.task.sequenceNumber}: ${taskLabel(entry.task)} (summary)`,
      );
      if (entry.artifacts.length > 0) {
        parts.push(renderArtifactMetadata(entry.artifacts, false));
      }
      parts.push("");
    }
  } else {
    parts.push(compressedSummary, "");
  }

  if (metadataTasks.length > 0) {
    parts.push("### Other tasks:");
    for (const entry of metadataTasks) {
      parts.push(
        `- Task #${entry.task.sequenceNumber}: ${taskLabel(entry.task)} — ${entry.artifacts.length} artifact(s)`,
      );
    }
    parts.push("");
  }

  return { contextText: parts.join("\n"), injectedArtifactIds };
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

async function compressSummaryTier(
  tasks: ReadonlyArray<TieredTask>,
  config: HarnessConfig,
  runId: string,
): Promise<string> {
  const inputParts: string[] = [
    "Summarize the following agent task outputs. Preserve factual conclusions,",
    "artifact references, decision outcomes, and error conditions. Be concise.",
    "",
  ];

  for (const entry of tasks) {
    const desc = entry.skillDescription ? ` — ${entry.skillDescription}` : "";
    const artList =
      entry.artifacts.length > 0 ?
        entry.artifacts.map((a) => `${a.name} (${a.type})`).join(", ")
      : "none";
    inputParts.push(
      "---",
      `Task: ${taskLabel(entry.task)}${desc}`,
      `Artifacts: ${artList}`,
      "Output:",
    );
    if (entry.serializedOutput !== undefined) {
      inputParts.push(
        entry.serializedOutput.slice(0, COMPRESSION_INPUT_TRUNCATE_CHARS),
      );
    }
    inputParts.push("---");
  }

  const textToCompress = inputParts.join("\n");

  const result = await complete(config.anthropic, {
    system:
      "You are a context compression assistant. Summarize task outputs preserving " +
      "key facts, numbers, conclusions, and artifact references. Do not add interpretation.",
    messages: [{ role: "user", content: textToCompress }],
    maxTokens: COMPRESSION_MAX_TOKENS,
  });

  const outputArtifactIds = [
    ...new Set(
      tasks.flatMap((entry) => entry.artifacts.map((artifact) => artifact.id)),
    ),
  ];
  const preservedOutputArtifactRegistry =
    renderExactOutputArtifactRegistry(outputArtifactIds);
  const summary =
    preservedOutputArtifactRegistry ?
      `${result.text}\n\n${preservedOutputArtifactRegistry}`
    : result.text;

  await config.repo.compactions.create({
    id: generateId(),
    runId,
    input: textToCompress,
    summary,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    createdAt: now(),
  });

  config.onCompression?.(runId, summary);

  return `[Compressed summary of ${tasks.length} tasks]\n${summary}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function buildContext(
  run: Run,
  definition: AgentDefinition,
  lineage: RunLineage,
  config: HarnessConfig,
): Promise<BuiltContext> {
  const tokenBudget = Math.min(
    definition.limits.maxTokensPerRun * CONTEXT_BUDGET_RATIO,
    MAX_CONTEXT_TOKENS,
  );

  const weights: ContextWeights =
    definition.limits.contextWeights ?? DEFAULT_CONTEXT_WEIGHTS;
  const scored = scoreTasks(lineage, weights);
  if (scored.length === 0) {
    return {
      messages: [{ role: "user", content: `User request: ${run.input}` }],
      injectedArtifactIds: [],
    };
  }

  const tiered = assignTiers(scored, tokenBudget);

  // Check if summary tier needs compression
  const summaryTasks = tiered.filter((t) => t.tier === "summary");
  let compressedSummary: string | undefined;

  if (summaryTasks.length > 0) {
    const summaryBudgetTokens =
      tokenBudget * (SUMMARY_BUDGET_RATIO - FULL_BUDGET_RATIO);
    const summaryTokens = summaryTasks.reduce(
      (sum, t) => sum + t.estimatedTokens,
      0,
    );

    if (summaryTokens > summaryBudgetTokens) {
      compressedSummary = await compressSummaryTier(
        summaryTasks,
        config,
        run.id,
      );
    }
  }

  let { contextText, injectedArtifactIds } = renderContext(
    run,
    tiered,
    compressedSummary,
  );

  const messages: MessageParam[] = [{ role: "user", content: contextText }];

  // Only call the token-counting API when the heuristic estimate suggests
  // we're close to the budget. Below 80% is safe enough to skip the call.
  const estimatedTotal = tiered.reduce((sum, t) => sum + t.estimatedTokens, 0);

  if (estimatedTotal > tokenBudget * 0.8) {
    const actualTokens = await countTokens(config.anthropic, { messages });

    if (actualTokens > tokenBudget) {
      const demotable = tiered
        .filter((t) => t.tier === "full" && !t.isHitl)
        .toSorted((a, b) => a.score - b.score);

      // Use heuristic estimates to track savings — re-counting via API
      // per demotion would be too expensive.
      let excess = actualTokens - tokenBudget;
      for (const entry of demotable) {
        if (excess <= 0) break;
        const index = tiered.indexOf(entry);
        if (index !== -1) {
          tiered[index] = { ...entry, tier: "summary" };
          excess -= entry.estimatedTokens;
        }
      }

      const rerendered = renderContext(run, tiered, compressedSummary);
      contextText = rerendered.contextText;
      injectedArtifactIds = rerendered.injectedArtifactIds;
      messages[0] = { role: "user", content: contextText };
    }
  }

  return { messages, injectedArtifactIds };
}

// ---------------------------------------------------------------------------
// Conversation turn compression
// ---------------------------------------------------------------------------

function extractTextFromMessages(
  messages: ReadonlyArray<MessageParam>,
): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if ("text" in block && typeof block.text === "string") {
          parts.push(block.text);
        } else if ("content" in block && typeof block.content === "string") {
          parts.push(block.content);
        }
      }
    }
  }
  return parts.join("\n");
}

const OUTPUT_ARTIFACT_ID_RE =
  /output_artifact_id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

function collectOutputArtifactIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(OUTPUT_ARTIFACT_ID_RE)) {
    const id = match[1];
    if (id) ids.push(id);
  }
  return ids;
}

function renderExactOutputArtifactRegistry(
  ids: ReadonlyArray<string>,
): string | undefined {
  if (ids.length === 0) return undefined;
  return [
    "[Preserved exact output_artifact_ids from compressed turns]",
    ...ids.map((id) => `- output_artifact_id: ${id}`),
  ].join("\n");
}

export async function compressOlderTurns(
  state: ConversationState,
  config: HarnessConfig,
  runId: string,
  definition: AgentDefinition,
): Promise<ConversationState> {
  const { recentMessages, toolUseIdToTaskId } = state;

  const pairCount = Math.floor(recentMessages.length / 2);
  const midpoint = Math.max(1, Math.floor(pairCount / 2));

  // Determine which tasks are important enough to protect from compression.
  const lineage = await config.repo.lineage.getRunLineage(runId);
  const weights: ContextWeights =
    definition.limits.contextWeights ?? DEFAULT_CONTEXT_WEIGHTS;
  const protectedTaskIds =
    lineage ? getProtectedTaskIds(lineage, weights) : new Set<string>();

  // Identify message pairs in the older half that contain protected task results.
  const protectedPairIndices = new Set<number>();
  for (let pair = 0; pair < midpoint; pair++) {
    const userMessage = recentMessages[pair * 2 + 1];
    if (!userMessage || !Array.isArray(userMessage.content)) continue;
    for (const block of userMessage.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "tool_use_id" in block &&
        typeof block.tool_use_id === "string"
      ) {
        const taskId = toolUseIdToTaskId.get(block.tool_use_id);
        if (taskId !== undefined && protectedTaskIds.has(taskId)) {
          protectedPairIndices.add(pair);
          break;
        }
      }
    }
  }

  // Partition: older unprotected pairs get compressed, protected pairs move to newer.
  const olderMessages: MessageParam[] = [];
  const newerMessages: MessageParam[] = [];

  for (let pair = 0; pair < pairCount; pair++) {
    const messageA = recentMessages[pair * 2];
    const messageB = recentMessages[pair * 2 + 1];
    if (messageA === undefined || messageB === undefined) continue;

    if (pair < midpoint && !protectedPairIndices.has(pair)) {
      olderMessages.push(messageA, messageB);
    } else {
      newerMessages.push(messageA, messageB);
    }
  }

  // Fallback: if all older pairs were protected, revert to midpoint split
  // to prevent the compressor from becoming a no-op (which would cause the
  // run loop to re-trigger compression endlessly).
  if (olderMessages.length === 0) {
    const splitIndex = midpoint * 2;
    olderMessages.push(...recentMessages.slice(0, splitIndex));
    newerMessages.length = 0;
    newerMessages.push(...recentMessages.slice(splitIndex));
  }

  const textToCompress = extractTextFromMessages(olderMessages);
  const newerText = extractTextFromMessages(newerMessages);
  if (textToCompress.length === 0) {
    return state;
  }

  const compressPairCount = Math.floor(olderMessages.length / 2);

  const result = await complete(config.anthropic, {
    system:
      "You are a context compression assistant. Summarize the following conversation turns " +
      "preserving key facts, tool results, decisions, and conclusions. Do not add interpretation.",
    messages: [{ role: "user", content: textToCompress }],
    maxTokens: COMPRESSION_MAX_TOKENS,
  });

  const summary = result.text;

  const existingHistory =
    state.historyMessage && typeof state.historyMessage.content === "string" ?
      state.historyMessage.content
    : "";
  const preservedOutputArtifactIds = [
    ...new Set([
      ...collectOutputArtifactIds(existingHistory),
      ...collectOutputArtifactIds(textToCompress),
    ]),
  ];
  const preservedOutputArtifactRegistry = renderExactOutputArtifactRegistry(
    preservedOutputArtifactIds,
  );
  const summaryWithRegistry =
    preservedOutputArtifactRegistry ?
      `${summary}\n\n${preservedOutputArtifactRegistry}`
    : summary;

  await config.repo.compactions.create({
    id: generateId(),
    runId,
    input: textToCompress,
    summary: summaryWithRegistry,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    createdAt: now(),
  });

  config.onCompression?.(runId, summaryWithRegistry);

  // Merge compressed content into history message
  const updatedHistory =
    existingHistory ?
      [
        existingHistory,
        "",
        `[Compressed from ${compressPairCount} earlier turns]`,
        summaryWithRegistry,
      ].join("\n")
    : [
        `[Compressed from ${compressPairCount} earlier turns]`,
        summaryWithRegistry,
      ].join("\n");

  const newerTokenEstimate = estimateTokens(newerText);

  // Clean up map entries for compressed-away messages
  const updatedMap = new Map(toolUseIdToTaskId);
  for (const message of olderMessages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          typeof block === "object" &&
          block !== null &&
          "tool_use_id" in block &&
          typeof block.tool_use_id === "string"
        ) {
          updatedMap.delete(block.tool_use_id);
        }
      }
    }
  }

  return {
    historyMessage: { role: "user", content: updatedHistory },
    recentMessages: [...newerMessages],
    recentTokenEstimate: newerTokenEstimate,
    injectedArtifactIds: state.injectedArtifactIds,
    toolUseIdToTaskId: updatedMap,
  };
}
