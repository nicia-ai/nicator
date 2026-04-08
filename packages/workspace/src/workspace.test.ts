import { unlinkSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createBashTool } from "./bash-tool.js";
import { createPersistentWorkspace, createWorkspace } from "./workspace.js";

function cleanupFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // file may not exist
  }
}

describe("createWorkspace", () => {
  it("executes a simple command", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    const result = await ws.exec("echo hello world");
    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    await ws.dispose();
  });

  it("persists files across exec calls", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    await ws.exec('echo "line 1" > notes.txt');
    await ws.exec('echo "line 2" >> notes.txt');
    const result = await ws.exec("cat notes.txt");
    expect(result.stdout).toContain("line 1");
    expect(result.stdout).toContain("line 2");
    await ws.dispose();
  });

  it("seeds initial files", async () => {
    const ws = await createWorkspace({
      runId: "test-run",
      initialFiles: {
        "data.json": '{"count": 42}',
        "nested/readme.md": "# Hello",
      },
    });
    const json = await ws.exec("cat data.json");
    expect(json.stdout).toContain('"count": 42');
    const md = await ws.exec("cat nested/readme.md");
    expect(md.stdout).toContain("# Hello");
    await ws.dispose();
  });

  it("supports piped commands", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    await ws.exec(
      String.raw`printf "banana\napple\ncherry\napple\n" > fruits.txt`,
    );
    const result = await ws.exec("cat fruits.txt | sort | uniq -c | sort -rn");
    expect(result.stdout).toContain("apple");
    expect(result.exitCode).toBe(0);
    await ws.dispose();
  });

  it("reports nonzero exit code on failure", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    const result = await ws.exec("cat nonexistent-file.txt");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No such file");
    await ws.dispose();
  });

  it("truncates long output", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    // Generate output longer than 32K chars
    const result = await ws.exec("seq 1 50000");
    expect(result.stdout).toContain("truncated");
    expect(result.stdout.length).toBeLessThan(40_000);
    await ws.dispose();
  });

  it("captures output files matching patterns", async () => {
    const ws = await createWorkspace({
      runId: "test-run",
      outputPaths: ["/workspace/*.md"],
    });
    await ws.exec('echo "# Report" > report.md');
    await ws.exec('echo "not captured" > notes.txt');
    const outputs = await ws.captureOutputs();
    expect(outputs.length).toBe(1);
    expect(outputs[0]?.path).toContain("report.md");
    expect(outputs[0]?.content).toContain("# Report");
    expect(outputs[0]?.mimeType).toBe("text/markdown");
    await ws.dispose();
  });

  it("uses jq for JSON processing", async () => {
    const ws = await createWorkspace({
      runId: "test-run",
      initialFiles: {
        "data.json": JSON.stringify([
          { name: "Alice", score: 95 },
          { name: "Bob", score: 87 },
        ]),
      },
    });
    const result = await ws.exec("cat data.json | jq '.[].name' -r | sort");
    expect(result.stdout.trim()).toBe("Alice\nBob");
    await ws.dispose();
  });
});

describe("createPersistentWorkspace", () => {
  const TEST_DB = ".test-workspace.db";

  it("stores files in SQLite via agentfs", async () => {
    cleanupFile(TEST_DB);
    try {
      const ws = await createPersistentWorkspace(
        { runId: "persist-test" },
        TEST_DB,
      );
      await ws.exec('echo "persisted content" > test-file.txt');
      const result = await ws.exec("cat test-file.txt");
      expect(result.stdout).toContain("persisted content");
      expect(result.exitCode).toBe(0);
      await ws.dispose();
    } finally {
      cleanupFile(TEST_DB);
    }
  });

  it("supports complex shell pipelines over agentfs", async () => {
    cleanupFile(TEST_DB);
    try {
      const ws = await createPersistentWorkspace(
        { runId: "pipeline-test" },
        TEST_DB,
      );
      await ws.exec(
        String.raw`printf "cherry\napple\nbanana\napple\n" > fruits.txt`,
      );
      const result = await ws.exec(
        "cat fruits.txt | sort | uniq -c | sort -rn | head -1",
      );
      expect(result.stdout).toContain("apple");
      await ws.dispose();
    } finally {
      cleanupFile(TEST_DB);
    }
  });
});

