/**
 * Worker workspace adapter.
 *
 * Uses InMemoryFs for the filesystem. Files live for the duration of
 * the run within the Worker isolate.
 *
 * For persistent workspaces backed by Durable Object SQLite, use
 * agentfs-sdk/cloudflare directly: `AgentFS.create(ctx.storage)` returns
 * a FileSystem that can be wrapped with `agentfs()` from
 * agentfs-sdk/just-bash and passed as the `fs` argument to
 * `createWorkspace()`. This requires a DO-per-run architecture.
 */

export { createWorkspace as createWorkerWorkspace } from "./workspace.js";
