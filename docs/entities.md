# Entity design decisions

The harness has six entities: `AgentDefinition`, `Run`, `Task`, `Operation`,
`Skill`, and `Artifact`. This document explains why each entity exists at
this level of abstraction, what it specifically is not, and what was deliberately
left out.

Each entity maps 1:1 to a TypeGraph node type (defined in
`packages/core/src/graph.ts`, graph ID `nicator`). Fields that express
relationships between entities — `Run.agentDefinitionId`, `Task.runId` — are
not stored as node properties. They are expressed as typed edges in the graph
(`instantiates`, `contains`, `produces`, etc.), which makes relationships
traversable and queryable without JOINs. Artifacts have no `runId`, `taskId`,
or `operationId` properties — all directionality is in edges. Zod schemas
validate at the storage boundary; TypeGraph handles persistence and traversal.
See [docs/graph-model.md](graph-model.md) for the complete node/edge schema.

---

## AgentDefinition

**What it is:** A versioned blueprint for an agent — the set of skills it can
invoke, the policies that govern when each skill can be used, and the system
prompt that establishes its behavioral context.

**The design decision:** `AgentDefinition` is separate from `Run` because the
same definition should produce reproducible runs. If you want to understand why
an agent behaved differently on Tuesday than on Monday, you need to know whether
the definition changed. Merging definition and execution makes this question
unanswerable.

`AgentDefinition` is immutable after creation. A changed definition is a new
definition with a new version. Runs reference a specific definition version.
This means every Run is fully reproducible given the same inputs — you know
exactly what the agent was allowed to do, not just what it did.

**What it is not:** An `AgentDefinition` is not a routing graph. It does not
specify the sequence of skill calls or the conditions under which each skill
fires. That is the model's job. The definition establishes the environment;
the model plans within it.

**What was left out:** Role-based access control on individual skills within a
definition. This is the obvious next thing — some skills should only be available
to certain agent definitions, or only under certain policy conditions — but it
introduces enough complexity that I wanted to establish the simpler model first
and extend it deliberately.

---

## Run

**What it is:** One end-to-end execution of an `AgentDefinition` against a
specific input. A `Run` has a status (`pending`, `running`, `awaiting_hitl`,
`completed`, `failed`), a reference to the definition version, the original
input, and the set of tasks that emerged during execution.

**The design decision:** A `Run` is the unit of accountability. If an agent
does something unexpected, the Run record is where you start. It contains the
complete lineage: every task, every operation, every artifact produced. This is
not for debugging convenience — it is a design constraint. An agent that cannot
be audited is an agent that cannot be trusted in production.

`Run` status includes `awaiting_hitl` as a first-class state, not an error
condition. A run waiting for human approval is in a well-defined, recoverable
state. In the local CLI runner, the process waits for a bounded human response
and then resumes the same in-process run loop. Durable remote resumption is not
part of the active implementation.

**What it is not:** A `Run` is not a conversation. A conversational AI product
that accumulates turns indefinitely is a different abstraction. A `Run` has a
defined completion condition — either the agent determines the task is done, a
terminal error occurs, or a policy limit is reached. Open-ended conversation is
out of scope.

**What was left out:** Run cancellation. The `cancelled` status was removed from
the schema because no code path set it and the cleanup logic (releasing acquired
resources, notifying human approvers, marking in-flight operations as abandoned)
was never implemented. If cancellation is needed later, add it back with the
cleanup logic from the start.

---

## Task

**What it is:** A schedulable delegated work unit with its own context, policy,
cancellation, and wait semantics. Tasks form a two-level hierarchy within a Run:

- **Root Task** — created automatically at run start, represents the outer LLM
  loop. The root Task is a pure coordinator: it owns no Operations directly,
  except for policy-gated HITL (`require_hitl_approval`), which records its
  `hitl_response` operation on the root task before the subagent child Task is
  created (on approval). All other work is delegated to child Tasks. The
  coordinator's decisions are expressed structurally — `spawns` edges and
  child Task ordering via `sequenceNumber` — rather than as Operations. The
  model's reasoning about what to dispatch is part of the conversation state,
  not the graph. This is deliberate: recording reasoning as Operations would
  conflate deciding with acting. A failed tool call is meaningfully different
  from a reasoning step that led nowhere. The graph captures _what happened_;
  compaction summaries (`has_compaction` on the Run) preserve a lossy record
  of _why_.
