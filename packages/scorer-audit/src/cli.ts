/**
 * scorer-audit CLI — "your scorer might be lying to you" audit tool.
 *
 * Subcommands:
 *
 *   rescore       Per-fact LLM-judge rescore of eval outputs
 *   ablate        Matcher-design ablation with paired-t statistics
 *   audit-packet  Generate a stratified human-audit packet
 *   audit-score   Score a labeled packet (Cohen's κ)
 *   cross-vendor  Re-judge with an OpenAI-compatible vendor and compare
 *
 * Inputs are either a generic scorer-audit input file (`--input`) or one
 * or more nicator EvalReport JSONs (`--nicator-report`, repeatable) plus
 * a facts file (`--facts`) mapping task id → reference facts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  formatAblationReport,
  type JudgeReference,
  judgeReferenceFromRescore,
  runAblation,
} from "./ablation.js";
import {
  NicatorEvalReportSchema,
  NicatorFactsFileSchema,
  nicatorReportsToAuditInput,
} from "./adapters/nicator.js";
import {
  type AnswerKey,
  formatAuditScoreReport,
  generateAuditPacket,
  parseLabels,
  type SampleSizes,
} from "./audit.js";
import {
  createOpenAiCompatibleJudgeCall,
  DEFAULT_VENDOR_MODEL,
  formatCrossVendorReport,
  resolveSpotCheckJobs,
  runCrossVendorSpotCheck,
} from "./cross-vendor.js";
import { createAnthropicJudgeCall, DEFAULT_JUDGE_MODEL } from "./judge.js";
import { formatRescoreReport, rescoreInput } from "./rescore.js";
import {
  type AuditInput,
  AuditInputSchema,
  type RescoreOutput,
  RescoreOutputSchema,
} from "./schema.js";

const USAGE = `Usage: scorer-audit <command> [options]

Commands:
  rescore        Per-fact LLM-judge rescore of eval outputs
  ablate         Matcher-design ablation with paired-t statistics
  audit-packet   Generate a stratified human-audit packet
  audit-score    Score a labeled packet (Cohen's kappa)
  cross-vendor   Re-judge with an OpenAI-compatible vendor and compare

Input (rescore, ablate, audit-packet, cross-vendor):
  --input <file>            Generic scorer-audit input JSON
  --nicator-report <file>   Nicator EvalReport JSON (repeatable)
  --facts <file>            Facts file for --nicator-report: JSON object
                            mapping task id -> array of reference facts
  --out-dir <dir>           Output directory (default: ./scorer-audit-out)

rescore:
  --model <id>              Judge model (default: ${DEFAULT_JUDGE_MODEL})

ablate:
  --judge-rescore <file>    Rescore JSON to use as the judge reference row

audit-packet:
  --rescore <file>          Rescore JSON (required)
  --seed <n>                Sampling/shuffle seed (default: 1337)
  --mfjp-primary <n>        matcher-fail/judge-pass sample, comparison[0] (default: 40)
  --mfjp-secondary <n>      matcher-fail/judge-pass sample, comparison[1] (default: 20)
  --both-passed <n>         both-passed random sample (default: 15)
  --out-name <stem>         Output file stem

audit-score:
  --packet <file>           Labeled packet .md (required)
  --key <file>              Answer key (default: <packet>.key.json)
  --out <file>              Report path (default: <packet>.report.md)

cross-vendor:
  --rescore <file>          Reference rescore JSON (required)
  --single | --all          Spot-check scope (default: --single)
  --run <id>                Explicit run (repeatable, with --condition)
  --condition <name>        Explicit condition (repeatable)
  --model <id>              Vendor model (default: ${DEFAULT_VENDOR_MODEL},
                            or OPENAI_JUDGE_MODEL env var)
  --base-url <url>          OpenAI-compatible endpoint base URL
                            (default: https://api.openai.com/v1)

Environment:
  ANTHROPIC_API_KEY         Required for rescore
  OPENAI_API_KEY            Required for cross-vendor
`;

// ---------------------------------------------------------------------------
// Shared option parsing
// ---------------------------------------------------------------------------

type CommonOptions = {
  input?: string;
  nicatorReports: string[];
  facts?: string;
  outDir: string;
  rest: Map<string, string[]>;
  flags: Set<string>;
};

const VALUE_FLAGS = new Set([
  "--input",
  "--nicator-report",
  "--facts",
  "--out-dir",
  "--model",
  "--judge-rescore",
  "--rescore",
  "--seed",
  "--mfjp-primary",
  "--mfjp-secondary",
  "--both-passed",
  "--out-name",
  "--packet",
  "--key",
  "--out",
  "--run",
  "--condition",
  "--base-url",
]);

const BOOLEAN_FLAGS = new Set(["--single", "--all", "--help", "-h"]);

function parseCommon(argv: readonly string[]): CommonOptions {
  const options: CommonOptions = {
    nicatorReports: [],
    outDir: "./scorer-audit-out",
    rest: new Map(),
    flags: new Set(),
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (BOOLEAN_FLAGS.has(argument)) {
      options.flags.add(argument);
      continue;
    }
    if (!VALUE_FLAGS.has(argument)) {
      throw new Error(`Unknown option: ${argument}\n\n${USAGE}`);
    }
    const value = argv[++index];
    if (value === undefined) {
      throw new Error(`Missing value for ${argument}`);
    }
    switch (argument) {
      case "--input": {
        options.input = value;
        break;
      }
      case "--nicator-report": {
        options.nicatorReports.push(value);
        break;
      }
      case "--facts": {
        options.facts = value;
        break;
      }
      case "--out-dir": {
        options.outDir = value;
        break;
      }
      default: {
        const values = options.rest.get(argument) ?? [];
        values.push(value);
        options.rest.set(argument, values);
      }
    }
  }
  return options;
}

function singleValue(options: CommonOptions, flag: string): string | undefined {
  return options.rest.get(flag)?.at(-1);
}

function intValue(options: CommonOptions, flag: string): number | undefined {
  const raw = singleValue(options, flag);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n))
    throw new Error(`${flag} expects an integer, got: ${raw}`);
  return n;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadInput(options: CommonOptions): AuditInput {
  if (options.input && options.nicatorReports.length > 0) {
    throw new Error("Pass either --input or --nicator-report, not both.");
  }
  if (options.input) {
    return AuditInputSchema.parse(readJson(options.input));
  }
  if (options.nicatorReports.length > 0) {
    if (!options.facts) {
      throw new Error(
        "--nicator-report requires --facts <file> (JSON: task id -> reference facts). " +
          "Nicator EvalReports do not carry canonical strings or matcher patterns.",
      );
    }
    const factsByTask = NicatorFactsFileSchema.parse(readJson(options.facts));
    const reports = options.nicatorReports.map((path) =>
      NicatorEvalReportSchema.parse(readJson(path)),
    );
    return nicatorReportsToAuditInput(reports, factsByTask, (taskId, reason) =>
      console.warn(`  [skip] ${taskId}: ${reason}`),
    );
  }
  throw new Error(
    `An input is required: --input or --nicator-report.\n\n${USAGE}`,
  );
}

function writeReports(
  outDir: string,
  stem: string,
  json: unknown,
  markdown: string,
): { jsonPath: string; mdPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${stem}.json`);
  const mdPath = join(outDir, `${stem}.md`);
  // eslint-disable-next-line unicorn/no-null -- JSON.stringify replacer argument
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  writeFileSync(mdPath, markdown);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  return { jsonPath, mdPath };
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function cmdRescore(options: CommonOptions): Promise<void> {
  const input = loadInput(options);
  const model = singleValue(options, "--model") ?? DEFAULT_JUDGE_MODEL;
  if (!process.env["ANTHROPIC_API_KEY"]) {
    throw new Error("ANTHROPIC_API_KEY is not set (required for rescore).");
  }
  const call = createAnthropicJudgeCall({ model });
  const output = await rescoreInput(input, call, {
    judgeModel: model,
    log: (m) => console.log(m),
  });
  const markdown = formatRescoreReport(output);
  writeReports(options.outDir, `rescore-${timestamp()}`, output, markdown);
  console.log("\n" + markdown);
}

function cmdAblate(options: CommonOptions): void {
  const input = loadInput(options);
  const judgeRescorePath = singleValue(options, "--judge-rescore");
  let judge: JudgeReference | undefined;
  if (judgeRescorePath) {
    const rescore = RescoreOutputSchema.parse(readJson(judgeRescorePath));
    judge = judgeReferenceFromRescore(rescore);
  }
  const result = runAblation({ input, ...(judge ? { judge } : {}) });
  const markdown = formatAblationReport(result);
  writeReports(
    options.outDir,
    `ablation-${timestamp()}`,
    { ...result, ...(judgeRescorePath ? { judgeRescorePath } : {}) },
    markdown,
  );
  console.log("\n" + markdown);
}

function cmdAuditPacket(options: CommonOptions): void {
  const input = loadInput(options);
  const rescorePath = singleValue(options, "--rescore");
  if (!rescorePath) throw new Error("audit-packet requires --rescore <file>");
  const rescore = RescoreOutputSchema.parse(readJson(rescorePath));

  const mfjpPrimary = intValue(options, "--mfjp-primary");
  const mfjpSecondary = intValue(options, "--mfjp-secondary");
  const bothPassed = intValue(options, "--both-passed");
  const sample: Partial<SampleSizes> = {
    ...(mfjpPrimary === undefined ? {} : { mfjpPrimary }),
    ...(mfjpSecondary === undefined ? {} : { mfjpSecondary }),
    ...(bothPassed === undefined ? {} : { bothPassed }),
  };
  const seed = intValue(options, "--seed");

  const packet = generateAuditPacket({
    input,
    rescore,
    rescoreSource: basename(rescorePath),
    ...(seed === undefined ? {} : { seed }),
    sample,
  });

  const stem =
    singleValue(options, "--out-name") ?? `audit-packet-${timestamp()}`;
  mkdirSync(options.outDir, { recursive: true });
  const mdPath = join(options.outDir, `${stem}.md`);
  const keyPath = join(options.outDir, `${stem}.key.json`);
  writeFileSync(mdPath, packet.markdown);
  // eslint-disable-next-line unicorn/no-null -- JSON.stringify replacer argument
  writeFileSync(keyPath, JSON.stringify(packet.key, null, 2));
  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${keyPath}`);
  console.log(
    `\n${packet.cases.length} cases for labeling. Open the .md, fill in each \`Your label\`, then run:`,
  );
  console.log(`  scorer-audit audit-score --packet ${mdPath}`);
}

function cmdAuditScore(options: CommonOptions): void {
  const packetPath = singleValue(options, "--packet");
  if (!packetPath) throw new Error("audit-score requires --packet <file>");
  const keyPath =
    singleValue(options, "--key") ?? packetPath.replace(/\.md$/, ".key.json");
  const packetText = readFileSync(packetPath, "utf8");
  const key = JSON.parse(readFileSync(keyPath, "utf8")) as AnswerKey;
  const labels = parseLabels(packetText);

  const report = formatAuditScoreReport(key, labels);
  const outPath =
    singleValue(options, "--out") ??
    join(
      dirname(packetPath),
      `${basename(packetPath).replace(/\.md$/, "")}.report.md`,
    );
  writeFileSync(outPath, report);
  console.log(`Wrote ${outPath}`);
  console.log("\n" + report);
}

async function cmdCrossVendor(options: CommonOptions): Promise<void> {
  const input = loadInput(options);
  const rescorePath = singleValue(options, "--rescore");
  if (!rescorePath) throw new Error("cross-vendor requires --rescore <file>");
  const rescore: RescoreOutput = RescoreOutputSchema.parse(
    readJson(rescorePath),
  );

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set (required for cross-vendor).");
  }
  const vendorModel =
    singleValue(options, "--model") ??
    process.env["OPENAI_JUDGE_MODEL"] ??
    DEFAULT_VENDOR_MODEL;
  const baseUrl = singleValue(options, "--base-url");
  const call = createOpenAiCompatibleJudgeCall({
    model: vendorModel,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  });

  const runs = options.rest.get("--run") ?? [];
  const conditions = options.rest.get("--condition") ?? [];
  const selection =
    options.flags.has("--all") ? ("all" as const)
    : runs.length > 0 || conditions.length > 0 ? { runs, conditions }
    : ("single" as const);
  const jobs = resolveSpotCheckJobs(rescore, selection);
  if (jobs.length === 0) {
    throw new Error("No (run, condition) pairs matched the selection.");
  }
  console.log(
    `Cross-vendor spot-check: ${jobs.length} (run, condition) pair(s) using ${vendorModel}`,
  );

  const results = await runCrossVendorSpotCheck({
    input,
    rescore,
    jobs,
    call,
    vendorModel,
    log: (m) => console.log(m),
  });
  const markdown = formatCrossVendorReport(results, basename(rescorePath));
  writeReports(
    options.outDir,
    `cross-vendor-${timestamp()}`,
    results,
    markdown,
  );
  console.log("\n" + markdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    console.log(USAGE);
    return;
  }
  const options = parseCommon(rest);
  if (options.flags.has("--help") || options.flags.has("-h")) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case "rescore": {
      await cmdRescore(options);
      break;
    }
    case "ablate": {
      cmdAblate(options);
      break;
    }
    case "audit-packet": {
      cmdAuditPacket(options);
      break;
    }
    case "audit-score": {
      cmdAuditScore(options);
      break;
    }
    case "cross-vendor": {
      await cmdCrossVendor(options);
      break;
    }
    default: {
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
    }
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
