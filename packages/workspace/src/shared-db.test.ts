import { unlinkSync } from "node:fs";

import { createClient } from "@libsql/client";
import { createRepository, nicatorGraph } from "@nicator/core";
import {
  makeDefinition,
  makeRun,
  makeSkill,
} from "@nicator/core/test-factories";
import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";
import { describe, expect, it } from "vitest";

import { createPersistentWorkspace } from "./workspace.js";

const TEST_DB = ".test-shared.db";

function cleanup(): void {
  try {
    unlinkSync(TEST_DB);
  } catch {
    // file may not exist
  }
}

describe("shared database", () => {
  it("TypeGraph and agentfs tables coexist in the same SQLite file", async () => {
    cleanup();
    try {
      // 1. Open TypeGraph on this database
      const client = createClient({ url: `file:${TEST_DB}` });
      const { backend } = await createLibsqlBackend(client);
      const [store] = await createStoreWithSchema(nicatorGraph, backend);
      const repo = createRepository(store);

      // 2. Create a skill, agent definition, and a run in TypeGraph
      await repo.agents.registerSkill(makeSkill());
      const definition = makeDefinition();
      await repo.agents.createDefinition(definition);

      const run = makeRun(definition.id);
      await repo.runs.create(run);
      const runId = run.id;

      // 3. Verify run exists before opening agentfs
      const runBefore = await repo.runs.get(runId);
      expect(runBefore).toBeDefined();
      expect(runBefore?.status).toBe("running");

      // 4. Open agentfs workspace on the SAME database
      const ws = await createPersistentWorkspace({ runId }, TEST_DB);
      await ws.exec('echo "hello from agentfs" > shared-test.txt');
      const catResult = await ws.exec("cat shared-test.txt");
      expect(catResult.stdout).toContain("hello from agentfs");

      // 5. Verify TypeGraph data is still accessible after agentfs init
      const runAfter = await repo.runs.get(runId);
      expect(runAfter).toBeDefined();
      expect(runAfter?.status).toBe("running");

      // 6. Verify both table families exist
      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      );
      const tableNames = tables.rows.map((r) => r["name"] as string);

      // Both table families should coexist
      // TypeGraph uses default table names; agentfs uses fs_* prefix
      const hasTypegraphTables = tableNames.some(
        (t) =>
          t === "nodes" ||
          t === "edges" ||
          t.includes("schema") ||
          t.includes("unique"),
      );
      const hasAgentfsTables = tableNames.some((t) => t.startsWith("fs_"));

      expect(hasAgentfsTables).toBe(true);
      expect(hasTypegraphTables).toBe(true);

      await ws.dispose();
      await backend.close();
    } finally {
      cleanup();
    }
  });
});
