import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import { EvalReportSchema, type EvalReport } from "./schema";

export type EvalReportFile = Readonly<{
  name: string;
  path: string;
  mtimeMs: number;
  /** Parsed at list time so callers don't re-read the same file. */
  report: EvalReport;
}>;

function parseReportFile(path: string): EvalReport | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = EvalReportSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function listEvalReportFiles(resultsDir: string): EvalReportFile[] {
  const entries: EvalReportFile[] = [];
  for (const name of readdirSync(resultsDir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(resultsDir, name);
    const report = parseReportFile(path);
    if (!report) continue;
    entries.push({ name, path, mtimeMs: statSync(path).mtimeMs, report });
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function loadEvalReportFile(file: EvalReportFile): EvalReport {
  return file.report;
}

export function selectEvalReportFiles(
  resultsDir: string,
  options: {
    last?: number;
    runPrefixes?: readonly string[];
    runPrefix?: string;
  },
): EvalReportFile[] {
  const files = listEvalReportFiles(resultsDir);

  const prefixes =
    options.runPrefixes ??
    (options.runPrefix ? [options.runPrefix] : undefined);
  if (prefixes && prefixes.length > 0) {
    return prefixes.map((prefix) => {
      const match = files.find((file) => file.name.startsWith(prefix));
      if (!match) {
        throw new Error(`No EvalReport result file matches prefix: ${prefix}`);
      }
      return match;
    });
  }

  if (options.last !== undefined) {
    return files.slice(0, options.last);
  }

  return files;
}

export function loadEvalReports(
  resultsDir: string,
  options: { last?: number; runPrefixes?: readonly string[] } = {},
): EvalReport[] {
  return selectEvalReportFiles(resultsDir, options).map(loadEvalReportFile);
}
