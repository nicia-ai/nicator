/**
 * Human-audit packets and agreement scoring.
 *
 * Packet generation stratifies fact-verdicts across the four agreement
 * quadrants (matcher × judge), random-samples per quadrant according to a
 * fixed design, packages each case with the relevant context, shuffles
 * them so quadrant blocks don't leak, and emits a labeling document plus
 * an answer key. Judge verdicts are hidden inside `<details>` blocks so
 * the labeler labels first and reveals second.
 *
 * Scoring reads the labeled packet back and produces Cohen's κ between
 * author labels and judge verdicts, per-quadrant agreement rates, and a
 * list of every disagreement.
 */
import type { AuditFact, AuditInput, RescoreOutput } from "./schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Quadrant =
  | "matcher-fail-judge-pass"
  | "matcher-pass-judge-fail"
  | "both-failed"
  | "both-passed";

export const QUADRANTS: readonly Quadrant[] = [
  "matcher-fail-judge-pass",
  "matcher-pass-judge-fail",
  "both-failed",
  "both-passed",
];

export type Label = "PASS" | "FAIL" | "AMBIGUOUS" | "DISPUTE-RUBRIC" | "TODO";

export type CaseRecord = Readonly<{
  caseIndex: number; // 1-based, matches the position in the shuffled packet
  runId: string;
  taskId: string;
  condition: string;
  factId: string;
  quadrant: Quadrant;
  matcherMatched: boolean;
  judgeMatched: boolean;
  judgeJustification: string;
  fact: Readonly<{
    id: string;
    description: string;
    canonical: string;
    pattern?: string | undefined;
    weight: number;
  }>;
  outputExcerpt: string; // ~440 chars around the candidate match
}>;

export type SampleSizes = Readonly<{
  /** matcher-fail/judge-pass sample size for comparison[0]. */
  mfjpPrimary: number;
  /** matcher-fail/judge-pass sample size for comparison[1]. */
  mfjpSecondary: number;
  bothPassed: number;
  // both-failed and matcher-pass-judge-fail are sampled exhaustively
}>;

export const DEFAULT_SAMPLE_SIZES: SampleSizes = {
  mfjpPrimary: 40,
  mfjpSecondary: 20,
  bothPassed: 15,
};

export type AnswerKey = Readonly<{
  rescoreSource: string;
  seed: number;
  sample: SampleSizes;
  generatedAt: string;
  cases: ReadonlyArray<
    Readonly<{
      caseIndex: number;
      runId: string;
      taskId: string;
      condition: string;
      factId: string;
      quadrant: Quadrant;
      matcherMatched: boolean;
      judgeMatched: boolean;
    }>
  >;
}>;

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32)
// ---------------------------------------------------------------------------

export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d_2b_79_f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const index_ = Math.floor(rng() * (index + 1));
    const a = out[index] as T;
    const b = out[index_] as T;
    out[index] = b;
    out[index_] = a;
  }
  return out;
}

function sampleN<T>(items: readonly T[], n: number, rng: () => number): T[] {
  if (n >= items.length) return [...items];
  return shuffle(items, rng).slice(0, n);
}

// ---------------------------------------------------------------------------
// Quadrant classification
// ---------------------------------------------------------------------------

export function classifyQuadrant(
  matcherMatched: boolean,
  judgeMatched: boolean,
): Quadrant {
  if (!matcherMatched && judgeMatched) return "matcher-fail-judge-pass";
  if (matcherMatched && !judgeMatched) return "matcher-pass-judge-fail";
  if (!matcherMatched && !judgeMatched) return "both-failed";
  return "both-passed";
}

// ---------------------------------------------------------------------------
// Excerpt extraction
// ---------------------------------------------------------------------------

const EXCERPT_RADIUS = 220;

function firstPattern(fact: AuditFact): string | undefined {
  if (fact.matcher.kind === "regex") return fact.matcher.pattern;
  if (fact.matcher.kind === "all-of") return fact.matcher.patterns[0];
  return undefined;
}

