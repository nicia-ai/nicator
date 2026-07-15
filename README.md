# Nicator

A methodology-first agent eval harness with graph-native execution
provenance. From [Nicia](https://nicia.ai).

Two artifacts in one repo:

- **A reproducibility playbook for agent evals.** Per-fact LLM-judge
  rescoring, regex-design ablation, human-audit packets, cross-vendor
  judge spot-check, and shuffled-fact-order replicates. Used to catch
  a methodology bug in this repo's own headline measurement before
  publication: a 23-point comparative-eval gap on `dcv-004` that a
  one-line regex change reduced to 5 points. See
  [`eval-methodology-post-v5.md`](eval-methodology-post-v5.md) for the
  long-form writeup, including the v4 → v5 self-audit.
- **The harness that produced the evidence.** Local CLI, execution state
  stored as a typed graph on SQLite using
  [TypeGraph](https://github.com/nicia-ai/typegraph), sandboxed virtual
  workspace, skill dispatch with policies, and behavioral evals expressed
  as structural assertions on the execution graph.

The playbook is the contribution; the harness is the vehicle that produced
the evidence behind it.

Tracked runs, reports, and rescores are listed in
[`evals/results/MANIFEST.md`](evals/results/MANIFEST.md). Treat the manifest
as the source of truth — do not cite a run ID in docs unless the manifest
lists it.

→ **[Reproduce the dcv-004 measurement bug](#reproduce-dcv-004)** —
`pnpm eval:rescore` regenerates the audit table from the five checked-in
run files in ~2–5 min  
→ **[Methodology validation suite](#methodology-validation)** — three
scripted checks that close the most common critiques of LLM-judge
rescoring  
→ **[Eval philosophy and graph-based behavioral eval](docs/evals.md)** —
outcome metrics, process metrics, structural assertions on the graph  
→ **[Why graph-native execution state](docs/why.md)** — the storage
decision behind the harness, and what the harness gives evals  
→ **[Entity design decisions](docs/entities.md)** /
**[Graph model](docs/graph-model.md)** — schema reference for readers
diving into the code

---

## Reproduce dcv-004

The methodology writeup
[`eval-methodology-post-v5.md`](eval-methodology-post-v5.md) — "A one-line
regex change moves the conclusion by 30 points: a methodology self-audit" —
reports two findings on the same `dcv-004` outputs across 5 runs:

1. The per-fact LLM judge and the canonical (proximity-130) regex disagree
   by 20 percentage points on the comparative gap H−B.
2. A regex-design ablation shows that almost all of that disagreement is
   the proximity-window choice: widening the window from 130 to 260
   characters collapses the 23-point gap to 5 points; widening further
   reverses its sign.

The strong-form claim from an earlier draft ("surface-form scoring is a
measurement bug") does not survive the ablation. The weak-form claim
("matcher proximity is a hidden hyperparameter that can flip architectural
conclusions, and brittleness is asymmetric across verbosity-differing
conditions") does.

The 5 raw run files are checked into this repo at
`evals/results/{7464bfdf,757cf6f9,a702013b,e15c4595,ed259a03}.json` and
their provenance is the canonical record in
[`evals/results/MANIFEST.md`](evals/results/MANIFEST.md). This section gives
the exact commands a reader runs to regenerate the post's central tables.

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

`pnpm eval:rescore` writes a JSON with verdicts and a Markdown report. The
report's `## Disagreement audit` section reproduces the regex-vs-judge
quadrant counts. Expected counts on the harness side: regex-fail / judge-pass
≈ 113, regex-pass / judge-fail 1–2, both-failed 6, both-passed ≈ 119. On the
baseline side: 63 / 0 / 0 / 177.

The 113-vs-63 differential is what an earlier draft read as evidence of a
20-percentage-point surface-form scoring artifact. Before publishing, run
the regex-design ablation as the second check.

### Regex-design ablation

```bash
pnpm eval:regex-ablation --task dcv-004 \
  --runs 7464bfdf 757cf6f9 a702013b e15c4595 ed259a03 \
  --judge-rescore evals/results/rescore-2026-04-22T17-57-49-540Z.json
```

Wall time: ~5 seconds. Cost: $0 (no API calls). Writes
`evals/results/regex-ablation-{timestamp}.{md,json}`.

The ablation sweeps the regex matcher across proximity-window sizes
(130, 260, 520, 1040), strips the proximity anchor entirely (`no-proximity`),
and compares to a bag-of-tokens matcher and the LLM judge. The headline
table — comparative gap H−B per matcher variant — is the load-bearing
finding the v5 post is built around. Sanity check: `original`
(proximity-130) must reproduce the result-file regex scores exactly.

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

## Methodology validation

Three scripted checks close the most common critiques of "you're using
one stochastic LLM judge to indict another stochastic scorer." Each is
optional but each closes a specific argument before someone else does.

### 1. Human audit — calibrate the judge against your own labels

Generates a stratified sample of fact-verdicts across the four
agreement quadrants, packages each case with the reference fact, regex
pattern, and a ~440-character output excerpt around the candidate
match, and **hides the judge verdict** inside a collapsible block so
the labeler labels first and reveals second. Then a scoring step
computes Cohen's κ and per-quadrant agreement.

```bash
# 1. Generate a packet (no API calls — packages an existing rescore)
pnpm eval:audit-packet --rescore evals/results/<rescore>.json

# 2. Open the resulting evals/human-audit/<stem>.md and replace each
#    `[ TODO ]` with PASS / FAIL / AMBIGUOUS / DISPUTE-RUBRIC.
#    Label every case BEFORE expanding the judge verdict — that's the
#    whole evidentiary point of the audit. Budget ~30-60 sec/case.

# 3. Score the labeled packet
pnpm eval:audit-score --packet evals/human-audit/<stem>.md
```

Default sample design (~82 cases, ~45-90 min of labeling):
- 40 from regex-fail/judge-pass (harness side — load-bearing quadrant)
- 20 from regex-fail/judge-pass (baseline side)
- All regex-pass/judge-fail (typically 1-2)
- All both-failed (typically 6)
- 15 random both-passed (sanity check that both scorers agree)

Override via `--rfjp-harness N --rfjp-baseline N --both-passed N`.
Use `--seed 42` for reproducible packets.

The output report computes Cohen's κ on PASS/FAIL pairs (excluding
AMBIGUOUS and DISPUTE-RUBRIC, which are tracked separately as
methodology signal) and produces a one-line headline phrasing for the
post.

### 2. Cross-vendor judge spot-check

Re-runs the per-fact judge using a different vendor (default OpenAI
GPT-5 via the Chat Completions HTTP API — no SDK dependency) against
the same prompt, and compares verdicts to a reference rescore.
Closes the "Anthropic-judging-Anthropic bias loop" critique.

```bash
# Set OPENAI_API_KEY in .env (intentionally not in .env.example —
# this validation is opt-in and incurs cost on a second vendor).
pnpm eval:rescore-cross-vendor --rescore evals/results/<rescore>.json --single

# Or all 5 runs × both modes
pnpm eval:rescore-cross-vendor --rescore evals/results/<rescore>.json --all
```

Cost: `--single` ≈ $0.15, `--all` ≈ $1.50. Override the model with
`--model gpt-4o` or set `OPENAI_JUDGE_MODEL` in your env.

### 3. Shuffled-fact-order replicates — judge stability check

For each (run, mode), runs the per-fact judge N additional times with
randomly shuffled fact order, then reports per-fact stability across
the N+1 verdicts. Closes the "intra-prompt position effects" critique
that batched fact-list judging is structurally vulnerable to.

```bash
# 3 extra judge runs per (run, mode) — ~30 extra calls, ~$24
pnpm eval:rescore --last 5 --shuffle-replicates 3
```

The output report adds a `## Shuffle-replicate stability` section
classifying each fact as **stable** (all verdicts agree),
**borderline** (one disagreement), or **flipped** (two or more
disagreements). High % stable means position effects are not the
dominant noise source on this task.

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
