# Nicator

An agent harness for the post-framework era. From [Nicia](https://nicia.ai) —
every general needs a victory title.

Six entities. No orchestration graphs. Evals first. Execution state stored as
a graph using [TypeGraph](https://github.com/niciaai/typegraph). Sandboxed
workspace and execution graph share one SQLite database — file provenance is
graph-native. Agent behavior evaluated as structural assertions on the graph.

→ **[Read the thesis](docs/why.md)** before looking at the code.  
→ **[Read the entity design decisions](docs/entities.md)** before reading the implementation.  
→ **[Understand the storage model](docs/graph-model.md)** for how nodes and edges record execution.  
→ **[Read the eval methodology](docs/evals.md)** before running benchmarks — especially the [graph-based behavioral eval](docs/evals.md#graph-based-behavioral-eval) section.

---

## Quick start

```bash
# Install
pnpm install

# Configure environment
cp .env.example .env
# Then edit .env with your keys:
#   ANTHROPIC_API_KEY=sk-ant-...   (required)
#   BRAVE_API_KEY=BSA...           (optional — web-search uses mock if absent)

# Build all packages
pnpm build

# Run a local agent
pnpm cli run \
  --definition fixtures/definitions/research-assistant.json \
  --input "What will be the impact of AGI on GDP?"
```

## Evals

**Caution:** evals use a lot of tokens

```bash
# Run the benchmark eval suite
pnpm eval

# Run 5 times for statistical significance
pnpm eval --runs 5

# Behavioral evals — graph assertions, no LLM judge
pnpm eval --category dispatch --no-judge
pnpm eval --category hitl --no-judge

# Generate reports
pnpm eval:report              # single-run summary
pnpm eval:multi-run --last 5  # cross-run variance and significance
```

## Structure

```text
├── packages/
│   ├── core/             # Zod schemas, TypeGraph graph schema, Repository
│   ├── sdk/              # Anthropic SDK wrapper, subagent loop
│   ├── harness/          # Run loop, task dispatch, skill execution
│   ├── workspace/        # Virtual bash shell (just-bash) + agentfs filesystem
│   └── hitl/             # Human-in-the-loop Durable Object + CF handler
├── apps/
│   ├── worker/           # Cloudflare Workers entry point (D1, DOs)
│   └── cli/              # Local development runner
├── tools/
│   ├── web-search/       # Brave Search tool implementation
│   └── web-fetch/        # URL fetch tool implementation
├── evals/
│   ├── tasks/            # Eval task definitions (YAML)
│   ├── results/          # Eval run results and reports
│   ├── calibration/      # Judge calibration data
│   └── llm-judge/        # LLM judge prompts and rubric
├── fixtures/
│   ├── definitions/      # AgentDefinition fixtures
│   └── skills/           # Skill fixture data (seeded into graph)
└── docs/                 # Design documentation
```

## Creating an agent

An agent needs one file: a definition (JSON). Skills are optional — an
agent with just a system prompt and tools is a valid starting point.

### 1. Write a definition

Create `fixtures/definitions/my-agent.json`:

```json
{
  "id": "a1b2c3d4-...",
  "version": 1,
  "name": "My Agent",
  "description": "What this agent does.",
  "systemPrompt": "You are a research assistant. Use web-search to find...",
  "skills": [],
  "limits": {
    "maxTasksPerRun": 20,
    "maxOperationsPerTask": 3,
    "maxTokensPerRun": 100000
  },
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

The `systemPrompt` is what the model sees. Every agent gets `web-search`,
`web-fetch`, and `bash` (sandboxed workspace) as built-in tools. `limits`
control the run's resource envelope. Optional `workspace` config can seed
initial files and declare `outputPaths` globs for auto-capture.

### 2. Run it

```bash
pnpm cli run \
  --definition fixtures/definitions/my-agent.json \
  --input "Your task here"
```

The CLI prints an execution tree on completion showing tasks, operations,
and artifacts. State is persisted to `nicator.db` (SQLite, created in the
working directory).

### 3. Add skills (optional)

Skills give an agent reusable, scoped reasoning capabilities — each skill
runs its own LLM loop with the parent's tools. Create
`fixtures/skills/my-skill.json`:

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "One sentence the coordinator sees when deciding to invoke this.",
  "maxIterations": 10,
  "prompt": "# Skill Prompt\n\nYou are a specialist. Use web-search and web-fetch to..."
}
```

`description` is what the model reads to decide when to use the skill —
make it specific. `maxIterations` caps the skill's tool-call loop (set to
`1` for pure-analysis skills that don't need tools). `prompt` is the skill's
full system prompt. See [docs/entities.md](docs/entities.md) § Skill for
design details.

Then reference it in your definition's `skills` array:

```json
"skills": [
  { "name": "my-skill", "version": "1.0.0", "policy": { "type": "always" } }
]
```

References must match a fixture by `name` + `version` exactly. Each skill
can have a `policy`: `always` (default), `never`,
`require_hitl_approval` (human gate per invocation), or
`max_calls_per_run` (budget cap). If a skill has `require_hitl_approval`
policy, the CLI pauses for stdin approval.

### Multi-agent coordination

The model can spawn subagents on the fly — no declarative topology
required. The `systemPrompt` tells it how to coordinate:

- `agent(name, prompt, task_input)` — ad-hoc dispatch: model constructs
  the prompt
- `skill(skill_name, task_input)` — activates a pre-registered skill
  with its fixture prompt

See `fixtures/definitions/debate-assistant.json` for a working example
that spawns advocate and judge subagents.

## Agent Workspace

Each run gets a sandboxed shell
([just-bash](https://github.com/niciaai/just-bash) — pure TypeScript, 79+
builtins) backed by a virtual filesystem
([agentfs](https://github.com/tursodatabase/agentfs) — SQLite, same database
as TypeGraph). Agents get CLI capabilities without host access. Workspace files
promoted to artifacts become content-addressed, versioned graph nodes with full
provenance. See [docs/entities.md](docs/entities.md) § Artifact and
[docs/graph-model.md](docs/graph-model.md) for the storage details.

## What this is not

This is not a production framework (yet). It is a reference implementation bringing together several concepts. The Cloudflare Workers deployment is
functional end-to-end (Hono API, D1 persistence, Durable Object HITL) but lacks
operational hardening (auth, observability, crash recovery). See
[docs/why.md](docs/why.md).

## Development

```bash
pnpm build             # Build all packages (turbo)
pnpm typecheck         # TypeScript strict check across all workspaces
pnpm test              # Run tests (vitest)
pnpm lint              # Lint (eslint)
pnpm fix               # Auto-fix lint + format issues
pnpm check             # Lint + typecheck + format check (CI gate)
pnpm dev               # Watch mode for all packages
```

## Deploy to Cloudflare Workers

```bash
# Create D1 database
wrangler d1 create nicator

# Update wrangler.toml with your database_id

# Set API key
wrangler secret put ANTHROPIC_API_KEY

# Deploy
wrangler deploy
```

## License

MIT
