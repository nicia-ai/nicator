import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listEvalReportFiles, loadEvalReports } from "./result-files";

function report(runId: string) {
  return {
    runId,
    timestamp: "2026-04-23T00:00:00.000Z",
    harnessVersion: "0.1.0",
    modelVersion: "test-model",
    tasks: [],
    aggregate: {
      factualAccuracy: { harness: 0, baseline: 0, delta: 0 },
      judgeQuality: {
        harness: 0,
        baseline: 0,
        delta: 0,
        inconclusiveCount: 0,
      },
      byCategory: {},
      processMetrics: {
        avgSkillsPerRun: 0,
        avgOperationsPerRun: 0,
        hitlRate: 0,
        avgContextPressureRatio: 0,
      },
    },
  };
}

describe("result file helpers", () => {
  it("loads only EvalReport JSON files from mixed result directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-results-"));
    try {
      writeFileSync(
        join(dir, "abc12345.json"),
        JSON.stringify(report("abc12345-full")),
      );
      writeFileSync(
        join(dir, "sweep-weights-1.json"),
        JSON.stringify({ configs: [] }),
      );
      writeFileSync(
        join(dir, "multi-run-1.json"),
        JSON.stringify({ runIds: ["abc12345-full"] }),
      );

      expect(listEvalReportFiles(dir).map((file) => file.name)).toEqual([
        "abc12345.json",
      ]);
      expect(loadEvalReports(dir, { runPrefixes: ["abc123"] })).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
