# A one-line regex change moves the conclusion by 30 points: a methodology self-audit

In an earlier draft of this post (v4, unpublished), I reported a 23-percentage-point gap between regex-scored and LLM-judge-scored versions of the same agent outputs on a vendor-compliance matrix task, and argued this was evidence that surface-form scoring is a measurement bug in agent evaluation. Before publishing, I ran a regex-design ablation on the same outputs. The ablation showed that doubling the regex's proximity window — a one-line change — collapses the 23-point gap to a statistically-indistinguishable-from-zero 5 points, and that widening it further flips the sign of the point estimate. The strong-form "surface-form scoring is broken" claim did not survive its own audit.

This post is the corrected version. The smaller finding that does survive is more useful than the larger finding I almost published. The meta-finding — a methodology playbook catching its own methodology bug — is more useful still.

## TL;DR

- On task `dcv-004` (12 vendor dossiers × 4 attributes, decomposed harness vs flat baseline), the canonical 130-character-proximity regex scored a comparative gap of **−23.3 percentage points**. A per-fact LLM judge on the same outputs scored **−3.3 percentage points**.
- I attributed that 20-point gulf to surface-form scoring sensitivity and was about to publish that as a general claim about agent evals.
- I then ablated the matcher. Holding outputs constant, varying _only_ the regex proximity window: **proximity-130 → −23.3pp, proximity-260 → −5.0pp, proximity-520 → +2.9pp, proximity-1040 → +4.6pp, no-proximity → +6.7pp**. The judge gap of −3.3pp sits inside the proximity-260+ envelope. With n = 5 runs, only the proximity-130 gap is statistically distinguishable from zero (paired t, p = .030); every wider variant's 95% CI includes zero.
- The original measurement is not wrong, but the _cause_ I attributed it to is wrong. The dominant axis is not "regex vs judge" or "lexical vs semantic." It is **matcher permissiveness specifically**, and on this task most of it is a single number — the proximity window — that determined the architectural conclusion.
- A different matcher family — token-presence-anywhere, no contiguity — still shows a smaller comparative gap of **−9.2pp** that is significant at n = 5 (p = .020) while the judge's −3.3pp is not (p = .227). The two scorers' gaps are not statistically separable from _each other_ at this run count, so "a real effect the judge does not see" is what the point estimates say, not yet a demonstrated finding.
- The right rephrasing of the finding: **proximity-anchored regex matchers can be brittle to architecture-induced verbosity differences in ways that flip architectural conclusions, and the brittleness is asymmetric across conditions. Therefore, matcher-design ablations should be reported alongside any comparative eval result that uses lexical scoring.**
- That is a smaller claim than v4 made. It is also the claim the evidence actually supports.

## What I originally measured

