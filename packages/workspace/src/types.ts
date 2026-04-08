import type { IFileSystem } from "just-bash";

// ---------------------------------------------------------------------------
// Workspace configuration
// ---------------------------------------------------------------------------

export type WorkspaceConfig = Readonly<{
  /** Run ID this workspace belongs to. */
  runId: string;
  /** Working directory for the shell (default: "/workspace"). */
  cwd?: string;
  /** URL allowlist for network access. Empty or omitted = no network. */
  allowedUrls?: ReadonlyArray<string>;
  /** Execution limits passed to just-bash. */
  limits?: WorkspaceLimits;
  /** Glob patterns for files to auto-capture as artifacts on completion. */
  outputPaths?: ReadonlyArray<string>;
  /** Files to seed into the workspace before execution. */
  initialFiles?: Readonly<Record<string, string>>;
}>;

export type WorkspaceLimits = Readonly<{
  maxCommands?: number;
  maxLoopIterations?: number;
  maxStringLength?: number;
}>;

// ---------------------------------------------------------------------------
// Workspace interface
// ---------------------------------------------------------------------------

export type BashResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type FileSnapshot = Readonly<{
  path: string;
  content: string;
  mimeType: string;
  size: number;
}>;

export type PromotedFile = Readonly<{
  path: string;
  name: string;
}>;

export type Workspace = Readonly<{
  /** The underlying virtual filesystem. */
  fs: IFileSystem;
  /** Execute a bash command, returning stdout/stderr/exitCode. */
  exec: (command: string) => Promise<BashResult>;
  /** Files explicitly promoted as artifacts via `save_artifact` command. */
  promotedFiles: ReadonlyArray<PromotedFile>;
  /** Snapshot output files (promoted + outputPaths matches) as artifact-ready payloads. */
  captureOutputs: () => Promise<ReadonlyArray<FileSnapshot>>;
  /** Release resources (close DB connections, etc.). */
  dispose: () => Promise<void>;
}>;
