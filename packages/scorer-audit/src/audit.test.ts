import { describe, expect, it } from "vitest";

import {
  classifyQuadrant,
  cohensKappa,
  extractExcerpt,
  generateAuditPacket,
  type LabelPair,
  makeRng,
  parseLabels,
  shuffle,
} from "./audit";
import {
  AuditFactSchema,
  type AuditInput,
  AuditInputSchema,
  type RescoreOutput,
  RescoreOutputSchema,
} from "./schema";

describe("cohensKappa", () => {
  it("returns zeros for no pairs", () => {
    expect(cohensKappa([])).toEqual({ kappa: 0, agreement: 0, pe: 0, n: 0 });
  });

  it("is 1 for perfect agreement with mixed labels", () => {
    const pairs: LabelPair[] = [
      { author: "PASS", judge: "PASS" },
      { author: "FAIL", judge: "FAIL" },
      { author: "PASS", judge: "PASS" },
      { author: "FAIL", judge: "FAIL" },
    ];
    const k = cohensKappa(pairs);
    expect(k.agreement).toBe(1);
    expect(k.kappa).toBe(1);
  });

  it("handles the degenerate all-PASS case (pe = 1)", () => {
    const pairs: LabelPair[] = [
      { author: "PASS", judge: "PASS" },
      { author: "PASS", judge: "PASS" },
    ];
    const k = cohensKappa(pairs);
    expect(k.pe).toBe(1);
    expect(k.kappa).toBe(1);
  });

  it("matches a hand-computed 2x2 example", () => {
    // Classic worked example: a=20 both-PASS, d=15 both-FAIL,
    // b=5 (author PASS, judge FAIL), c=10 (author FAIL, judge PASS), n=50.
    // po = 35/50 = 0.7
    // author PASS = 25/50 = 0.5, judge PASS = 30/50 = 0.6
    // pe = 0.5*0.6 + 0.5*0.4 = 0.5 → kappa = (0.7-0.5)/0.5 = 0.4
    const pairs: LabelPair[] = [
      ...Array.from(
        { length: 20 },
        (): LabelPair => ({ author: "PASS", judge: "PASS" }),
      ),
      ...Array.from(
        { length: 5 },
        (): LabelPair => ({ author: "PASS", judge: "FAIL" }),
      ),
      ...Array.from(
        { length: 10 },
        (): LabelPair => ({ author: "FAIL", judge: "PASS" }),
      ),
      ...Array.from(
        { length: 15 },
        (): LabelPair => ({ author: "FAIL", judge: "FAIL" }),
      ),
    ];
    const k = cohensKappa(pairs);
    expect(k.n).toBe(50);
    expect(k.agreement).toBeCloseTo(0.7, 10);
    expect(k.pe).toBeCloseTo(0.5, 10);
    expect(k.kappa).toBeCloseTo(0.4, 10);
  });

  it("is ~0 for chance-level agreement", () => {
    // Author says PASS half the time regardless of the judge.
    const pairs: LabelPair[] = [
      { author: "PASS", judge: "PASS" },
      { author: "PASS", judge: "FAIL" },
      { author: "FAIL", judge: "PASS" },
      { author: "FAIL", judge: "FAIL" },
    ];
    const k = cohensKappa(pairs);
    expect(k.kappa).toBeCloseTo(0, 10);
  });
});

describe("classifyQuadrant", () => {
  it("maps the four matcher × judge combinations", () => {
    expect(classifyQuadrant(false, true)).toBe("matcher-fail-judge-pass");
    expect(classifyQuadrant(true, false)).toBe("matcher-pass-judge-fail");
    expect(classifyQuadrant(false, false)).toBe("both-failed");
    expect(classifyQuadrant(true, true)).toBe("both-passed");
  });
});

describe("parseLabels", () => {
  it("reads labels from case sections", () => {
    const packet = [
      "## Case 1 of 3",
      "**Your label**: `PASS`",
      "## Case 2 of 3",
      "**Your label**: `[ FAIL ]`",
      "## Case 3 of 3",
      "**Your label**: `[ TODO ]`",
    ].join("\n");
    const labels = parseLabels(packet);
    expect(labels.get(1)).toBe("PASS");
    expect(labels.get(2)).toBe("FAIL");
    expect(labels.get(3)).toBe("TODO");
  });

  it("treats unrecognized labels as TODO", () => {
    const packet = ["## Case 1 of 1", "**Your label**: `MAYBE`"].join("\n");
    expect(parseLabels(packet).get(1)).toBe("TODO");
  });
});

describe("deterministic RNG", () => {
  it("shuffles reproducibly for a given seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffle(items, makeRng(42));
    const b = shuffle(items, makeRng(42));
    expect(a).toEqual(b);
    expect(a.toSorted((x, y) => x - y)).toEqual(items);
  });
});

