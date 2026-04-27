# Layered eval architecture

This document defines a three-layer eval model — **Steering → Decomposition → Answer quality** — and the methodology for building evals at each layer. It is a companion to [`evals.md`](evals.md), which describes the existing outcome-based and behavioral eval infrastructure. This document explains how to use that infrastructure in a layered, diagnostic way that separates failure modes cleanly.

## Motivation

The existing eval categories (`kwb-*`, `dsp-*`, `hitl-*`, `lim-*`, `ctx-*`, `crd-*`) are flat — each measures a mix of concerns. When a task fails, the failure is ambiguous:

- Did the **model** make the wrong decision?
- Did the **framework** fail to give the model the right affordances?
- Did the **user's steering intent** fail to reach the model at all?

These are three different failure modes with three different fixes. A flat eval structure conflates them, making debugging a matter of speculation rather than measurement.

A concrete example from the Apr 5 `5aced9d6` and Apr 9 `crd-001` runs: on the adversarial-debate task, the task YAML's system prompt explicitly names three agents — bull, bear, judge — and demands they be spawned via ad-hoc dispatch. The harness produced **six** subagents, none with those names, all using the `summarizer` skill. The model's final prose narrated "the three-agent debate process" while the graph showed nothing of the kind.

Was that a model failure (ignored clear instructions)? A framework failure (dispatch path broken)? A steering failure (prompt got diluted by harness-injected context before reaching the model)? **From the data we had, we could not tell.** All three were plausible, and the fix for each is different and non-overlapping. This is exactly the situation the layered architecture is designed to resolve.

