# Why this exists

## The problem with orchestration frameworks

LangGraph, CrewAI, AutoGen, and most of their contemporaries were built between
2022 and 2024, when GPT-3.5 and early GPT-4 were the available frontier models.
Those models had a specific failure pattern: they could reason about a multi-step
task but they could not reliably _execute_ it. Ask GPT-3.5 to research a company,
synthesize findings, draft an email, and send it — and it would hallucinate a tool
call, forget what it had already done, or simply declare the task complete after
the first step. The model needed scaffolding to stay on track.

Orchestration frameworks provided that scaffolding. A LangGraph graph specifies
the exact sequence of steps, the transitions between them, and the conditions under
which each transition fires. The developer codes the control flow; the model fills
in the content. This is a reasonable engineering response to a real capability gap.

The gap has closed. Current frontier models can maintain coherent intent across
dozens of tool calls on a complex task without being told in advance which tools
to call in which order. The need for explicit
routing graphs has largely evaporated. The frameworks have not.

## What frameworks cost

The costs are easy to underestimate because they show up in the wrong place.

**Complexity is invisible to the model.** A LangGraph graph is a Python object.
The model never sees its structure; it only sees whatever the current node's prompt
tells it. This means the developer is doing the planning work that the model could
do, without the model being able to check or correct that plan. If the graph is
wrong — if the sequence of steps doesn't actually solve the task — the model has
no recourse. It executes the graph.

**Coupling is pervasive.** A multi-agent system built on an orchestration framework
couples three things that should be separate: the task decomposition logic (which
steps to take), the routing logic (when to move between steps), and the model
behavior (what each step does). Change the model and you may need to rebuild the
graph. Change the task structure and you rebuild the graph. Change the routing
conditions and you rebuild the graph. Each rebuild is a chance to introduce bugs
that are invisible until a task fails in production in a way that cannot be
reproduced in your test suite.

**Auditing is an afterthought.** Most orchestration frameworks were designed to
run tasks, not to record them. Audit trail support is typically bolted on — a
callback here, a log line there. This makes it hard to answer the questions that
matter when an agent does something unexpected: what did it know at each step, what
did it decide, and why? Without a complete record of operations and their inputs,
post-hoc debugging is guesswork.

**The framework becomes the product.** Teams optimizing for LangGraph performance
are optimizing for a different thing than teams optimizing for task performance.
Prompt engineering for a specific graph node is not the same as prompt engineering
for a capable model. You develop intuitions about the framework's behavior rather
than the model's behavior, and those intuitions don't transfer.

## Recording what happened

The audit argument above — "without a complete record of operations and their
inputs, post-hoc debugging is guesswork" — implies a storage model. What shape
should that record take?

Agent execution state is naturally a directed acyclic graph. A run contains
tasks. Tasks have operations. Operations produce artifacts. Downstream tasks
consume artifacts from earlier tasks. That last relationship — consumption —
is a cross-reference between nodes in the same run, not a parent-child
hierarchy. Storing it in a relational model means either a JSON array column
(opaque to queries) or a junction table (another JOIN). Storing it as a graph
edge makes it a first-class, traversable relationship.

This system uses [TypeGraph](https://github.com/niciaai/typegraph) — a typed
knowledge graph library for SQLite and Postgres — as its sole storage layer.
Every entity is a graph node. Every relationship is a typed edge. The two
queries that matter most — full run lineage and artifact provenance — each
compile to a single SQL statement via TypeGraph's `store.subgraph()`, which
emits a `WITH RECURSIVE` CTE that traverses, filters, and hydrates in the
database. No application-layer N+1 loops, no multi-step query chains. The
graph is also directly renderable in a visualization layer: no translation,
no result-set assembly.

The choice is not ideological. It is practical: agent execution state has
graph structure, so storing it in a graph removes the impedance mismatch
between what the data _is_ and how it is stored. The implementation
delivers on that: `getRunLineage` issues one recursive CTE that returns
every task, operation, artifact, skill, and consumption edge for a run;
`getArtifactProvenance` issues one bidirectional CTE that traces an
artifact back to its producing operation, task, and run, and forward to
every task that consumed it. See [docs/graph-model.md](graph-model.md)
for the full node/edge schema.

## What a harness does instead

A harness is not an orchestration framework. It does not specify what the model
will do. It provides the environment in which the model acts, records what happens,
and ensures the model has the right affordances to act effectively.

The distinction matters. An orchestration framework is prescriptive — it says "call
this tool, then this tool, then this tool." A harness is descriptive — it says "the
model called this tool, then this tool, then this tool, and here is the full record."

This means the control flow lives in the model, not in the code. If the model
decides the task requires a step the developer didn't anticipate, it can take that
step. If it decides a step is unnecessary, it can skip it. The harness records both
decisions. This is not a loss of control — it is a shift in where control is
exercised. The developer controls what skills are available, what policies govern
their use, and what the model is told about the task. The model controls the plan.

The harness earns its complexity through three things the model cannot do for
itself: persistent state across a long-running execution, external action with
retryable semantics, and integration of human judgment at task boundaries.

## The boundary question

Harness-based decomposition is not always better than a single call. The benchmark
in `evals/` is specifically designed to find the boundary.

The hypothesis: structured decomposition pays off when the task has at least two
of the following properties:

1. **Evidence is fragmented across sources.** The model benefits from an explicit
   retrieve → extract → synthesize sequence because working from all sources
   simultaneously introduces interference between competing claims.

2. **Faithfulness constraints are strict.** When the cost of fabrication is high
   (legal documents, financial analysis, safety-critical decisions), a harness that
   separates extraction from synthesis makes it easier to audit which claims came
   from which sources.

3. **The task is longer than a single context window.** A harness that compresses
   completed operation history prevents the model from losing track of what it has
   already done on very long tasks.

4. **Human judgment is required at a decision point.** A task that requires an
   approval step partway through cannot be completed in a single call.

For tasks without any of these properties — a short document with a clear question
and no ambiguity — the single-call baseline is the right approach. The harness adds
overhead without adding value. The benchmark shows where that line is.

**Current eval status:** The benchmark tasks primarily test property 2
(faithfulness on long documents) and property 4 (HITL gating). The harness wins
on these through system prompt framing and HITL integration, not skill
decomposition. Property 1 (fragmented evidence requiring multi-skill
coordination) is the untested case — no eval task currently requires the
retrieve → extract → cross-reference → synthesize pipeline that would exercise
the skill system's artifact routing. The skill machinery is currently
load-bearing for auditability and policy enforcement; its outcome value on
complex tasks is a hypothesis, not a demonstrated result. See
[docs/evals.md](evals.md) § What the results show for the full analysis.

## What this is not

This is not a production framework. It is a reference implementation designed to
make a specific argument legible in code. There is no multi-tenant auth, no billing,
no SLA.

The Cloudflare Workers deployment is functional — real Hono API routes with Zod
validation, a Durable Object HITL implementation with alarm-based timeouts and
cryptographic token management, D1-backed TypeGraph persistence, and run
execution in a dedicated Durable Object with heartbeat-based crash detection.
It runs real agent workloads end-to-end on an edge runtime. What it lacks is
operational hardening: authentication, rate limiting, and structured
observability. Functional, not production-hardened.

The argument is: if you accept the premise that modern models don't need explicit
routing graphs, what does an agent harness look like? This repo is the answer. Six
entities. Skills that are versioned and imported. HITL as a task type, not a special
case. Evals that measure process and outcome. No orchestration framework dependency.

Whether that answer is right is an empirical question. The benchmark exists to test
it.
