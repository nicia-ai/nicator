import "dotenv/config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AgentDefinitionSchema,
  generateId,
  now,
  type Run,
  type RunLineage,
  taskLabel,
  todayISO,
} from "@nicator/core";
import env from "@nicator/core/env";
import {
  createHarness,
  createLocalRepo,
  loadSkillFixturesFromDir,
  runAgent,
  seedSkillsFromFixtures,
  toolRegistryFromMap,
} from "@nicator/harness";
import { createWebFetchTool } from "@nicator/tool-web-fetch";
import { webFetchManifest } from "@nicator/tool-web-fetch/manifest";
import { createWebSearchTool } from "@nicator/tool-web-search";
import { webSearchManifest } from "@nicator/tool-web-search/manifest";
import { createBashTool, createPersistentWorkspace } from "@nicator/workspace";

import { CliHitlHandler } from "./cli-hitl.js";

const PROJECT_ROOT = resolve(import.meta.dirname ?? ".", "../../..");

// ---------------------------------------------------------------------------
// Execution graph visualization
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<string, string> = {
  completed: "●",
  failed: "✗",
  skipped: "○",
  running: "◌",
  pending: "◌",
  awaiting_hitl: "⏸",
};

function renderExecutionGraph(lineage: RunLineage): string {
  const { run, tasks: taskEntries } = lineage;

  // Build lookup: taskId → entry
  const entryById = new Map(taskEntries.map((entry) => [entry.task.id, entry]));

  // Build children map from parentTaskId
  const children = new Map<string, string[]>();
  let rootId: string | undefined;
  for (const { task } of taskEntries) {
    if (task.role === "root") {
      rootId = task.id;
    }
    if (task.parentTaskId) {
      const siblings = children.get(task.parentTaskId);
      if (siblings) {
        siblings.push(task.id);
      } else {
        children.set(task.parentTaskId, [task.id]);
      }
    }
  }

  if (!rootId) return "";

  const lines: string[] = [];
  const icon = STATUS_ICONS[run.status] ?? "?";
  lines.push(`${icon} Run ${run.id.slice(0, 8)} [${run.status}]`);

  function renderNode(taskId: string, prefix: string, isLast: boolean): void {
    const entry = entryById.get(taskId);
    if (!entry) return;

    const { task, skill, operations } = entry;
    const connector = isLast ? "└── " : "├── ";
    const continuation = isLast ? "    " : "│   ";

    const statusIcon = STATUS_ICONS[task.status] ?? "?";
    const label = taskLabel(task);
    const skillTag = skill ? ` (skill: ${skill.name})` : "";
    const opCount = operations.length;
    const artifactCount = operations.reduce(
      (n, o) => n + o.artifacts.length,
      0,
    );

    let detail = "";
    if (opCount > 0 || artifactCount > 0) {
      const parts: string[] = [];
      if (opCount > 0) parts.push(`${opCount} op${opCount > 1 ? "s" : ""}`);
      if (artifactCount > 0)
        parts.push(`${artifactCount} artifact${artifactCount > 1 ? "s" : ""}`);
      detail = ` — ${parts.join(", ")}`;
    }

    lines.push(
      `${prefix}${connector}${statusIcon} ${label}${skillTag}${detail}`,
    );

    const childIds = children.get(taskId) ?? [];
    for (let index = 0; index < childIds.length; index++) {
      const childId = childIds[index];
      if (childId !== undefined) {
        renderNode(
          childId,
          prefix + continuation,
          index === childIds.length - 1,
        );
      }
    }
  }

  // Render root's children directly under the run line
  const rootChildren = children.get(rootId) ?? [];
  for (let index = 0; index < rootChildren.length; index++) {
    const childId = rootChildren[index];
    if (childId !== undefined) {
      renderNode(childId, "", index === rootChildren.length - 1);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run command
// ---------------------------------------------------------------------------

async function runCommand(
  definitionPath: string,
  input: string,
): Promise<void> {
  const { ANTHROPIC_API_KEY: apiKey, BRAVE_API_KEY: braveApiKey } = env;

  const agentDefinition = AgentDefinitionSchema.parse(
    JSON.parse(readFileSync(resolve(definitionPath), "utf8")),
  );

  const DB_PATH = "nicator.db";
  const { repo } = await createLocalRepo(DB_PATH);

  // Skills must be seeded before definitions so uses edges can be created
  await seedSkillsFromFixtures(
    repo,
    loadSkillFixturesFromDir(resolve(PROJECT_ROOT, "fixtures/skills")),
  );

  const existing = await repo.agents.getDefinition(
    agentDefinition.id,
    agentDefinition.version,
  );
  if (!existing) {
    await repo.agents.createDefinition(agentDefinition);
  }

  const timestamp = now();
  const run: Run = {
    id: generateId(),
    agentDefinitionId: agentDefinition.id,
    agentDefinitionVersion: agentDefinition.version,
    status: "pending",
    input,
    totalTokensUsed: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await repo.runs.create(run);

  console.log(`Run ${run.id} created.`);
  console.log(
    `Definition: ${agentDefinition.name} v${agentDefinition.version}`,
  );
  console.log(`Input: ${input}\n`);

  // Virtual workspace — bash shell + agentfs in same database as TypeGraph
  const defWs = agentDefinition.workspace;
  const workspace = await createPersistentWorkspace(
    {
      runId: run.id,
      ...(defWs?.outputPaths ? { outputPaths: defWs.outputPaths } : {}),
      ...(defWs?.initialFiles ? { initialFiles: defWs.initialFiles } : {}),
    },
    DB_PATH,
  );

  // Tool registry — direct tools available to the agent
  const toolRegistry = toolRegistryFromMap([
    ["web-search", createWebSearchTool(webSearchManifest, braveApiKey)],
    ["web-fetch", createWebFetchTool(webFetchManifest)],
    ["bash", createBashTool(workspace)],
  ]);

  const config = createHarness({
    apiKey,
    repo,
    toolRegistry,
    workspace,
    hitlHandler: new CliHitlHandler(),
    env: {
      date: todayISO(),
      platform: process.platform,
      runtime: "cli",
    },
    onTextDelta(delta) {
      process.stdout.write(delta);
    },
    onCompression(runId, summary) {
      console.log(`[compression] Run ${runId}: ${summary.slice(0, 200)}...`);
    },
  });

  try {
    await runAgent(run.id, config);

    const finalRun = await repo.runs.get(run.id);
    console.log(`\n\nRun ${finalRun?.status ?? "unknown"}.`);
    if (finalRun?.status === "completed") {
      console.log("\n--- Output ---");
      console.log(finalRun.output);
    }
    if (finalRun?.status === "failed") {
      console.log("\n--- Error ---");
      console.log(finalRun.error);
    }

    const artifacts = await repo.artifacts.getForRun(run.id);
    const fileReferences = artifacts.filter((a) => a.type === "file_reference");
    if (fileReferences.length > 0) {
      const totalBytes = fileReferences.reduce(
        (sum, a) => sum + a.content.length,
        0,
      );
      console.log(`\n--- Workspace Artifacts (${fileReferences.length}) ---`);
      for (const a of fileReferences) {
        console.log(`  ${a.name} (${a.mimeType}, ${a.content.length} bytes)`);
      }
      console.log(`  Total: ${totalBytes} bytes`);
    }

    const lineage = await repo.lineage.getRunLineage(run.id);
    if (lineage) {
      console.log(`\n--- Execution Graph ---`);
      console.log(renderExecutionGraph(lineage));
      console.log(
        `${lineage.tasks.length} tasks, ${finalRun?.totalTokensUsed ?? 0} tokens`,
      );
    }
  } catch (error) {
    console.error("Run failed:", error);
    process.exit(1);
  } finally {
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

if (command === "run") {
  let definitionPath = "";
  let input = "";

  for (let index = 1; index < args.length; index++) {
    if (args[index] === "--definition") definitionPath = args[++index] ?? "";
    if (args[index] === "--input") input = args[++index] ?? "";
  }

  if (!definitionPath || !input) {
    console.error("Usage: pnpm cli run --definition <path> --input <text>");
    process.exit(1);
  }

  try {
    await runCommand(definitionPath, input);
  } catch (error: unknown) {
    console.error(error);
    process.exit(1);
  }
} else {
  console.log("nicator CLI");
  console.log("Usage: pnpm cli run --definition <path> --input <text>");
}