(This original failure occurred when the dispatch tools were named `spawn_subagent` and `spawn_subagent_with_skill`. The root cause turned out to be tool presentation — the skill-based variant was biased against by design. Tool names are now `agent` and `skill`, mirroring Claude Code's split. See "Order of operations" below for the diagnostic sequence that led to that fix.)

## The three layers

```text
          ┌─────────────────────────────────────────┐
Layer 1   │  Steering                               │
          │  "Does user intent propagate to the     │
          │  model's decision surface?"             │
          └─────────────────────────────────────────┘
                         │ gates
                         ▼
          ┌─────────────────────────────────────────┐
Layer 2   │  Decomposition                          │
          │  "Given propagated intent, does the     │
          │  model use primitives effectively?"     │
          └─────────────────────────────────────────┘
                         │ gates
                         ▼
          ┌─────────────────────────────────────────┐
Layer 3   │  Answer Quality                         │
          │  "Given that composition, is the final  │
          │  output correct/useful?"                │
          └─────────────────────────────────────────┘
```

Each layer **gates** the next. A failure at any layer makes results below it uninterpretable: if steering doesn't propagate, it's meaningless to measure whether decomposition is effective, because the model is operating in an undirected space. If decomposition fails, answer quality may still be correct (as the `kwb-*` Apr 6 results showed) but it cannot be attributed to framework value.

| Layer              | Question                                                      | Grading style                   | Cost per task |
| ------------------ | ------------------------------------------------------------- | ------------------------------- | ------------- |
| **Steering**       | Does user intent reach the model?                             | Graph-shape assertions only     | ~$0.02        |
| **Decomposition**  | Does the model use primitives effectively within that intent? | Graph assertions + some factual | ~$0.10        |
| **Answer quality** | Does the output match ground truth?                           | Factual + judge                 | ~$0.50        |

### Short-circuit eval flow

The layer dependency dictates execution order. Run steering evals first. When running a full suite, apply this short-circuit rule:

1. Run all steering evals.
2. If a test's steering assertions fail, **skip** the same task's decomposition and answer-quality assertions. Mark them as `blocked` in the report, not `fail`.
3. Compute per-layer aggregates independently. Report `steering_fidelity`, `decomposition_effectiveness_conditioned_on_steering_pass`, `answer_quality_conditioned_on_both`.

This prevents a single layer failure from fabricating downstream failures that have nothing to teach you. It also naturally produces a diagnostic signal: if steering fidelity is 0.60 and decomposition is 0.95, you know where to invest.

### Per-layer aggregates

Each layer reports its own score. The framework's overall eval health is a vector, not a scalar:

```text
Steering fidelity:          0.95  (11/12 pairs passed)
Decomposition effectiveness: 0.80  (4/5 conditioned on steering pass)
Answer quality:              0.76  (factual weighted average)
```

A single aggregate number is always an oversimplification at this level. Surface the layers.

## Steering as composition

**Steering is not a flag. It is a property of how the user's system prompt, skill descriptions, tool descriptions, and harness-injected context compose into the context the model actually sees.**

The composition elements the user can vary:

1. **System prompt** (`definitionOverrides.systemPrompt` in eval tasks, or the agent's `systemPrompt` field in production).
2. **Skill descriptions** (fixture JSON at `fixtures/skills/*.json`; what the model sees when deciding between skills via the `skill` tool).
3. **Tool descriptions** (SDK tool builders at `packages/sdk/src/sdk.ts`; the descriptions for direct tools and for `skill` / `agent` themselves).
4. **Skill set provided to the agent** (which skills are registered at all, which are gated by policy).

The composition elements the user **cannot** vary — these are harness-injected and uniform across agents:

- The agent loop structure (one turn of completion, then tool results, then next turn).
- The artifact context (summaries of prior task outputs in each turn).
- The date, platform, and runtime metadata.
- The limits boilerplate (e.g. "you have X tokens remaining").

The model's decision at any turn is a function of everything in its context window — both the user's steering and the harness's injections. If the harness injections are more prominent, more concrete, or more numerous than the user's steering, the steering is diluted. **Steering fidelity is the measurable property of how faithfully user intent reaches the model's decision surface despite this dilution.**

### Case 1 vs Case 2

Users fall into two intent patterns:

- **Case 1 — Naive / best-effort**: The user provides skills because they might be useful but does not care whether they are used. "Just answer my question correctly." Most `kwb-*` tasks are Case 1 in practice: the model answers correctly from sources without invoking the researcher skill, and the Apr 6 `3251f5b8` run shows this is a valid outcome (100% factual accuracy).
- **Case 2 — Steered / methodological**: The user encodes specific methodology, compliance, or topology requirements in how they express available primitives. "Use the researcher skill — it applies our compliance-required methodology" or "organize this as a three-agent debate." The user cares about the **path**, not just the outcome.

The framework currently handles Case 1 by default. The `always` policy (`packages/harness/src/policy.ts`) is permissive — it says "invocation is always permitted," not "invocation is always required." Case 2 is not enforced by any framework mechanism today; it is meant to be achieved through composition alone (the user writes a prescriptive system prompt, picks skills with clear descriptions, and trusts the model to follow).

**Case 2 is not solved by adding a flag or policy extension.** Policy is a permissions axis — `always | never | require_hitl_approval | max_calls_per_run` all answer "is this invocation allowed?" Adding a `required` policy would conflate permissions with behavior expectations. Behavior is an orthogonal axis, and the answer to "is this invocation expected?" lives in composition, not in the policy type system.

The framework's product claim with respect to Case 2 is: **given enough steering surface area (system prompt + skill descriptions + tool descriptions), the user's intent propagates reliably**. Whether this claim holds is an empirical question — answered by steering evals.

### Policy vs behavior — do not conflate

This is worth restating as a standalone rule, because the temptation to conflate is strong:

> Policy is about **permissions** ("is invocation allowed?"). Behavior is about **expectations** ("is invocation wanted?"). These are orthogonal.

A `required_to_invoke` policy type would be a category error. It would mean a skill can be simultaneously "permitted once per run" (`max_calls_per_run: 1`) and "required to invoke" — what happens when both apply? The answer lives in neither axis cleanly.

Keep `PolicySchema` in `packages/core/src/schema.ts` as it is. If a Case 2 user needs deterministic guarantees (e.g. audit requirements that cannot trust the model's compliance), the right abstraction is a **workflow primitive** — a mandatory preflight step the harness creates before the agent loop starts, or a post-hoc audit gate that rejects non-compliant runs. Those are separate concepts from permissions, and should be designed separately **only when driven by concrete user demand**, not preemptively.

## Decomposition within bounds

Given steering that correctly propagates, the decomposition layer answers: **does the model use the execution primitives effectively within that intent?**

The decomposition primitives are:

- Direct tool calls (`web-search`, `web-fetch`, `bash`, etc.)
- Skill activation (the `skill` tool)
- Ad-hoc agent creation (the `agent` tool with a model-chosen name and prompt)
- Artifact read (`read_artifact`)
- HITL requests (`human-approval`)
- Parallel dispatch (multiple tool calls in one turn)

A decomposition test holds steering constant and correct, then asks whether the resulting execution graph matches what the steering intended. Examples:

| Steering intent                                      | Task                   | Expected graph shape                                                   |
| ---------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| "Use debate topology for adversarial questions"      | Adversarial Q          | 3 ad-hoc subagents (bull/bear/judge) + DAG ordering + scoped artifacts |
| "Use the researcher skill for research questions"    | Research Q             | ≥1 `invokes` edge to researcher Skill node                             |
| "Prefer direct answers for self-contained questions" | Arithmetic Q           | Zero subagents, direct answer                                          |
| "Use bash for computations"                          | SHA-256 of random UUID | ≥1 `bash` operation, output grounded in real execution                 |

Decomposition tests use the same graph-assertion machinery as steering tests. The difference is the unit under test: steering tests vary the prompt/description composition and assert on whether any intent propagates at all; decomposition tests fix the composition and assert on whether the primitives operate correctly given it.

## The gradient: steering intensity as a controlled variable

Testing steering as pass/fail is coarse. The more useful test is a **gradient**: hold the task fixed, vary the steering intensity, and measure both compliance and quality at each point.

### Intensity levels

| Level            | Description                                                 | Example prompt                                                                                                  |
| ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Light**        | Permission only. The skill/tool is available; no directive. | "You have the `researcher` skill available."                                                                    |
| **Moderate**     | Contextual directive. Use for this kind of task.            | "For research-shaped questions, use the `researcher` skill."                                                    |
| **Heavy**        | Mandatory directive. Must always use.                       | "You must invoke `researcher` before answering any research question."                                          |
| **Over-steered** | Rigid pattern forcing. Use even when inappropriate.         | "Decompose every question into exactly three named agents: `alpha`, `beta`, `gamma`, regardless of task shape." |

### Two curves

At each intensity level, measure two things:

1. **Steering compliance rate** — does the graph match the directive? (Graph assertion.)
2. **Answer quality rate** — does the final output satisfy the task's quality bar? (Factual score or judge.)

The expected pattern:

```text
compliance │                ╭─────────
           │              ╭─
           │          ╭───
           │       ╭──
  0.0 ─────┴────────────────────────  intensity
           light  mod  heavy  over

quality    │ ─────────╮
           │            ╰─╮
           │              ╰───╮
           │                  ╰───────
  0.0 ─────┴────────────────────────  intensity
           light  mod  heavy  over
```

- Compliance should **rise** with intensity — stronger directives should produce more compliant behavior.
- Quality should be **flat or slowly declining** through the normal range, then drop as over-steering forces inappropriate patterns.
- The intersection of "compliance is high enough to be useful" and "quality hasn't yet degraded" defines the **steering sweet spot** — the intensity range users can rely on.

### What the curves tell you

The shape of the curves is diagnostic:

- **Compliance flat at 0 across all intensities** → steering is being ignored entirely. Composition problem: user intent isn't reaching the model at all. Root cause is probably in how `system-prompt.ts` assembles the prompt or what the harness injects around it.
- **Compliance only rises at heavy intensity** → light/moderate steering is being diluted. The model's default tool-selection bias is overcoming user directives until the directives are framed as absolute requirements. Fix is probably in tool descriptions (`packages/sdk/src/sdk.ts`) making tool use feel optional or less relevant.
- **Compliance high but quality drops sharply at moderate** → steering is over-triggering. The model is forcing the pattern even when it would be inappropriate. Fix is in how directives are phrased in task authoring (a documentation/user-education issue, not a framework bug).
- **Compliance high and quality preserved through heavy, drops at over-steered** → healthy curve. This is the publishable result.
- **Compliance high across all intensities but quality is low across the board** → the steered behavior is itself the problem. Users should not be steering this way for this task shape. Surface in task-design guidance.

The gradient is not a pass/fail measurement — it's a **dose-response curve**. Its value is in the curve shape, not in a single aggregate number.

## Positive/negative pairing and worst-of aggregation

Gradient measurements are necessary but not sufficient. A model can be gamed in two opposite directions:

- **Tool-happy**: always invokes, always spawns. Passes every positive test (invocation happens). Fails every negative test (invocation happens when it shouldn't).
- **Tool-avoidant**: never invokes anything, always answers directly. Passes every negative test trivially. Fails every positive test.

A naive category aggregate that averages across tests gives both failure modes a passing score if the test count happens to favor one side. This is exactly the scoring pathology to avoid.

### Structural pairing

For every capability or steering directive, design a matched **pair** of tests: a positive variant (behavior should happen) and a negative variant (behavior should not happen), holding all other composition elements identical. The pair passes only if both sides pass.

Example:

- **Positive**: moderate-intensity "use researcher for research questions" + research-shaped task → researcher should fire.
- **Negative**: same moderate-intensity steering + arithmetic task → researcher should NOT fire (steering respects task shape).

A model that blindly invokes researcher on both fails the pair. A model that invokes on neither fails the pair. Only a model that correctly discriminates passes.

### Worst-of aggregation

Even with pairing, the category-level aggregate should not hide imbalance. Compute:

```text
category_score = min(positive_pass_rate, negative_pass_rate)
```

A category with 5 positive and 5 negative tests, where the model passes all 5 positives but only 2 negatives, scores 0.4 — not 0.7. This prevents volume gaming and makes "fail" unambiguous.

Report the breakdown alongside the aggregate:

```text
Steering: 0.60 (pairs_pass=3/5, pos_rate=5/5, neg_rate=3/5)
  - moderate/body: PASS (positive + negative)
  - heavy/body:    PARTIAL (positive passes, negative fails — over-steering confirmed)
  - adhoc/body:    PASS
  - skill-desc:    FAIL (positive fails — skill description ignored)
  - over-steer:    PASS
```

## Differential diagnostic design

Individual tests are useful for pass/fail. **Matrices of tests across controlled dimensions are more useful**, because the pattern of passes and failures across the matrix points at root causes.

### The sparse matrix

The steering eval matrix varies two axes:

- **Intensity**: light / moderate / heavy / over-steered
- **Location**: system-prompt body / skill description / tool description

A full 4×3 matrix is 12 positions, each with a positive and negative variant, giving 24 tests. That's too many for v1 and would obscure the signal with noise. Instead, build a **sparse** matrix: pick 6-8 positions that maximally separate the diagnostic questions.

### Diagnostic patterns and their fixes

Different failure patterns across the matrix imply different root causes:

| Observed pattern                                                  | Likely root cause                                                              | Fix location                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Light fails, moderate fails, heavy passes                         | User directives are dilutely presented; model needs absolute framing to comply | Strengthen system-prompt presentation or increase salience of user directives     |
| All body-location tests fail, all description-location tests pass | System-prompt content is being drowned out by harness injections               | Reduce harness-injected context OR elevate user system-prompt placement           |
| Description-location tests fail regardless of intensity           | Skill/tool descriptions don't get enough weight in model decisions             | Improve description quality OR adjust how descriptions are presented to the model |
| Moderate/heavy positive tests pass, matching negatives fail       | Over-steering — model forces pattern regardless of task shape                  | Task-authoring guidance: users need to be more conditional in their directives    |
| All positive tests pass, all negative tests pass                  | Healthy steering. Claim defensible.                                            | No fix — ship the eval as a regression gate                                       |
| Everything fails at all intensities                               | Steering is not propagating at all; upstream bug                               | Read `system-prompt.ts`; the composition layer is broken                          |

**This is why the matrix is sparse but carefully chosen.** Each test position should answer a different diagnostic question. Test overlap wastes tokens without improving resolution.

### Methodology: evals before framework changes

A cornerstone principle: **do not add framework changes speculatively to improve steering.** Adding a `systemPromptDirectives` channel, or restructuring tool descriptions, or modifying prompt assembly — these are all plausible fixes that should be **driven by eval results**, not by intuition.

The discipline:

1. Build the steering eval matrix.
2. Run it. Observe the pattern of passes and failures.
3. Read the pattern → identify the root cause from the diagnostic table above.
4. Apply the minimum fix that addresses that specific root cause.
5. Re-run the steering eval matrix. Verify the fix produced the expected pattern shift.
6. Lock the eval in as a regression test for that specific fix.

This is eval-driven development for the framework itself. The evals are both diagnostic instrument and regression test.

## Order of operations

The layered architecture and the eval-driven discipline imply a specific build order:

1. **Steering evals first.** Build the sparse matrix. These are cheap, graph-assertion-only, and have the highest diagnostic value per token spent.
2. **Run them. Read the pattern.**
3. **Apply whatever framework fix the pattern points at.** (Or no fix, if the pattern is healthy.)
4. **Re-run steering to verify the fix.**
5. **Only after steering is reliable**: build decomposition evals. These measure what the model does within a correctly-propagated intent.
6. **Only after decomposition is reliable**: run answer-quality evals (existing `kwb-*`). These become interpretable as measurements of the layer they're meant to measure, rather than noise-weighted combinations of all three layers.

Skipping earlier layers does not save time. Every measurement at a later layer is noisy until earlier layers are confirmed.

## Product claim implications

The layered view has direct implications for what the framework can credibly claim:

- **"Our harness does not degrade answer quality relative to a direct-prompt baseline on knowledge-work tasks"** — supported by the `kwb-*` Apr 6 results (harness 100% vs baseline 84.8%). Can be claimed.
- **"Our harness gives users composable primitives that reliably propagate steering intent to the model"** — not yet supported; this is what steering evals measure. The claim becomes defensible when the steering matrix shows healthy curves.
- **"Our harness produces better answers through structured decomposition"** — **not currently supported**. The Apr 6 `kwb-*` results show the model is winning answer quality **without** decomposing. The framework is not adding value on these tasks via decomposition; it's neutral at worst and passively helpful at best. **Do not make this claim** without evidence from a task category that specifically isolates "with decomposition > without decomposition" — which no existing task does.
- **"Our harness supports Case 2 users who need guaranteed methodology compliance"** — supported only when steering evals show heavy-intensity directives propagate reliably. Until then, caveat any Case 2 claim with "best-effort via prompt engineering."

## The sparse matrix v1 specification

This is the concrete v1 design. Six tasks across three logical pairs. Each task is a graph-assertion-only eval with minimal sources and no factual scoring.

### Matrix positions

| ID        | Intensity | Location           | Positive/Negative          | Task shape           | Expected assertion                                                                            |
| --------- | --------- | ------------------ | -------------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `str-001` | moderate  | system-prompt body | positive                   | Research Q           | `researcher` invoked ≥1 time                                                                  |
| `str-002` | moderate  | system-prompt body | negative                   | Trivial arithmetic   | `researcher` NOT invoked                                                                      |
| `str-003` | heavy     | system-prompt body | positive                   | Research Q           | `researcher` invoked ≥1 time                                                                  |
| `str-004` | heavy     | system-prompt body | negative                   | Trivial non-research | `researcher` NOT invoked (tests whether heavy steering forces inappropriate use)              |
| `str-005` | heavy     | system-prompt body | positive — ad-hoc dispatch | Adversarial debate   | 3 ad-hoc subagents named `bull`/`bear`/`judge`, no `invokes` edges to any Skill               |
| `str-006` | moderate  | skill description  | positive                   | Research Q           | `researcher` invoked (test that skill description alone can steer without system-prompt body) |

### Logical pairs

- **Pair A (moderate/body)**: `str-001` + `str-002`. Both must pass for pair credit. Tests whether moderate steering propagates AND respects task shape.
- **Pair B (heavy/body)**: `str-003` + `str-004`. Both must pass. Tests whether heavy steering propagates AND adapts — this is the over-steering resilience test.
- **Pair C (special cases)**: `str-005` + `str-006`. `str-005` isolates the crd-001 dispatch-mode failure. `str-006` isolates the description-location channel. These do not pair with each other structurally; they pair with their absence (running the system-prompt-body tests shows baseline behavior, running these shows whether alternate channels work).

### What the pattern will tell us

Concrete predictions based on our current evidence:

- **If str-001 passes and str-005 fails**: moderate system-prompt steering works for _some_ decompositions but not for ad-hoc named dispatch. Problem is specific to the `agent` tool's presentation or selection bias, not general steering.
- **If both str-001 and str-005 fail**: system-prompt steering is not propagating at all. The problem is upstream — in how `system-prompt.ts` assembles the prompt.
- **If str-001 passes but str-003 fails**: heavy framing is backfiring — probably the model interprets "must" directives as unnatural and refuses. This would be surprising; investigate in the task output text.
- **If str-002 or str-004 fails**: the model is over-applying steering. This is the over-steering mode; the pattern tells us task authors need more conditional directives.
- **If str-006 fails**: skill-description content alone cannot steer the model. All steering must flow through the system prompt. Tells us where to invest.

### Running

```bash
# First-time run — deliberate, one test at a time
pnpm eval --task str-001 --no-judge
pnpm eval --task str-002 --no-judge
pnpm eval --task str-005 --no-judge  # crd-001 isolation test — highest diagnostic value

# Full category once the above are validated
pnpm eval --category steering --no-judge

# With multi-run statistics (recommended before drawing conclusions)
pnpm eval --category steering --runs 5 --no-judge
```

### Extension to the full matrix (v2)

Once v1 runs and produces a diagnosable pattern, extend in the direction the pattern suggests:

- If light-intensity is worth measuring separately: add `str-007` (light/body/positive) and `str-008` (light/body/negative).
- If tool-description location matters: add `str-009` (moderate/tool-desc/positive) — requires creating an alternate skill fixture or a tool description override mechanism.
- If an over-steered position is needed: add `str-010` (over-steered/body/rigid-topology) — requires a task whose correct shape is demonstrably NOT the steered pattern.

Each extension should be justified by a diagnostic question the v1 results raised. Do not extend speculatively.

## Schema and infrastructure changes required for v1

Minimal — intentionally so:

1. **Add `"steering"` to `TaskCategorySchema`** in `evals/schema.ts`. One-line enum extension.
2. **Create skill fixture variant** for `str-006` if testing description-location requires a non-default description. Use a new fixture file under `fixtures/skills/` with a distinct name/version, not a modification of the existing `researcher.json` (to avoid polluting other tests).
3. **No changes** to graph assertions, runner, report format, or step graders. The existing assertion types (`task_exists`, `task_absent`, `task_count`, `run_status`) are sufficient for v1.

The pair-grading and worst-of aggregation are **reporting concerns**, not task-YAML concerns. For v1, task YAMLs are independent and the pair relationships are documented in this doc and in per-task comments. If pair grading proves valuable, add a `pair_id` field to the task schema in v2 and update the runner's aggregate computation.

## Open questions

Questions this document deliberately does not answer — they are empirical and will be resolved by running the v1 matrix:

1. Is there a composition gap in `system-prompt.ts` that dilutes user directives? Unknown. v1 results will tell us.
2. Are the `agent` and `skill` tool descriptions distinct enough that the model picks between them correctly? Unknown as of the initial diagnosis; the rename from `spawn_subagent` / `spawn_subagent_with_skill` to `agent` / `skill` was made in response to the `str-005` + `crd-001` signal. `str-005` (with naive system prompts) and the re-run of `crd-001` validate whether the rename closed the gap.
3. Can skill descriptions alone (without system-prompt directives) steer the model? Unknown. `str-006` tests this.
4. Is the over-steering mode common in practice, or a theoretical concern? Unknown. `str-004` will give the first data point.
5. Do users need a deterministic workflow primitive (preflight / audit gate) for Case 2? Unknown — probably premature to ask. Defer until a real user raises it.

Each of these is a question best answered by data, not speculation.

## Coordination-layer findings (resolved)

The tool rename (`427a043`) recovered named-role dispatch: bull/bear/judge now exist via the `agent` tool with correct ordering. Subsequent investigation on crd-001/002/003 surfaced several coordination-layer issues, all now resolved. The root cause of most of them turned out to be a concurrency race in the harness, not decomposition logic.

1. **Scoped visibility violation (resolved)** — bull consumed bear's artifacts despite the prompt forbidding it. Root cause was framework, not the model: `resolveArtifactIds` silently fell back to `injectedArtifactIds` (every artifact the coordinator had seen, including sibling outputs) when the model omitted `artifact_ids`. Fix: remove the fallback; children see only artifacts the coordinator explicitly grants. "Scoped visibility" is now an enforceable property.

2. **Hallucinated artifact_ids (resolved)** — under multi-stage dispatch pressure, the coordinator emitted plausible-looking but non-existent UUIDs for downstream `artifact_ids`. Fix: `handleAgentCall` / `handleSkillCall` now validate every requested artifact_id against the graph before dispatching. Invalid IDs short-circuit into a failed child task with an actionable tool_result error.

3. **Invisible mid-run artifact_ids (resolved)** — the coordinator's "Completed Tasks" context is built once at bootstrap and only rebuilt on compression, so artifact_ids for mid-run completions were invisible until the token budget rotated them in. The model had no real IDs to pass downstream and fell back to hallucination. Fix: completed subagent dispatches now append `[dispatch metadata] output_artifact_id: <uuid>` to the tool_result content, so the model sees real IDs in-band.

4. **Retry churn / "decomposition efficiency" (resolved — was actually a concurrency race)** — the Apr 13 status doc called out 8 subagents for 3 roles, 28× context ratio, and "the coordinator retrying subagent steps 2-4×" as "the biggest efficiency gap." On investigation this turned out to be a concurrency race, not decomposition logic. The run-loop's `gatherWithTimeout` used a 10-second timeout on all concurrent tool calls. Subagent dispatches take 20-60 seconds (they run their own LLM loop). When the gather expired, the coordinator received `"Task in progress"` placeholders where artifact_ids should have been, proceeded to the next turn, hallucinated IDs to fill in the gaps, and cascaded into re-dispatches of earlier stages. Fix: `agent` / `skill` tool calls bypass the gather timeout and are always awaited to completion; direct tools (`bash`, `web-search`) keep the fast path. Post-fix, crd-001/002/003 run at 3-6 operations each with 3-9× context ratio.

The broader lesson: retry-churn-looking patterns should be investigated for concurrency races before being attributed to model decomposition behavior.

## Decomposition-value infrastructure and first null result

The "decomposition adds value" hypothesis is distinct from everything above. The harness wins on factual accuracy (+23.7pp) and judge quality (+9.2pp) against a direct-API baseline, but that delta conflates three effects:

1. Harness system prompt (output guidance, operational sections)
2. Harness tool access (bash, web-search, read_artifact)
3. Skill decomposition (pipelined sub-tasks with artifact routing)

To isolate (3) we introduced the `decomposition-value` task category. These
tasks are also tagged in YAML as `metadata.purpose: mechanism` with
`metadata.comparisonMode: flat-harness`. The runner now keys off
`comparisonMode`, not the category name itself, so the taxonomy can stay:

- `category` = capability being exercised
- `metadata.purpose` = why the eval exists
- derived suites = how it should be selected in practice

For decomposition-value tasks the "baseline" column in the runner runs a
**flat-harness** variant: the same harness wrapper, same tools, same input
artifacts, but with `skills: []` and the default eval system prompt
substituted for the task's decomposition-specific one. The delta between
decomposed and flat measures decomposition specifically, holding prompt and
tools constant.

Some mechanism tasks also set
`passFail.requireZeroFailingStepGrades: true`. That means a factual win is
not counted as a binary pass unless the intended process also completed
without failing graph / skill / retry gates. This makes "answer quality
win" and "clean decomposition win" explicit rather than conflating them.
The markdown report re-evaluates pass/fail against the current task YAML when
available, so older result files reflect the current gate semantics.

For decomposition-mechanism tasks, the harness can also be configured with
`definitionOverrides.subagentResultMode: artifact_only`. In that mode a child
dispatch returns only its `output_artifact_id` in-band, not the full child
text, so the coordinator cannot bypass artifact routing by reading the child
result directly out of chat history.

### First task: dcv-001

Ten fictional due-diligence documents (~400 tokens each) on a SaaS acquisition, with four planted cross-source discrepancies ranging from overt (different numbers for the same metric) to definitional (same underlying data, different computation method). The decomposition pipeline: coordinator reads all 10 input artifacts → invokes `extract-claims` 10 times in parallel with document content inline → dispatches a `cross-referencer` agent with all claim artifact_ids → dispatches a `synthesizer` agent → emits final text. Flat baseline: one LLM call with all content in context.

### Finding (claude-sonnet-4-6, April 2026)

The task does not discriminate. Across five runs on the same prompt:

| Run | Harness (decomposed) | Flat | Outcome                                             |
| --- | -------------------- | ---- | --------------------------------------------------- |
| 1   | 1.00                 | 1.00 | both ceiling, no consumes edges                     |
| 2   | 0.00                 | 1.00 | extract-claims `maxIterations: 1` bug (since fixed) |
| 3   | 0.00                 | 1.00 | malformed skill input threw (since fixed)           |
| 4   | 1.00                 | 1.00 | both ceiling, 42 ops, no consumes edges             |
| 5   | 0.00                 | 1.00 | circuit breaker mid-execution                       |

When the decomposition pipeline completes, it matches flat on factual accuracy — both catch all four planted discrepancies. When it fails mid-run, flat still wins because it has fewer moving parts. **On this task, at this scale, the decomposition path is observably worse than the flat path** — same factual ceiling, much higher run-failure rate.

This rules out "10 short-ish documents with moderately subtle discrepancies" as a viable testbed against a long-context model that can hold all of them in a single attention pass. Sonnet is too capable at ~4K total tokens for decomposition to matter.

### What the null result does and does not prove

It **does** prove that at this scale the decomposition pipeline is not load-bearing — a single flat pass captures the same factual signal with less fragility. It **does not** disprove the general "decomposition adds value" claim. The task was simply not hard enough to force long-context attention to fail.

It also surfaced two real framework bugs along the way (extract-claims `maxIterations: 1` vs. the coordinator passing `artifact_ids`, and malformed tool input throwing instead of returning a tool error) which are now fixed.

### Decomposition-value follow-up: dcv-002 through dcv-004

We built the harder tasks. The resulting picture is sharper, but not the one
the original hypothesis wanted.

#### dcv-002 — larger audit corpus, still no discrimination

`dcv-002` moved to a 20-document HIPAA-style audit with buried facts, stricter
required-fact matching, and graph assertions for the intended
`extract-claims -> cross-referencer -> synthesizer` flow. On April 13, 2026,
after fixing an impossible task budget and tightening the planted-fact matcher,
the best clean result was:

- run `632c791a`: harness `0.917`, flat `0.917`

That established two things:

1. The stricter matcher was necessary; shallow keyword answers no longer pass.
2. Moderate-complexity cross-source joins at roughly 16K tokens still do not
   discriminate. Flat long-context reasoning was enough.

#### dcv-003 — arithmetic joins plus ~27.9K context, scale alone still not enough

`dcv-003` pushed harder on arithmetic and timeline reconciliation: 11 long
documents, ~27.9K declared tokens, no single-document leak of the planted gaps.
It was explicitly designed to force cross-source arithmetic rather than lookup.

Initial runs were noisy because one matcher was overfit (`fact-mfa-breakglass-23`)
and the decomposition arm was still shortcutting its process. After correcting
the matcher, the meaningful result was:

- April 14, 2026 re-score of `b98cad2f`: harness `0.923`, flat `0.923`

So even with longer docs and arithmetic joins, flat still solved the task. The
lesson from `dcv-003` was that scale alone is not enough under the current
comparison setup.

#### dcv-004 — breadth-at-scale with per-vendor distractors

After three tasks that kept a single long cross-referenced corpus with a
prose final answer, `dcv-004` picks a different shape: twelve independent
vendor dossiers (each roughly 400 tokens of marketing-framed prose with
the authoritative fact buried among plausible distractors — superseded
SOC 2 reports, deprecated algorithm tiers, aspirational regions,
pilot-only SLA commitments). Four attributes per vendor × 12 vendors =
48 reference facts. The final deliverable is a strict four-column
matrix with one block per vendor.

The decomposed path is `12 × extract-claims` in parallel + `matrix-compiler`
with `autoFinalizeFromSubagent`. The flat-harness path gets the same tools
and the same seeded artifacts, no skills. The hypothesis is that per-dossier
extraction isolates each vendor's distractors from every other vendor's
distractors, whereas the flat path has to attend to all 12 vendors'
distractors at once. Scoring is per-vendor regex with tight proximity
windows so wrong-vendor assignment is detectable rather than masked.

#### dcv-004 — rescoring status

Local `dcv-004` runs showed that regex factual scoring can be dominated by
surface-form variation on the 12-vendor matrix task, so the branch now has a
per-fact LLM judge (`evals/llm-judge/per-fact.ts`, `pnpm eval:rescore`) for
rescoring mechanism tasks whose deterministic matchers are too brittle.

The previous numeric tables for this section cited local run IDs and rescore
outputs that are not tracked in this branch. They have been removed from the
published evidence story. Before restoring a quantitative `dcv-004` claim,
rerun the task, run `pnpm eval:rescore`, and commit or archive the raw JSON,
generated report, and rescore sidecar referenced from
[`evals/results/MANIFEST.md`](../evals/results/MANIFEST.md).

The methodological lesson remains: regex factual scorers are fast and cheap
but surface-form sensitive, and on tasks where the model has real freedom in
output format the scorer noise can dominate the signal. For mechanism
research, where we care whether a framework change produced a real content
effect, the per-fact LLM judge is the right audit tool even though it costs
more per run.

### Reliability as a separate measurement axis

An earlier iteration of the decomposition-value suite included a
21-document control-gap task with a four-stage fixed-skill pipeline
(`extract-claims → control-mapper → gap-prioritizer → synthesizer`).
It was parked and then removed once the judge rescoring made its
status clear: the two runs where the pipeline completed cleanly
(`ef1964df`, `bcc27c8f`) reached content parity with flat, but the
other seven runs had the pipeline break mid-execution — producing a
bimodal result driven by coordinator reliability, not decomposition
content. That is a different question than decomposition-value
measures, and the task wasn't designed to answer it.

Rather than keep a scaffold around for a question it wasn't built to
measure, we removed it and added a dedicated `reliability` category
(`rel-001`, `rel-002`, `rel-003`) that isolates the measurement:

- Per-stage work is deliberately trivial (write a small JSON
  artifact), so model variance in the stage itself is minimal.
- Stages are dispatched via ad-hoc `agent` calls with fixed names
  and fixed per-stage prompts dictated by the task's system prompt.
- The final stage is a fixed `stage-final` skill with
  `autoFinalizeFromSubagent`, so the run output is exactly the final
  artifact content and exact-match assertions are reliable.
- There is no `referenceFacts` array and no flat-harness comparison;
  a run passes iff every graph assertion holds.

Aggregate reliability is the fraction of runs that pass at each
depth. Three tasks at depths 3 / 4 / 5 produce a depth-vs-reliability
curve. That signal is independent of content quality and does not
confound the decomposition-value measurements.

### First reliability measurement (10 runs × 3 tasks, 2026-04-22)

First data point at claude-sonnet-4-6:

| Task    | Depth | Structural pass | End-to-end pass | Failure mode                                   |
| ------- | ----- | --------------- | --------------- | ---------------------------------------------- |
| rel-001 | 3     | 100%            | 30%             | stage-final skipped read_artifact / read empty |
| rel-002 | 4     | 100%            | 80%             | same                                           |
| rel-003 | 5     | 100%            | 60%             | same                                           |

Read carefully: the original point of the category was to measure
coordinator dispatch reliability as depth grows. That signal is
**100% at depths 3-5** — the coordinator always dispatches the correct
stage chain in the correct order. We have not yet found the depth at
which dispatch-chain correctness degrades on a trivial-work pipeline.

A secondary signal — content flow through `stage-final` — is noisy
(30% / 80% / 60%, non-monotonic) and dominated by a single failure
mode: the skill either skips its `read_artifact` call or reads empty
content and falls back to emitting `upstream_stage: unknown`.
Operation-count inspection confirms: failed runs have consistently
fewer operations than passed runs at the same depth, indicating
skipped tool calls rather than coordinator mis-dispatch.

This narrows the explanation for the earlier ~22% completion rate on
the removed original dcv-004. That rate was not primarily a dispatch-
depth issue (dispatch at 4-stage depth is reliable here); it combined
dispatch-layer bugs that have since been fixed with content-work
complexity in the real stage skills themselves. When per-stage work
is made trivial, coordinator dispatch is fine; the weak link becomes
skill prompt-following, which is an LLM compliance question rather
than a framework reliability question.

**Next step for someone iterating on this:** the stage-final skill
prompt is borderline in how forcefully it requires `read_artifact` —
a context-builder artifact preview is enough for the model to
"believe" it has the content. Strengthening that prompt (or
disabling dispatch-time context inlining for small artifacts) would
raise the end-to-end signal, but the structural signal is already
informative as-is.
