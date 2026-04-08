/**
 * Browser workspace adapter.
 *
 * Uses just-bash's browser bundle with InMemoryFs. The browser build
 * excludes WASM-dependent commands (python3, sqlite3, tar, yq, xan)
 * and Node.js filesystem adapters (OverlayFs, ReadWriteFs).
 *
 * Core commands (grep, sed, awk, jq, cat, ls, sort, find, etc.) work
 * in the browser. Files live in memory for the duration of the session.
 *
 * For persistent browser workspaces, pass an agentfs IFileSystem backed
 * by sql.js or OPFS to createWorkspace() as the second argument.
 */

export type {
  BashResult,
  FileSnapshot,
  PromotedFile,
  Workspace,
  WorkspaceConfig,
  WorkspaceLimits,
} from "./types.js";
export { createWorkspace as createBrowserWorkspace } from "./workspace.js";
