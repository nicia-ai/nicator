# Eval report

**Run ID:** `5aced9d6-6f0f-4186-bfd0-2069b9fde650`
**Timestamp:** 4/5/2026, 1:23:27 PM
**Harness version:** 0.1.0
**Model:** claude-sonnet-4-6
**Tasks:** 23

## Aggregate

| Metric | Harness | Baseline | Delta |
|--------|---------|----------|-------|
| Factual accuracy | 68.4% | 95.0% | ▼ -26.6pp |
| Judge quality | 0.0% | 0.0% | → +0.0pp |

## By category

| Category | N | Harness | Baseline | Delta |
|----------|---|---------|----------|-------|
| synthesis | 3 | 0.0% | 0.0% | → +0.0pp |
| extraction | 2 | 0.0% | 0.0% | → +0.0pp |
| gap-analysis | 2 | 0.0% | 0.0% | → +0.0pp |
| decision-support | 2 | 0.0% | 0.0% | → +0.0pp |
| dispatch | 5 | 0.0% | 0.0% | → +0.0pp |
| hitl | 4 | 0.0% | 0.0% | → +0.0pp |
| limits | 5 | 0.0% | 0.0% | → +0.0pp |

## Process metrics

| Metric | Value |
|--------|-------|
| Avg skills per run | 0.2 |
| Avg operations per run | 1.5 |
| HITL trigger rate | 13.0% |
| Avg context pressure ratio | 2.37x baseline |

> Context pressure ratio > 1.5x — harness is consuming significantly more tokens than the baseline. Check for unnecessary context injection or retry churn.

## Per-task results

| Task | Category | Factual (H) | Factual (B) | Judge (H) | Judge (B) | Inconclusive | Skills | Operations |
|------|----------|-------------|-------------|-----------|-----------|--------------|--------|----------|
| dsp-001 | dispatch | 100.0% | 100.0% | — | — | no | 0 | 1 |
| dsp-002 | dispatch | 0.0% | 50.0% | — | — | no | 1 | 6 |
| dsp-003 | dispatch | 100.0% | 100.0% | — | — | no | 0 | 1 |
| dsp-004 | dispatch | 0.0% | 100.0% | — | — | no | 1 | 6 |
| dsp-005 | dispatch | 0.0% | 100.0% | — | — | no | 1 | 6 |
| hitl-001 | hitl | 0.0% | 100.0% | — | — | no | 0 | 3 |
| hitl-002 | hitl | 100.0% | 100.0% | — | — | no | 0 | 0 |
| hitl-003 | hitl | 0.0% | 100.0% | — | — | no | 0 | 3 |
| hitl-004 | hitl | 0.0% | 100.0% | — | — | no | 0 | 1 |
| kwb-001 | synthesis | 100.0% | 100.0% | — | — | no | 0 | 0 |
| kwb-002 | synthesis | 100.0% | 100.0% | — | — | no | 0 | 0 |
| kwb-003 | synthesis | 100.0% | 75.0% | — | — | no | 0 | 0 |
| kwb-007 | gap-analysis | 100.0% | 100.0% | — | — | no | 0 | 0 |
| kwb-008 | gap-analysis | 100.0% | 100.0% | — | — | no | 0 | 0 |
| kwb-010 | extraction | 100.0% | 80.0% | — | — | no | 0 | 0 |
| kwb-011 | extraction | 100.0% | 100.0% | — | — | no | 0 | 0 |
| kwb-020 | decision-support | 100.0% | 100.0% | — | — | no | 0 | 0 |
| kwb-021 | decision-support | 100.0% | 100.0% | — | — | no | 0 | 0 |
| lim-001 | limits | — | — | — | — | no | 0 | 0 |
| lim-002 | limits | — | — | — | — | no | 0 | 1 |
| lim-003 | limits | — | — | — | — | no | 0 | 1 |
| lim-004 | limits | 100.0% | 100.0% | — | — | no | 0 | 2 |
| lim-005 | limits | — | — | — | — | no | 1 | 3 |

## Step grades

| Task | Severity | Aspect | Finding |
|------|----------|--------|---------|
| dsp-001 | fail | graph_assertion | [task_exists] Agent should call web-search directly: No task found matching skillName="web-search", skillVersion="tool" |
| dsp-002 | fail | graph_assertion | [run_status] Run should complete successfully: Run status is "failed", expected "completed" |
| dsp-003 | fail | graph_assertion | [task_exists] Agent should call web-fetch directly: No task found matching skillName="web-fetch", skillVersion="tool" |
| dsp-004 | fail | graph_assertion | [task_exists] Summarizer skill must be invoked: No task found matching skillName="summarizer" |
| dsp-004 | fail | graph_assertion | [task_order] Researcher must precede summarizer: No task found matching 'then' (skillName="summarizer") |
| dsp-004 | fail | graph_assertion | [consumes] Summarizer must consume researcher artifacts: No consumer task found matching skillName="summarizer" |
| dsp-004 | fail | graph_assertion | [run_status] Run should complete successfully: Run status is "failed", expected "completed" |
| dsp-005 | fail | graph_assertion | [task_exists] Researcher skill must complete: No task found matching skillName="researcher", status="completed" |
| dsp-005 | fail | graph_assertion | [run_status] Run should complete successfully: Run status is "failed", expected "completed" |
| hitl-001 | fail | graph_assertion | [run_status] Run should complete successfully: Run status is "failed", expected "completed" |
| hitl-003 | fail | graph_assertion | [task_exists] Researcher skill should execute after approval: No task found matching skillName="researcher" |
| hitl-003 | fail | graph_assertion | [task_order] Human approval must precede researcher activation: No task found matching 'then' (skillName="researcher") |
| hitl-003 | fail | graph_assertion | [run_status] Run should complete successfully: Run status is "failed", expected "completed" |
| kwb-001 | warn | skill_decomposition | Missing expected skills: researcher. Invoked: . |
| kwb-002 | warn | skill_decomposition | Missing expected skills: researcher. Invoked: . |
| kwb-003 | warn | skill_decomposition | Missing expected skills: researcher. Invoked: . |
| kwb-007 | warn | skill_decomposition | Missing expected skills: researcher. Invoked: . |
| kwb-008 | warn | skill_decomposition | Missing expected skills: researcher. Invoked: . |
| kwb-010 | warn | skill_decomposition | Missing expected skills: researcher. Invoked: . |
| kwb-011 | warn | skill_decomposition | Missing expected skills: researcher. Invoked: . |
| kwb-020 | warn | skill_decomposition | Missing expected skills: researcher. Invoked: . |
| kwb-021 | warn | skill_decomposition | Missing expected skills: researcher. Invoked: . |
| lim-001 | fail | graph_assertion | [run_status] Run must fail due to task limit: Run status is "completed", expected "failed" |
| lim-001 | fail | graph_assertion | [run_error] Error must indicate task limit exceeded: Run status is "completed", not "failed" — no error to match |
| lim-001 | fail | graph_assertion | [task_count] Exactly 2 tasks (root + 1 child skill): Found 1 task(s) matching (any task); expected [2, 2] |

> Step grade totals: 85 pass, 9 warn, 16 fail

## Known limitations

- Judge quality aggregate excludes inconclusive tasks. If > 20% of tasks are inconclusive, the judge prompt or rubric should be revised before drawing conclusions from the aggregate.
- Process metrics reflect harness behavior only. There are no process metrics for the baseline (it has no tasks, operations, or skills by design).