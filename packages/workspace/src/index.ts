export {
  BASH_TOOL_NAME,
  BASH_TOOL_VERSION,
  bashManifest,
  createBashTool,
} from "./bash-tool.js";
export type {
  BashResult,
  FileSnapshot,
  PromotedFile,
  Workspace,
  WorkspaceConfig,
  WorkspaceLimits,
} from "./types.js";
export { createPersistentWorkspace, createWorkspace } from "./workspace.js";
