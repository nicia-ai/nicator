import type { AgentDefinition, Skill } from "@nicator/core";
import { HARNESS_MODEL, HUMAN_APPROVAL_SKILL_NAME } from "@nicator/core";
import { BASH_TOOL_NAME } from "@nicator/workspace";

import type { RuntimeContext, ToolImplementation } from "./types.js";

export type RunBudget = Readonly<{
  tokensUsed: number;
  tokenLimit: number;
  tasksUsed: number;
  taskLimit: number;
}>;

// ---------------------------------------------------------------------------
// System prompt builder
//
// Precedence: the harness wrapper takes precedence over agent-authored
// instructions. The definition author controls *what* the agent does;
// the harness controls *how* it operates — tool dispatch, HITL protocol,
// output format, and resource limits.
// ---------------------------------------------------------------------------

export function buildSystemPrompt(options: {
  definition: AgentDefinition;
  tools: ReadonlyArray<ToolImplementation>;
  skills: ReadonlyArray<Skill>;
  env: RuntimeContext;
  budget: RunBudget;
}): string {
  const { definition, tools, skills, env, budget } = options;
  const hasBash = tools.some((t) => t.tool.name === BASH_TOOL_NAME);

  const sections: string[] = [
    identity(definition),
    environment(env),
    agentInstructions(definition),
    toolCatalog(tools),
    hasBash ? workspaceGuidance() : "",
    agentGuidance(definition),
    skillCatalog(skills),
    artifactAccess(),
    hitlProtocol(),
    operationalConstraints(definition, budget),
    outputGuidance(),
  ];

  return sections.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function identity(definition: AgentDefinition): string {
  return [
    `<identity>`,
    `You are "${definition.name}", an autonomous agent running in the Nicia agent harness.`,
    definition.description,
    ``,
    `Model: ${HARNESS_MODEL}`,
    `</identity>`,
  ].join("\n");
}

function environment(env: RuntimeContext): string {
  const lines = [`<environment>`, `Date: ${env.date}`];
  if (env.platform) lines.push(`Platform: ${env.platform}`);
  if (env.runtime) lines.push(`Runtime: ${env.runtime}`);
  lines.push(`</environment>`);
  return lines.join("\n");
}

function agentInstructions(definition: AgentDefinition): string {
  if (!definition.systemPrompt.trim()) return "";
  return [
    `<instructions>`,
    `The following instructions were provided by the agent definition author.`,
    `They describe your goals, domain, and working style. Follow them unless`,
    `they contradict the harness operational sections below (tools, skills,`,
    `hitl, constraints, output).`,
    ``,
    definition.systemPrompt.trim(),
    `</instructions>`,
  ].join("\n");
}

function toolCatalog(tools: ReadonlyArray<ToolImplementation>): string {
  if (tools.length === 0) return "";

  const entries = tools.map(
    (t) => `- **${t.tool.name}**: ${t.tool.description}`,
  );

  return [
    `<tools>`,
    `You have the following tools available. Call them directly when the task`,
    `is straightforward and a single tool invocation suffices.`,
    ``,
    ...entries,
    `</tools>`,
  ].join("\n");
}

function workspaceGuidance(): string {
  return [
    `<workspace>`,
    `You have a virtual workspace with a bash tool. Files you create persist`,
    `across bash calls within this run. The workspace includes 79+ Unix`,
    `commands (grep, sed, awk, jq, sort, find, curl, etc.).`,
    ``,
    `To save a file as a named output artifact, run:`,
    `  save_artifact <path> [name]`,
    ``,
    `Promoted files are captured as artifacts in the run graph when the run`,
    `completes. Use save_artifact for any output the user should see or that`,
    `downstream agents need to consume. Files not promoted are discarded.`,
    `</workspace>`,
  ].join("\n");
}

function agentGuidance(definition: AgentDefinition): string {
  const resultModeGuidance =
    definition.subagentResultMode === "artifact_only" ?
      [
        `In this run, agent outputs are not returned inline.`,
        `A successful agent call returns dispatch metadata including an`,
        `\`output_artifact_id\`. Use that artifact_id for downstream`,
        `\`artifact_ids\`, \`read_artifact\`, or \`answer_from_artifact\`; do`,
        `not assume you received the child agent's full text as the tool result.`,
      ]
    : [`Each agent's final text response is returned as your tool result.`];

  return [
    `<agents>`,
    `Use the \`agent\` tool to create an agent with a custom role you define —`,
    `name, system prompt, and task input. Use this when you need a named role`,
    `that doesn't match any pre-registered skill.`,
    ``,
    `Use agents to:`,
    `- Run multi-agent coordination patterns with named roles`,
    `  (e.g. \`bull\` and \`bear\` in a debate, or \`extractor\` → \`analyst\` → \`advisor\` in a pipeline)`,
    `- Parallelize independent work streams that each need a distinct persona`,
    `- Isolate a sub-task from your working context`,
    ``,
    ...resultModeGuidance,
    `Pass \`artifact_ids\` to give an agent access to specific artifacts.`,
    `Pass \`artifact_query\` when the harness should resolve artifacts from the`,
    `run graph for you (for example, "all extract-claims outputs" or "the latest`,
    `synthesizer output") instead of copying UUIDs from memory.`,
    `</agents>`,
  ].join("\n");
}

function skillCatalog(skills: ReadonlyArray<Skill>): string {
  if (skills.length === 0) return "";

  const entries = skills.map((s) => `- **${s.name}**: ${s.description}`);

  return [
    `<skills>`,
    `Use the \`skill\` tool to activate a pre-registered skill. A skill is a`,
    `named, versioned capability with a fixed system prompt that encodes a`,
    `specific methodology. Activate a skill when one of the listed skills`,
    `directly matches your task. For ad-hoc roles that don't match any skill,`,
    `use the \`agent\` tool instead. Prefer a direct tool call when a single`,
    `tool invocation suffices.`,
    ``,
    ...entries,
    `</skills>`,
  ].join("\n");
}

function artifactAccess(): string {
  return [
    `<artifacts>`,
    `Your context includes a summary of completed task artifacts. Each artifact`,
    `is listed with an ID, name, type, and (for high-relevance artifacts) a`,
    `short preview.`,
    ``,
    `Use read_artifact to fetch full content by artifact_id.`,
    `Use lookup_artifacts to recover exact artifact_ids by metadata (for`,
    `example produced_by_subagent or name_contains) instead of copying opaque`,
    `UUIDs from memory.`,
    `Use write_artifact to checkpoint a registry, plan, or intermediate JSON`,
    `state as a first-class artifact when later steps must reference it`,
    `exactly.`,
    `Use answer_from_artifact when a downstream stage already produced the`,
    `final answer and you should return that exact artifact content rather`,
    `than reconstructing it from memory. It accepts either an exact`,
    `artifact_id or a narrow graph-backed artifact_query.`,
    ``,
    `Do NOT assume you know the full content from a preview alone. If you need`,
    `complete data to answer accurately, call read_artifact first. Artifacts`,
    `are scoped to the current run. Artifact types include text, json, and`,
    `file_reference (workspace files promoted via save_artifact — use`,
    `read_artifact to retrieve their content). Prefer graph-backed artifact`,
    `lookup over conversational memory whenever an exact artifact_id matters.`,
    `</artifacts>`,
  ].join("\n");
}

function hitlProtocol(): string {
  return [
    `<hitl>`,
    `You have a ${HUMAN_APPROVAL_SKILL_NAME} tool. Use it when:`,
    `- The task requires judgment, authorization, or information only a human can provide.`,
    `- You are about to take an action with material consequences (recommendations,`,
    `  commitments, irreversible operations).`,
    `- Your instructions explicitly require approval before a specific action.`,
    ``,
    `When you call ${HUMAN_APPROVAL_SKILL_NAME}, the run pauses until the human responds.`,
    `Be specific about what you need decided and why. Provide enough context for`,
    `the human to make an informed decision without re-reading the full history.`,
    `</hitl>`,
  ].join("\n");
}

function operationalConstraints(
  definition: AgentDefinition,
  budget: RunBudget,
): string {
  const tokenPct =
    budget.tokenLimit > 0 ?
      Math.round((budget.tokensUsed / budget.tokenLimit) * 100)
    : 0;
  const taskPct =
    budget.taskLimit > 0 ?
      Math.round((budget.tasksUsed / budget.taskLimit) * 100)
    : 0;

  return [
    `<constraints>`,
    `Budget:`,
    `- Tokens: ${budget.tokensUsed.toLocaleString()} / ${budget.tokenLimit.toLocaleString()} used (${tokenPct}%)`,
    `- Tasks: ${budget.tasksUsed} / ${budget.taskLimit} used (${taskPct}%)`,
    ``,
    `Rules:`,
    `- Do not repeat a failed operation more than ${definition.limits.maxOperationsPerTask - 1} time(s). Report the error and move on.`,
    `- When your work is complete, respond with your final answer as plain text`,
    `  (no tool call). This ends the run.`,
    `- If you are running low on budget, prioritize completing the most important`,
    `  parts of the task and summarize what remains.`,
    `</constraints>`,
  ].join("\n");
}

function outputGuidance(): string {
  return [
    `<output>`,
    `Produce a finished, polished answer — not a transcript of your reasoning.`,
    `Reason privately; write a clean final response. Do not show mid-answer`,
    `self-correction, exploratory tangents, or "Wait — actually…" pivots.`,
    `If you realize your draft is wrong, revise it before you finalize, not in`,
    `front of the reader.`,
    ``,
    `Lead with conclusions. Structure with headings, lists, or tables when they`,
    `aid comprehension — not decoration.`,
    ``,
    `Distinguish facts (directly supported by the sources or tool results) from`,
    `inferences (your analytical extension of them). Label inferences as such`,
    `— e.g. "The most likely explanation, though not directly stated, is…".`,
    `Do not state speculation with confidence. Do not assert a causal story`,
    `the sources merely permit.`,
    ``,
    `When you draw on knowledge that is not in the provided sources or tool`,
    `results (background facts, legal cases, general domain knowledge), note`,
    `that the reader should verify before relying on it. Do not fabricate`,
    `sources or citations. If information is missing or conflicting, say so`,
    `directly.`,
    `</output>`,
  ].join("\n");
}
