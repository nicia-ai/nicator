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

import {
  EvalTaskSchema,
  type EvalSuite,
  resolveTaskMetadata,
  taskBelongsToSuite,
  type EvalTask,
} from "./schema";

const TASKS_DIR = join(__dirname, "tasks");

export function loadTasks(filter?: {
  categories?: string[] | undefined;
  excludeCategories?: string[] | undefined;
  purposes?: string[] | undefined;
  excludePurposes?: string[] | undefined;
  suites?: string[] | undefined;
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
  if (filter?.categories && filter.categories.length > 0) {
    const included = new Set(filter.categories);
    filtered = filtered.filter((t) => included.has(t.category));
  }
  if (filter?.excludeCategories && filter.excludeCategories.length > 0) {
    const excluded = new Set(filter.excludeCategories);
    filtered = filtered.filter((t) => !excluded.has(t.category));
  }
  if (filter?.purposes && filter.purposes.length > 0) {
    const included = new Set(filter.purposes);
    filtered = filtered.filter((t) => included.has(resolveTaskMetadata(t).purpose));
  }
  if (filter?.excludePurposes && filter.excludePurposes.length > 0) {
    const excluded = new Set(filter.excludePurposes);
    filtered = filtered.filter((t) => !excluded.has(resolveTaskMetadata(t).purpose));
  }
  if (filter?.suites && filter.suites.length > 0) {
    filtered = filtered.filter((t) =>
      filter.suites?.some((suite) => taskBelongsToSuite(t, suite as EvalSuite)),
    );
  }
  if (filter?.taskId) {
    filtered = filtered.filter((t) => t.id === filter.taskId);
  }

  // Auto-exclude parked tasks unless they were reached via explicit task id
  // or category selection, which both count as deliberate opt-in.
  const explicitSelection =
    (filter?.taskId !== undefined && filter.taskId !== "") ||
    (filter?.categories !== undefined && filter.categories.length > 0);
  if (!explicitSelection) {
    filtered = filtered.filter((t) => !resolveTaskMetadata(t).parked);
  }

  return filtered;
}

/**
 * Map of current task definitions keyed by id. Optionally restricted to a
 * set of ids so historical reports don't force-load unrelated tasks.
 * Returns an empty map if task loading fails (missing directory, schema
 * validation errors) so callers can fall back to stored data.
 */
export function loadCurrentTaskMap(
  taskIds?: ReadonlySet<string>,
): Map<string, EvalTask> {
  try {
    const all = loadTasks();
    const filtered = taskIds ? all.filter((task) => taskIds.has(task.id)) : all;
    return new Map(filtered.map((task) => [task.id, task]));
  } catch {
    return new Map();
  }
}
