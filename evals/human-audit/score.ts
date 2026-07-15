/**
 * Reads a labeled human-audit packet (the `<stem>.md` produced by
 * `generate.ts` with `Your label` lines filled in) plus the matching
 * `<stem>.key.json`, and produces an agreement report:
 *
 *   - Cohen's κ between author labels and judge verdicts (PASS/FAIL only)
 *   - Per-quadrant agreement rates
 *   - Headline numbers ("Of N judge-passed cases the author also
 *     passed, X / N = Y%") for the post
 *   - List of every disagreement with case index for follow-up
 *
 * Also reports counts of `AMBIGUOUS` and `DISPUTE-RUBRIC` labels
 * separately from the κ calculation — those are signal that the
 * methodology has edge cases worth naming in the post.
 *
 * Usage:
 *
 *   pnpm eval:audit-score --packet evals/human-audit/<stem>.md
 *   pnpm eval:audit-score --packet <md> --key <key.json>
 */
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

type Quadrant =
  | "regex-fail-judge-pass"
  | "regex-pass-judge-fail"
  | "both-failed"
  | "both-passed";

type AnswerKey = Readonly<{
  rescoreSource: string;
  seed: number;
  sample: Readonly<{ rfjpHarness: number; rfjpBaseline: number; bothPassed: number }>;
  generatedAt: string;
  cases: ReadonlyArray<
    Readonly<{
      caseIndex: number;
      runId: string;
      taskId: string;
      mode: "harness" | "baseline";
      factId: string;
      quadrant: Quadrant;
      regexMatched: boolean;
      judgeMatched: boolean;
    }>
  >;
}>;

type Label = "PASS" | "FAIL" | "AMBIGUOUS" | "DISPUTE-RUBRIC" | "TODO";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Options = Readonly<{ packetPath: string; keyPath?: string; outPath?: string }>;

function parseArgs(argv: readonly string[]): Options {
  let packetPath: string | undefined;
  let keyPath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--packet") packetPath = argv[++i];
    else if (arg === "--key") keyPath = argv[++i];
    else if (arg === "--out") outPath = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: pnpm eval:audit-score --packet <path-to-packet.md> [--key <path>] [--out <path>]",
      );
      process.exit(0);
    }
  }
  if (!packetPath) {
    throw new Error("--packet <file> is required");
  }
  const opts: { packetPath: string; keyPath?: string; outPath?: string } = {
    packetPath,
  };
  if (keyPath) opts.keyPath = keyPath;
  if (outPath) opts.outPath = outPath;
  return opts;
}

// ---------------------------------------------------------------------------
// Parse labels from the packet markdown
// ---------------------------------------------------------------------------