- **Child Task** — created for every dispatch: tool calls, subagent spawns,
  and HITL requests. Each child Task has its own Operation(s), a
  `parentTaskId` linking it to the root via a `spawns` edge, and a `role`
  indicating its type.

Task roles (`TaskRoleSchema`):

- `root` — the coordinator task (one per run)
- `tool` — a direct tool call (web-search, web-fetch, etc.)
- `hitl` — a human-in-the-loop approval request
- `subagent` — delegated reasoning work with its own prompt, context, and
  capability set

Subagent tasks carry `subagentName` — the human-readable label. Skill-backed
subagents (created via the `skill` tool) have an `invokes` edge to the Skill
node. Ad-hoc subagents (created via the `agent` tool) have no `invokes` edge.
Tasks are not pre-declared — they emerge from model dispatch decisions.

**The design decision:** Tasks are the delegation and scheduling boundary.
If something has its own prompt, context window, capability set, budget, and
termination behavior, it is a Task, not an Operation.

Policy enforcement happens at Task creation — before any Operation exists. This
means a policy denial produces no Operation nodes; the Task is either never
created (for `never` policy) or created and immediately gated (for
`require_hitl_approval`). This is a critical ordering constraint.

Every dispatch — regardless of type — creates a child Task. This unified model
means tool calls and skill activations share a common execution abstraction:
both are child Tasks with Operations. The distinction between "fast tool" and
"slow skill" is an implementation detail, not a structural one. This enables:

- **Concurrent dispatch:** Multiple child Tasks are dispatched concurrently via
  a gather-with-timeout mechanism. Completed dispatches return real results;
  still-running dispatches return "in progress" and continue in the background.
- **Uniform lifecycle:** Every dispatch has `pending → running → completed/failed`,
  tracked via the Task's status field.
- **Uniform auditing:** The context builder scores and renders all child Tasks
  the same way, regardless of role.

HITL dispatches are the one exception to concurrent dispatch — they change the
Run's status to `awaiting_hitl` and must be sequential to avoid status races.

**Why tool calls are Tasks, not flat Operations.** The obvious alternative is
to model tool calls as direct children of the Run (like Claude Code, Codex,
and SWE-agent do) and reserve Tasks for subagent loops that have their own
context window and multi-turn iteration. A single `web-search` call doesn't
need its own execution scope — it's one tool call, not an agent loop.

The reason tool calls are wrapped in Tasks anyway is the graph model. Making
every dispatch a Task means `consumes` and `produces` edges are always
Task→Artifact, policy enforcement always happens at Task creation, and
provenance queries always follow the same traversal shape. The alternative —
flat Operations for tool calls, nested Operations for subagents — would
require every graph query, every assertion, and the context builder to handle
two structural shapes instead of one. The cost is a 1:1 Task-to-Operation
mapping for tool calls (extra nodes and edges that carry no additional
information). The payoff is uniform traversal everywhere else.

**What it is not:** A Task is not an atomic action — that is an Operation.
A Task is a scope that owns Operations.

**What was left out:** Task cancellation. The infrastructure for cancelling
in-flight background Tasks (aborting a subagent loop) is not implemented.
Currently, background Tasks always run to completion.

---

## Operation

**What it is:** An atomic recorded action within a Task. One execution of a
tool call or one HITL response. Each Operation records its input (what the
harness provided), its output (what the tool or human returned), its status,
its token usage, and its latency.

Operation types:

- `tool_call` — a tool execution (web-search, web-fetch, etc.)
- `hitl_response` — a human-in-the-loop approval or decision

Context compression is a separate concern — compactions are stored as
`Compaction` nodes linked to the Run via `has_compaction` edges, not as
Operations. This keeps the Operation type strictly about external actions
(tool calls and human decisions) that the model initiated.

