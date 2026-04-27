import { DEFAULT_MIME_TYPE } from "@nicator/core";
import { AgentFS } from "agentfs-sdk";
import type { IFileSystem } from "just-bash";
import { Bash, defineCommand, InMemoryFs } from "just-bash";

import type {
  BashResult,
  FileSnapshot,
  PromotedFile,
  Workspace,
  WorkspaceConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CWD = "/workspace";
const DEFAULT_MAX_COMMANDS = 1000;
const DEFAULT_MAX_LOOP_ITERATIONS = 1000;
const DEFAULT_MAX_STRING_LENGTH = 1_048_576; // 1 MB
const MAX_PROMOTED_FILES = 100;

/** Maximum characters returned in stdout/stderr to prevent context explosion. */
const MAX_OUTPUT_CHARS = 32_000;

const MIME_TYPES: Readonly<Record<string, string>> = {
  json: "application/json",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  sh: "text/x-shellscript",
  sql: "application/sql",
  log: "text/plain",
  txt: "text/plain",
};

function mimeFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[extension] ?? DEFAULT_MIME_TYPE;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... (truncated, ${text.length} chars total)`;
}

// ---------------------------------------------------------------------------
// Internal: assemble a Workspace from any IFileSystem
// ---------------------------------------------------------------------------

function assembleWorkspace(
  config: WorkspaceConfig,
  fileSystem: IFileSystem,
  bash: Bash,
  teardown?: () => Promise<void>,
): Workspace {
  const cwd = config.cwd ?? DEFAULT_CWD;
  const promoted: PromotedFile[] = [];

  // Register save_artifact: promotes a workspace file as a named artifact.
  // Usage: save_artifact <path> [name]
  bash.registerCommand(
    defineCommand("save_artifact", async (args, ctx) => {
      const filePath = args[0];
      if (!filePath) {
        return {
          stdout: "",
          stderr: "Usage: save_artifact <path> [name]\n",
          exitCode: 1,
        };
      }

      const resolvedPath =
        filePath.startsWith("/") ? filePath : `${ctx.cwd}/${filePath}`;

      const exists = await fileSystem.exists(resolvedPath);
      if (!exists) {
        return {
          stdout: "",
          stderr: `save_artifact: ${filePath}: No such file\n`,
          exitCode: 1,
        };
      }

      if (promoted.length >= MAX_PROMOTED_FILES) {
        return {
          stdout: "",
          stderr: `save_artifact: limit of ${MAX_PROMOTED_FILES} artifacts reached\n`,
          exitCode: 1,
        };
      }

      const name = args[1] ?? filePath.split("/").pop() ?? filePath;
      promoted.push({ path: resolvedPath, name });
      return {
        stdout: `Saved artifact: ${name} (${resolvedPath})\n`,
        stderr: "",
        exitCode: 0,
      };
    }),
  );

  async function exec(command: string): Promise<BashResult> {
    const result = await bash.exec(command);
    return {
      stdout: truncate(result.stdout, MAX_OUTPUT_CHARS),
      stderr: truncate(result.stderr, MAX_OUTPUT_CHARS),
      exitCode: result.exitCode,
    };
  }

  async function captureOutputs(): Promise<ReadonlyArray<FileSnapshot>> {
    const snapshots: FileSnapshot[] = [];
    const captured = new Set<string>();

    // Capture explicitly promoted files first
    for (const pf of promoted) {
      try {
        const content = await bash.readFile(pf.path);
        snapshots.push({
          path: pf.path,
          content,
          mimeType: mimeFromPath(pf.path),
          size: content.length,
        });
        captured.add(pf.path);
      } catch {
        console.warn(
          `[workspace] promoted file missing at capture time: ${pf.path}`,
        );
      }
    }

    if (!config.outputPaths || config.outputPaths.length === 0)
      return snapshots;

    // Escape single quotes in patterns to prevent shell injection.
    // The find -path argument uses fnmatch(3), not shell globs.
    for (const pattern of config.outputPaths) {
      const escaped = pattern.replaceAll("'", String.raw`'\''`);
      const findResult = await bash.exec(
        `find '${cwd}' -path '${escaped}' -type f 2>/dev/null`,
      );
      const paths = findResult.stdout
        .trim()
        .split("\n")
        .filter((p) => p.length > 0);

      for (const filePath of paths) {
        if (captured.has(filePath)) continue;
        try {
          const content = await bash.readFile(filePath);
          snapshots.push({
            path: filePath,
            content,
            mimeType: mimeFromPath(filePath),
            size: content.length,
          });
        } catch {
          // File may have been deleted between find and read
        }
      }
    }

    return snapshots;
  }

  return {
    fs: fileSystem,
    exec,
    promotedFiles: promoted,
    captureOutputs,
    dispose: teardown ?? (async () => {}),
  };
}

async function initBash(
  config: WorkspaceConfig,
  fileSystem: IFileSystem,
): Promise<Bash> {
  const cwd = config.cwd ?? DEFAULT_CWD;

  await fileSystem.mkdir(cwd, { recursive: true });

  if (config.initialFiles) {
    for (const [path, content] of Object.entries(config.initialFiles)) {
      const fullPath = path.startsWith("/") ? path : `${cwd}/${path}`;
      const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      if (dir) await fileSystem.mkdir(dir, { recursive: true });
      await fileSystem.writeFile(fullPath, content);
    }
  }

  return new Bash({
    fs: fileSystem,
    cwd,
    executionLimits: {
      maxCommandCount: config.limits?.maxCommands ?? DEFAULT_MAX_COMMANDS,
      maxLoopIterations:
        config.limits?.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS,
      maxStringLength:
        config.limits?.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    },
    ...(config.allowedUrls && config.allowedUrls.length > 0 ?
      {
        network: {
          allowedUrlPrefixes: [...config.allowedUrls],
        },
      }
    : {}),
  });
}

// ---------------------------------------------------------------------------
// In-memory workspace (no persistence, no agentfs)
// ---------------------------------------------------------------------------

export async function createWorkspace(
  config: WorkspaceConfig,
  fs?: IFileSystem,
): Promise<Workspace> {
  const fileSystem = fs ?? new InMemoryFs();
  const bash = await initBash(config, fileSystem);
  return assembleWorkspace(config, fileSystem, bash);
}

// ---------------------------------------------------------------------------
// Persistent workspace (agentfs-backed, same SQLite as TypeGraph)
//
// Opens the same database file that TypeGraph uses. agentfs tables (fs_*,
// kv_*, tool_calls) coexist with TypeGraph tables (tg_*). Both use
// separate connections; SQLite WAL mode handles concurrent access.
// ---------------------------------------------------------------------------

export async function createPersistentWorkspace(
  config: WorkspaceConfig,
  dbPath: string,
): Promise<Workspace> {
  // Open agentfs explicitly so we retain the handle for teardown.
  // createAgentFs wraps it as an IFileSystem for just-bash.
  // Using the same file path as TypeGraph means both share one SQLite
  // database (separate connections, WAL mode).
  // Dynamic import: agentfs-sdk's "./just-bash" subpath export only declares
  // an "import" condition, which tsx's CJS-based resolver cannot satisfy at
  // static-import time. Resolving it at call time routes through the ESM
  // loader and avoids ERR_PACKAGE_PATH_NOT_EXPORTED.
  const { agentfs: createAgentFs } = await import("agentfs-sdk/just-bash");
  const agent = await AgentFS.open({ path: dbPath });
  const fileSystem = await createAgentFs(agent);
  const bash = await initBash(config, fileSystem);

  return assembleWorkspace(config, fileSystem, bash, async () => {
    await agent.close();
  });
}
