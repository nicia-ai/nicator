/**
 * Task loader — discovers and validates YAML task files from the tasks/ directory.
 *
 * Tasks are .yaml files that conform to EvalTaskSchema. The loader:
 * 1. Scans the tasks/ directory for *.yaml files
 * 2. Parses each file as YAML
 * 3. Validates against EvalTaskSchema (runtime Zod check)
 * 4. Returns the validated array, sorted by task ID
 *
 * Adding a new task: create a .yaml file in tasks/. No code changes needed.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

import { EvalTaskSchema, type EvalTask } from "./schema";

const TASKS_DIR = join(__dirname, "tasks");

export function loadTasks(filter?: {
  category?: string | undefined;
  excludeCategories?: string[] | undefined;
  taskId?: string | undefined;
}): EvalTask[] {
  const files = readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No task files found in ${TASKS_DIR}`);
  }

  const tasks: EvalTask[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const path = join(TASKS_DIR, file);
    const raw = readFileSync(path, "utf-8");

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      errors.push(`${file}: invalid YAML — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const result = EvalTaskSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      errors.push(`${file}: schema validation failed\n${issues}`);
      continue;
    }

    tasks.push(result.data);
  }

  if (errors.length > 0) {
    throw new Error(
      `Failed to load ${errors.length} task file(s):\n\n${errors.join("\n\n")}`,
    );
  }

  let filtered = tasks;
  if (filter?.category) {
    filtered = filtered.filter((t) => t.category === filter.category);
  }
  if (filter?.excludeCategories && filter.excludeCategories.length > 0) {
    const excluded = new Set(filter.excludeCategories);
    filtered = filtered.filter((t) => !excluded.has(t.category));
  }
  if (filter?.taskId) {
    filtered = filtered.filter((t) => t.id === filter.taskId);
  }

  return filtered;
}