describe("extractExcerpt", () => {
  const fact = AuditFactSchema.parse({
    id: "f",
    description: "Quantix — 24 hour breach SLA",
    canonical: "Quantix 24 hours",
    matcher: {
      kind: "regex",
      pattern: String.raw`Quantix[\s\S]{0,130}24.?hours?`,
    },
  });

  it("centers the excerpt on the pattern match", () => {
    const text = `${"a".repeat(500)} Quantix responds within 24 hours ${"b".repeat(500)}`;
    const excerpt = extractExcerpt(text, fact);
    expect(excerpt).toContain("Quantix responds within 24 hours");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("falls back to the head of the output when nothing anchors", () => {
    const excerpt = extractExcerpt("completely unrelated text", {
      ...fact,
      description: "no anchors here",
      canonical: "zzz",
      matcher: { kind: "substring" },
    });
    expect(excerpt).toContain("[no anchor in output");
    expect(excerpt).toContain("completely unrelated text");
  });
});

function makeFixtures(): { input: AuditInput; rescore: RescoreOutput } {
  const input = AuditInputSchema.parse({
    comparison: ["harness", "baseline"],
    runs: [
      {
        runId: "run-1",
        tasks: [
          {
            taskId: "t-1",
            facts: [
              { id: "fact-a", canonical: "alpha value" },
              { id: "fact-b", canonical: "beta value" },
            ],
            conditions: {
              harness: {
                text: "The alpha value is stated. Beta is described loosely.",
              },
              baseline: { text: "Neither is stated properly here." },
            },
          },
        ],
      },
    ],
  });
  const rescore = RescoreOutputSchema.parse({
    comparison: ["harness", "baseline"],
    judgeModel: "test-model",
    generatedAt: new Date().toISOString(),
    entries: [
      {
        runId: "run-1",
        taskId: "t-1",
        conditions: {
          harness: {
            matcherScore: 0.5,
            judgeScore: 1,
            verdicts: [
              { factId: "fact-a", matched: true, justification: "stated" },
              { factId: "fact-b", matched: true, justification: "paraphrased" },
            ],
            matcherVerdicts: { "fact-a": true, "fact-b": false },
          },
          baseline: {
            matcherScore: 0,
            judgeScore: 0,
            verdicts: [
              { factId: "fact-a", matched: false, justification: "absent" },
              { factId: "fact-b", matched: false, justification: "absent" },
            ],
            matcherVerdicts: { "fact-a": false, "fact-b": false },
          },
        },
      },
    ],
  });
  return { input, rescore };
}

describe("generateAuditPacket", () => {
  it("builds a shuffled packet with an aligned answer key", () => {
    const { input, rescore } = makeFixtures();
    const packet = generateAuditPacket({
      input,
      rescore,
      rescoreSource: "rescore-test.json",
      seed: 7,
    });

    // 1 matcher-fail-judge-pass (harness fact-b), 1 both-passed
    // (harness fact-a), 2 both-failed (baseline), 0 matcher-pass-judge-fail.
    expect(packet.cases).toHaveLength(4);
    const quadrants = packet.cases.map((c) => c.quadrant).toSorted();
    expect(quadrants).toEqual([
      "both-failed",
      "both-failed",
      "both-passed",
      "matcher-fail-judge-pass",
    ]);

    // Key rows mirror the case order.
    expect(packet.key.cases.map((c) => c.caseIndex)).toEqual([1, 2, 3, 4]);
    for (const [index, keyCase] of packet.key.cases.entries()) {
      expect(keyCase.factId).toBe(packet.cases[index]!.factId);
    }

    // Every case renders with a hidden judge verdict and a label slot.
    expect(packet.markdown).toContain("## Case 1 of 4");
    expect(packet.markdown.match(/\*\*Your label\*\*/g)).toHaveLength(4);
    expect(packet.markdown.match(/<details>/g)).toHaveLength(4);

    // Same seed → identical packet.
    const again = generateAuditPacket({
      input,
      rescore,
      rescoreSource: "rescore-test.json",
      seed: 7,
    });
    expect(again.markdown).toBe(packet.markdown);
  });

  it("round-trips labels through parseLabels", () => {
    const { input, rescore } = makeFixtures();
    const packet = generateAuditPacket({
      input,
      rescore,
      rescoreSource: "rescore-test.json",
      seed: 7,
    });
    const labeled = packet.markdown.replaceAll("`[ TODO ]`", "`PASS`");
    const labels = parseLabels(labeled);
    expect(labels.size).toBe(4);
    for (const c of packet.key.cases) {
      expect(labels.get(c.caseIndex)).toBe("PASS");
    }
  });
});
