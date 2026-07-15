import { describe, expect, it } from "vitest";

import {
  buildPerFactUserPrompt,
  type JudgeCall,
  parsePerFactResponse,
  PER_FACT_SYSTEM_PROMPT,
  runPerFactJudge,
} from "./judge";
import { auditCategories, matcherVerdictsFor, rescoreInput } from "./rescore";
import {
  type AuditFact,
  AuditFactSchema,
  type AuditInput,
  AuditInputSchema,
} from "./schema";

const FACTS: AuditFact[] = [
  AuditFactSchema.parse({
    id: "fact-sla",
    description: "Quantix — 24 hour breach SLA",
    canonical: "Quantix 24 hours",
    matcher: {
      kind: "regex",
      pattern: String.raw`Quantix[\s\S]{0,130}(24.?hours?|24h\b)`,
    },
  }),
  AuditFactSchema.parse({
    id: "fact-encryption",
    description: "Quantix — AES-256 at rest",
    canonical: "Quantix AES-256",
    matcher: {
      kind: "regex",
      pattern: String.raw`Quantix[\s\S]{0,130}AES-?256`,
    },
  }),
];

function judgeResponse(
  verdicts: ReadonlyArray<{ factId: string; matched: boolean }>,
): string {
  return [
    "<reasoning>",
    "One sentence per fact.",
    "</reasoning>",
    "<verdicts>",
    JSON.stringify({
      verdicts: verdicts.map((v) => ({ ...v, justification: "because" })),
    }),
    "</verdicts>",
  ].join("\n");
}

/** Judge transport that must never be reached. */
const neverCall: JudgeCall = () => {
  throw new Error("should not be called");
};

/** Judge transport that passes fact-sla only when the output states the SLA. */
const slaAwareCall: JudgeCall = (_system, user) => {
  const statesSla = user.includes("24h breach SLA");
  return Promise.resolve(
    judgeResponse([
      { factId: "fact-sla", matched: statesSla },
      { factId: "fact-encryption", matched: true },
    ]),
  );
};

describe("buildPerFactUserPrompt", () => {
  it("lists fact ids with descriptions and appends the response", () => {
    const prompt = buildPerFactUserPrompt(FACTS, "the response text");
    expect(prompt).toContain(
      'factId="fact-sla" — Quantix — 24 hour breach SLA',
    );
    expect(prompt).toContain("the response text");
  });

  it("falls back to canonical when description is empty", () => {
    const bare = AuditFactSchema.parse({
      id: "f",
      canonical: "Quantix AES-256",
    });
    expect(buildPerFactUserPrompt([bare], "x")).toContain(
      'factId="f" — Quantix AES-256',
    );
  });
});

describe("parsePerFactResponse", () => {
  it("parses reasoning and verdicts in expected-id order", () => {
    const text = judgeResponse([
      { factId: "fact-encryption", matched: false },
      { factId: "fact-sla", matched: true },
    ]);
    const { reasoning, verdicts } = parsePerFactResponse(text, [
      "fact-sla",
      "fact-encryption",
    ]);
    expect(reasoning).toBe("One sentence per fact.");
    expect(verdicts.map((v) => v.factId)).toEqual([
      "fact-sla",
      "fact-encryption",
    ]);
    expect(verdicts.map((v) => v.matched)).toEqual([true, false]);
  });

  it("throws when a block is missing", () => {
    expect(() => parsePerFactResponse("no blocks here", ["fact-sla"])).toThrow(
      "missing required blocks",
    );
  });

  it("throws when the judge omits a fact", () => {
    const text = judgeResponse([{ factId: "fact-sla", matched: true }]);
    expect(() =>
      parsePerFactResponse(text, ["fact-sla", "fact-encryption"]),
    ).toThrow("omitted verdict for factId=fact-encryption");
  });
});

describe("runPerFactJudge", () => {
  it("returns a weighted score from injected verdicts without any API", async () => {
    const call: JudgeCall = (system, user) => {
      expect(system).toBe(PER_FACT_SYSTEM_PROMPT);
      expect(user).toContain("Candidate response");
      return Promise.resolve(
        judgeResponse([
          { factId: "fact-sla", matched: true },
          { factId: "fact-encryption", matched: false },
        ]),
      );
    };
    const result = await runPerFactJudge(FACTS, "some output", call);
    expect(result.score).toBe(0.5);
    expect(result.verdicts).toHaveLength(2);
  });

  it("short-circuits on empty fact lists", async () => {
    const result = await runPerFactJudge([], "output", neverCall);
    expect(result.score).toBe(0);
    expect(result.verdicts).toEqual([]);
  });
});

describe("rescoreInput", () => {
  const input: AuditInput = AuditInputSchema.parse({
    comparison: ["harness", "baseline"],
    runs: [
      {
        runId: "run-aaaa1111",
        tasks: [
          {
            taskId: "dcv-004",
            facts: FACTS,
            conditions: {
              // Harness states both facts, but the SLA is phrased beyond
              // the matcher's proximity window (surface-form false negative).
              harness: {
                text: `Quantix uses AES-256 at rest. ${"x".repeat(200)} Quantix also commits to a 24h breach SLA.`,
                recordedVerdicts: {
                  "fact-sla": false,
                  "fact-encryption": true,
                },
                recordedScore: 0.5,
              },
              // Baseline states only the encryption fact.
              baseline: { text: "Quantix uses AES-256 at rest." },
            },
          },
        ],
      },
    ],
  });

  it("compares matcher verdicts against injected judge verdicts", async () => {
    const output = await rescoreInput(input, slaAwareCall, {
      judgeModel: "test-model",
    });
    expect(output.entries).toHaveLength(1);
    const entry = output.entries[0]!;

    const harness = entry.conditions["harness"]!;
    expect(harness.matcherScore).toBe(0.5); // recorded score preserved
    expect(harness.judgeScore).toBe(1); // judge tolerates the phrasing
    expect(harness.matcherVerdicts).toEqual({
      "fact-sla": false,
      "fact-encryption": true,
    });

    const baseline = entry.conditions["baseline"]!;
    expect(baseline.matcherScore).toBe(0.5); // recomputed from matcher specs
    expect(baseline.judgeScore).toBe(0.5);

    // The load-bearing quadrant: matcher failed, judge passed (harness SLA).
    const audit = auditCategories(output.entries, "harness");
    expect(audit.matcherFailJudgePass).toBe(1);
    expect(audit.bothPassed).toBe(1);
    expect(audit.total).toBe(2);
  });

  it("recomputes matcher verdicts when none are recorded", () => {
    const task = input.runs[0]!.tasks[0]!;
    const baseline = task.conditions["baseline"]!;
    expect(matcherVerdictsFor(task, baseline)).toEqual({
      "fact-sla": false,
      "fact-encryption": true,
    });
  });
});
