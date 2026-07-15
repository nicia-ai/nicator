# Why this exists

This is a methodology-first agent eval harness. The contribution is a
reproducibility playbook for agent evaluation — per-fact LLM-judge
rescoring, human-audit packets, cross-vendor judge spot-check, shuffled-
fact-order replicates — and the harness is the vehicle that produced the
evidence behind it.

## The measurement problem

Most published agent benchmarks score outputs against reference answers
using lexical or regex-style proximity matchers. For paraphrase-admitting
outputs, those matchers undercount semantically correct answers. The QA
and NLG benchmarking literature has been documenting this for years:

- [Bulian et al. (2022) — "Tomayto, Tomahto"](https://arxiv.org/abs/2202.07654)
  defined an asymmetric notion of answer equivalence, showed that token-level
  F1 systematically underestimates QA system performance, and trained BEM to
  approximate human judgments better than F1.
- [Kamalloo et al. (2023)](https://arxiv.org/abs/2305.06984) re-evaluated
  open-domain QA on NQ-open and found InstructGPT zero-shot at 12.6% by
  lexical matching versus 71.4% by human assessment on the same outputs.
- [FActScore (Min et al., EMNLP 2023)](https://arxiv.org/abs/2305.14251)
  argued long-form generations need atomic-fact decomposition, not
  blob-level scoring.

The agent-eval-specific recurrence of this problem, measured on the
`dcv-004` vendor-compliance matrix in this repo: a same-task, same-model,
same-tools comparison between a decomposed harness condition and a flat
baseline produced a regex-scored gap of −23.3 percentage points and a
per-fact LLM-judge gap of −3.3 percentage points on identical outputs.

An earlier draft of the writeup (v4) treated that 20-point disagreement as
direct evidence that surface-form scoring writ large is broken. Before
publishing, a regex-design ablation on the same outputs showed that almost
all of the disagreement was attributable to one specific matcher choice —
the regex's 130-character proximity window. Widening that window to 260
characters collapses the comparative gap to −5 pp; widening further makes
the harness *beat* the baseline. The simpler "this regex was tuned wrong
for this output distribution" story accounts for ~78% of the headline
number. The full writeup is now
[`eval-methodology-post-v5.md`](../eval-methodology-post-v5.md), which
documents the v4 → v5 self-audit and the corrected, smaller claim:
matcher proximity is a hidden hyperparameter that can flip architectural
conclusions, and the brittleness is asymmetric across verbosity-differing
conditions. The canonical artifacts are listed in
[`evals/results/MANIFEST.md`](../evals/results/MANIFEST.md).

The failure mode this playbook is designed to prevent: taking a
lexically-scored comparative result at face value and publishing
"architecture A is worse than architecture B by N points" when in fact
a one-line matcher change would have given a different N or a different
sign. Per-fact LLM-judge rescoring detects that the matcher and the judge
disagree. The matcher-design ablation localizes *why*. Both checks are
necessary; neither alone is sufficient.

## What the playbook is

Two primary measurements — per-fact LLM-judge rescoring and regex-design
ablation — plus three scripted validations that close specific objections
to LLM-judge rescoring before someone else raises them. All five operate
against tracked run files in `evals/results/`; the manifest is the source
of truth for which runs are auditable.

### Per-fact LLM-judge rescore (primary measurement #1)

For each reference fact in a task, judge whether the agent's output
correctly states that fact, independent of surface form. One judge call
per output (batched across all facts). Temperature 0. Reasoning required
before the verdict block, to mitigate post-hoc rationalization. See
`evals/llm-judge/per-fact.ts` for the prompt and
`evals/rescore-per-fact.ts` for the runner.

```bash
pnpm eval:rescore --task dcv-004 --runs <prefix-1> <prefix-2> ...
pnpm eval:rescore --task dcv-004 --last 5
```

### Regex-design ablation (primary measurement #2)

The rescore tells you *that* the matcher and the judge disagree. It does
not tell you *why*. The ablation localizes the disagreement to specific
matcher-design choices by sweeping matcher specifications over the same
outputs: proximity-window widths (130, 260, 520, 1040), no-proximity
(strip the contiguity anchor entirely), substring-canonical, and
bag-of-tokens. Compares each variant's comparative gap H−B to the LLM
judge as the reference upper bound.

If the comparative gap collapses with a more permissive matcher, the
original measurement is a regex-design bug, not a property of
surface-form scoring writ large. If the gap survives across matcher
generations and only the LLM judge closes it, the strong-form claim
holds. On `dcv-004`, the gap collapsed under matcher widening — a
methodology bug the ablation caught before v4 was published. See
`evals/regex-ablation.ts` and the v5 post for the full table and the
self-audit narrative.

```bash
pnpm eval:regex-ablation --task dcv-004 \
  --runs <prefix-1> <prefix-2> ... \
  --judge-rescore evals/results/<rescore>.json
```

Zero API spend; runs locally in seconds.

### Validation 1 — human-audit packet

The judge is itself stochastic. The human audit calibrates it against
your own labels: a stratified sample of fact-verdicts across the four
agreement quadrants is packaged with the reference fact, the regex
pattern, and an excerpt around the candidate match. The judge verdict is
hidden in a collapsible block so the labeler labels first and reveals
second. A scoring step computes Cohen's κ and per-quadrant agreement.

```bash
pnpm eval:audit-packet --rescore evals/results/<rescore>.json
pnpm eval:audit-score  --packet  evals/human-audit/<stem>.md
```

### Validation 2 — cross-vendor judge spot-check

Re-runs the per-fact judge against a different model family (default
OpenAI via the Chat Completions HTTP API — no SDK dependency) on the
same prompt, and compares verdicts to a reference rescore. Closes the
"Anthropic-judging-Anthropic bias loop" objection.

```bash
pnpm eval:rescore-cross-vendor --rescore evals/results/<rescore>.json --all
```

### Validation 3 — shuffled-fact-order replicates

Batched per-fact judging is structurally vulnerable to intra-prompt
position effects. The shuffle-replicate check re-runs the judge with
randomly permuted fact orderings and classifies each fact as stable,
borderline, or flipped across the verdicts.

```bash
pnpm eval:rescore --last 5 --shuffle-replicates 3
```

## Why graph-native execution state

The playbook is the contribution; the harness exists because the playbook
needs evidence to operate on, and the evidence is most usable when
execution is recorded as a typed graph from the start.

Agent execution state has a natural graph structure. A run contains
tasks. Tasks have operations. Operations produce artifacts. Tasks consume
artifacts from earlier tasks. That last relationship — consumption — is a
directed edge between two nodes inside the same run, and it is the
relationship a behavioral assertion most often needs to read.

This harness uses
[TypeGraph](https://github.com/nicia-ai/typegraph) — a typed knowledge
graph library for SQLite and Postgres — as its sole storage layer. Every
entity is a graph node. Every relationship is a typed edge. The two
queries that matter most — full run lineage and artifact provenance —
each compile to a single SQL statement via TypeGraph's `store.subgraph()`,
which emits a `WITH RECURSIVE` CTE that traverses, filters, and hydrates
in the database. No application-layer N+1 loops, no multi-step query
chains.

### Compared to the alternatives

- **Relational (normalized tables).** Six tables, foreign keys, junction
  tables for many-to-many relationships like `consumes`. Run lineage
  requires five tables and four JOINs. Artifact provenance requires
  reverse-FK lookups plus an array deserialization scan. Every new
  relationship type means a new table or column plus a migration.
- **Event store.** Append-only logs are natural for audit but answering
  "what is the current state of this run?" requires replay or a
  projection. The graph model gives you both: the structure _is_ the
  current state, and the creation order of nodes and edges _is_ the
  event log.
- **Document database.** Embedding tasks inside a run document avoids
  JOINs but makes cross-entity references require denormalization.
  Nested documents do not model the `consumes` edge cleanly.
- **Graph.** Relationships are first-class. Run lineage is a single
  traversal. The `consumes` edge — the hardest relationship to model
  relationally — is just an edge. Behavioral assertions are predicates
  on the graph, not queries against a log.

See [`docs/graph-model.md`](graph-model.md) for the full node/edge
schema.

### What the graph gives evals

The same execution graph that drives the agent is what the eval suite
queries to answer behavioral questions:

- Did the agent call `web-search` directly, or did it unnecessarily
  activate the `researcher` skill?
- Did `human-approval` fire before the gated skill executed?
- Did the downstream task consume the artifact the upstream task
  produced?
- Were the bull and bear agents isolated from each other's findings
  before the judge synthesized?

Each of these is a predicate on `RunLineage` — no LLM judge, no log
parsing. See [`docs/evals.md` § Graph-based behavioral eval](evals.md#graph-based-behavioral-eval)
for the assertion catalog. If an assertion cannot be expressed against
the graph, the graph schema is incomplete; that feedback loop drives
schema evolution.

## What the harness is, briefly

Six entities — AgentDefinition, Run, Task, Operation, Skill, Artifact —
defined as Zod schemas in `packages/core/src/schema.ts`, stored as graph
nodes with typed edges. Three-tier execution model: a Run owns the agent
loop, Tasks are schedulable delegated work units, Operations are atomic
recorded actions. Every dispatch — tool call, ad-hoc agent creation, or
HITL request — creates a child Task linked to its parent via a `spawns`
edge. Skill activation is recorded as an `invokes` edge to a Skill node.
Concurrent dispatch is bounded by a gather timeout; HITL dispatches are
sequential.

The harness is single-vendor (Anthropic SDK) and runs on Node 20+ via
the local CLI. State is persisted to a single SQLite file shared between
TypeGraph (execution graph) and agentfs (the virtual workspace
filesystem), so file provenance is graph-native by construction.

## What the evidence does and does not support

The eval results in [`docs/evals.md`](evals.md) split claims into
**demonstrated**, **designed**, and **measured** categories. Reading
those carefully:

- **System-prompt framing is the primary value driver.** On document-
  based knowledge-work tasks, the harness wins +15–40 pp over a flat
  baseline through structured framing around source faithfulness, not
  through skill decomposition.
- **Tool access adds value when answers require external data.** The
  research-dependent synthesis task gains +18 pp from web research; that
  is tool access, not the skill abstraction per se.
- **Graph infrastructure enables behavioral testing.** Dispatch ordering,
  cross-agent scoping, and HITL precision are testable as structural
  predicates without an LLM judge.
- **Decomposition's content-quality advantage over flat-harness is not
  demonstrated.** The `dcv-*` mechanism suite has so far returned null
  on every task, and the matcher-brittleness artifact caught on
  `dcv-004` — a proximity-window choice that manufactured an apparent
  23-point decomposition loss — is what motivated the methodology
  playbook in the first place. The skill abstraction is load-bearing infrastructure for
  auditability, policy enforcement, and graph-routed artifact flow; its
  outcome value on harder workloads is an open question.

## What this is not

This is not a production framework. It is a reference implementation for
the playbook, the graph-native provenance model, the workspace, the
skill abstraction, the HITL boundary, and the eval methodology. There is
no auth, no multi-tenancy, no SLA, and a single LLM vendor wired in. A
previous Cloudflare Workers + Durable Object deployment path has been
archived under `archive/cloudflare-worker/` so the mainline stays focused
on the methodology and the local harness that produced its evidence.

The intended audience is people running agent evals who want their
comparative claims to survive scrutiny. The methodology post is the
front door; the harness is what made the evidence behind it.
