# Archived Cloudflare Worker Adapter

This directory contains the previous Cloudflare Workers and Durable Object
runtime path for Nicator.

It is intentionally outside the active pnpm workspace. The main repo is now
scoped to the local CLI, harness, workspace, and eval infrastructure. Treat this
archive as historical reference code unless the Cloudflare deployment path is
revived deliberately.

Archived paths:

- `apps/worker` - Hono Worker API, D1 repository wiring, run execution Durable
  Object
- `packages/hitl` - Durable Object HITL implementation and Cloudflare HITL
  handler
