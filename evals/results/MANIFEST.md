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

## Tracked Methodology Artifacts

Canonical artifacts behind the [v5 methodology post](../../eval-methodology-post-v5.md). These are the files a reviewer or replicator should treat as the source-of-truth for any citation of `dcv-004` regex/judge/ablation numbers.

| File | Scope | Notes |
| ---- | ----- | ----- |
| `7464bfdf.json` | dcv-004 vendor matrix, run 1/5 | Raw `EvalReport`. Backing data for the v5 post. |
| `757cf6f9.json` | dcv-004 vendor matrix, run 2/5 | As above. |
| `a702013b.json` | dcv-004 vendor matrix, run 3/5 | As above. |
| `e15c4595.json` | dcv-004 vendor matrix, run 4/5 | As above. |
| `ed259a03.json` | dcv-004 vendor matrix, run 5/5 | As above. The five JSONs were generated when the task was named `dcv-005`; the original `dcv-004` (a 4-stage compliance-audit pipeline) was removed in commit `1a821ba` and the vendor-matrix task inherited the `dcv-004` slot. The internal `taskId` fields have been reconciled to `dcv-004`. |
| `rescore-2026-04-22T17-57-49-540Z.json` | Per-fact LLM-judge rescore, 5 dcv-004 runs (canonical) | Per-fact verdicts (`claude-opus-4-6`, temperature 0). 5-run means: harness regex 0.504, harness judge 0.967, flat regex 0.738, flat judge 1.000. Disagreement audit: harness 113/2/6/119, flat 63/0/0/177. This is the judge reference the regex ablation cross-references. Reproduce with `pnpm eval:rescore --task dcv-004`. |
| `rescore-2026-05-10T23-18-36-215Z.{md,json}` | Per-fact judge rescore replicate 1, same 5 runs | Rerun of the April rescore on identical outputs. One borderline fact-verdict flipped (757cf6f9 harness): harness judge 0.971, judge Δ −0.029 vs April's 0.967 / −0.033. Quantifies judge verdict stochasticity: regex columns reproduce exactly; judge columns move by ~1 fact-verdict in 240 per rerun. |
| `rescore-2026-05-11T05-16-45-504Z.{md,json}` | Per-fact judge rescore replicate 2, same 5 runs | Second rerun; agrees with replicate 1 (harness judge 0.971, judge Δ −0.029). |
| `regex-ablation-2026-07-07T02-21-51-142Z.{md,json}` | Regex-design ablation over 5 dcv-004 runs | Sweeps the matcher over proximity-130/260/520/1040, no-proximity, substring-canonical, bag-of-tokens; cross-references the April judge rescore. **The load-bearing finding for v5.** Comparative gap H−B per variant, with 95% CI and paired-t p over per-run deltas (n=5): `original` −0.233 [−0.430, −0.037] p=.030, `proximity-260` −0.050 [−0.146, +0.046] p=.222, `proximity-520` +0.029 [−0.074, +0.132] p=.475, `proximity-1040` +0.046 [−0.057, +0.148] p=.282, `no-proximity` +0.067 [−0.012, +0.145] p=.078, `bag-of-tokens` −0.092 [−0.159, −0.024] p=.020, `judge` −0.033 [−0.098, +0.032] p=.227. Only `original` and `bag-of-tokens` are significant at n=5. Supersedes `regex-ablation-2026-05-15T05-27-27-177Z` (identical scores; regenerated to add CI/p columns after fixing an incomplete-beta bug in `evals/stats.ts` that deflated all previously printed p-values). Reproduce with `pnpm eval:regex-ablation --task dcv-004 --runs 7464bfdf 757cf6f9 a702013b e15c4595 ed259a03 --judge-rescore evals/results/rescore-2026-04-22T17-57-49-540Z.json`. Zero API spend. |

## Generated Side Reports

| Prefix | Scope | Notes |
| ------ | ----- | ----- |
| `sweep-weights-*` | Context-weight sweeps | Markdown summaries only; these are not `EvalReport` JSONs and are ignored by report loaders. |
| `multi-run-*` | Multi-run summaries | Generated locally; commit the Markdown and JSON together when citing. |
| `rescore-*` | Per-fact judge rescores | Generated locally; commit the Markdown and JSON together when citing. |
| `regex-ablation-*` | Regex-design ablation sweeps | Matcher-permissiveness ablation over existing rescored runs. Zero API spend. Commit the Markdown and JSON together when citing. |

## Citation Rules

- Do not cite a run ID in docs unless its report is tracked here or the raw
  output bundle is archived and linked.
- For no-baseline reliability tasks, cite harness pass/fail only; do not cite
  pairwise judge deltas.
- For multi-run claims, cite the generated `multi-run-*` report and verify the
  table uses confidence intervals, not standard deviations.
- Do not cite p-values from reports generated before the 2026-07 incomplete-beta
  fix in `evals/stats.ts` — the buggy implementation deflated p-values (biased
  toward significance). Recompute with `pnpm eval:multi-run` against the raw
  JSONs instead.
