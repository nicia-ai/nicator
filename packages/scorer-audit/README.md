# @nicator/scorer-audit

Audit whether your eval scorer choice flips your conclusion.

If your eval scores agent outputs with regexes or substring checks, the
comparative gap you're reporting may be an artifact of the matcher, not a
property of the systems being compared. This package takes existing eval
run outputs and produces three things:

1. **Per-fact LLM-judge rescore** (`rescore`) — a judge that tolerates
   surface-form variation re-scores every fact, and every fact-verdict is
   decomposed into agreement quadrants against your deterministic
   matcher. High counts of "matcher failed, judge passed" are
   surface-form false negatives.
2. **Matcher-design ablation** (`ablate`) — the same outputs are
   re-scored under a family of matcher variants (verbatim, widened
   proximity windows, no proximity anchor, canonical substring,
   bag-of-tokens), with mean, 95% CI, and paired-t p-value for the
   comparative gap under each variant.
3. **Human-audit packets** (`audit-packet` / `audit-score`) — a
   stratified, shuffled labeling document with judge verdicts hidden
   behind collapsible blocks, scored with Cohen's κ against the judge.

A fourth command, `cross-vendor`, re-runs the per-fact judge through any
OpenAI-compatible endpoint and compares verdicts, closing the
"one vendor judging its own outputs" critique.

## Commands

```bash
# 1. Judge rescore (requires ANTHROPIC_API_KEY)
scorer-audit rescore --input runs.json --out-dir out/
# → out/rescore-<timestamp>.{json,md}

# 2. Matcher ablation (no API calls; judge row from a prior rescore)
scorer-audit ablate --input runs.json \
  --judge-rescore out/rescore-<timestamp>.json --out-dir out/

# 3. Human audit
scorer-audit audit-packet --input runs.json \
  --rescore out/rescore-<timestamp>.json --seed 1337 --out-dir out/
# ... label every `Your label` line in the packet .md, then:
scorer-audit audit-score --packet out/audit-packet-<timestamp>.md

# Optional: cross-vendor spot-check (requires OPENAI_API_KEY;
# --base-url for any OpenAI-compatible endpoint)
scorer-audit cross-vendor --input runs.json \
  --rescore out/rescore-<timestamp>.json --all --model gpt-5
```

Nicator EvalReports can be used directly instead of `--input`:

```bash
scorer-audit rescore \
  --nicator-report results/<run-1>.json --nicator-report results/<run-2>.json \
  --facts facts.json --out-dir out/
```

where `facts.json` maps task id → array of nicator `ReferenceFact`
objects (EvalReports carry recorded verdicts but not the canonical
strings or matcher patterns themselves).

## Input format

A single JSON file: named runs, each with tasks, each task with shared
reference facts and per-condition output text. The two condition names
being compared are declared once; the gap is always
`comparison[0] − comparison[1]`.

```json
{
  "comparison": ["candidate", "baseline"],
  "runs": [
    {
      "runId": "run-1",
      "tasks": [
        {
          "taskId": "vendor-compare",
          "facts": [
            {
              "id": "fact-sla",
              "description": "Quantix — 24 hour breach SLA",
              "canonical": "Quantix 24 hours",
              "matcher": {
                "kind": "regex",
                "pattern": "Quantix[\\s\\S]{0,130}(24.?hours?|24h\\b)"
              },
              "expected": "present",
              "weight": 1
            }
          ],
          "conditions": {
            "candidate": {
              "text": "…agent output…",
              "recordedVerdicts": { "fact-sla": false },
              "recordedScore": 0
            },
            "baseline": { "text": "…other output…" }
          }
        }
      ]
    }
  ]
}
```

`matcher` kinds: `substring` (case-insensitive canonical substring, the
default), `regex` (single pattern), `all-of` (every pattern must match).
`recordedVerdicts` / `recordedScore` are optional; when present they are
treated as the authoritative matcher side and the ablation's sanity check
verifies the `original` variant reproduces them.

## Methodology

The two instruments answer different objections and neither is
sufficient alone. The ablation shows whether a measured gap is specific
to one matcher spec or survives across the whole surface-form family —
but every variant in the family shares the family's blind spot, so a gap
that survives could still be scoring artifact all the way down. The
judge rescore breaks out of the family, but a judge is itself a model
with failure modes, which is why its verdicts are audited: stratified
human labeling with κ, and a cross-vendor spot-check. Run the ablation
and the rescore together; trust the conclusion only where they agree,
and audit the quadrant where they disagree.