Task `dcv-004` in [Nicator](https://github.com/nicia-ai/nicator) is a vendor-compliance matrix: 12 vendor dossiers × 4 attributes per vendor = 48 reference facts per run, 5 runs per condition. Each dossier contains the authoritative current fact for each attribute alongside plausible distractors (superseded SOC 2 reports, deprecated cipher tiers, aspirational regions, pilot-only SLA terms). The eval compares two conditions of the same harness, holding model (`claude-sonnet-4-6`), temperature, tools, and prompt scaffolding constant: the only thing that varies is whether the harness decomposes the task into typed skills (`extract-claims` per vendor → `matrix-compiler`) or runs flat with no skills.

Two scorers run against the same outputs. Means across 5 runs, with 95% CIs and p-values from a paired t-test on per-run deltas:

| Scorer                            | Harness | Flat baseline | Δ (H − B)  | Δ 95% CI         | p    |
| --------------------------------- | ------- | ------------- | ---------- | ---------------- | ---- |
| Regex (proximity-130, 5-run mean) | 0.504   | 0.738         | **−0.233** | [−0.430, −0.037] | .030 |
| Per-fact LLM judge (5-run mean)   | 0.967   | 1.000         | **−0.033** | [−0.098, +0.032] | .227 |

One thing to note before anything else: the judge columns are at or near ceiling in both conditions — the flat baseline scores 1.000 on all five runs. At the semantic level both architectures essentially solve dcv-004, so the task has no headroom left to detect a real decomposition effect. Everything comparative in this post is about scorer behavior, not about which architecture is better.

The reference regex patterns are vendor-anchored with a proximity window: e.g. `Quantix[\s\S]{0,130}(US.?only|U\.S\.?.?only|United States only|exclusively.{0,20}U\.?S\.?)`. The 130-character window between the vendor name and the value disjunction is the construct under audit.

My first read of that table, written into v4, was: surface-form scoring undercounts paraphrastic correct answers, and the undercount is asymmetric across architecture conditions (the decomposed harness produces more verbose attribute prose that breaks the proximity windows; the flat baseline stays closer to canonical), so the apparent architectural finding is mostly a scorer artifact. I cited Bulian 2022, Kamalloo 2023, FActScore 2023 as prior art for the general failure mode, and presented `dcv-004` as the agent-eval-era recurrence with a comparative-corruption twist.

That story has prior art support, has the right shape, and made the data look meaningful. It was also wrong about the _mechanism_ in this case, and the data could not distinguish it from the simpler explanation: the regex was poorly specified.

## The methodology playbook caught itself

Nicator's eval methodology suite has a per-fact LLM-judge rescorer (`pnpm eval:rescore`), a human-audit packet generator, a cross-vendor judge spot-check, and a shuffled-fact-order replicate check. v4 was built on the per-fact rescore. Before publishing I added one more check — a regex-design ablation (`pnpm eval:regex-ablation`) — that sweeps matcher specifications over the same outputs.

The ablation variants:

- `original` (proximity-130, control; must reproduce result-file scores exactly)
- `proximity-260` / `proximity-520` / `proximity-1040` (widen the outermost proximity window only)
- `no-proximity` (strip the outermost proximity anchor; require vendor anchor and value disjunction each to match somewhere in the output)
- `substring-canonical` (case-insensitive substring of the canonical fact string)
- `bag-of-tokens` (every non-stopword token from the canonical string must appear somewhere in the output)
- `judge` (per-fact LLM judge from the existing rescore artifact — reference)

The headline result, with `original` verified to reproduce the result-file regex scores to three decimals. CIs and p-values are two-tailed paired t-tests on per-run H−B deltas (n = 5, df = 4); `*` marks p < .05:

| Variant               | Harness mean | Baseline mean | Δ (H−B)    | Δ 95% CI         | p       |
| --------------------- | ------------ | ------------- | ---------- | ---------------- | ------- |
| `original`            | 0.504        | 0.738         | **−0.233** | [−0.430, −0.037] | .030 \* |
| `proximity-260`       | 0.867        | 0.917         | −0.050     | [−0.146, +0.046] | .222    |
| `proximity-520`       | 0.946        | 0.917         | +0.029     | [−0.074, +0.132] | .475    |
| `proximity-1040`      | 0.963        | 0.917         | +0.046     | [−0.057, +0.148] | .282    |
| `no-proximity`        | 0.992        | 0.925         | +0.067     | [−0.012, +0.145] | .078    |
| `substring-canonical` | 0.000        | 0.000         | +0.000     | —                | —       |
| `bag-of-tokens`       | 0.887        | 0.979         | **−0.092** | [−0.159, −0.024] | .020 \* |
| `judge`               | 0.967        | 1.000         | −0.033     | [−0.098, +0.032] | .227    |

Only two rows are statistically distinguishable from zero at this run count: the original matcher's −23.3pp and bag-of-tokens' −9.2pp. For every widened proximity variant, the no-proximity variant, and the judge, the confidence interval includes zero.

`substring-canonical` is at 0.000 across the board because the canonical strings include the vendor name (`"Quantix US-only"`) and the agent outputs do not emit that exact substring. It is in the table as a sanity-check that a strictly-canonical-substring matcher catches _nothing_ under either condition; it is not informative about the comparative gap.

Reading the table:

- The proximity window is doing essentially all of the work in the headline result. Going from 130 → 260 characters — a one-line regex change — shrinks the comparative gap from a significant −23.3pp (p = .030) to a statistically-zero −5.0pp (p = .222). The judge gap of −3.3pp is well inside that envelope.
- Widening further drives the _point estimate_ positive: +2.9pp at proximity-520, +4.6pp at proximity-1040, +6.7pp with the contiguity anchor removed. None of these positive gaps are distinguishable from zero at n = 5 (the closest, no-proximity, is p = .078), so the defensible reading is not "the harness wins under permissive matching" — it is that the sign of the conclusion is itself a function of the matcher. With the anchor removed, the more verbose decomposed harness output looks at least as complete as the flat baseline, not less.
- `bag-of-tokens` (a different matcher family, no contiguity, requires all canonical tokens) gives −9.2pp [−0.159, −0.024], p = .020 — significant on its own where the judge's −3.3pp is not (p = .227). The mechanism reading: the harness condition paraphrases enough to lose ~10% of canonical-token coverage that the baseline retains, while the judge scores the content as preserved (0.967 vs 1.000). But a paired contrast between the two scorers' per-run gaps is itself not significant (t = −2.33, p ≈ .08), so five runs cannot separate a −9pp scorer gap from a −3pp one. There is suggestive evidence of a genuine surface-form effect at the architecture level — a fraction of the headline number — and pinning it down needs more runs, not more rhetoric.

The asymmetric-comparative-corruption claim from v4 — that the regex undercounts the harness disproportionately because it produces more variation — also weakens under the ablation. Looking at the variant-vs-judge agreement table, on the harness side `Judge-only pass` cases (judge accepts, matcher rejects) drop from 113 at proximity-130 to 26 at proximity-260, 7 at proximity-520, 3 at proximity-1040, 0 at no-proximity. On the baseline side they drop from 63 → 20 → 20 → 20 → 18. The harness-vs-baseline asymmetry in `Judge-only pass` counts is 50 at proximity-130 (the headline asymmetry), 6 at proximity-260, and _reverses_ at proximity-520 onward. Asymmetric corruption exists at the v4 matcher's specific window size; it is not a stable property of "lexical scoring" or even of "proximity-anchored regex."

## What survives, and what doesn't

**Does not survive.** The strong-form claim from v4 — that surface-form scoring is a _measurement bug_ in agent evaluation, evidenced by a 23-point regex-vs-judge gap on dcv-004 — is not what the data show. A simpler explanation accounts for most of the gap: the 130-character proximity window was a brittle choice for outputs that vary substantially in verbosity between conditions. Any reader who runs the ablation will see this. Anyone reviewing the post who cared about epistemic discipline would have asked for the ablation, and the response would have been worse than having run it first.

**Survives.** A weaker, more local claim survives, and is the one this post actually argues:

- _Matcher proximity is a hidden hyperparameter that can flip comparative agent-eval conclusions._ On this task, a single matcher-design choice — the 130-character vendor-to-attribute proximity — is doing essentially all the work that determines whether the decomposed condition "lost" or "won." Under the original window the loss is statistically significant (p = .030); under every wider window there is no significant difference in either direction.
- _The brittleness is asymmetric across conditions that produce different verbosity distributions._ This is the part of v4 that holds: when the harness produces more verbose attribute prose than the baseline, proximity-anchored matchers under-credit the more verbose side. The size of the asymmetry depends entirely on the proximity-window choice.
- _A small surface-form effect likely persists across matcher families._ The bag-of-tokens variant (no contiguity, just token presence) shows a −9.2pp comparative gap, significant at n = 5, where the judge's gap is not. That is roughly a third of the headline regex number, and is what is left of the "decomposed harness paraphrases differently" effect once the proximity-specific component is removed. The caveat from the table applies: the bag-vs-judge contrast is not itself significant at five runs, so this survives as the best-supported reading of the point estimates rather than as an established effect.
- _Absolute undercount is real, even when the comparative finding collapses._ Under proximity-130 the regex scores 0.504 / 0.738; under no-proximity it scores 0.992 / 0.925. The 0.504 number is an extreme undercount of what the model actually produced, and that is the kind of absolute-undercount story Kamalloo 2023 and Bulian 2022 have been telling for years. It just was not, in this case, the driver of an architectural reversal.

**Survives as the methodologically important finding.** The matcher-design ablation is the load-bearing check for any comparative eval result that uses lexical scoring. Per-fact LLM-judge rescoring (what v4 led with) is necessary but not sufficient: it tells you _that_ the matcher and the judge disagree but not _why_. The ablation localizes the disagreement to specific matcher-design choices. Without that, you cannot tell whether you are looking at "lexical scoring is structurally broken on this task" or "this specific regex was tuned wrong for this output distribution," and the right downstream actions are different.

## The honest list of what I changed my mind about

- I previously believed the regex-vs-judge disagreement count (113 facts on the harness side) was strong evidence of a surface-form-family failure. It is strong evidence of a _specific proximity-window failure_, which is a much narrower claim.
- I previously believed asymmetric comparative corruption was a stable property of lexical scoring under architecture comparisons. The ablation shows the asymmetry is itself a function of matcher choice and can be made to vanish — with the point estimate's sign flipping — by a one-line regex edit.
- I previously believed the appropriate response to this kind of result was to switch to LLM-judge scoring as a category. The narrower response that the data actually supports is: report matcher-design ablations alongside any lexical comparative result, _and_ run a judge rescore. Either alone is incomplete.
- I previously thought the post's prior-art lineage (Bulian, Kamalloo, FActScore) was directly load-bearing for the comparative-corruption claim. Those papers are still directly load-bearing for the _absolute-undercount_ claim, which the dcv-004 numbers also support; they are not direct evidence for the _comparative-corruption_ claim, which was always the more interesting and less well-supported part of the v4 argument and is now even less well-supported.

## Where this sits in the 2025–26 measurement-validity literature

Benchmark-validity auditing became its own genre while this work was in
progress, and the finding here should be read against it rather than
against the 2022–23 QA-eval papers alone.

- [Zhu et al. (NeurIPS 2025)](https://arxiv.org/abs/2507.02825) proposed
  the Agentic Benchmark Checklist after finding that 7 of 10 popular
  agentic benchmarks violate outcome validity, with scoring issues
  shifting results by up to 100% in relative terms. The checklist covers
  outcome validity in general terms, but it has no item that says _ablate
  your scorer's design parameters_. That is the concrete gap this post's
  recipe fills, and the operational proposal below — report scorer
  sensitivity the way you report seed variance — is best understood as a
  proposed checklist addition.
- [Bhat et al. (2026)](https://arxiv.org/abs/2607.02577) audited four
  tool-calling benchmarks and documented substring-based
  communication-check false negatives and an 18.9-point score spread
  across 23 reruns of an LLM-judge evaluator. Their substring failures
  are case reports of the same mechanism this post ablates
  systematically. Their judge-variance number is also worth contrasting:
  that spread comes from trajectory-level rubric judging, while the
  per-fact reference-grounded judge here moved by one verdict in 240
  across three reruns. Decomposed, reference-anchored judging is not just
  easier to audit — it appears to be much more stable.
- [Su et al. (2025)](https://arxiv.org/abs/2510.05152) showed the
  in-context delimiter character alone swings MMLU by ±23 points and can
  put any model in the lead. That is the prompt-side twin of this
  finding: single-parameter sensitivity exists on both the input side and
  the scoring side of an eval. This post is the scorer-side
  demonstration, and the thing it flips is an architecture comparison,
  not a model ranking.
- [Chandak et al. (2025)](https://arxiv.org/abs/2507.02856) found that
  reference-guided free-form answer matching reaches near-human-grader
  agreement while multiple choice and _reference-free_ LLM judging both
  align poorly with humans. That validates the specific design of the
  rescorer used here — the judge always sees the reference fact, per item
  — and is the current-generation successor to the Bulian/Kamalloo
  lineage v4 leaned on.
- [Norman et al. (2026)](https://arxiv.org/abs/2606.19544) showed at
  scale (~541k judgments, 21 judges) that raw agreement overstates judge
  reliability — Cohen's κ deflates it by 33–41 points on MT-Bench — and
  that a judge can have test–retest reliability above 0.95 while carrying
  severe position bias. Consistent is not valid. That is why the
  human-audit packet scores κ rather than raw agreement, and why the
  shuffled-order replicates and cross-vendor spot-check exist at all.
- The statistical reporting throughout (paired per-run deltas, CIs,
  explicit run counts) follows
  [Miller (2024)](https://arxiv.org/abs/2411.00640).

## What this means for agent evals more broadly

Four operational takeaways, scaled to the evidence I actually have:

**If you publish a comparative agent-eval result using lexical scoring, publish the matcher-design ablation with it.** Sweep the proximity window, sweep the matcher family, report the comparative gap as a function of matcher permissiveness — with confidence intervals on each gap, not just means. If the gap is stable across matcher generations, the result is robust. If it collapses with a one-line change to the matcher, the architectural conclusion is not what you thought it was. On run counts: five runs was enough here to establish that the original gap is real and that the widened gaps are noise; it is not enough to rank matcher families against the judge, and any claim of that shape needs more replicates. Framed as a norm: report scorer sensitivity the way you already report seed variance. It is cheap (the ablation here is zero-API-spend and runs in seconds), and it is the item currently missing from the Agentic Benchmark Checklist's outcome-validity section.

**Per-fact semantic judging is still the right additional check, and is still not a panacea.** Treat the per-fact judge as a calibration target for the matcher's permissiveness sweep: the matcher-design choice you would report as your headline is the one whose comparative gap aligns with the judge gap on your validation set. The judge has its own failure modes (verbosity bias, position bias, self-preference, confident-wrong leniency, prompt-injection susceptibility) and needs human-audit calibration at non-trivial sample sizes before it is load-bearing for headline claims.

**Architecture changes that produce verbosity differences are the obvious hazard.** Decomposed pipelines, tool-augmented agents, longer-context models, retrieval-augmented systems — anything that systematically shifts output verbosity relative to a comparator — will interact with proximity-anchored matchers. Design matchers anticipating that, or expect surprises in the direction of "the more verbose system looks worse," which is the direction agent-architecture comparisons most commonly run today.

**And ask whether free prose should be in the scoring path at all.** The standard alternative to everything in this post is to constrain the output format: require both conditions to emit the matrix as structured JSON or a fixed table, then score fields exactly. That removes the proximity window, the verbosity confound, and most of the judge dependence in one move — at the cost of also testing format compliance and changing the task. For dcv-004 a format-constrained variant is the obvious next control: if the decomposed-vs-flat gap is zero under exact structured scoring, the scorer-artifact story is confirmed from a second, independent direction.

## What I am not claiming

I am not claiming the original v4 measurement is fraudulent or non-reproducible. The 5 raw dcv-004 run files are checked into the repo at `evals/results/{7464bfdf,757cf6f9,a702013b,e15c4595,ed259a03}.json`. Running `pnpm eval:rescore` against them reproduces the −23.3pp regex gap exactly (regex scoring is deterministic) and the judge gap to within one borderline fact-verdict in 240: across three rescores of the same outputs (April 22, May 10, May 11 — all three artifacts committed), the judge gap came back −3.3pp, −2.9pp, −2.9pp as a single verdict flipped. `claude-opus-4-6` at temperature 0 is not bit-deterministic, and any claim resting on the third decimal of a judge score would be built on sand — none here does. Running `pnpm eval:regex-ablation` reproduces the ablation table bit-for-bit from the committed rescore artifact.

One provenance note for anyone diffing the raw files: the five runs were generated when this task was named `dcv-005`; the original `dcv-004` (a 4-stage compliance-audit pipeline) was later removed and the vendor-matrix task inherited the `dcv-004` slot, so the internal `taskId` fields in the run files were reconciled to `dcv-004`. This is documented in `evals/results/MANIFEST.md`; the agent outputs and scores are untouched.

The numbers in v4 were correct. The interpretation in v4 was wrong about the dominant mechanism. That is a different thing than the numbers being wrong, and it is the kind of mistake the ablation exists to catch.

I am not claiming surface-form scoring is fine. The absolute undercount (0.504 vs the judge's 0.967 on the harness side under proximity-130) is real and is consistent with what Kamalloo 2023 reported on NQ-open at a much larger scale. If you are trying to estimate _how well a single system performs in absolute terms_ on a paraphrase-admitting task, a 130-character proximity regex against a few canonical surface forms will undercount by a lot. That is the part of the QA-eval prior art that transfers cleanly to agent evals, and the ablation does not refute it.

I am not claiming the broader research direction is bankrupt. There is almost certainly a task design where the strong-form claim holds — where the comparative gap survives matcher widening because the architectures genuinely produce different canonical-token coverage and the verbosity confound has been controlled for. I have not constructed such a task yet, and until I have, I am not making that claim publicly. That is the next experiment, not the conclusion of this one.

## Reproducing

The five raw run files, three per-fact rescores, and the ablation output are committed; the manifest (`evals/results/MANIFEST.md`) lists them as the canonical reproduction artifacts. Two commands regenerate the tables in this post against those files:

```bash
# Per-fact LLM-judge rescore — regex column reproduces exactly; judge column
# moves by ~1 borderline fact-verdict per rerun (see the three committed
# rescore artifacts for the observed spread: judge Δ −3.3 / −2.9 / −2.9pp)
pnpm eval:rescore --runs 7464bfdf 757cf6f9 a702013b e15c4595 ed259a03

# Regex-design ablation — reproduces the proximity-window sweep, including
# the 95% CIs and paired-t p-values, bit-for-bit
pnpm eval:regex-ablation --task dcv-004 \
  --runs 7464bfdf 757cf6f9 a702013b e15c4595 ed259a03 \
  --judge-rescore evals/results/rescore-2026-04-22T17-57-49-540Z.json
```

The ablation runs locally with zero API spend. The rescore runs against the per-fact LLM judge (default `claude-opus-4-6`); cost ≈ $8 across all 5 runs × both modes.

The judge prompt, the matcher specifications, the audit categories, and the ablation variants are all in the repo under `evals/`. The full per-fact-judge prompt remains the one used in v4 (`evals/llm-judge/per-fact.ts`); nothing about the judge changed between v4 and this post. The only thing that changed was running one more methodology check before drawing a conclusion.

## Acknowledgement

The strong-form claim in v4 would have been a confident, citable, prior-art-buttressed wrong conclusion. The right reason to run methodology audits on your own headline finding is not to be defensible if a reviewer asks. It is to find out, before you commit, whether the conclusion you are about to publish is the simpler "the regex was wrong" or the more interesting "the scoring family is broken." On `dcv-004`, after running the ablation, the honest answer is the first one. The methodology playbook caught it. That is what the playbook is for.