export function extractExcerpt(text: string, fact: AuditFact): string {
  // Prefer pattern match location; fall back to canonical substring;
  // final fallback to the first 440 chars of the output.
  let matchIndex = -1;
  const pattern = firstPattern(fact);
  if (pattern) {
    try {
      const re = new RegExp(pattern, "i");
      const m = re.exec(text);
      if (m) matchIndex = m.index;
    } catch {
      // bad regex — fall through
    }
  }
  if (matchIndex < 0) {
    const index = text.toLowerCase().indexOf(fact.canonical.toLowerCase());
    if (index !== -1) matchIndex = index;
  }
  if (matchIndex < 0) {
    // No anchor anywhere — try to find any entity or attribute name
    // referenced in the fact description as a soft anchor.
    const tokens = fact.description.match(/[A-Z][A-Za-z0-9]{2,}/g) ?? [];
    for (const tok of tokens) {
      const index = text.indexOf(tok);
      if (index !== -1) {
        matchIndex = index;
        break;
      }
    }
  }
  if (matchIndex < 0) {
    // Truly nothing — return the first 2 × radius chars with a marker.
    const head = text.slice(0, EXCERPT_RADIUS * 2);
    return `[no anchor in output — first ${head.length} chars shown]\n${head}`;
  }
  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(text.length, matchIndex + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Build candidate cases
// ---------------------------------------------------------------------------

type Candidate = Omit<CaseRecord, "caseIndex">;

function buildCandidates(
  input: AuditInput,
  rescore: RescoreOutput,
): Candidate[] {
  const taskIndex = new Map<
    string,
    {
      facts: ReadonlyMap<string, AuditFact>;
      texts: ReadonlyMap<string, string>;
    }
  >();
  for (const run of input.runs) {
    for (const task of run.tasks) {
      const facts = new Map(task.facts.map((f) => [f.id, f]));
      const texts = new Map(
        Object.entries(task.conditions).map(([name, c]) => [name, c.text]),
      );
      taskIndex.set(`${run.runId}|${task.taskId}`, { facts, texts });
    }
  }

  const candidates: Candidate[] = [];
  for (const entry of rescore.entries) {
    const data = taskIndex.get(`${entry.runId}|${entry.taskId}`);
    if (!data) continue;
    for (const condition of rescore.comparison) {
      const block = entry.conditions[condition];
      if (!block) continue;
      const text = data.texts.get(condition);
      if (text === undefined) continue;
      const judgeById = new Map(block.verdicts.map((v) => [v.factId, v]));
      for (const [factId, matcherMatched] of Object.entries(
        block.matcherVerdicts,
      )) {
        const judge = judgeById.get(factId);
        if (!judge) continue; // no judge verdict for this fact (rare)
        const fact = data.facts.get(factId);
        if (!fact) continue;
        const pattern = firstPattern(fact);
        candidates.push({
          runId: entry.runId,
          taskId: entry.taskId,
          condition,
          factId,
          quadrant: classifyQuadrant(matcherMatched, judge.matched),
          matcherMatched,
          judgeMatched: judge.matched,
          judgeJustification: judge.justification,
          fact: {
            id: fact.id,
            description: fact.description || fact.canonical,
            canonical: fact.canonical,
            ...(pattern ? { pattern } : {}),
            weight: fact.weight,
          },
          outputExcerpt: extractExcerpt(text, fact),
        });
      }
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Stratified sample
// ---------------------------------------------------------------------------

function stratifiedSample(
  candidates: readonly Candidate[],
  comparison: readonly [string, string],
  sample: SampleSizes,
  rng: () => number,
): Candidate[] {
  const [primary, secondary] = comparison;
  const byBucket = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = `${c.quadrant}:${c.condition}`;
    const array = byBucket.get(key) ?? [];
    array.push(c);
    byBucket.set(key, array);
  }

  const bothPassedAll = candidates.filter((c) => c.quadrant === "both-passed");
  const exhaustive = candidates.filter(
    (c) =>
      c.quadrant === "matcher-pass-judge-fail" || c.quadrant === "both-failed",
  );

  const out: Candidate[] = [
    ...sampleN(
      byBucket.get(`matcher-fail-judge-pass:${primary}`) ?? [],
      sample.mfjpPrimary,
      rng,
    ),
    ...sampleN(
      byBucket.get(`matcher-fail-judge-pass:${secondary}`) ?? [],
      sample.mfjpSecondary,
      rng,
    ),
    ...exhaustive,
    ...sampleN(bothPassedAll, sample.bothPassed, rng),
  ];

  // Final shuffle so quadrant blocks don't leak position cues.
  return shuffle(out, rng);
}

// ---------------------------------------------------------------------------
// Packet generation
// ---------------------------------------------------------------------------

export type AuditPacket = Readonly<{
  markdown: string;
  key: AnswerKey;
  cases: readonly CaseRecord[];
}>;

export function generateAuditPacket(args: {
  input: AuditInput;
  rescore: RescoreOutput;
  rescoreSource: string;
  seed?: number;
  sample?: Partial<SampleSizes>;
}): AuditPacket {
  const seed = args.seed ?? 1337;
  const sample: SampleSizes = { ...DEFAULT_SAMPLE_SIZES, ...args.sample };
  const candidates = buildCandidates(args.input, args.rescore);
  const rng = makeRng(seed);
  const sampled = stratifiedSample(
    candidates,
    args.rescore.comparison,
    sample,
    rng,
  );

  // Assign caseIndex (1-based) after final shuffle.
  const cases: CaseRecord[] = sampled.map((c, index) => ({
    ...c,
    caseIndex: index + 1,
  }));

  const key: AnswerKey = {
    rescoreSource: args.rescoreSource,
    seed,
    sample,
    generatedAt: new Date().toISOString(),
    cases: cases.map((c) => ({
      caseIndex: c.caseIndex,
      runId: c.runId,
      taskId: c.taskId,
      condition: c.condition,
      factId: c.factId,
      quadrant: c.quadrant,
      matcherMatched: c.matcherMatched,
      judgeMatched: c.judgeMatched,
    })),
  };

  return {
    markdown: renderPacket(cases, args.rescoreSource, seed, sample),
    key,
    cases,
  };
}

function renderPacket(
  cases: readonly CaseRecord[],
  rescoreSource: string,
  seed: number,
  sample: SampleSizes,
): string {
  const counts = new Map<Quadrant, number>();
  for (const c of cases)
    counts.set(c.quadrant, (counts.get(c.quadrant) ?? 0) + 1);

  const lines: string[] = [
    "# Human-audit packet — per-fact judge calibration\n",
    `Rescore source: \`${rescoreSource}\`  \nSeed: \`${seed}\`  \n` +
      `Sample design: mfjp-primary=${sample.mfjpPrimary}, ` +
      `mfjp-secondary=${sample.mfjpSecondary}, both-passed=${sample.bothPassed}; ` +
      `matcher-pass/judge-fail and both-failed sampled exhaustively\n`,
    "Quadrant counts in this packet: " +
      QUADRANTS.map((q) => `${q}=${counts.get(q) ?? 0}`).join(", ") +
      `  (total=${cases.length})\n`,
    "## How to use this packet\n",
    "Each case shows the reference fact, the matcher spec, the matcher " +
      "verdict, and a ~440-character excerpt of the model output around " +
      "the candidate match span. The judge verdict is hidden inside a " +
      "collapsible block.\n\n" +
      "**Label every `Your label` line with one of:** `PASS`, `FAIL`, " +
      "`AMBIGUOUS`, or `DISPUTE-RUBRIC` (the last meaning you think the " +
      "rubric itself is wrong on this case). Label *before* expanding " +
      "the judge verdict — that's the whole point of the audit. After " +
      "labeling, expand to see whether you and the judge agreed.\n\n" +
      "When done, run `scorer-audit audit-score --packet <this-file>` to " +
      "compute Cohen's κ and per-quadrant agreement.\n",
    "---\n",
  ];

  for (const c of cases) {
    lines.push(
      `## Case ${c.caseIndex} of ${cases.length}\n`,
      `Run: \`${c.runId.slice(0, 8)}\`  ` +
        `Condition: \`${c.condition}\`  ` +
        `Task: \`${c.taskId}\`  ` +
        `Fact: \`${c.factId}\`\n`,
      `**Reference fact**: ${c.fact.description}\n`,
      `**Canonical**: \`${c.fact.canonical}\`\n`,
      ...(c.fact.pattern ?
        [`**Matcher pattern**: \`${c.fact.pattern}\`\n`]
      : []),
      `**Matcher verdict**: ${c.matcherMatched ? "PASS" : "FAIL"}\n`,
      `**Model output excerpt** (around candidate match):\n`,
      "```",
      c.outputExcerpt,
      "```\n",
      `**Your label**: \`[ TODO ]\`  *(replace with PASS / FAIL / AMBIGUOUS / DISPUTE-RUBRIC)*\n`,
      `<details><summary>↓ Reveal judge verdict (label yours first)</summary>\n`,
      "",
      `Judge verdict: **${c.judgeMatched ? "PASS" : "FAIL"}**`,
      "",
      `Judge reason: ${c.judgeJustification}`,
      "",
      "</details>\n",
      "---\n",
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parse labels from the packet markdown
// ---------------------------------------------------------------------------

export function parseLabels(packetText: string): Map<number, Label> {
  // Each case has a header `## Case <N> of <M>` and a line beginning
  // with `**Your label**:`. Pair them up by walking the doc once.
  const labels = new Map<number, Label>();
  const lines = packetText.split("\n");
  let currentCase: number | undefined;
  for (const raw of lines) {
    const headerMatch = raw.match(/^##\s+Case\s+(\d+)\s+of\s+\d+/);
    if (headerMatch) {
      const caseString = headerMatch[1];
      currentCase = caseString ? Number.parseInt(caseString, 10) : undefined;
      continue;
    }
    if (currentCase !== undefined && raw.startsWith("**Your label**")) {
      const valueMatch = raw.match(/`\[?\s*([A-Z][A-Z-]*)\s*\]?`/);
      const value = valueMatch?.[1];
      if (!value) {
        labels.set(currentCase, "TODO");
        continue;
      }
      const upper = value.toUpperCase();
      if (
        upper === "PASS" ||
        upper === "FAIL" ||
        upper === "AMBIGUOUS" ||
        upper === "DISPUTE-RUBRIC" ||
        upper === "TODO"
      ) {
        labels.set(currentCase, upper);
      } else {
        labels.set(currentCase, "TODO");
      }
    }
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Cohen's κ on PASS/FAIL pairs (excluding AMBIGUOUS/DISPUTE/TODO)
// ---------------------------------------------------------------------------

export type LabelPair = Readonly<{
  author: "PASS" | "FAIL";
  judge: "PASS" | "FAIL";
}>;

export function cohensKappa(pairs: readonly LabelPair[]): {
  kappa: number;
  agreement: number;
  pe: number;
  n: number;
} {
  const n = pairs.length;
  if (n === 0) return { kappa: 0, agreement: 0, pe: 0, n: 0 };

  let agree = 0;
  let aPass = 0;
  let bPass = 0;
  for (const p of pairs) {
    if (p.author === p.judge) agree++;
    if (p.author === "PASS") aPass++;
    if (p.judge === "PASS") bPass++;
  }
  const po = agree / n;
  const pPassA = aPass / n;
  const pPassB = bPass / n;
  const pe = pPassA * pPassB + (1 - pPassA) * (1 - pPassB);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { kappa, agreement: po, pe, n };
}

export function kappaInterpretation(k: number): string {
  // Landis & Koch 1977 informal benchmarks; called out as informal so
  // the reader doesn't treat them as universal.
  if (k < 0)
    return "Interpretation (Landis & Koch, informal): worse than chance.";
  if (k < 0.2)
    return "Interpretation (Landis & Koch, informal): slight agreement.";
  if (k < 0.4)
    return "Interpretation (Landis & Koch, informal): fair agreement.";
  if (k < 0.6)
    return "Interpretation (Landis & Koch, informal): moderate agreement.";
  if (k < 0.8)
    return "Interpretation (Landis & Koch, informal): substantial agreement.";
  return "Interpretation (Landis & Koch, informal): almost-perfect agreement.";
}

// ---------------------------------------------------------------------------
// Agreement report
// ---------------------------------------------------------------------------

export function formatAuditScoreReport(
  key: AnswerKey,
  labels: ReadonlyMap<number, Label>,
): string {
  const lines: string[] = [
    "# Human-audit agreement report\n",
    `Source rescore: \`${key.rescoreSource}\`  \nPacket cases: ${key.cases.length}  \n` +
      `Generated: ${new Date().toISOString()}\n`,
  ];

  // Bucket the cases.
  type BucketCase = {
    caseIndex: number;
    label: Label;
    judgeMatched: boolean;
    matcherMatched: boolean;
    runId: string;
    factId: string;
    condition: string;
  };
  const buckets: Record<Quadrant, BucketCase[]> = {
    "matcher-fail-judge-pass": [],
    "matcher-pass-judge-fail": [],
    "both-failed": [],
    "both-passed": [],
  };
  for (const c of key.cases) {
    const label = labels.get(c.caseIndex) ?? "TODO";
    buckets[c.quadrant].push({
      caseIndex: c.caseIndex,
      label,
      judgeMatched: c.judgeMatched,
      matcherMatched: c.matcherMatched,
      runId: c.runId,
      factId: c.factId,
      condition: c.condition,
    });
  }

  // Counts of each label across the whole packet.
  const labelCounts = new Map<Label, number>();
  for (const v of labels.values())
    labelCounts.set(v, (labelCounts.get(v) ?? 0) + 1);

  lines.push("## Label distribution\n", "| Label | Count |\n|---|---|");
  for (const lbl of [
    "PASS",
    "FAIL",
    "AMBIGUOUS",
    "DISPUTE-RUBRIC",
    "TODO",
  ] as Label[]) {
    lines.push(`| ${lbl} | ${labelCounts.get(lbl) ?? 0} |`);
  }
  lines.push("");
  if ((labelCounts.get("TODO") ?? 0) > 0) {
    lines.push(
      `> ⚠ ${labelCounts.get("TODO") ?? 0} cases still labeled \`TODO\` — finish ` +
        `labeling those before treating this report as final.\n`,
    );
  }

  // Cohen's κ on PASS/FAIL pairs (drop AMBIGUOUS, DISPUTE-RUBRIC, TODO).
  const pairs: LabelPair[] = [];
  for (const c of key.cases) {
    const label = labels.get(c.caseIndex) ?? "TODO";
    if (label !== "PASS" && label !== "FAIL") continue;
    pairs.push({ author: label, judge: c.judgeMatched ? "PASS" : "FAIL" });
  }
  const k = cohensKappa(pairs);
  lines.push(
    "## Author vs judge — Cohen's κ\n",
    "Computed on cases where the author labeled PASS or FAIL. AMBIGUOUS and DISPUTE-RUBRIC labels are excluded from κ; their counts are reported above and below.\n",
    "| Metric | Value |\n|---|---|",
    `| n (PASS/FAIL pairs) | ${k.n} |`,
    `| Observed agreement (po) | ${(k.agreement * 100).toFixed(1)}% |`,
    `| Chance agreement (pe) | ${(k.pe * 100).toFixed(1)}% |`,
    `| **Cohen's κ** | **${k.kappa.toFixed(3)}** |`,
    "",
    kappaInterpretation(k.kappa),
    "",
    "## Per-quadrant agreement\n",
    "| Quadrant | n | author PASS | author FAIL | author AMBIGUOUS | author DISPUTE | TODO | Agree (PASS/FAIL only) |\n" +
      "|---|---|---|---|---|---|---|---|",
  );
  for (const q of QUADRANTS) {
    const cases = buckets[q];
    const n = cases.length;
    const counts = {
      PASS: 0,
      FAIL: 0,
      AMBIGUOUS: 0,
      "DISPUTE-RUBRIC": 0,
      TODO: 0,
    } as Record<Label, number>;
    let agreed = 0;
    let scored = 0;
    for (const c of cases) {
      counts[c.label]++;
      if (c.label === "PASS" || c.label === "FAIL") {
        scored++;
        const judgeLabel: Label = c.judgeMatched ? "PASS" : "FAIL";
        if (c.label === judgeLabel) agreed++;
      }
    }
    const agreeString =
      scored === 0 ? "—" : (
        `${agreed}/${scored} (${((agreed / scored) * 100).toFixed(1)}%)`
      );
    lines.push(
      `| ${q} | ${n} | ${counts.PASS} | ${counts.FAIL} | ${counts.AMBIGUOUS} | ${counts["DISPUTE-RUBRIC"]} | ${counts.TODO} | ${agreeString} |`,
    );
  }
  lines.push("");

  // Headline number — the load-bearing quadrant.
  const mfjp = buckets["matcher-fail-judge-pass"];
  let mfjpAgree = 0;
  let mfjpScored = 0;
  for (const c of mfjp) {
    if (c.label === "PASS" || c.label === "FAIL") {
      mfjpScored++;
      if (c.label === "PASS") mfjpAgree++; // judge said PASS by definition of this quadrant
    }
  }
  lines.push("## Headline\n");
  if (mfjpScored === 0) {
    lines.push(
      "> Insufficient labels in the matcher-fail/judge-pass quadrant to report a headline number.\n",
    );
  } else {
    const pct = ((mfjpAgree / mfjpScored) * 100).toFixed(1);
    lines.push(
      `> On a stratified human audit of ${pairs.length} fact-verdicts ` +
        `(judge verdicts hidden during labeling), the auditor confirmed ` +
        `the per-fact judge on **${mfjpAgree} of ${mfjpScored} (${pct}%)** ` +
        `cases in the load-bearing matcher-fail/judge-pass quadrant. ` +
        `Cohen's κ across the full PASS/FAIL sample = **${k.kappa.toFixed(3)}**.\n`,
    );
  }

  // Disagreements list — every case where author and judge disagree on PASS/FAIL.
  const disagreements: Array<BucketCase & { quadrant: Quadrant }> = [];
  for (const q of QUADRANTS) {
    for (const c of buckets[q]) {
      if (c.label !== "PASS" && c.label !== "FAIL") continue;
      const judgeLabel: Label = c.judgeMatched ? "PASS" : "FAIL";
      if (c.label !== judgeLabel) disagreements.push({ ...c, quadrant: q });
    }
  }
  lines.push(`## Disagreements (${disagreements.length})\n`);
  if (disagreements.length === 0) {
    lines.push(
      "None — author and judge fully agreed on every PASS/FAIL labeled case.\n",
    );
  } else {
    lines.push(
      "| Case | Quadrant | Run | Condition | Fact | Author | Judge |\n|---|---|---|---|---|---|---|",
    );
    for (const c of disagreements) {
      const judgeLabel = c.judgeMatched ? "PASS" : "FAIL";
      lines.push(
        `| ${c.caseIndex} | ${c.quadrant} | ${c.runId.slice(0, 8)} | ${c.condition} | ${c.factId} | ${c.label} | ${judgeLabel} |`,
      );
    }
    lines.push("");
  }

  // Cases the author flagged as DISPUTE-RUBRIC — these are signal that
  // the rubric needs revisiting.
  const disputed: Array<BucketCase & { quadrant: Quadrant }> = [];
  for (const q of QUADRANTS) {
    for (const c of buckets[q]) {
      if (c.label === "DISPUTE-RUBRIC") disputed.push({ ...c, quadrant: q });
    }
  }
  lines.push(`## Rubric disputes (${disputed.length})\n`);
  if (disputed.length === 0) {
    lines.push("None.\n");
  } else {
    lines.push(
      "Cases the author flagged as DISPUTE-RUBRIC. These suggest the rubric or the reference fact itself may need revisiting.\n",
      "| Case | Quadrant | Run | Condition | Fact |\n|---|---|---|---|---|",
    );
    for (const d of disputed) {
      lines.push(
        `| ${d.caseIndex} | ${d.quadrant} | ${d.runId.slice(0, 8)} | ${d.condition} | ${d.factId} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
