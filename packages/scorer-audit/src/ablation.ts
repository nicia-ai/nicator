/**
 * Matcher-design ablation.
 *
 * Sweeps matcher variants over the same agent outputs and compares the
 * comparative gap (comparison[0] − comparison[1]) under each variant,
 * optionally against a per-fact LLM-judge reference from a rescore
 * output. Closes the "you used a bad regex" objection: if the gap
 * collapses as the matcher becomes more permissive, the original
 * measurement was a matcher-specific bug; if it survives across matcher
 * generations and only the judge closes it, the surface-form-scoring
 * family claim holds.
 */
import {
  DEFAULT_VARIANTS,
  type FactVerdict,
  type MatcherVariant,
  matchUnderVariant,
  variantLabel,
  weightedScore,
} from "./matchers.js";
import type { AuditInput, RescoreOutput } from "./schema.js";
import { mean, pairedTTest } from "./stats.js";

export const JUDGE_VARIANT_LABEL = "judge";

// ---------------------------------------------------------------------------
// Judge reference — per-fact verdicts from a rescore output
// ---------------------------------------------------------------------------

/** Keyed `runId|taskId|condition` → factId → judge verdict. */
export type JudgeReference = ReadonlyMap<string, ReadonlyMap<string, boolean>>;

export function judgeReferenceFromRescore(
  rescore: RescoreOutput,
): JudgeReference {
  const out = new Map<string, Map<string, boolean>>();
  for (const entry of rescore.entries) {
    for (const [condition, block] of Object.entries(entry.conditions)) {
      const verdicts = new Map<string, boolean>();
      for (const v of block.verdicts) verdicts.set(v.factId, v.matched);
      out.set(`${entry.runId}|${entry.taskId}|${condition}`, verdicts);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-fact rows
// ---------------------------------------------------------------------------

type PerFactRow = Readonly<{
  runId: string;
  taskId: string;
  condition: string;
  factId: string;
  weight: number;
  expected: "present" | "absent";
  /** Variant label → matched. `judge` may be undefined without a reference. */
  matches: Readonly<Record<string, boolean | undefined>>;
}>;

function scoreRows(rows: readonly PerFactRow[], label: string): number {
  const verdicts: FactVerdict[] = [];
  for (const row of rows) {
    const matched = row.matches[label];
    if (matched === undefined) continue;
    verdicts.push({
      factId: row.factId,
      matched,
      expected: row.expected,
      weight: row.weight,
    });
  }
  return weightedScore(verdicts);
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type VariantSummary = Readonly<{
  variant: string;
  perRun: ReadonlyArray<{
    runId: string;
    a: number;
    b: number;
    delta: number;
  }>;
  aMean: number;
  bMean: number;
  deltaMean: number;
  deltaCi95Lower: number;
  deltaCi95Upper: number;
  deltaPValue: number;
  deltaSignificant: boolean;
}>;

export type SanityCheck = Readonly<{
  runId: string;
  taskId: string;
  condition: string;
  reproduced: boolean;
  ablation: number;
  recorded: number;
}>;

export type FactCategoryCounts = Readonly<{
  bothPass: number;
  variantOnlyPass: number;
  judgeOnlyPass: number;
  bothFail: number;
}>;

export type AblationResult = Readonly<{
  comparison: readonly [string, string];
  runIds: readonly string[];
  variantLabels: readonly string[];
  summaries: readonly VariantSummary[];
  sanity: readonly SanityCheck[];
  vsJudge?: Readonly<Record<string, Record<string, FactCategoryCounts>>>;
}>;

// ---------------------------------------------------------------------------
// Ablation
// ---------------------------------------------------------------------------

export function runAblation(args: {
  input: AuditInput;
  variants?: readonly MatcherVariant[];
  judge?: JudgeReference;
}): AblationResult {
  const { input, judge } = args;
  const variants = args.variants ?? DEFAULT_VARIANTS;
  const [condA, condB] = input.comparison;
  const variantLabels = variants.map((variant) => variantLabel(variant));
  const allLabels =
    judge ? [...variantLabels, JUDGE_VARIANT_LABEL] : variantLabels;

  const rows: PerFactRow[] = [];
  const sanity: SanityCheck[] = [];
  const runIds: string[] = [];

  for (const run of input.runs) {
    let runHasRows = false;
    for (const task of run.tasks) {
      for (const condition of input.comparison) {
        const output = task.conditions[condition];
        if (!output) continue;
        runHasRows = true;
        const judgeVerdicts = judge?.get(
          `${run.runId}|${task.taskId}|${condition}`,
        );
        const conditionRows: PerFactRow[] = task.facts.map((fact) => {
          const matches: Record<string, boolean | undefined> = {};
          for (const [index, variant] of variants.entries()) {
            const label = variantLabels[index];
            if (label === undefined) continue;
            matches[label] = matchUnderVariant(variant, fact, output.text);
          }
          matches[JUDGE_VARIANT_LABEL] = judgeVerdicts?.get(fact.id);
          return {
            runId: run.runId,
            taskId: task.taskId,
            condition,
            factId: fact.id,
            weight: fact.weight,
            expected: fact.expected,
            matches,
          };
        });
        rows.push(...conditionRows);

        // Sanity: `original` must reproduce the recorded scorer output.
        const recorded =
          output.recordedScore ??
          (output.recordedVerdicts ?
            weightedScore(
              task.facts.map((fact) => ({
                factId: fact.id,
                matched: output.recordedVerdicts?.[fact.id] ?? false,
                expected: fact.expected,
                weight: fact.weight,
              })),
            )
          : undefined);
        if (recorded !== undefined) {
          const ablation = scoreRows(conditionRows, "original");
          sanity.push({
            runId: run.runId,
            taskId: task.taskId,
            condition,
            reproduced: Math.abs(ablation - recorded) < 0.005,
            ablation,
            recorded,
          });
        }
      }
    }
    if (runHasRows) runIds.push(run.runId);
  }

  const summaries = allLabels.map((label) =>
    summarizeVariant(label, rows, runIds, condA, condB),
  );

  const result: {
    comparison: readonly [string, string];
    runIds: readonly string[];
    variantLabels: readonly string[];
    summaries: readonly VariantSummary[];
    sanity: readonly SanityCheck[];
    vsJudge?: Readonly<Record<string, Record<string, FactCategoryCounts>>>;
  } = {
    comparison: input.comparison,
    runIds,
    variantLabels: allLabels,
    summaries,
    sanity,
  };

  if (judge) {
    const vsJudge: Record<string, Record<string, FactCategoryCounts>> = {};
    for (const condition of input.comparison) {
      const conditionRows = rows.filter((r) => r.condition === condition);
      const byVariant: Record<string, FactCategoryCounts> = {};
      for (const label of variantLabels) {
        byVariant[label] = compareToJudge(conditionRows, label);
      }
      vsJudge[condition] = byVariant;
    }
    result.vsJudge = vsJudge;
  }

  return result;
}

function summarizeVariant(
  label: string,
  rows: readonly PerFactRow[],
  runIds: readonly string[],
  condA: string,
  condB: string,
): VariantSummary {
  const perRun: Array<{ runId: string; a: number; b: number; delta: number }> =
    [];
  for (const runId of runIds) {
    const a = scoreRows(
      rows.filter((r) => r.runId === runId && r.condition === condA),
      label,
    );
    const b = scoreRows(
      rows.filter((r) => r.runId === runId && r.condition === condB),
      label,
    );
    perRun.push({ runId, a, b, delta: a - b });
  }
  const test = pairedTTest(
    perRun.map((r) => r.a),
    perRun.map((r) => r.b),
  );
  return {
    variant: label,
    perRun,
    aMean: mean(perRun.map((r) => r.a)),
    bMean: mean(perRun.map((r) => r.b)),
    deltaMean: mean(perRun.map((r) => r.delta)),
    deltaCi95Lower: test.ci95Lower ?? 0,
    deltaCi95Upper: test.ci95Upper ?? 0,
    deltaPValue: test.pValue,
    deltaSignificant: test.significant,
  };
}

export function compareToJudge(
  rows: readonly PerFactRow[],
  label: string,
): FactCategoryCounts {
  let bothPass = 0;
  let variantOnlyPass = 0;
  let judgeOnlyPass = 0;
  let bothFail = 0;
  for (const row of rows) {
    const judgeMatched = row.matches[JUDGE_VARIANT_LABEL];
    const variantMatched = row.matches[label];
    if (judgeMatched === undefined || variantMatched === undefined) continue;
    const judgePassed =
      row.expected === "absent" ? !judgeMatched : judgeMatched;
    const variantPassed =
      row.expected === "absent" ? !variantMatched : variantMatched;
    if (judgePassed && variantPassed) bothPass++;
    else if (!judgePassed && variantPassed) variantOnlyPass++;
    else if (judgePassed && !variantPassed) judgeOnlyPass++;
    else bothFail++;
  }
  return { bothPass, variantOnlyPass, judgeOnlyPass, bothFail };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function sign(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
}

export function formatAblationReport(result: AblationResult): string {
  const [condA, condB] = result.comparison;
  const lines: string[] = [
    "# Matcher-design ablation\n",
    `Runs: ${result.runIds.map((r) => `\`${r.slice(0, 8)}\``).join(", ")} · ` +
      `Gap: ${condA} − ${condB}\n`,
    "## What this measures\n\n" +
      "Same agent outputs, varied matcher. The comparative gap under each " +
      "matcher tells us whether the original measurement is a property of " +
      "the matcher spec specifically or of surface-form scoring in general. " +
      "If the gap collapses as the matcher becomes more permissive, the " +
      "original finding narrows to 'this matcher was wrong.' If the gap " +
      "survives across matcher generations and only the LLM judge closes " +
      "it, the surface-form-family claim holds.\n",
  ];

  if (result.sanity.length > 0) {
    lines.push(
      "## Sanity check — `original` must reproduce recorded scores\n",
      "| Run | Task | Condition | Ablation | Recorded | Match |",
      "|---|---|---|---|---|---|",
    );
    for (const s of result.sanity) {
      lines.push(
        `| ${s.runId.slice(0, 8)} | ${s.taskId} | ${s.condition} | ${s.ablation.toFixed(3)} | ${s.recorded.toFixed(3)} | ${s.reproduced ? "✓" : "✗"} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    `## Comparative gap ${condA}−${condB} under each matcher\n`,
    `| Variant | ${condA} mean | ${condB} mean | Δ | Δ 95% CI | p (paired t) |`,
    "|---|---|---|---|---|---|",
  );
  for (const s of result.summaries) {
    lines.push(
      `| \`${s.variant}\` | ${s.aMean.toFixed(3)} | ${s.bMean.toFixed(3)} | ${sign(s.deltaMean)} | [${sign(s.deltaCi95Lower)}, ${sign(s.deltaCi95Upper)}] | ${s.deltaPValue.toFixed(3)}${s.deltaSignificant ? " *" : ""} |`,
    );
  }
  lines.push(
    "",
    "Δ 95% CI and p are from a two-tailed paired t-test on per-run deltas " +
      "(t-distribution, df = runs − 1). `*` marks p < .05. Gaps whose CI " +
      "includes zero are not statistically distinguishable from zero at " +
      "this run count.\n",
    "## Per-run breakdown\n",
  );
  for (const s of result.summaries) {
    lines.push(
      `### \`${s.variant}\`\n`,
      `| Run | ${condA} | ${condB} | Δ |`,
      "|---|---|---|---|",
    );
    for (const r of s.perRun) {
      lines.push(
        `| ${r.runId.slice(0, 8)} | ${r.a.toFixed(3)} | ${r.b.toFixed(3)} | ${sign(r.delta)} |`,
      );
    }
    lines.push("");
  }

  if (result.vsJudge) {
    lines.push(
      "## Per-variant agreement with LLM judge (fact-verdict level)\n",
      "Aggregated across all (run, fact) pairs. `Variant-only pass` are " +
        "facts the matcher accepted but the judge rejected (false positives " +
        "of the matcher); `Judge-only pass` are facts the judge accepted but " +
        "the matcher rejected (the surface-form false-negative bucket).\n",
    );
    for (const condition of result.comparison) {
      const byVariant = result.vsJudge[condition];
      if (!byVariant) continue;
      lines.push(
        `### ${condition} side\n`,
        "| Variant | Both pass | Variant-only pass | Judge-only pass | Both fail |",
        "|---|---|---|---|---|",
      );
      for (const label of result.variantLabels) {
        if (label === JUDGE_VARIANT_LABEL) continue;
        const c = byVariant[label];
        if (!c) continue;
        lines.push(
          `| \`${label}\` | ${c.bothPass} | ${c.variantOnlyPass} | ${c.judgeOnlyPass} | ${c.bothFail} |`,
        );
      }
      lines.push("");
    }
  }

  lines.push(
    "## Reading\n",
    "- If the widened-proximity variants show the comparative gap " +
      "shrinking monotonically toward the `judge` row, the matcher's " +
      "proximity window is the principal driver of the artifact.\n" +
      "- If `no-proximity` shows the gap close to the `judge` row, the " +
      "issue is contiguity-anchoring specifically, not proximity per se.\n" +
      "- If `substring-canonical` / `bag-of-tokens` show large gaps " +
      "relative to `judge`, surface-form sensitivity to canonical phrasing " +
      "is the bigger driver than proximity.\n" +
      "- If the gap is roughly stable across all matcher variants and only " +
      "`judge` closes it, the strong-form 'surface-form scoring family is " +
      "structurally undercounting' claim survives.\n",
  );

  return lines.join("\n") + "\n";
}
