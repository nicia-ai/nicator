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
    subagentGuidance(),
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

function subagentGuidance(): string {
  return [
    `<subagents>`,
    `You can spawn subagents via spawn_subagent (custom prompt) or`,
    `spawn_subagent_with_skill (pre-built skill prompt). Each subagent runs in`,
    `its own context window with the same tools you have. Subagents can spawn`,
    `their own subagents.`,
    ``,
    `Use subagents to:`,
    `- Parallelize independent work (dispatch multiple subagents at once)`,
    `- Isolate context for disparate operations`,
    `- Delegate reasoning tasks with focused prompts`,
    ``,
    `Each subagent's final text response is returned as your tool result.`,
    `Pass artifact_ids to give a subagent access to specific artifacts.`,
    `</subagents>`,
  ].join("\n");
}

function skillCatalog(skills: ReadonlyArray<Skill>): string {
  if (skills.length === 0) return "";

  const entries = skills.map((s) => `- **${s.name}**: ${s.description}`);

  return [
    `<skills>`,
    `You can spawn a subagent with a pre-built skill via the`,
    `spawn_subagent_with_skill tool. Use a skill when the task benefits from`,
    `specialized instructions and multi-step tool use. Prefer a direct tool`,
    `call over a skill when a single tool invocation suffices.`,
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
    `short preview. To read the full content, call the read_artifact tool with`,
    `the artifact_id.`,
    ``,
    `Do NOT assume you know the full content from a preview alone. If you need`,
    `complete data to answer accurately, call read_artifact first. Artifacts`,
    `are scoped to the current run. Artifact types include text, json, and`,
    `file_reference (workspace files promoted via save_artifact — use`,
    `read_artifact to retrieve their content).`,
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
    `Be concise. Lead with conclusions, not process. Structure your output for`,
    `the reader — use headings, lists, or tables when they aid comprehension.`,
    `Distinguish clearly between facts, inferences, and uncertainties. Do not`,
    `fabricate sources or citations. If information is missing or conflicting,`,
    `say so directly.`,
    `</output>`,
  ].join("\n");
}
