# Eval Results Manifest

This directory tracks generated Markdown reports that are safe to review in
git, plus the raw `EvalReport` JSON for every cited run so reviewers can audit
judge traces, regrade pass/fail under current rules, and rerun multi-run
statistics from the branch alone. All other raw `*.json` outputs are ignored;
when you cite a new run, also exempt its `<prefix>.json` in the root
`.gitignore`.

## Tracked Reports

| Run prefix | Report | Raw JSON | Scope | Notes |
| ---------- | ------ | -------- | ----- | ----- |
| `3251f5b8` | `3251f5b8.report.md` | `3251f5b8.json` | Knowledge-work, no judge | Historical KWB IDs; factual aggregate only. |
| `1d3c75ba` | `1d3c75ba.report.md` | `1d3c75ba.json` | Synthesis with judge | Factual win, judge-quality loss. |
| `a345f39c` | `a345f39c.report.md` | `a345f39c.json` | Dispatch | Historical behavioral report; regrade with current graph gates before citing pass rate. |
| `2e370910` | `2e370910.report.md` | `2e370910.json` | HITL | Historical behavioral report; regrade with current graph gates before citing pass rate. |
| `341e6044` | `341e6044.report.md` | `341e6044.json` | Limits | Historical behavioral report; regrade with current graph gates before citing pass rate. |
| `b1b15014` | `b1b15014.report.md` | `b1b15014.json` | Coordination | Historical coordination report. |
| `09c45a9e` | `09c45a9e.report.md` | `09c45a9e.json` | Decomposition-value | Historical report. |
| `47d48abd` | `47d48abd.report.md` | `47d48abd.json` | Decomposition-value | Historical report. |
| `517c16c7` | `517c16c7.report.md` | `517c16c7.json` | Decomposition-value | Historical report. |
| `58d7f3b5` | `58d7f3b5.report.md` | `58d7f3b5.json` | Decomposition-value | Historical report. |
| `5a478eec` | `5a478eec.report.md` | `5a478eec.json` | Decomposition-value | Historical report. |
| `5aced9d6` | `5aced9d6.report.md` | `5aced9d6.json` | Mixed early suite | Historical report; predates current task naming and gates. |

## Generated Side Reports

| Prefix | Scope | Notes |
| ------ | ----- | ----- |
| `sweep-weights-*` | Context-weight sweeps | Markdown summaries only; these are not `EvalReport` JSONs and are ignored by report loaders. |
| `multi-run-*` | Multi-run summaries | Generated locally; commit the Markdown and JSON together when citing. |
| `rescore-*` | Per-fact judge rescores | Generated locally; commit the Markdown and JSON together when citing. |

## Citation Rules

- Do not cite a run ID in docs unless its report is tracked here or the raw
  output bundle is archived and linked.
- For no-baseline reliability tasks, cite harness pass/fail only; do not cite
  pairwise judge deltas.
- For multi-run claims, cite the generated `multi-run-*` report and verify the
  table uses confidence intervals, not standard deviations.