function parseLabels(packetText: string): Map<number, Label> {
  // Each case has a header `## Case <N> of <M>` and a line beginning
  // with `**Your label**:`. Pair them up by walking the doc once.
  const labels = new Map<number, Label>();
  const lines = packetText.split("\n");
  let currentCase: number | null = null;
  for (const raw of lines) {
    const headerMatch = raw.match(/^##\s+Case\s+(\d+)\s+of\s+\d+/);
    if (headerMatch) {
      const caseStr = headerMatch[1];
      currentCase = caseStr ? Number.parseInt(caseStr, 10) : null;
      continue;
    }
    if (currentCase != null && raw.startsWith("**Your label**")) {
      const valueMatch = raw.match(/`\[?\s*([A-Z][A-Z-]*)\s*\]?`/);
      const value = valueMatch?.[1];
      if (!value) {
        console.warn(`  [warn] case ${currentCase}: could not parse label from line: ${raw.trim()}`);
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
        console.warn(`  [warn] case ${currentCase}: unrecognized label "${value}"`);
        labels.set(currentCase, "TODO");
      }
    }
  }
  return labels;
}

// ---------------------------------------------------------------------------
// Cohen's κ on PASS/FAIL pairs (excluding AMBIGUOUS/DISPUTE/TODO)
// ---------------------------------------------------------------------------

type Pair = Readonly<{ author: "PASS" | "FAIL"; judge: "PASS" | "FAIL" }>;

function cohensKappa(pairs: readonly Pair[]): {
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

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(
  key: AnswerKey,
  labels: ReadonlyMap<number, Label>,
): string {
  const lines: string[] = [];
  lines.push("# Human-audit agreement report\n");
  lines.push(
    `Source rescore: \`${key.rescoreSource}\`  \nPacket cases: ${key.cases.length}  \n` +
      `Generated: ${new Date().toISOString()}\n`,
  );

  // Bucket the cases.
  const buckets: Record<
    Quadrant,
    {
      caseIndex: number;
      label: Label;
      judgeMatched: boolean;
      regexMatched: boolean;
      runId: string;
      factId: string;
      mode: "harness" | "baseline";
    }[]
  > = {
    "regex-fail-judge-pass": [],
    "regex-pass-judge-fail": [],
    "both-failed": [],
    "both-passed": [],
  };
  for (const c of key.cases) {
    const label = labels.get(c.caseIndex) ?? "TODO";
    buckets[c.quadrant].push({
      caseIndex: c.caseIndex,
      label,
      judgeMatched: c.judgeMatched,
      regexMatched: c.regexMatched,
      runId: c.runId,
      factId: c.factId,
      mode: c.mode,
    });
  }

  // Counts of each label across the whole packet.
  const labelCounts = new Map<Label, number>();
  for (const v of labels.values()) labelCounts.set(v, (labelCounts.get(v) ?? 0) + 1);

  lines.push("## Label distribution\n");
  lines.push("| Label | Count |\n|---|---|");
  for (const lbl of ["PASS", "FAIL", "AMBIGUOUS", "DISPUTE-RUBRIC", "TODO"] as Label[]) {
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
  const pairs: Pair[] = [];
  for (const c of key.cases) {
    const label = labels.get(c.caseIndex) ?? "TODO";
    if (label !== "PASS" && label !== "FAIL") continue;
    pairs.push({ author: label, judge: c.judgeMatched ? "PASS" : "FAIL" });
  }
  const k = cohensKappa(pairs);
  lines.push("## Author vs judge — Cohen's κ\n");
  lines.push("Computed on cases where the author labeled PASS or FAIL. AMBIGUOUS and DISPUTE-RUBRIC labels are excluded from κ; their counts are reported above and below.\n");
  lines.push("| Metric | Value |\n|---|---|");
  lines.push(`| n (PASS/FAIL pairs) | ${k.n} |`);
  lines.push(`| Observed agreement (po) | ${(k.agreement * 100).toFixed(1)}% |`);
  lines.push(`| Chance agreement (pe) | ${(k.pe * 100).toFixed(1)}% |`);
  lines.push(`| **Cohen's κ** | **${k.kappa.toFixed(3)}** |`);
  lines.push("");
  lines.push(kappaInterpretation(k.kappa));
  lines.push("");

  // Per-quadrant agreement.
  lines.push("## Per-quadrant agreement\n");
  lines.push(
    "| Quadrant | n | author PASS | author FAIL | author AMBIGUOUS | author DISPUTE | TODO | Agree (PASS/FAIL only) |\n" +
      "|---|---|---|---|---|---|---|---|",
  );
  for (const q of [
    "regex-fail-judge-pass",
    "regex-pass-judge-fail",
    "both-failed",
    "both-passed",
  ] as Quadrant[]) {
    const cases = buckets[q];
    const n = cases.length;
    const counts = { PASS: 0, FAIL: 0, AMBIGUOUS: 0, "DISPUTE-RUBRIC": 0, TODO: 0 } as Record<Label, number>;
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
    const agreeStr = scored === 0 ? "—" : `${agreed}/${scored} (${((agreed / scored) * 100).toFixed(1)}%)`;
    lines.push(
      `| ${q} | ${n} | ${counts.PASS} | ${counts.FAIL} | ${counts.AMBIGUOUS} | ${counts["DISPUTE-RUBRIC"]} | ${counts.TODO} | ${agreeStr} |`,
    );
  }
  lines.push("");

  // Headline number for the post — load-bearing quadrant.
  const rfjp = buckets["regex-fail-judge-pass"];
  let rfjpAgree = 0;
  let rfjpScored = 0;
  for (const c of rfjp) {
    if (c.label === "PASS" || c.label === "FAIL") {
      rfjpScored++;
      if (c.label === "PASS") rfjpAgree++; // judge said PASS by definition of this quadrant
    }
  }
  lines.push("## Headline for the post\n");
  if (rfjpScored === 0) {
    lines.push("> Insufficient labels in the regex-fail/judge-pass quadrant to report a headline number.\n");
  } else {
    const pct = ((rfjpAgree / rfjpScored) * 100).toFixed(1);
    lines.push(
      `> On a stratified human audit of ${pairs.length} fact-verdicts ` +
        `(judge verdicts hidden during labeling), the author confirmed ` +
        `the per-fact judge on **${rfjpAgree} of ${rfjpScored} (${pct}%)** ` +
        `cases in the load-bearing regex-fail/judge-pass quadrant. ` +
        `Cohen's κ across the full PASS/FAIL sample = **${k.kappa.toFixed(3)}**.\n`,
    );
  }

  // Disagreements list — every case where author and judge disagree on PASS/FAIL.
  const disagreements: typeof buckets[Quadrant] = [];
  for (const q of Object.keys(buckets) as Quadrant[]) {
    for (const c of buckets[q]) {
      if (c.label !== "PASS" && c.label !== "FAIL") continue;
      const judgeLabel: Label = c.judgeMatched ? "PASS" : "FAIL";
      if (c.label !== judgeLabel) disagreements.push(c);
    }
  }
  lines.push(`## Disagreements (${disagreements.length})\n`);
  if (disagreements.length === 0) {
    lines.push("None — author and judge fully agreed on every PASS/FAIL labeled case.\n");
  } else {
    lines.push("| Case | Quadrant | Run | Mode | Fact | Author | Judge |\n|---|---|---|---|---|---|---|");
    for (const c of disagreements) {
      const judgeLabel = c.judgeMatched ? "PASS" : "FAIL";
      const quadrant =
        Object.entries(buckets).find(([, arr]) => arr.includes(c))?.[0] ?? "?";
      lines.push(
        `| ${c.caseIndex} | ${quadrant} | ${c.runId.slice(0, 8)} | ${c.mode} | ${c.factId} | ${c.label} | ${judgeLabel} |`,
      );
    }
    lines.push("");
  }

  // Cases the author flagged as DISPUTE-RUBRIC — these are signal that
  // the rubric needs revisiting.
  const disputed: { caseIndex: number; quadrant: Quadrant; runId: string; factId: string; mode: "harness" | "baseline" }[] = [];
  for (const q of Object.keys(buckets) as Quadrant[]) {
    for (const c of buckets[q]) {
      if (c.label === "DISPUTE-RUBRIC") {
        disputed.push({ caseIndex: c.caseIndex, quadrant: q, runId: c.runId, factId: c.factId, mode: c.mode });
      }
    }
  }
  lines.push(`## Rubric disputes (${disputed.length})\n`);
  if (disputed.length === 0) {
    lines.push("None.\n");
  } else {
    lines.push("Cases the author flagged as DISPUTE-RUBRIC. These suggest the rubric or the reference fact itself may need revisiting.\n");
    lines.push("| Case | Quadrant | Run | Mode | Fact |\n|---|---|---|---|---|");
    for (const d of disputed) {
      lines.push(`| ${d.caseIndex} | ${d.quadrant} | ${d.runId.slice(0, 8)} | ${d.mode} | ${d.factId} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function kappaInterpretation(k: number): string {
  // Landis & Koch 1977 informal benchmarks; called out as informal so
  // the reader doesn't treat them as universal.
  if (k < 0) return "Interpretation (Landis & Koch, informal): worse than chance.";
  if (k < 0.2) return "Interpretation (Landis & Koch, informal): slight agreement.";
  if (k < 0.4) return "Interpretation (Landis & Koch, informal): fair agreement.";
  if (k < 0.6) return "Interpretation (Landis & Koch, informal): moderate agreement.";
  if (k < 0.8) return "Interpretation (Landis & Koch, informal): substantial agreement.";
  return "Interpretation (Landis & Koch, informal): almost-perfect agreement.";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const packetText = readFileSync(opts.packetPath, "utf-8");
  const keyPath = opts.keyPath ?? opts.packetPath.replace(/\.md$/, ".key.json");
  const key: AnswerKey = JSON.parse(readFileSync(keyPath, "utf-8"));
  const labels = parseLabels(packetText);

  const out = report(key, labels);
  const outPath = opts.outPath ?? join(dirname(opts.packetPath), `${opts.packetPath.replace(/\.md$/, "").split("/").pop()}.report.md`);
  writeFileSync(outPath, out);

  console.log(`Wrote ${outPath}`);
  console.log("\n" + out);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
