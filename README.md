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

## Reproduce dcv-004

The methodology post ["Surface-form scoring is a measurement bug in agent
evaluation"](TODO-post-url) reports a 20-percentage-point gap between regex
and per-fact LLM-judge scoring on the same outputs, across 5 runs of the
`dcv-004` vendor compliance matrix task. The 5 raw run files are checked into
this repo at `evals/results/{7464bfdf,757cf6f9,a702013b,e15c4595,ed259a03}.json`
(provenance documented in `evals/results/MANIFEST.md`). This section gives the
exact commands a reader runs to regenerate the post's central audit table.

### Quick reproduce (recommended)

This rescores the checked-in run files and reproduces the post's 4-category
audit table. It does **not** rerun the agent — the agent outputs are fixed in
the JSONs above. It runs the per-fact LLM judge fresh against those outputs,
which is what the post is actually about.

```bash
# 1. Clone and install
git clone https://github.com/nicia-ai/nicator.git
cd nicator
pnpm install

# 2. Set your Anthropic key (the judge is claude-opus-4-6 by default)
cp .env.example .env
# edit .env: ANTHROPIC_API_KEY=sk-ant-...

# 3. Rescore the 5 dcv-004 runs against the per-fact judge
pnpm eval:rescore --runs 7464bfdf 757cf6f9 a702013b e15c4595 ed259a03
```

Wall time: ~2–5 minutes. Cost: roughly $8 in Anthropic API spend on Opus
calls (2 modes × 5 runs × 1 batched judge call per mode-run, with each
judge call sending the full agent output and the 48 reference facts).

`pnpm eval:rescore` writes two files to `evals/results/`: a JSON with the
verdicts and a Markdown report. The report's `## Disagreement audit` section
reproduces the post's central table. Expected counts:

**dcv-004 — harness side**

| Category | Count |
| --- | --- |
| Regex failed, judge passed | 113 |
| Regex passed, judge failed | 1–2 |
| Both failed | 6 |
| Both passed | 119–120 |
| Total harness fact-verdicts | 240 |

**dcv-004 — baseline side**

| Category | Count |
| --- | --- |
| Regex failed, judge passed | 63 |
| Regex passed, judge failed | 0 |
| Both failed | 0 |
| Both passed | 177 |
| Total baseline fact-verdicts | 240 |

The 1–2 / 119–120 ranges are **not approximations** — they reflect run-to-run
variation in judge stochasticity on one borderline fact-verdict (a
partial-information case that lands on the wrong side of the rubric ~50% of
the time). Every other cell is deterministic across rescores. The
load-bearing differential — `113 − 63 = 50` fact-verdicts ≈ 20.8 pp of 240,
net to ~20.0 pp after accounting for the regex false positives — is
**invariant** across rescores. That's the comparative scorer artifact the
post is about.

### Full reproduce (advanced)

To regenerate the agent outputs themselves (not just rerun the judge), run
the eval first, then rescore:

```bash
# Regenerate 5 runs of dcv-004 (~10–20 min, ~$5–10 in agent API spend)
pnpm eval --task dcv-004 --runs 5

# Then rescore the most recent 5 results
pnpm eval:rescore --last 5
```

The agent outputs will differ run-to-run (sonnet-4-6 at default temperature),
so the exact regex/judge per-cell counts will not match the post's checked-in
runs. The aggregate Δ (regex ≈ −0.23, judge ≈ −0.03) is robust across
regenerations within paired-bootstrap intervals.

### Going deeper

- Judge prompt template: `evals/llm-judge/per-fact.ts`
- Reference facts for dcv-004: `evals/tasks/dcv-004.yaml` under `referenceFacts`
- Full methodology discussion (independent vs batched per-fact judging,
  intra-prompt position effects, calibration): in the post and in
  `docs/evals.md`

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
│   └── workspace/        # Virtual bash shell (just-bash) + agentfs filesystem
├── apps/
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
├── archive/
│   └── cloudflare-worker/ # Archived Worker/Durable Object adapter
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

This is not a production framework. It is a reference implementation for the
local CLI harness, graph-native provenance model, workspace, skills, HITL
abstraction, and eval methodology. The previous Cloudflare Workers deployment
path has been archived under `archive/cloudflare-worker/` so the mainline stays
focused and reproducible. See [docs/why.md](docs/why.md).

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

## License

MIT