**The design decision:** `Operation` is separate from `Task` because failure is
information. If a tool call fails and is retried, both the failure and the
retry should be in the record. A task that succeeded after two failed operations
behaved differently from one that succeeded on the first — and the difference
is relevant to evaluating harness performance.

Operations are immutable facts, not retriable intents. There is no
operation-level retry or idempotency mechanism because the model is the retry
mechanism. A failed tool call returns an error result to the model, which
decides — with full context — whether to retry with different parameters, try
a different tool, or move on. Each retry attempt is a new Operation, preserving
the complete decision trail. The circuit breaker (`MAX_CONSECUTIVE_FAILURES`)
catches degenerate loops where the model cannot make progress despite retries.

Operations are uniform regardless of where they execute. A tool call on a
`tool` child Task and a tool call inside a skill subagent's inner loop
(Operation on a `subagent` child Task) are the same entity with the same
recorded fields: consumes edges, latency tracking, artifacts.

**What it is not:** An Operation is not a message. The messages exchanged between
the harness and the model to complete a tool call are not individually recorded —
only the final input and output of the call are stored as the Operation
record. Recording every message would produce a faithful transcript but would
make the Operation record expensive to store and difficult to use for evaluation.
The tool call is the right unit of granularity for auditing.

**What was left out:** Operation-level cost accounting. Token usage is recorded
per operation, but the cost in dollars is not computed or stored. This is the
obvious operational metric — you want to know not just that a run had 47
operations but that it cost $1.23 — and it requires only a lookup table against
the model's pricing. Left out to avoid coupling the harness to pricing data
that changes.

---

## Skill

