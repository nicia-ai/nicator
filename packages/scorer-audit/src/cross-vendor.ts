/**
 * Cross-vendor per-fact judge spot-check.
 *
 * Re-runs the per-fact judge using a different vendor's model via any
 * OpenAI-compatible Chat Completions HTTP endpoint, with the same prompt
 * the primary judge uses, then compares verdicts to a reference rescore
 * output. Closes the "one vendor judging its own outputs" bias critique.
 *
 * No SDK dependency: uses the built-in `fetch`.
 */
import { type JudgeCall, runPerFactJudge } from "./judge.js";
import type { AuditInput, RescoreOutput, RescoreVerdict } from "./schema.js";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_VENDOR_MODEL = "gpt-5";

// ---------------------------------------------------------------------------
// OpenAI-compatible transport
// ---------------------------------------------------------------------------

export function createOpenAiCompatibleJudgeCall(options: {
  model: string;
  apiKey: string;
  baseUrl?: string;
}): JudgeCall {
  const baseUrl = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(
    /\/$/,
    "",
  );
  return async (system, user) => {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // Some vendors ignore temperature; the parsing layer enforces
      // structure via the system-prompt contract, so deterministic
      // decoding is best-effort.
      temperature: 0,
    };

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(
        `Vendor judge call failed (${res.status} ${res.statusText}): ${errorText.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("Vendor judge returned empty content");
    return text;
  };
}

// ---------------------------------------------------------------------------
// Spot-check
// ---------------------------------------------------------------------------

export type SpotCheckJob = Readonly<{
  runId: string;
  taskId: string;
  condition: string;
}>;

export type SpotCheckResult = Readonly<{
  runId: string;
  taskId: string;
  condition: string;
  vendorJudgeModel: string;
  vendorVerdicts: readonly RescoreVerdict[];
  referenceVerdicts: readonly RescoreVerdict[];
  agreement: number; // fraction of facts where vendor and reference agree
  agreedCount: number;
  totalCount: number;
  vendorPassRate: number;
  referencePassRate: number;
  disagreements: ReadonlyArray<
    Readonly<{
      factId: string;
      vendor: boolean;
      reference: boolean;
      vendorJustification: string;
      referenceJustification: string;
    }>
  >;
}>;

export function compareVerdicts(
  vendor: readonly RescoreVerdict[],
  reference: readonly RescoreVerdict[],
  job: SpotCheckJob,
  vendorJudgeModel: string,
): SpotCheckResult {
  const refByFact = new Map(reference.map((v) => [v.factId, v]));
  let agreedCount = 0;
  let vendorPass = 0;
  let referencePass = 0;
  const disagreements: SpotCheckResult["disagreements"][number][] = [];
  for (const v of vendor) {
    const r = refByFact.get(v.factId);
    if (!r) continue;
    if (v.matched) vendorPass++;
    if (r.matched) referencePass++;
    if (v.matched === r.matched) {
      agreedCount++;
    } else {
      disagreements.push({
        factId: v.factId,
        vendor: v.matched,
        reference: r.matched,
        vendorJustification: v.justification,
        referenceJustification: r.justification,
      });
    }
  }
  const total = vendor.length;
  return {
    ...job,
    vendorJudgeModel,
    vendorVerdicts: vendor,
    referenceVerdicts: reference,
    agreement: total === 0 ? 0 : agreedCount / total,
    agreedCount,
    totalCount: total,
    vendorPassRate: total === 0 ? 0 : vendorPass / total,
    referencePassRate: total === 0 ? 0 : referencePass / total,
    disagreements,
  };
}

/** Resolve the (run, task, condition) jobs a selection describes. */
export function resolveSpotCheckJobs(
  rescore: RescoreOutput,
  selection:
    | "single"
    | "all"
    | Readonly<{ runs: readonly string[]; conditions: readonly string[] }>,
): SpotCheckJob[] {
  const jobs: SpotCheckJob[] = [];
  if (selection === "single") {
    const first = rescore.entries[0];
    const condition = rescore.comparison[0];
    if (first && first.conditions[condition]) {
      jobs.push({ runId: first.runId, taskId: first.taskId, condition });
    }
    return jobs;
  }
  if (selection === "all") {
    for (const entry of rescore.entries) {
      for (const condition of rescore.comparison) {
        if (entry.conditions[condition]) {
          jobs.push({ runId: entry.runId, taskId: entry.taskId, condition });
        }
      }
    }
    return jobs;
  }
  const wantedRuns = new Set(selection.runs);
  const conditions =
    selection.conditions.length > 0 ?
      selection.conditions
    : [rescore.comparison[0]];
  for (const entry of rescore.entries) {
    if (wantedRuns.size > 0 && !runMatches(wantedRuns, entry.runId)) continue;
    for (const condition of conditions) {
      if (entry.conditions[condition]) {
        jobs.push({ runId: entry.runId, taskId: entry.taskId, condition });
      }
    }
  }
  return jobs;
}

function runMatches(wanted: ReadonlySet<string>, runId: string): boolean {
  if (wanted.has(runId)) return true;
  for (const w of wanted) {
    if (runId.startsWith(w) || runId.slice(0, 8) === w) return true;
  }
  return false;
}

export async function runCrossVendorSpotCheck(args: {
  input: AuditInput;
  rescore: RescoreOutput;
  jobs: readonly SpotCheckJob[];
  call: JudgeCall;
  vendorModel: string;
  log?: (message: string) => void;
}): Promise<SpotCheckResult[]> {
  const log = args.log ?? (() => undefined);
  const taskIndex = new Map<
    string,
    {
      facts: AuditInput["runs"][number]["tasks"][number]["facts"];
      texts: Map<string, string>;
    }
  >();
  for (const run of args.input.runs) {
    for (const task of run.tasks) {
      taskIndex.set(`${run.runId}|${task.taskId}`, {
        facts: task.facts,
        texts: new Map(
          Object.entries(task.conditions).map(([name, c]) => [name, c.text]),
        ),
      });
    }
  }
  const rescoreIndex = new Map(
    args.rescore.entries.map((entry) => [
      `${entry.runId}|${entry.taskId}`,
      entry,
    ]),
  );

  const results: SpotCheckResult[] = [];
  for (const job of args.jobs) {
    const data = taskIndex.get(`${job.runId}|${job.taskId}`);
    const entry = rescoreIndex.get(`${job.runId}|${job.taskId}`);
    const reference = entry?.conditions[job.condition]?.verdicts;
    const text = data?.texts.get(job.condition);
    if (!data || !reference || text === undefined) {
      log(
        `  [skip] ${job.runId.slice(0, 8)} ${job.taskId} ${job.condition}: missing input or reference`,
      );
      continue;
    }
    log(
      `  [${job.runId.slice(0, 8)} ${job.condition}] ${data.facts.length} facts → calling ${args.vendorModel}…`,
    );
    const judged = await runPerFactJudge(data.facts, text, args.call);
    const result = compareVerdicts(
      [...judged.verdicts],
      reference,
      job,
      args.vendorModel,
    );
    results.push(result);
    log(
      `           agreement: ${result.agreedCount}/${result.totalCount} ` +
        `(${(result.agreement * 100).toFixed(1)}%) — ` +
        `vendor pass=${(result.vendorPassRate * 100).toFixed(1)}%, ` +
        `reference pass=${(result.referencePassRate * 100).toFixed(1)}%`,
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function formatCrossVendorReport(
  results: readonly SpotCheckResult[],
  rescoreSource: string,
): string {
  const lines: string[] = [
    "# Cross-vendor judge spot-check\n",
    `Reference rescore: \`${rescoreSource}\`  \nVendor judge model: \`${results[0]?.vendorJudgeModel ?? "—"}\`\n`,
    "Closes the 'one vendor judging its own outputs' bias critique: same prompt, different vendor, compared per-fact verdict.\n",
    "## Per-(run, condition) summary\n",
    "| Run | Condition | n facts | Vendor pass-rate | Reference pass-rate | Agreement | # disagreements |\n|---|---|---|---|---|---|---|",
  ];

  for (const r of results) {
    lines.push(
      `| ${r.runId.slice(0, 8)} | ${r.condition} | ${r.totalCount} | ${(r.vendorPassRate * 100).toFixed(1)}% | ${(r.referencePassRate * 100).toFixed(1)}% | ${(r.agreement * 100).toFixed(1)}% | ${r.disagreements.length} |`,
    );
  }
  lines.push("");

  // Aggregate
  const totalFacts = results.reduce((s, r) => s + r.totalCount, 0);
  const totalAgreed = results.reduce((s, r) => s + r.agreedCount, 0);
  const totalVendorPass = results.reduce(
    (s, r) => s + Math.round(r.vendorPassRate * r.totalCount),
    0,
  );
  const totalRefPass = results.reduce(
    (s, r) => s + Math.round(r.referencePassRate * r.totalCount),
    0,
  );
  lines.push(
    "## Aggregate\n",
    "| Metric | Value |\n|---|---|",
    `| Total facts judged | ${totalFacts} |`,
    `| Vendor-vs-reference agreement | ${totalFacts === 0 ? "—" : `${totalAgreed}/${totalFacts} (${((totalAgreed / totalFacts) * 100).toFixed(1)}%)`} |`,
    `| Vendor pass-rate | ${totalFacts === 0 ? "—" : `${totalVendorPass}/${totalFacts} (${((totalVendorPass / totalFacts) * 100).toFixed(1)}%)`} |`,
    `| Reference pass-rate | ${totalFacts === 0 ? "—" : `${totalRefPass}/${totalFacts} (${((totalRefPass / totalFacts) * 100).toFixed(1)}%)`} |`,
    "",
  );

  // Disagreements
  const allDis = results.flatMap((r) =>
    r.disagreements.map((d) => ({
      ...d,
      runId: r.runId,
      condition: r.condition,
    })),
  );
  lines.push(`## Disagreements (${allDis.length})\n`);
  if (allDis.length === 0) {
    lines.push(
      "None — vendor and reference judges fully agreed on every fact.\n",
    );
  } else {
    lines.push(
      "| Run | Condition | Fact | Vendor | Reference | Vendor reason | Reference reason |\n|---|---|---|---|---|---|---|",
    );
    for (const d of allDis) {
      lines.push(
        `| ${d.runId.slice(0, 8)} | ${d.condition} | ${d.factId} | ${d.vendor ? "PASS" : "FAIL"} | ${d.reference ? "PASS" : "FAIL"} | ${d.vendorJustification.replaceAll("|", String.raw`\|`)} | ${d.referenceJustification.replaceAll("|", String.raw`\|`)} |`,
      );
    }
    lines.push("");
  }

  if (totalFacts > 0) {
    lines.push(
      "## Suggested phrasing\n",
      `> A cross-vendor spot-check using ${results[0]?.vendorJudgeModel ?? "another vendor"} ` +
        `as the judge against the same prompt and the same agent outputs reproduced ` +
        `${((totalAgreed / totalFacts) * 100).toFixed(1)}% (${totalAgreed}/${totalFacts}) ` +
        `of the reference judge's per-fact verdicts. The vendor pass-rate ` +
        `(${((totalVendorPass / totalFacts) * 100).toFixed(1)}%) and reference pass-rate ` +
        `(${((totalRefPass / totalFacts) * 100).toFixed(1)}%) differed by ` +
        `${Math.abs(totalVendorPass - totalRefPass)} fact-verdicts ` +
        `(${((Math.abs(totalVendorPass - totalRefPass) / totalFacts) * 100).toFixed(1)} pp).\n`,
    );
  }

  return lines.join("\n");
}
