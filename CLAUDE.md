# Nicator — Claude Code Instructions

A framework for running LLM agents with skill dispatch, human-in-the-loop
(HITL) approval, and evaluation. Runs on Cloudflare Workers (D1 + Durable
Objects) with a local CLI for development. Stores execution state as a
graph using [TypeGraph](https://github.com/niciaai/typegraph).

Read this file first, then the docs in `docs/`, then the existing source
files listed below before writing any code.

## Tech Stack

- **Runtime**: Node 20+ (packages), Cloudflare Workers (apps/worker)
- **Package Manager**: pnpm (workspaces)
- **Monorepo**: Turborepo
- **Language**: TypeScript 5.x strict mode throughout
- **LLM SDK**: Anthropic TypeScript SDK
- **Storage**: [TypeGraph](https://github.com/niciaai/typegraph) (open-source graph-native) on SQLite — D1 in Workers, libsql in CLI
- **Workspace**: [just-bash](https://github.com/vercel-labs/just-bash) (virtual shell) + [agentfs](https://github.com/tursodatabase/agentfs) (SQLite filesystem) — same database as TypeGraph
- **HITL**: Cloudflare Durable Objects (production), readline (CLI)

## Workspace Packages

| Package              | Path                 | Description                                     |
| -------------------- | -------------------- | ----------------------------------------------- |
| `@nicator/core`      | `packages/core`      | Zod schemas, TypeGraph graph schema, Repository |
| `@nicator/sdk`       | `packages/sdk`       | Anthropic SDK wrapper                           |
| `@nicator/harness`   | `packages/harness`   | Run loop, task dispatch, subagent execution     |
| `@nicator/workspace` | `packages/workspace` | Virtual bash shell + agentfs filesystem per run |
| `@nicator/hitl`      | `packages/hitl`      | HITL Durable Object + CF handler                |
| `@nicator/worker`    | `apps/worker`        | Cloudflare Workers entry point                  |
| `@nicator/cli`       | `apps/cli`           | Local dev runner                                |

## Package Dependency Graph

```text
@nicator/worker ────→ core, harness, hitl, sdk
@nicator/cli ───────→ core, harness, workspace, sdk
@nicator/harness ───→ core, sdk, workspace
@nicator/workspace ─→ core, just-bash, agentfs-sdk
@nicator/hitl ──────→ core
@nicator/sdk ───────→ core
@nicator/core ──────→ zod, @nicia-ai/typegraph
```

## Six Core Entities

AgentDefinition, Run, Task, Operation, Skill, Artifact — all defined as Zod
schemas in `packages/core/src/schema.ts`. Stored as graph nodes with typed
edges in TypeGraph. See `docs/graph-model.md` for the node/edge schema.

## Three-Tier Execution Model

```text
Run        — whole user request, owns the agent loop
Task       — schedulable delegated work unit (root coordinator + child tasks per dispatch)
Operation  — atomic recorded action (tool_call | hitl_response)
Artifact   — named, typed content node (outputs, inputs, skill prompts)
```

Every Run has a root Task (coordinator, no Operations). Every dispatch — tool
call, subagent spawn, or HITL request — creates a child Task linked via
`spawns` edges. Task roles: `root`, `tool`, `hitl`, `subagent`. Subagents are
spawned via `spawn_subagent` (model constructs the prompt) or
`spawn_subagent_with_skill` (uses a pre-built skill prompt). All dispatches
are concurrent with a gather timeout; HITL dispatches are sequential.

## Subagent Model

The model is the coordinator. It spawns subagents on the fly using two tools:

- `spawn_subagent(name, prompt, task_input, artifact_ids?)` — the model
  constructs the subagent's system prompt and dispatches it directly.
- `spawn_subagent_with_skill(skill_name, task_input, artifact_ids?)` — convenience
  wrapper that uses a pre-built skill prompt from the workspace.

Subagents inherit the parent's tools (no per-subagent tool filtering). Whether
a subagent used a skill is determined by the presence of an `invokes` edge to
a Skill node, not by a field on the Task. Multi-agent coordination patterns
(pipeline, fan-in, debate) emerge from model decisions — there is no
declarative topology. See `packages/harness/src/skill-dispatch.ts` for the
dispatch implementation.

## Skill Execution Model

Skills are graph-native data: a `Skill` node linked to a `skill_prompt`
Artifact via a `has_definition` edge. Skill metadata (name, version,
description, maxIterations) lives on the Skill node; the prompt content is the
linked Artifact. Subagents inherit the parent's full tool set — skills no
longer declare their own tools. AgentDefinitions reference skills via `uses`
edges with optional `policy` edge properties.

At run start, skills are materialized to the workspace at `skills/[name]@[version]/SKILL.md`.
At activation time, the prompt is read from the workspace filesystem. The
harness executes a skill by running an inner LLM loop with the prompt as the
system prompt and the parent's tools inherited.

Skill data lives in `fixtures/skills/*.json`. Entry points seed these into
the graph via `seedSkillsFromFixtures()` before creating definitions.

## Agent Workspace

Each run gets a virtual workspace: a sandboxed bash shell (just-bash) backed by
a SQLite filesystem (agentfs). The workspace gives agents CLI capabilities —
file creation, text processing, scripting — without host access.

**Architecture:**

- `just-bash` interprets bash commands in pure TypeScript (no `child_process`).
  79+ built-in commands: grep, sed, awk, jq, sort, find, curl, etc.
- `agentfs` stores the virtual filesystem in SQLite using POSIX semantics
  (inodes, directory entries, chunked file storage). Tables are prefix-namespaced
  (`fs_*`) and coexist with TypeGraph tables in the same database.
- The `bash` tool is registered in the tool registry alongside web-search and
  web-fetch. Agents call it with `{ command: "..." }` and receive
  `{ stdout, stderr, exitCode }`.
- `save_artifact` is a custom bash command that promotes workspace files as
  named artifacts in the graph (`type: "file_reference"`).
- On run completion, promoted files are auto-captured as Artifact nodes.
- Artifacts are content-addressed (`contentHash` = SHA-256 of content).
  Identical content within a run is deduplicated; successive writes to the
  same name create `supersedes` version chains. Use `buildArtifact(type,
name, content, mimeType?)` from `@nicator/core` to construct artifacts
  with hash pre-computed.

**Key files:**

- `packages/workspace/src/workspace.ts` — `createWorkspace()` (in-memory) and
  `createPersistentWorkspace()` (agentfs-backed, same SQLite as TypeGraph)
- `packages/workspace/src/bash-tool.ts` — `createBashTool()` ToolImplementation
- `packages/workspace/src/types.ts` — Workspace, WorkspaceConfig, BashResult

## What already exists — do not modify

```text
evals/                              Eval suite (do not modify)
fixtures/definitions/               AgentDefinition fixtures
```

## Critical constraints

**TypeGraph is the storage layer.** [TypeGraph](https://github.com/niciaai/typegraph)
is an open-source typed knowledge graph library for SQLite and Postgres
([docs](https://typegraph.dev), [LLM context](https://typegraph.dev/llms-small.txt)).
There is no SQL schema file. There are no JOIN queries. All persistence goes
through the `Repository` interface backed by TypeGraph.
There is no raw SQL in this codebase — TypeGraph's backend system handles SQLite
access internally. Store construction is the responsibility of the entry points:
`packages/harness/src/local-repo.ts` (libsql for CLI/evals) and
`apps/worker/src/index.ts` (D1 via drizzle for Workers). Core only receives
a constructed `Store` — it never imports a SQLite driver.

**Read the TypeGraph README before implementing the graph schema.** The graph
schema in `docs/graph-model.md` describes _what_ to model. TypeGraph's API
describes _how_ to express it. Use the exact method signatures from the TypeGraph
package. You will learn: how to define nodes and edges with Zod schemas
(`defineNode`, `defineEdge`, `defineGraph`), how to query with the fluent
traversal builder, and how the adapter interface abstracts over SQLite backends.

**Runtime separation.** `packages/core`, `packages/sdk`, and `packages/harness`
must have zero Cloudflare-specific imports. They must run in Node (for the CLI
and evals) and in Workers (via apps/worker). Cloudflare-specific wiring (D1
backend, Durable Objects) lives in `apps/worker/`.

**Zod is the source of truth.** Never write a TypeScript `type` or `interface`
that duplicates a Zod schema. Infer types with `z.infer<typeof Schema>`.

**Policy before Operation.** In the harness run loop, policy checks must happen
before the child Task and its Operation are created. A policy denial should
produce no Operation node — the Task is either never created (`never` policy)
or gated via HITL before creation.

**HITL is a child Task, not a special case.** A HITL request creates a child
Task (`role: "hitl"`) with an Operation (`type: "hitl_response"`). HITL
dispatches are sequential (they change run status to `awaiting_hitl`).

**Compression creates real graph nodes.** Context compression produces a
`Compaction` node linked to the Run via a `has_compaction` edge. Compactions
are a separate node type from Operations. Originals are not deleted.

**Tool errors are results, not exceptions.** Tool implementations (web-search,
web-fetch) return error objects on failure (HTTP 4xx/5xx, oversized responses)
rather than throwing. This lets the model see the error and try a different
approach — a 403 on one URL should not kill the entire run. Only truly
unrecoverable failures (network down, invalid input schema) may throw.

**`consumes` edges are created at access time, not task creation time.**
The context builder surfaces artifact metadata (ID, name, type, preview) based
on scoring tiers. When the agent calls `read_artifact` to fetch full content,
the harness creates a `consumes` edge. Metadata-only tiers (artifact count)
do not produce `consumes` edges — the model never accesses their content.

## Code Conventions

- **TypeScript strict mode** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- **No `any`** — use `unknown` and narrow explicitly
- **Functional over class-based** except for stateful objects (Repository, HarnessError, DOs)
- **All graph access** goes through the `Repository` interface — no raw SQL anywhere
- **Type-only imports** use `import type`
- **async/await** only — no `.then()` chains
- **Errors** are typed `HarnessError` instances, not strings

## File Naming

- `index.ts` — package entry points
- `schema.ts` — Zod schemas and inferred types
- `graph.ts` — TypeGraph node/edge schema definition
- `repository.ts` — Repository interface and implementations
- `fixtures/skills/*.json` — skill fixture data (seeded into graph)

## Environment Variables

| Variable            | Required | Used in           | Description                   |
| ------------------- | -------- | ----------------- | ----------------------------- |
| `ANTHROPIC_API_KEY` | Yes      | worker, cli       | Anthropic API key             |
| `BRAVE_API_KEY`     | No       | skills/web-search | Brave Search (mock if absent) |

## Running the system locally

```bash
pnpm install           # Install all dependencies
pnpm build             # Build all packages
pnpm typecheck         # TypeScript check across all workspaces

# CLI run with the research-assistant fixture
pnpm cli run \
  --definition fixtures/definitions/research-assistant.json \
  --input "What are the main arguments for and against agentic AI systems?"

# Benchmark eval
pnpm eval --no-judge

# Behavioral evals — graph assertions, no LLM judge
pnpm eval --category dispatch --no-judge
pnpm eval --category hitl --no-judge

# Multi-agent coordination eval
pnpm eval --category coordination --no-judge

# Knowledge-work evals only (exclude infra/behavioral categories)
pnpm eval --exclude-category dispatch --exclude-category hitl \
  --exclude-category limits --exclude-category context \
  --exclude-category coordination --no-judge

# Multi-run eval with statistical analysis
pnpm eval --runs 5
pnpm eval:multi-run --last 5

# Context weight sweep — empirical validation of scoring weights
pnpm eval:sweep-weights              # quick: 1 run per config
pnpm eval:sweep-weights --runs 5     # statistical: 5 runs per config
```

## Questions to answer before asking for clarification

- Graph node/edge schema → `docs/graph-model.md`
- Entity schema details → `docs/entities.md`
- Repository interface → `packages/core/src/repository.ts`
- TypeGraph learning path → `docs/graph-model.md` (what exists in the graph and why) → `packages/core/src/graph.ts` (how nodes/edges are declared) → `packages/core/src/repository.ts` (how they're queried) → `docs/storage-queries.md` (annotated query cookbook)
- TypeGraph library API → TypeGraph package README or https://typegraph.dev/llms-small.txt
- Run loop sequence → `packages/harness/src/`
- System prompt assembly → `packages/harness/src/system-prompt.ts`
- HITL flow → `docs/entities.md` § Task + `packages/hitl/src/`
- Skill format and execution → `docs/entities.md` § Skill + `packages/harness/src/skill-dispatch.ts`
- Skill workspace materialization → `packages/harness/src/skill-loader.ts`
- Skill seeding from fixtures → `packages/harness/src/skill-seeder.ts`
- Skill inner loop → `packages/sdk/src/sdk.ts` (`runSubagentLoop`)
- Subagent dispatch → `packages/harness/src/skill-dispatch.ts` (handles both `spawn_subagent` and `spawn_subagent_with_skill`)
- Agent workspace → `packages/workspace/src/`
- Bash tool integration → `packages/workspace/src/bash-tool.ts`
- Workspace types → `packages/workspace/src/types.ts`
- Graph-based behavioral evals → `docs/evals.md` § Graph-based behavioral eval
- Graph assertion types → `evals/graph-assertions.ts`