**What it is:** A versioned, callable reasoning capability with its own inner
model loop, following the [Agent Skills](https://agentskills.io) standard. A
skill is a graph node (`Skill` type) whose prompt content is stored as a linked
`skill_prompt` artifact (via `has_definition` edge) and whose supporting files
are linked as `skill_asset` artifacts (via `has_asset` edges). Skill metadata
(name, version, description, maxIterations) lives on the node; the
prompt body lives in the artifact.

At run start, skills are materialized to the workspace filesystem at
`skills/[name]@[version]/SKILL.md` (via `materializeSkills` in
`packages/harness/src/skill-loader.ts`). At activation time, the prompt is
read from the workspace — the workspace is the runtime source. Skill fixtures
live in `fixtures/skills/*.json`.

The skill's "implementation" is its prompt. The harness executes a skill by
spawning a child subagent Task, using the prompt body as the system prompt,
passing artifact visibility explicitly from the parent, and running a bounded
subagent loop (`runSubagentLoop` in `packages/sdk/src/sdk.ts`) with the
parent's inherited tools plus `read_artifact`. The same model powers both the outer run
loop and every skill subagent. The skill decides when to call tools, how many
times, and when to stop — it is a scoped sub-agent, not a function call.

Skills are distinct from tools. A **tool** is atomic and stateless — it calls an
API and returns results. There is no reasoning, no iteration, no decision about
when to stop. A **skill** is a reasoning capability that uses tools to accomplish
a sub-task, running its own model context until it produces a structured output.

In the three-tier model, a skill activation creates a child subagent Task. The
skill's inner loop produces Operations on that child Task. This makes skill execution
structurally identical to what a sub-agent would produce — the skill _is_ a
sub-agent with a scoped context.

**The design decision:** Skills are versioned graph nodes for the same reason
npm packages are versioned: you want to know exactly what prompt ran, you want
to be able to update skills independently of agent definitions, and you want to
be able to reuse skills across multiple agent definitions without copying their
implementation. The `uses` edge (`AgentDefinition → Skill`) with an optional
`policy` property replaces the former `skills` JSON array on AgentDefinition.

System skills (like `human-approval`) are registered by the harness at startup
and are available in every AgentDefinition without being declared in the skills
list. They cannot be overridden by user-defined skills.

The description field is what the model sees. It is the skill's interface to
the model's planning. A well-written skill description makes the model more
likely to invoke the skill correctly and in the right context. A poorly written
description produces skill invocations with malformed inputs or inappropriate
calls. The description is load-bearing in a way that function docstrings in
normal code are not.

**What it is not:** A skill is not a tool. Tools are a separate concept —
stateless adapters that skills call within their inner model loop. Tool
invocations within a skill's inner loop are recorded as Operations on the
skill's child Task, providing full audit trail visibility.

A skill is not a tool in the OpenAI/Anthropic API sense. The model calls the
`skill` tool as an explicit tool use, but the harness mediates execution: it
resolves the skill name to a specific version, enforces policy, loads the
prompt from the workspace, and runs the subagent loop. This indirection means
skill implementations can change without the model needing to learn a new
calling convention, and the harness can apply policy checks before the call
executes.

**What was left out:** Remote skill resolution. Currently, skills are graph
nodes loaded from fixtures at definition creation time. A remote registry
would allow skills to be published and pulled by name and version. For now,
skills are bundled with the definition and materialized to the workspace.

---

## Artifact

**What it is:** A named, typed content node. Artifacts have an ID, a type, a
content payload, and provenance expressed entirely through edges — there are no
`runId`, `taskId`, or `operationId` properties on the artifact itself.
Provenance is recovered by inbound traversal: `produces` (from an Operation),
`has_input` (from a Run), `has_definition` / `has_asset` (from a Skill).
Downstream tasks can reference artifacts by ID; the context builder surfaces
artifact metadata and the agent reads content on demand via `read_artifact`.

Artifact types: `text`, `json`, `file_reference`, `hitl_decision`,
`skill_prompt` (a skill's system prompt body), `skill_asset` (a skill's
supporting file), `input_document` (user-supplied input, replacing the former
`source_document` type).

Artifacts are content-addressed: each carries a `contentHash` (SHA-256 of its
content) used for deduplication within the run. If an identical artifact already
exists, the repository returns the existing node. When the same logical artifact
(matched by name) is written with new content, the repository creates a new
node linked to the previous version via a `supersedes` edge — preserving full
history without mutation. Workspace files can be promoted to artifacts
explicitly via `save_artifact` or automatically via `outputPaths` globs
configured on the AgentDefinition's workspace.

**The design decision:** Making artifacts first-class rather than passing
outputs implicitly through the model's context solves two problems.

First, it makes data flow explicit. If task B depends on the output of task A,
that dependency is recorded as an artifact reference in task B's input — not
inferred by examining the model's context. This makes the run's data flow
auditable: you can trace any claim in the final output back to the artifact
that produced it, and from there back to the operation and the input document.
This is what block-level provenance looks like in practice.

Second, it enables selective access. The context builder scores artifacts and
surfaces metadata (ID, name, type, preview) for high-scoring ones. The agent
calls `read_artifact` to pull full content on demand. On a long run with many
tasks, this is the difference between a model that reads what it needs and a
model overwhelmed by intermediate outputs it cannot use.

**What it is not:** An artifact is not a message or a turn in a conversation.
It is a discrete produced output with a type and a schema. Text summaries,
structured JSON extractions, file references, and human decisions are all
artifacts — they are typed differently and accessed differently (HITL
decisions are inlined; others are pulled on demand via `read_artifact`),
but they participate in the same provenance system.

**What was left out:** Artifact storage beyond the run boundary. Currently,
artifacts are stored in the run's local SQLite-backed graph and are accessible
for the lifetime of the run.
Cross-run artifact reuse — where run B can reference an artifact produced by
run A — is not implemented. This is the foundation for a long-term memory
system: artifacts that survive their originating run and can be retrieved by
future runs. The schema supports it (artifact IDs are stable); the retrieval
and injection logic does not exist yet.

**Multi-agent role:** In a multi-agent run, artifacts are the communication
channel between subagents. Subagent A writes artifacts; Subagent B reads them
via `consumes` edges. The model coordinates which subagents see which artifacts
by passing `artifact_ids` to the spawn tools.
