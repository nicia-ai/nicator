import { describe, expect, it } from "vitest";

import {
  resolveTaskMetadata,
  taskBelongsToSuite,
  type EvalTask,
} from "./schema";
import { loadTasks } from "./task-loader";

function makeTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: "syn-001",
    category: "synthesis",
    name: "Test task",
    description: "A test task",
    sources: [{ id: "s1", title: "Source", content: "content", tokenCount: 100 }],
    question: "What is the answer?",
    referenceFacts: [],
    passFail: {
      requiredFactIds: [],
      description: "Must pass",
    },
    hitlBehavior: "auto_approve",
    ...overrides,
  } as EvalTask;
}

describe("resolveTaskMetadata", () => {
  it("infers forecast defaults from outcome categories", () => {
    const metadata = resolveTaskMetadata(makeTask());

    expect(metadata.purpose).toBe("forecast");
    expect(metadata.realism).toBe("prod-shaped");
    expect(metadata.releaseGate).toBe("blocker");
    expect(metadata.comparisonMode).toBe("direct-api");
    expect(metadata.suites).toEqual(["prod-gate", "preprod-headroom"]);
  });

  it("infers mechanism defaults for decomposition-value tasks", () => {
    const metadata = resolveTaskMetadata(
      makeTask({ category: "decomposition-value" }),
    );

    expect(metadata.purpose).toBe("mechanism");
    expect(metadata.releaseGate).toBe("research");
    expect(metadata.comparisonMode).toBe("flat-harness");
    expect(metadata.suites).toEqual(["research", "decomposition-research"]);
  });

  it("respects explicit metadata overrides", () => {
    const metadata = resolveTaskMetadata(
      makeTask({
        metadata: {
          purpose: "stress",
          realism: "prod-derived",
          releaseGate: "advisory",
          comparisonMode: "none",
          stressAxes: ["context_volume"],
        },
      }),
    );

    expect(metadata.purpose).toBe("stress");
    expect(metadata.realism).toBe("prod-derived");
    expect(metadata.releaseGate).toBe("advisory");
    expect(metadata.comparisonMode).toBe("none");
    expect(metadata.stressAxes).toEqual(["context_volume"]);
    expect(metadata.suites).toEqual(["preprod-headroom"]);
  });
});

describe("taskBelongsToSuite", () => {
  it("matches derived suites correctly", () => {
    expect(taskBelongsToSuite(makeTask(), "prod-gate")).toBe(true);
    expect(
      taskBelongsToSuite(
        makeTask({ category: "decomposition-value" }),
        "decomposition-research",
      ),
    ).toBe(true);
    expect(
      taskBelongsToSuite(
        makeTask({
          metadata: { purpose: "stress", releaseGate: "advisory" },
        }),
        "prod-gate",
      ),
    ).toBe(false);
  });
});

describe("loadTasks metadata filters", () => {
  it("filters by purpose", () => {
    const tasks = loadTasks({ taskId: "dcv-003", purposes: ["mechanism"] });
    expect(tasks.map((t) => t.id)).toEqual(["dcv-003"]);
  });

  it("filters by suite", () => {
    const tasks = loadTasks({
      taskId: "dcv-003",
      suites: ["decomposition-research"],
    });
    expect(tasks.map((t) => t.id)).toEqual(["dcv-003"]);
  });

  it("excludes mismatched purposes", () => {
    const tasks = loadTasks({ taskId: "dcv-003", purposes: ["forecast"] });
    expect(tasks).toHaveLength(0);
  });
});
