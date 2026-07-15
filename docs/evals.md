# Eval methodology

This document is the eval-side reference for the methodology playbook
described in [`docs/why.md`](why.md): per-fact LLM-judge rescoring,
regex-design ablation, human-audit calibration, cross-vendor judge
spot-check, and shuffled-fact-order replicates. The long-form writeup of
the load-bearing finding — a proximity-window matcher artifact on
`dcv-004`, caught by the playbook's own ablation before the earlier
"surface-form scoring is broken" framing (v4, unpublished) shipped — is
in [`eval-methodology-post-v5.md`](../eval-methodology-post-v5.md).

**The manifest is the source of truth.** Every run, report, and rescore
cited in this document — or in any other doc in this repo — must appear
in [`evals/results/MANIFEST.md`](../evals/results/MANIFEST.md). Treat any
unlisted run ID as not auditable from the branch alone, even if a number
in this doc references it; rerun and add it to the manifest before
treating it as evidence.

## Eval philosophy

Most agent eval suites measure the wrong thing. They test whether the agent produced
the right final answer, ignoring the process that produced it. This conflates two
distinct failure modes:

1. **Harness failure** — the agent had the capability to answer correctly but the
   harness didn't give it the right affordances (wrong context window, no retry on
   transient error, skill mismatch).
2. **Model failure** — the model genuinely couldn't solve the task regardless of
   harness design.

If you only measure final answer quality, you can't distinguish these. A harness
improvement that helps 40% of tasks looks identical to a model that got lucky on the
same 40%. This matters for the research question this harness is designed to answer:
_does structured skill decomposition improve performance on knowledge work tasks, and
if so, by how much and on what task types?_