describe("save_artifact command", () => {
  it("promotes a file for artifact capture", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    await ws.exec('echo "report content" > report.md');
    const result = await ws.exec("save_artifact report.md my-report");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Saved artifact: my-report");
    expect(ws.promotedFiles).toHaveLength(1);
    expect(ws.promotedFiles[0]?.name).toBe("my-report");

    const outputs = await ws.captureOutputs();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.content).toContain("report content");
    await ws.dispose();
  });

  it("uses filename as default artifact name", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    await ws.exec('echo "data" > results.json');
    await ws.exec("save_artifact results.json");
    expect(ws.promotedFiles[0]?.name).toBe("results.json");
    await ws.dispose();
  });

  it("fails on nonexistent file", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    const result = await ws.exec("save_artifact missing.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file");
    expect(ws.promotedFiles).toHaveLength(0);
    await ws.dispose();
  });

  it("fails with no arguments", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    const result = await ws.exec("save_artifact");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
    await ws.dispose();
  });
});

describe("edge cases", () => {
  it("returns nonzero exit code for invalid bash syntax", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    const result = await ws.exec("if then else fi");
    expect(result.exitCode).not.toBe(0);
    await ws.dispose();
  });

  it("enforces maxCommands execution limit", async () => {
    const ws = await createWorkspace({
      runId: "test-run",
      limits: { maxCommands: 5 },
    });
    // A loop that would exceed 5 commands
    const result = await ws.exec("for i in $(seq 1 20); do echo $i; done");
    // just-bash should stop execution when limit is hit
    expect(result.exitCode).not.toBe(0);
    await ws.dispose();
  });

  it("enforces maxLoopIterations execution limit", async () => {
    const ws = await createWorkspace({
      runId: "test-run",
      limits: { maxLoopIterations: 3 },
    });
    const result = await ws.exec(
      "i=0; while true; do i=$((i+1)); echo $i; done",
    );
    expect(result.exitCode).not.toBe(0);
    await ws.dispose();
  });

  it("caps promoted files at MAX_PROMOTED_FILES", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    // Create and promote files in a loop — the 101st should fail
    for (let index = 0; index < 100; index++) {
      await ws.exec(
        `echo "f" > file${index}.txt && save_artifact file${index}.txt`,
      );
    }
    expect(ws.promotedFiles).toHaveLength(100);
    await ws.exec('echo "overflow" > overflow.txt');
    const result = await ws.exec("save_artifact overflow.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("limit");
    await ws.dispose();
  });

  it("sequential persistent workspaces share the same filesystem", async () => {
    const DB = ".test-sequential.db";
    cleanupFile(DB);
    try {
      // First workspace writes a file
      const ws1 = await createPersistentWorkspace({ runId: "run-1" }, DB);
      await ws1.exec('echo "persisted across workspaces" > shared.txt');
      await ws1.dispose();

      // Second workspace should see the file (same database)
      const ws2 = await createPersistentWorkspace({ runId: "run-2" }, DB);
      const result = await ws2.exec("cat shared.txt");
      expect(result.stdout).toContain("persisted across workspaces");
      await ws2.dispose();
    } finally {
      cleanupFile(DB);
    }
  });
});

describe("createBashTool", () => {
  it("wraps workspace.exec as a ToolImplementation", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    const tool = createBashTool(ws);

    expect(tool.tool.name).toBe("bash");

    const result = (await tool.execute({ command: "echo test" })) as {
      stdout: string;
      exitCode: number;
    };
    expect(result.stdout).toBe("test\n");
    expect(result.exitCode).toBe(0);
    await ws.dispose();
  });

  it("throws ZodError on missing command field", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    const tool = createBashTool(ws);
    await expect(tool.execute({})).rejects.toThrow();
    await ws.dispose();
  });

  it("throws ZodError on null input", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    const tool = createBashTool(ws);
    await expect(tool.execute(undefined)).rejects.toThrow();
    await ws.dispose();
  });

  it("throws ZodError on empty command string", async () => {
    const ws = await createWorkspace({ runId: "test-run" });
    const tool = createBashTool(ws);
    await expect(tool.execute({ command: "" })).rejects.toThrow();
    await ws.dispose();
  });
});