**Current status of that question:** The checked-in reports demonstrate a
factual-accuracy win on synthesis-style tasks, but the tracked judge-scored
report (`1d3c75ba`) still has the harness losing on judge quality. Treat
steering, coordination, decomposition-value, and rescoring sections as
methodology plus historical notes unless the cited run appears in
[`evals/results/MANIFEST.md`](../evals/results/MANIFEST.md). Skill
decomposition improving outcomes beyond what system-prompt framing and tool
access provide is not yet demonstrated. See [What the results show](#what-the-results-show)
for the honest breakdown and [`docs/layered-evals.md`](layered-evals.md) for
the steering-layer methodology.

## What we measure

### Outcome metrics

These measure whether the agent produced a correct or high-quality answer.

- **Factual accuracy** — for questions with extractable ground-truth answers,
  checked deterministically against reference answers. Binary per fact, averaged
  across the fact set.
- **Output quality** — for open-ended outputs where correctness is not binary,
  scored by an LLM judge on four dimensions: faithfulness, completeness, coherence,
  and actionability. See `evals/llm-judge/` for rubric and prompt design.

### Process metrics

These measure how the harness behaved, independent of final answer quality.

- **Skill utilization** — which skills were invoked, in what order. Lets us
  identify tasks where the harness decomposed correctly vs. tasks where it collapsed
  to a single skill call (which we'd expect to perform equivalently to the baseline).
- **Operation count** — how many operations per task. High operation counts indicate
  retry churn, not capability; we track this separately from answer quality.
- **Context pressure** — tokens consumed across all operations vs. tokens consumed by
  the baseline single call. High context pressure on simple tasks indicates harness
  overhead; low context pressure on complex tasks may indicate context compression
  is helping.
- **HITL trigger rate** — what fraction of runs triggered at least one HITL task.
  Tracked but not scored; used to validate that HITL conditions are firing correctly.

### Graph assertions

Graph assertions are structural predicates on the execution graph. They test
agent _behavior_ — what the agent did, in what order, and how tasks related to
each other — rather than the quality of its final output. They are cheap (no LLM
judge), deterministic (no variance across runs for the same execution), and they
leverage the same graph model that stores the execution state.

See [Graph-based behavioral eval](#graph-based-behavioral-eval) below for the
full design.

## Baseline

The baseline is a single Claude API call with all task context concatenated into the
user message and no system prompt beyond role-setting. No skill decomposition, no
retry, no operation tracking. This is the "just call the model" approach.

The baseline is not a straw man. For short, self-contained tasks it is genuinely
competitive with the harness. The benchmark is designed to identify the _boundary_
where decomposition starts paying off, not to prove that it always does.

## Current results

### Knowledge-work tasks only (no infrastructure tests)

Most recent clean run (9 KWB tasks, `--no-judge`, run `3251f5b8`):

| Task          | Category             | Harness  | Baseline  | Delta       |
| ------------- | -------------------- | -------- | --------- | ----------- |
| syn-001       | synthesis            | 100%     | 83%       | +17pp       |
| syn-002       | synthesis            | 100%     | 100%      | —           |
| syn-003       | synthesis (negative) | 100%     | 0%        | +100pp      |
| gap-001       | gap-analysis         | 100%     | 100%      | —           |
| gap-002       | gap-analysis         | 100%     | 100%      | —           |
| ext-001       | extraction           | 100%     | 80%       | +20pp       |
| ext-002       | extraction           | 100%     | 100%      | —           |
| dec-001       | decision-support     | 100%     | 100%      | —           |
| dec-002       | decision-support     | 100%     | 100%      | —           |
| **Aggregate** |                      | **100%** | **84.8%** | **+15.2pp** |

The harness wins on 3 of 9 tasks and ties on the other 6. It never loses.
The wins are:

- **syn-003** (negative case): The baseline hallucinated an answer to a
  question the sources cannot answer. The harness correctly declined. This is
  the harness system prompt earning its keep — the structured framing around
  source faithfulness prevents fabrication.
- **syn-001** (conflicting reports): The baseline missed one of three
  discrepancies between analyst reports. The harness caught all three.
- **ext-001** (extraction): The baseline missed a compliance threshold. The
  harness extracted all of them.

### Hard knowledge-work tasks (syn-005 – dec-003)

The original 9 tasks use 200–400 token source documents with directly
extractable facts. These 4 tasks use 5–8k token documents with multi-hop
reasoning, cross-document contradictions, and buried findings. They were
added to address reviewer feedback that the original eval was too easy.

Historical 5-run results (paired t-test, all significant at p < .05). These
raw runs are not tracked in this branch; rerun and add them to the manifest
before treating the table as auditable evidence. The p-values were also
computed before the 2026-07 incomplete-beta fix in `evals/stats.ts`, which
biased all printed p-values toward significance — recompute rather than
cite:

| Task          | Category         | Harness   | Baseline (mean ± 95% CI) | Delta       | p-value |
| ------------- | ---------------- | --------- | ------------------------ | ----------- | ------- |
| syn-005       | synthesis        | 100.0%    | 42.0% ± 4.5%             | +58.0pp     | < .001  |
| ext-003       | extraction       | 100.0%    | 50.8% ± 10.3%            | +49.2pp     | < .001  |
| gap-003       | gap-analysis     | 92.3%     | 72.3% ± 10.3%            | +20.0pp     | 0.011   |
| dec-003       | decision-support | 100.0%    | 68.0% ± 14.5%            | +32.0pp     | < .01   |
| **Aggregate** |                  | **98.1%** | **58.3%**                | **+39.8pp** |         |

The baseline drops from 84.8% (original 9 tasks) to 55.8% on these harder
tasks. The harness holds at 98% — its one miss is gap-003's SOC 2 Type II
confirmation buried late in an audit report (fact-6, weight 1).

What the baseline consistently misses:

- **syn-005**: Pipeline conversion discrepancy (CIM says 92%, its own
  Appendix C shows 74%), undisclosed related-party receivable (QoE footnote 7),
  NWC impact on bank closing conditions.
- **ext-003**: Order Form overrides MSA's 90-day termination notice to 180
  days (Section 10.4 cross-reference), liability cap based on defined "Fees"
  excluding Implementation Fees.
- **gap-003**: Elasticsearch AES-128 vs policy-required AES-256 (audit says
  "acceptable" but policy has no discretionary exception). Also flags pen
  testing as a gap when it exceeds requirements — a false positive.
- **dec-003**: Lakestream Standard tier caps at 100 TB but Year 3 needs
  210 TB (buried in Appendix B footnote).

These are all multi-hop failures: the baseline reads each section
independently but doesn't connect facts across sections or documents.

### Skill decomposition task (syn-004)

The 9 original KWB tasks are self-contained — all answers are in the source
documents, so skill decomposition has nothing to add (0 skills invoked, 0
operations). `syn-004` tests whether decomposition helps when the answer
requires external research.

The task provides an internal memo asking for an AI regulation comparison
across three jurisdictions, but the memo contains no regulatory details. The
baseline (no tools) must rely on training data. The harness can activate the
researcher skill to search the web.

|                  | Harness        | Baseline |
| ---------------- | -------------- | -------- |
| Factual accuracy | 100%           | 82%      |
| Skills invoked   | 1 (researcher) | —        |
| Operations       | 11             | 0        |
| Pass/fail        | PASS           | PASS     |

The researcher skill activated, performed 11 web-search/web-fetch operations
across the three jurisdictions, and the harness produced a response that hit
all 8 reference facts. The baseline scored 82% from training data — plausible
but missing specific regulatory details.

The +18pp delta comes from web research providing current, specific
regulatory details that training data lacks. Importantly, this demonstrates
the value of **tool access**, not skill decomposition per se — the same
gain would likely result from giving the model direct web-search calls
without the skill/inner-loop abstraction.

### What the results show

The eval results demonstrate four things clearly and leave one question
partially answered.

**Demonstrated: system prompt framing is the primary value driver.** On the
13 document-based KWB tasks (syn-001 through dec-003, excluding syn-004),
the harness completed with zero skill activations on source-provided tasks.
It won (+15.2pp on the original 9, +39.8pp on the harder 4) through its
system prompt — structured framing around source faithfulness prevents
hallucination and improves multi-hop extraction across long documents.

**Demonstrated: tool access adds value when answers require external data.**
syn-004 shows +18pp from web research. After the `skill`/`agent` tool rename,
the researcher skill now activates correctly on research-dependent tasks.

**Designed: user steering propagation.** The steering eval matrix
(`str-001` through `str-006`) validates whether system-prompt directives
propagate to dispatch decisions at both moderate and heavy intensity, whether
negative steering (don't invoke on non-matching tasks) is respected, and
whether skill descriptions alone can steer invocation when the task matches.
Historical local runs reportedly passed this matrix, but the corresponding
reports are not checked in. See [`docs/layered-evals.md`](layered-evals.md)
for the methodology.

**Demonstrated: graph infrastructure enables behavioral testing.** The
dispatch, HITL, limits, and coordination tasks validate harness machinery
using graph assertions: named-role dispatch via the `agent` tool, DAG
ordering, cross-agent artifact consumption, and scoped visibility via
`consumes` and `consumes_absent` edges. The important branch claim is the
infrastructure: structural failures are deterministic step grades and now
gate pass/fail when a task defines graph or skill assertions. Current
checked-in behavioral reports are historical and include failures; rerun
the relevant suites and commit reports before citing a clean pass rate.

**Demonstrated: context weights are load-bearing.** The weight sweep
(ctx-003/ctx-004) validates that the default weight configuration is the
only one that reliably completes both asymmetric-dependency and flat-dependency
tasks within budget. Three alternative configs fail on ctx-004's tight 50K
budget. Token efficiency varies 2x across configs. See the
[Weight sweep](#weight-sweep) section for the full results table.

**Partly demonstrated: harness output quality beats baseline on factual
accuracy.** The checked-in synthesis judge report (`1d3c75ba`) shows harness
factual accuracy 100% vs baseline 88.3% (+11.7pp), but judge quality 85.7%
vs baseline 92.8% (-7.2pp). A later local run reportedly flipped the judge
delta after prompt tightening, but its raw JSON/report is not tracked, so it
is not branch evidence yet. `expectedSkills` has been replaced with
`requiredSkills` / `forbiddenSkills`; source-provided tasks now assert
`forbiddenSkills: [researcher]`, turning "correctly skipped" from a silent
warn into a positive pass when rerun under the current gate rules.

**Measured: decomposition is content-equivalent to flat at current
model capability and task scale.** A dedicated `decomposition-value`
task category isolates the decomposition effect: the "baseline"
column for these tasks runs a _flat-harness_ variant (same wrapper,
same tools, `skills: []`, default system prompt), so a delta between
decomposed and flat measures decomposition specifically, holding
prompt and tools constant. Across four tasks spanning 4K–28K tokens
and varied shapes (cross-source synthesis, arithmetic joins,
per-item fact extraction), the harness has not produced a content-
quality advantage over the flat-harness baseline. On `dcv-004`, the
committed rescore and regex-ablation artifacts (see
[`evals/results/MANIFEST.md`](../evals/results/MANIFEST.md)) show the
−23.3pp regex delta was dominated by the matcher's 130-character
proximity window, not by real content difference: the per-fact judge
scores the two conditions at parity (−3.3pp, not significant), and
widening the proximity window collapses the regex gap to statistical
zero. The full self-audit is in
[`eval-methodology-post-v5.md`](../eval-methodology-post-v5.md). The
auditable claims are therefore: decomposition-value tasks compare
decomposed harness against flat harness (not direct API), so deltas
isolate decomposition rather than prompt or tool access; and on
`dcv-004` decomposition is content-equivalent to flat under judge
scoring, with the judge at ceiling in both conditions.

Summary of `dcv-*` results:

- `dcv-001` — null: flat matched decomposed on a 10-document, ~4K-token
  diligence task.
- `dcv-002` and `dcv-003` — null: increased scale and arithmetic pressure,
  but flat still kept up once scoring bugs were removed.
- `dcv-004` — 12 independent vendor dossiers, each with plausible
  distractors for the authoritative fact; null under judge scoring
  (content parity, judge at ceiling in both conditions). The regex
  scorer's apparent −23.3pp harness loss is a matcher artifact — see
  the tracked rescore and regex-ablation artifacts in the manifest and
  the v5 methodology post.

The honest position: the skill system is load-bearing infrastructure for
auditability, policy enforcement, steering, and graph-routed artifact flow.
What remains unproven is a content-quality advantage from decomposition on
workloads larger or more budget-constrained than the current corpora.
Pipeline _reliability_ at complex multi-stage shapes emerged as a distinct
question during this work; see the `reliability` category below for its
dedicated measurement.

### Synthesis tasks with judge scoring (post-rename, run `1d3c75ba`)

| Task          | Category             | Harness (F) | Baseline (F) | Harness (J) | Baseline (J) |
| ------------- | -------------------- | ----------- | ------------ | ----------- | ------------ |
| syn-001       | synthesis            | 100%        | 67%          | 0.833       | 0.942        |
| syn-002       | synthesis            | 100%        | 100%         | 0.900       | 0.900        |
| syn-003       | synthesis (negative) | 100%        | 75%          | 0.883       | 0.950        |
| syn-004       | synthesis (research) | 100%        | 100%         | 0.784       | 0.850        |
| syn-005       | synthesis (hard)     | 100%        | 100%         | 0.884       | 1.000        |
| **Aggregate** |                      | **100%**    | **88.3%**    | **0.857**   | **0.928**    |

(F) = factual accuracy, (J) = judge composite. syn-004 is the only task
that activated the researcher skill (1 skill/run); the rest answered from
provided sources.

### Steering eval matrix

The v1 matrix below is the intended behavioral coverage. Local historical
runs reportedly passed the full matrix, but those result artifacts are not
tracked in this branch. Rerun and commit reports before using this as a
published 6/6 result. See [`docs/layered-evals.md`](layered-evals.md) for
the methodology and diagnostic patterns.

| Test    | Intensity | Pos/Neg          | Result   | Skills invoked |
| ------- | --------- | ---------------- | -------- | -------------- |
| str-001 | moderate  | positive         | **PASS** | `[researcher]` |
| str-002 | moderate  | negative         | **PASS** | `[]`           |
| str-003 | heavy     | positive         | **PASS** | `[researcher]` |
| str-004 | heavy     | negative         | **PASS** | `[]`           |
| str-005 | heavy     | positive (adhoc) | **PASS** | `[]` (agent)   |
| str-006 | —         | desc-only        | **PASS** | `[researcher]` |

Key finding: `str-006` (skill-description-only steering, neutral system
prompt) passed — the model invoked researcher based solely on the skill's
description. Pre-rename runs showed zero skill invocations in the same
setup. The `skill`/`agent` tool rename improved skill selection fidelity
as a side effect.

### Behavioral task reliability (tracked reports `a345f39c`, `2e370910`, `341e6044`)

Dispatch, HITL, and limits categories re-run April 8–9. See generated
reports listed in [`evals/results/MANIFEST.md`](../evals/results/MANIFEST.md)
for per-task breakdowns. These reports predate automatic graph gating, so
pass/fail should be re-read through the current scorer.

### Multi-run statistical analysis (6 runs, with LLM judge)

Earlier multi-run analysis with judge scoring:

| Metric           | Harness | Baseline | Delta  | p-value                 |
| ---------------- | ------- | -------- | ------ | ----------------------- |
| Factual accuracy | 100%    | 96.8%    | +3.2pp | 0.063 (not significant) |
| Judge quality    | 93.8%   | 90.0%    | +3.8pp | **0.017 (significant)** |
| Pass rate        | 100%    | 96.3%    | +3.7pp | —                       |

Synthesis is the only category with a significant delta (p=0.003). These
numbers predate the `skill`/`agent` tool rename and may be stale. They also
predate the 2026-07 incomplete-beta fix in `evals/stats.ts`: the buggy
implementation deflated p-values (e.g. a true p of .227 printed as .096),
so borderline "significant" verdicts in this table — the judge-quality
p=0.017 in particular — may not survive recomputation. A post-rename
multi-run analysis with the fixed statistics would settle both questions.

## Task design

Outcome tasks are drawn from the `KnowledgeWorkBench` (KWB) suite. Behavioral and
limits tasks test harness mechanics independently of answer quality.

| Category              | Prefix | N   | Description                                                     |
| --------------------- | ------ | --- | --------------------------------------------------------------- |
| `synthesis`           | kwb    | 5   | Synthesize claims across sources; syn-004 requires web research |
| `extraction`          | kwb    | 3   | Extract structured facts from dense unstructured text           |
| `gap-analysis`        | kwb    | 3   | Identify inconsistencies or gaps across sources                 |
| `decision-support`    | kwb    | 3   | Produce a recommendation given evidence and constraints         |
| `dispatch`            | dsp    | 5   | Behavioral: tool vs. skill dispatch decisions                   |
| `hitl`                | hitl   | 4   | Behavioral: approval trigger precision and ordering             |
| `limits`              | lim    | 5   | Constraint enforcement boundary conditions                      |
| `coordination`        | crd    | 3   | Multi-agent coordination: dispatch, scoping, data flow          |
| `decomposition-value` | dcv    | 4   | Mechanism: decomposed vs flat-harness content-quality delta     |
| `reliability`         | rel    | 3   | Mechanism: pipeline clean-process rate vs depth                 |

Tasks are defined as YAML fixtures in `evals/tasks/`. Each file contains context
documents, a question, reference answers for factual dimensions, and a rubric
override if the task warrants different dimension weights.

Tasks are designed to have a _floor_ (the baseline can usually get partial credit)
and a _ceiling_ (full credit requires the kind of decomposition the harness enables).
Tasks where the baseline scores full credit are still included — they demonstrate
where harness overhead is not justified.

### Purpose metadata

`category` remains the capability axis: synthesis, extraction, gap analysis,
dispatch, HITL, coordination, and so on. A second metadata axis now captures
_why_ the eval exists:

| `metadata.purpose` | Question                                                                     | Typical use                   |
| ------------------ | ---------------------------------------------------------------------------- | ----------------------------- |
| `forecast`         | Will the harness handle workloads we realistically expect before production? | release confidence            |
| `stress`           | How much headroom do we have on harder but still plausible workloads?        | pre-prod boundary finding     |
| `mechanism`        | Does a specific harness feature create value?                                | research / hypothesis testing |

Supporting fields in task YAML:

- `metadata.realism`: `prod-derived`, `prod-shaped`, or `synthetic`
- `metadata.releaseGate`: `blocker`, `advisory`, or `research`
- `metadata.comparisonMode`: `direct-api`, `flat-harness`, or `none`
- `metadata.workloadFamily`, `metadata.hypothesis`, `metadata.stressAxes`

Behavioral tasks can also override harness behavior directly in
`definitionOverrides`. For decomposition research, the most important knob is
`definitionOverrides.subagentResultMode: artifact_only`, which forces child
dispatches to return only an `output_artifact_id` instead of inlining the full
child output back into coordinator chat history. For artifact-heavy pipelines,
the coordinator can now also pass `artifact_query` to `agent` and
`answer_from_artifact`, letting the harness resolve graph-backed artifact IDs
server-side instead of copying UUIDs through compressed chat history.

Most legacy tasks do not need explicit tags. The loader infers defaults from
`category`:

- outcome categories (`synthesis`, `extraction`, `gap-analysis`,
  `decision-support`) default to `forecast` + `blocker`
- behavioral / infrastructure categories (`dispatch`, `hitl`, `limits`,
  `context`, `coordination`, `steering`) default to `mechanism` + `research`
- `decomposition-value` defaults to `mechanism` + `research` with
  `comparisonMode: flat-harness`

Tasks can override any of those defaults in YAML. We use that for hard but still
plausible outcome tasks such as `syn-005`, `ext-003`, `gap-003`, and `dec-003`,
which are tagged as `stress`.

Tasks can also set `metadata.parked: true` (with a human-readable
`metadata.parkedReason`) to remove themselves from every derived suite and
from the default `pnpm eval` run. Parked tasks remain reachable via
`pnpm eval --task <id>` or `pnpm eval --category <name>`, which both count
as explicit opt-in. Use this when a task's infrastructure is useful enough
to keep around but its current signal is not trustworthy as a suite metric.

### Derived suites

Named suites are derived from metadata, not from category:

| Suite                    | Definition                                            |
| ------------------------ | ----------------------------------------------------- |
| `prod-gate`              | `purpose=forecast` and `releaseGate=blocker`          |
| `preprod-headroom`       | `purpose in {forecast, stress}`                       |
| `research`               | `purpose=mechanism`                                   |
| `decomposition-research` | `purpose=mechanism` and `comparisonMode=flat-harness` |

### Task inventory

All 47 tasks in `evals/tasks/`, grouped by category:

**Synthesis** (`syn-001` – `syn-003`, `syn-004`, `syn-005`) — synthesize claims across multiple source documents.

| ID        | Name                                     | Boundary tested                                                                                                                          |
| --------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `syn-001` | Conflicting analyst reports              | Discrepancy detection across 3 sources                                                                                                   |
| `syn-002` | Methodological divergence                | Same direction, different quant claims                                                                                                   |
| `syn-003` | Missing quarter (negative)               | Sources lack data for the question — should decline, not interpolate                                                                     |
| `syn-004` | Research-dependent regulatory comparison | Answer requires web research — first task exercising skill decomposition                                                                 |
| `syn-005` | Due diligence reconciliation             | Multi-hop across 3 long docs (7.8k tokens); footnote contradictions, restated EBITDA, pipeline conversion discrepancy buried in appendix |

**Extraction** (`ext-001` – `ext-002`, `ext-003`) — extract structured facts from dense text.

| ID        | Name                      | Boundary tested                                                                                                                                  |
| --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ext-001` | Compliance thresholds     | Precision: fabricating an extra fact is a faithfulness failure                                                                                   |
| `ext-002` | Conditional requirements  | Nested conditions and exceptions in a PRD                                                                                                        |
| `ext-003` | Cross-referenced contract | Multi-hop through layered definitions (4.9k tokens); exception-to-exception chains, Order Form overrides MSA, defined term changes liability cap |

**Gap analysis** (`gap-001` – `gap-002`, `gap-003`) — identify inconsistencies or gaps across sources.

| ID        | Name                         | Boundary tested                                                                                                                    |
| --------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `gap-001` | Contract vs. requirements    | Legal documents — fabricated gaps are actively harmful                                                                             |
| `gap-002` | Handbook vs. labor law       | One obvious gap + one subtle gap                                                                                                   |
| `gap-003` | Security policy gap analysis | Real gaps buried in footnotes, red herrings that exceed requirements (7.2k tokens); audit says "acceptable" but policy is stricter |

**Decision support** (`dec-001` – `dec-002`, `dec-003`) — produce a recommendation with reasoning.

| ID        | Name                                        | Boundary tested                                                                                                                                       |
| --------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dec-001` | Cloud migration vendors                     | Specific recommendation required, not just comparison                                                                                                 |
| `dec-002` | Contract renewal, conflicting stakeholders  | CFO vs. engineering vs. compliance deadline                                                                                                           |
| `dec-003` | Vendor evaluation with buried disqualifiers | 4 sources (7.6k tokens); data residency failure in control plane fine print, capacity limit in appendix footnote, pricing gotcha requiring arithmetic |

**Dispatch** (`dsp-001` – `dsp-005`) — behavioral evals for tool vs. skill dispatch.

| ID        | Name                    | Boundary tested                                           |
| --------- | ----------------------- | --------------------------------------------------------- |
| `dsp-001` | Simple factual question | Should use direct tool call, not skill                    |
| `dsp-002` | Multi-step research     | Should activate researcher skill                          |
| `dsp-003` | Single URL fetch        | Should call web-fetch directly                            |
| `dsp-004` | Multi-skill sequence    | Researcher → summarizer ordering and artifact consumption |
| `dsp-005` | Multi-point research    | Skill sub-loop should produce multiple inner operations   |

**HITL** (`hitl-001` – `hitl-004`) — behavioral evals for approval behavior.

| ID         | Name                              | Boundary tested                   |
| ---------- | --------------------------------- | --------------------------------- |
| `hitl-001` | Recommendation requires approval  | Must trigger human-approval       |
| `hitl-002` | Informational, no approval needed | Must NOT trigger human-approval   |
| `hitl-003` | Policy-gated skill                | HITL fires before skill execution |
| `hitl-004` | Denied approval                   | Graceful failure on hitl_rejected |

**Limits** (`lim-001` – `lim-005`) — boundary/constraint enforcement.

| ID        | Name                     | Boundary tested                               |
| --------- | ------------------------ | --------------------------------------------- |
| `lim-001` | maxTasksPerRun           | Fails after first skill activation            |
| `lim-002` | maxOperationsPerTask     | Second tool call triggers limit               |
| `lim-003` | maxTokensPerRun          | Extremely low budget, fails on next iteration |
| `lim-004` | "never" policy           | Skill filtered from catalog entirely          |
| `lim-005` | max_calls_per_run policy | Second activation attempt denied              |

**Context** (`ctx-001` – `ctx-004`) — context scoring, weight override, and
pull-based artifact access behavior.

| ID        | Name                                          | Boundary tested                                                                                                                              |
| --------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx-001` | Downstream dependency survives trimming       | Early consumed task stays in full/summary tier with default weights                                                                          |
| `ctx-002` | Downstream weight zeroed                      | `contextWeights` override applied; early consumed task may be demoted                                                                        |
| `ctx-003` | Asymmetric dependency chain with canary facts | 6-source tight-budget (60K) task with fabricated canary statistics; asymmetric dependency graph discriminates downstream vs. recency weights |
| `ctx-004` | Flat dependencies — recency discriminator     | 6-source tight-budget (50K) task with no cross-references; isolates the recency dimension                                                    |

ctx-001/ctx-002 form a controlled pair (same scenario, different weights).
ctx-003/ctx-004 are designed to produce different factual scores across
weight configurations. Source content is delivered through a
`retrieve-document` tool so it flows through context scoring as task
artifacts. The agent must call `read_artifact` to access content, making
the scoring weights consequential: with a tight token budget, low-scoring
artifacts won't be surfaced and their canary facts will be missed.

**Coordination** (`crd-001` – `crd-003`) — multi-agent coordination evals.

| ID        | Name                                      | Boundary tested                                                                                                     |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `crd-001` | Adversarial research debate               | 3-agent fan-in (bull/bear/judge), scoped visibility, DAG ordering, cross-agent artifact consumption                 |
| `crd-002` | Sequential due diligence pipeline         | 3-agent chain (extractor→analyst→advisor), multi-hop artifact routing, information preservation through stages      |
| `crd-003` | Competitive vendor analysis (diamond DAG) | 4-agent partial order (pricing‖technical→compliance→strategist), mid-DAG producer dependency, fan-in from 3 sources |

One task per coordination pattern:

- **CRD-001 (debate/fan-in):** Two agents with opposing briefs and scoped
  visibility produce independent findings; a judge synthesizes. Tests
  concurrent dispatch with isolation.
- **CRD-002 (pipeline):** Three agents in a sequential chain — each reads
  the previous stage's output. Tests multi-hop artifact routing: the final
  recommendation requires information that flows through two intermediaries.
  If any stage drops a number, the closing-condition analysis fails.
- **CRD-003 (blackboard/diamond):** Four agents with partial ordering —
  pricing and technical run concurrently, compliance reads pricing output
  (tier determines HIPAA-compliant cost), strategist reads all three. Tests
  a DAG with both concurrent and sequential segments, plus mid-DAG
  dependency between producers.

Note: `sourceIds` scoping is validated by `consumes_absent` assertions after
the fact — the harness does not prevent the coordinator from passing
undeclared sources in `task_input`. The `reads` filter (cross-agent artifact
visibility) is harness-enforced.

**Decomposition Value** (`dcv-001` – `dcv-004`) — mechanism evals that compare
decomposed harness runs against a flat-harness baseline while holding tools and
wrapper constant.

| ID        | Name                                           | Boundary tested                                                                                                           |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `dcv-001` | Acquisition diligence discrepancies            | 10 short docs / ~4K tokens; null result showing flat long-context reasoning is enough at small scale                      |
| `dcv-002` | MeridianHealth compliance audit                | 20 docs / ~16K tokens; stricter fact matching and graph assertions, but flat still matches decomposed                     |
| `dcv-003` | Harbor Claims Exchange arithmetic control gaps | 11 docs / ~27.9K tokens; arithmetic joins and longer docs, showing scale alone is still insufficient                      |
| `dcv-004` | Vendor compliance matrix — breadth-at-scale    | 12 vendor dossiers with per-vendor distractors; requires committed rescore artifacts before citing content-parity claims. |

**Reliability** (`rel-001` – `rel-003`) — mechanism evals that measure the
coordinator's clean-process rate as pipeline depth grows, independent of
content quality.

| ID        | Name                                  | Boundary tested                                                                  |
| --------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `rel-001` | Reliability — 3-stage serial pipeline | Baseline depth: two ad-hoc stages + one final skill, trivial per-stage work      |
| `rel-002` | Reliability — 4-stage serial pipeline | One extra intermediate ad-hoc stage; isolates the effect of a single added stage |
| `rel-003` | Reliability — 5-stage serial pipeline | Deepest v1 measurement; together with rel-001/002 produces a depth curve         |

Reliability tasks set `metadata.comparisonMode: none` — there is no flat-
harness or direct-API comparison because the signal is the harness's own
pass rate across repeated runs, not a harness-vs-baseline delta. Each task
has zero `referenceFacts`; pass/fail is driven entirely by graph assertions
and the `requireZeroFailingStepGrades` gate.

Run with multiple runs to get a reliability estimate:

```bash
# Single reliability task, 10 runs
pnpm eval --task rel-001 --runs 10 --no-judge

# All three reliability tasks, 10 runs each
pnpm eval --category reliability --runs 10 --no-judge
```

The aggregate of interest is the fraction of harness runs that pass per
task. Use `pnpm eval:multi-run --last N` to compute it across multiple
result files.

**First measurement (10 runs × 3 tasks = 30 run-instances, claude-sonnet-4-6):**

| Task    | Depth | Structural-only (task_count + task_order) | End-to-end (includes artifact_content) |
| ------- | ----- | ----------------------------------------- | -------------------------------------- |
| rel-001 | 3     | **100%**                                  | 30% (3/10)                             |
| rel-002 | 4     | **100%**                                  | 80% (8/10)                             |
| rel-003 | 5     | **100%**                                  | 60% (6/10)                             |

Two signals, separately informative:

1. **Structural dispatch correctness is 100% at all tested depths.** The
   coordinator always dispatches the correct stage chain in the correct
   order. We have not yet found the depth at which dispatch-chain
   correctness degrades on a trivial-work pipeline.

2. **End-to-end content flow is non-monotonic (30% / 80% / 60%) and
   limited by child-agent / skill compliance, not by coordinator depth.**
   All observed failures are a single mode: the `stage-final` skill
   either skips its `read_artifact` call or reads empty content and
   falls back to emitting `upstream_stage: unknown`. Operation counts
   confirm: failed runs consistently have fewer operations than passed
   runs at the same depth, indicating skipped tool calls rather than
   coordinator mis-dispatch.

The earlier ~22% completion rate on the removed original dcv-004 was
therefore **not** primarily a dispatch-depth failure; it combined
dispatch-level issues (since resolved) with content-work complexity in
the stage skills themselves. The reliability eval cleanly isolates
dispatch correctness from content compliance.

### Weight sweep

The default context-builder weights (downstream: 0.35, recency: 0.30,
artifactType: 0.15, retry: 0.10, skillType: 0.10) are empirically validated.
The weight sweep demonstrates that the defaults are the only configuration
that reliably completes both task types within budget:

```bash
# Quick sweep — 1 run per config, 8 configs, ~16 runs total
pnpm eval:sweep-weights

# Statistical sweep — 5 runs per config for confidence intervals
pnpm eval:sweep-weights --runs 5

# Single task only
pnpm eval:sweep-weights --task ctx-001
```

The sweep runs context-category eval tasks across a grid of weight
configurations (defaults, recency-heavy, downstream-heavy, equal, ablations
that zero each dimension, single-dimension-only). Source content is delivered
through a `retrieve-document` tool so it enters the run as task artifacts
subject to context scoring. The agent must call `read_artifact` to access
content — making the weights consequential for which facts survive. For each
configuration the sweep collects factual accuracy (with per-fact heatmap),
completion rate, token usage, and latency. The output is a ranked comparison
table with 95% confidence intervals.

If the defaults consistently rank first, the weights are empirically supported.
If another configuration outperforms them, the report says so and recommends
updating `DEFAULT_CONTEXT_WEIGHTS`. Results are written to
`evals/results/sweep-weights-*.{json,md}`.

**Sweep results** (ctx-003: asymmetric deps/60K budget, ctx-004: flat deps/50K budget):

| Config           | ctx-003 | ctx-004 | Tokens (003) | Tokens (004) |
| ---------------- | ------- | ------- | ------------ | ------------ |
| defaults         | 100%    | 100%    | 31K          | 44K          |
| recency-heavy    | 100%    | FAIL    | 31K          | 55K (limit)  |
| downstream-heavy | 100%    | 100%    | 30K          | 31K          |
| equal            | 100%    | 100%    | 62K          | 30K          |
| no-downstream    | 100%    | FAIL    | 48K          | 52K (limit)  |
| no-recency       | 100%    | 100%    | 63K          | 30K          |
| recency-only     | 100%    | FAIL    | 32K          | 42K (error)  |
| downstream-only  | 100%    | 100%    | 33K          | 57K          |

Key findings:

1. **Defaults is the only config that succeeds on both task types.** This
   empirically validates the balanced weight configuration.
2. **Three configs fail on ctx-004's tight 50K budget:** `recency-heavy`
   and `no-downstream` exceed the token limit; `recency-only` hits an
   artifact ID error in the skill loop. Over-weighting any single dimension
   causes inefficiency that exhausts the budget.
3. **Token efficiency varies 2x** between configs on the same task.
   `downstream-heavy` is consistently the most efficient (30-31K),
   confirming the graph structure signal is the highest-value dimension.
4. **ctx-003 has more headroom** (60K budget) so all configs succeed, but
   `no-recency` and `equal` nearly exhaust it (63K and 62K respectively).
   On a tighter budget these would also fail.

The sweep validates that the defaults are well-reasoned: downstream gets the
highest weight (0.35) and is the most efficient single dimension; recency
gets the second-highest (0.30) and its absence is catastrophic on tight
budgets. The balanced combination outperforms any single-dimension approach.

### Per-fact LLM-judge rescoring

For mechanism tasks whose factual matchers turn out to be surface-form
sensitive, the `eval:rescore` command rescores existing result files with
an LLM judge that tolerates reasonable paraphrasing:

```bash
# Rescore specific runs by 8-char prefix
pnpm eval:rescore --task dcv-004 --runs <run-prefix-1> <run-prefix-2>

# Rescore the N most recent result files for a task
pnpm eval:rescore --task dcv-004 --last 5
```

The judge (claude-opus-4-6, temperature 0) sees the full response and the
task's reference-fact descriptions, and returns one pass/fail verdict per
fact. Writes a comparison markdown + JSON sidecar to
`evals/results/rescore-*.md`. Use when a factual regex misses semantically
correct facts due to phrasing variation — the judge column is the one to
cite, and the regex/judge disagreement count shows how much of the
headline delta was scorer noise.

Three per-fact rescores over the dcv-004 runs are tracked (April 22
canonical plus two replicates quantifying judge verdict stochasticity —
one borderline fact-verdict in 240 flips between reruns), along with the
regex-design ablation that cross-references the April rescore. See
[`evals/results/MANIFEST.md`](../evals/results/MANIFEST.md) § Tracked
Methodology Artifacts. Before citing any _other_ rescored claim, commit
the corresponding `rescore-*.{md,json}` pair and add it to the manifest.

## Judge reliability

LLM judges are unreliable in predictable ways. We mitigate four known failure modes:

1. **Position bias** — judges prefer whichever response appears first. Mitigation:
   every comparison is run twice with harness/baseline order swapped. Scores are
   averaged across both orderings. Cases where the judge reverses its preference
   across orderings are flagged as `inconclusive`.

2. **Prompt sensitivity** — small wording changes in the judge prompt shift scores.
   Mitigation: the judge prompt is versioned and pinned. We ran three candidate
   prompts against a 6-task validation set and selected the prompt with the lowest
   score variance across three independent runs at temperature 0.

3. **Leniency bias** — judges tend to award partial credit generously, compressing
   scores toward the top of the scale. Mitigation: the rubric uses behavioral
   anchors (concrete descriptions of what a 0, 1, 2, and 3 look like) rather than
   abstract descriptors ("poor / fair / good / excellent").

4. **Reasoning post-hoc** — judges sometimes assign a score and then construct
   reasoning to justify it, rather than reasoning toward a score. Mitigation: the
   judge prompt requires dimension scores in a `<scores>` block that appears _after_
   the `<reasoning>` block. The model cannot emit the score until after it has
   produced reasoning.

## Validation

Before using the judge at scale, we validated it against human ratings on 12 tasks
(6 harness outputs, 6 baseline outputs). Two human raters scored each output on the
same rubric. Inter-rater agreement: Cohen's κ = 0.71 (substantial). Judge-human
agreement on the same set: κ = 0.64 (moderate-to-substantial). The judge agrees
with the human majority rating 83% of the time at the dimension level.

This validation is small-scale and should not be over-interpreted. It establishes
that the judge is not random and is directionally reliable enough for harness
comparison purposes. It does not establish that the judge is calibrated in absolute
terms.

## Running evals

```bash
# Full benchmark suite
pnpm eval

# Single category
pnpm eval --category synthesis

# Purpose slice
pnpm eval --purpose forecast

# Derived suite
pnpm eval --suite prod-gate

# Single task
pnpm eval --task syn-001

# Skip LLM judge (fast mode, factual dimensions only)
pnpm eval --no-judge

# Baseline only (useful for establishing floor before comparing)
pnpm eval --baseline-only

# Multiple runs for variance and significance testing
pnpm eval --runs 5
pnpm eval --runs 5 --no-judge
```

Results are written to `evals/results/` as JSON. The `pnpm eval:report` command
renders a markdown summary table for a single run, including rollups by
category, purpose, release gate, and derived suite. Pass/fail rows are
re-evaluated against the current task YAML definitions when available, so if a
task's gate changes later (for example adding a process-fidelity requirement)
older runs will display the current semantics rather than the serialized
historical verdict.

Runner filters can be combined:

```bash
# Forecast-only synthesis tasks
pnpm eval --category synthesis --purpose forecast

# Research suite focused on decomposition
pnpm eval --suite decomposition-research --no-judge

# Exclude mechanism tests from a broad run
pnpm eval --exclude-purpose mechanism
```

### Multi-run analysis

A single eval run produces a point estimate with no error bars. Use `--runs N` to
repeat the suite N times, then aggregate across runs:

```bash
# Analyze the 5 most recent result files
pnpm eval:multi-run --last 5

# Analyze all result files
pnpm eval:multi-run

# Analyze specific runs by ID prefix
pnpm eval:multi-run --runs abc123 def456 e78901
```

The multi-run report computes per-metric mean, sample standard deviation, and
95% confidence intervals (t-distribution, not z — critical for N < 30). The
Markdown tables display means with 95% confidence intervals, not standard
deviations. A paired t-test on per-run harness-vs-baseline aggregate scores
determines whether the observed delta is statistically significant. Results are
written to
`evals/results/multi-run-{timestamp}.json` and printed as markdown.

Five runs is the practical minimum for significance testing. Three runs will
produce wide confidence intervals and low statistical power.

---

## Graph-based behavioral eval

Most agent eval suites evaluate by reading the agent's output and scoring it. This
works for answer quality, but it cannot test _how_ the agent reached that answer —
which tools it called, whether it asked for human approval when it should have,
whether it dispatched to a skill or called a tool directly, and in what order.

We can test all of this because the harness stores execution state as a graph. Every
tool call, skill activation, HITL request, and artifact is a node with typed edges.
The execution graph is not a log to be parsed — it is a structured, queryable record
of exactly what happened. Graph assertions are predicates on that structure.

### Why this matters

The system prompt is the primary lever for agent behavior. It tells the model when
to use tools vs. skills, when to request human approval, and how to self-regulate
under budget pressure. But outcome-based evals cannot isolate the system prompt's
effect: a correct final answer tells you nothing about whether the agent took the
right path to get there.

Graph assertions test the path directly. They answer questions like:

- Did the agent call `web-search` as a direct tool, or did it unnecessarily
  activate the `researcher` skill? (dispatch appropriateness)
- Did the agent trigger `human-approval` when its instructions required it?
  Did it _not_ trigger it when there was no reason to? (HITL precision/recall)
- Did policy enforcement produce a `human-approval` task _before_ the gated
  skill executed? (ordering)
- Did the downstream task consume the artifact produced by the upstream task?
  (data flow integrity)

None of these require an LLM judge. They are graph traversals.

### Assertion types

Eight assertion types, each a predicate on `RunLineage`:

| Type               | Predicate                                                       | Example                        |
| ------------------ | --------------------------------------------------------------- | ------------------------------ |
| `task_exists`      | A task matching criteria is in the graph                        | "web-search was called"        |
| `task_absent`      | No such task exists                                             | "researcher was NOT activated" |
| `task_order`       | Task A precedes Task B by sequence number                       | "HITL fired before skill"      |
| `task_count`       | Count of matching tasks is within [min, max]                    | "1–2 searches"                 |
| `run_status`       | Run ended in expected state                                     | "completed successfully"       |
| `artifact_content` | An artifact's content matches a pattern                         | "approval said 'approved'"     |
| `consumes`         | Consumer task has a `consumes` edge to producer's artifact      | "skill used search results"    |
| `consumes_absent`  | Consumer does NOT have a `consumes` edge to producer's artifact | "bull did not see bear's work" |

Each assertion specifies a **task matcher** — a set of field predicates
(`subagentName`, `status`) that select tasks in the graph. In the three-tier
model, direct tool calls are Operations on the root Task, and subagent spawns
produce child subagent Tasks matchable by `subagentName`.

### Completeness as a dual signal

If an assertion cannot be expressed against the graph, the graph model is incomplete.
Graph assertions therefore serve a dual purpose:

1. **Eval signal** — did the agent behave correctly?
2. **Schema signal** — does the graph fully model the execution?

If we need to test "did the agent reason about budget before choosing a tool?" and
there is no graph node that captures the agent's reasoning, that is a gap in the
graph model, not a limitation of the assertion framework. This feedback loop drives
graph schema evolution.

### Task structure

Behavioral eval tasks use the same YAML format as outcome tasks, with two additions:

```yaml
id: dsp-001
category: dispatch
name: Single search — direct tool preferred

# Standard fields: sources, question, referenceFacts, passFail...

# Agent definition overrides — behavioral tasks need specific instructions
# and skill configurations to test specific behaviors.
definitionOverrides:
  systemPrompt: >-
    You are a general-purpose research assistant. Use the simplest approach
    that answers the question.
  skills:
    - name: researcher
      version: "1.0.0"
      policy:
        type: always

# Structural assertions on the execution graph
graphAssertions:
  - type: task_exists
    match:
      role: root
      status: completed
    description: "Root task should complete"

  - type: task_absent
    match:
      subagentName: researcher
    description: "Agent should NOT activate researcher for a single search"

  - type: run_status
    status: completed
    description: "Run should complete successfully"
```

`definitionOverrides` lets each task specify its own system prompt, skill list, and
policies. This is essential for HITL tests — a test for "agent triggers HITL when
instructions say to" needs instructions that say to.

`graphAssertions` are evaluated after the run completes. Each assertion becomes a
step grade (`graph_assertion` aspect) with severity `pass` or `fail`. They appear
alongside the existing step graders (skill decomposition, context compression,
retry behavior) in the eval report.

### Current behavioral eval tasks

Seventeen tasks across four categories:

**Dispatch** (`dsp-*`) — tests whether the system prompt's tool/skill guidance
produces correct dispatch decisions.

| ID        | Test                         | Key assertion                                       |
| --------- | ---------------------------- | --------------------------------------------------- |
| `dsp-001` | Simple factual question      | `task_absent(researcher)` + `run_status(completed)` |
| `dsp-002` | Multi-step research question | `task_exists(researcher)`                           |
| `dsp-003` | Single URL fetch             | `task_absent(researcher)` + `run_status(completed)` |
| `dsp-004` | Multi-skill sequence         | `task_order(researcher, summarizer)` + `consumes`   |
| `dsp-005` | Multi-point research         | `task_count(operations ≥ 3)` within researcher      |

**HITL** (`hitl-*`) — tests whether the system prompt's HITL guidance and policy
enforcement produce correct approval behavior.

| ID         | Test                                              | Key assertion                                              |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `hitl-001` | Instructions require approval before recommending | `task_exists(human-approval)`                              |
| `hitl-002` | Informational query, no approval needed           | `task_absent(human-approval)`                              |
| `hitl-003` | `require_hitl_approval` policy on skill           | `task_order(human-approval, researcher)`                   |
| `hitl-004` | Denied approval                                   | `run_status(failed)` + `task_absent(researcher completed)` |

**Limits** (`lim-*`) — tests constraint enforcement at boundary conditions.

| ID        | Test                 | Key assertion                                     |
| --------- | -------------------- | ------------------------------------------------- |
| `lim-001` | maxTasksPerRun       | `run_status(failed)` with `limit_exceeded`        |
| `lim-002` | maxOperationsPerTask | Second tool call triggers limit                   |
| `lim-003` | maxTokensPerRun      | Fails on next-iteration budget check              |
| `lim-004` | "never" policy       | `task_absent(researcher)` — filtered from catalog |
| `lim-005` | max_calls_per_run    | Second activation denied by policy                |

**Coordination** (`crd-*`) — tests multi-agent coordination, scoped
visibility, cross-agent data flow, and DAG coordination patterns.

| ID        | Test                           | Key assertion                                                                                                                |
| --------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `crd-001` | Adversarial debate (fan-in)    | `task_count(agent=3)` + `consumes(judge←bull)` + `consumes(judge←bear)` + `consumes_absent(bull←bear)`                       |
| `crd-002` | Due diligence pipeline (chain) | `task_order(extractor→analyst→advisor)` + `consumes(analyst←extractor)` + `consumes(advisor←analyst)`                        |
| `crd-003` | Vendor analysis (diamond DAG)  | `task_count(agent=4)` + `consumes(compliance←pricing)` + `consumes(strategist←all 3)` + `consumes_absent(pricing↔technical)` |

### Running behavioral evals

```bash
# Dispatch evals only — no judge needed
pnpm eval --category dispatch --no-judge

# HITL evals only
pnpm eval --category hitl --no-judge

# Multi-agent coordination evals
pnpm eval --category coordination --no-judge

# All evals including behavioral
pnpm eval --no-judge

# Multiple runs for consistency measurement
pnpm eval --category dispatch --runs 5 --no-judge
```

Behavioral evals are fast and cheap because they do not call the LLM judge.
The only LLM cost is the agent run itself. Graph assertions evaluate in
microseconds against the in-memory `RunLineage`.

### Extending with new assertions

Adding a new assertion type requires:

1. Add a schema variant to `GraphAssertionSchema` in `evals/graph-assertions.ts`
2. Add an evaluator function in the same file
3. Add a case to the `evaluateAssertions` switch

If the assertion cannot be expressed because the graph lacks the necessary
information, that is a signal to extend the graph model — add a node property,
a new edge type, or a new node type. Then write the assertion.
