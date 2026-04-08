import type { EvalTask } from "../schema";
import { FailureModeSchema } from "../schema";
import { DIMENSIONS } from "./rubric";

// ---------------------------------------------------------------------------
// System prompt (built once — deterministic)
// ---------------------------------------------------------------------------

const FAILURE_MODE_LIST = FailureModeSchema.options
  .map((mode) => {
    const descriptions: Record<string, string> = {
      none: "the response is acceptable; no dominant failure",
      hallucination: "the response makes claims not supported by any source",
      source_confusion:
        "the response attributes information to the wrong source or confuses details between sources",
      incomplete_coverage:
        "the response misses significant aspects of the question",
      misinterpretation:
        "the response misreads or distorts what the sources say",
      wrong_refusal:
        "the response declines to answer when the sources provide sufficient information",
      formatting_only:
        "the content is adequate but the presentation is poor enough to impede use",
    };
    return `- "${mode}" — ${descriptions[mode]}`;
  })
  .join("\n");

function buildRubricText(): string {
  return DIMENSIONS.map((dim) => {
    const anchors = dim.anchors
      .map((a) => `    ${a.score} — ${a.label}: ${a.description}`)
      .join("\n");
    return `### ${dim.name}\n${dim.description}\n\nScoring anchors:\n${anchors}`;
  }).join("\n\n");
}

/**
 * Judge system prompt — built once at module load.
 *
 * Design decisions:
 * - The judge is told it is evaluating knowledge work outputs, not general text.
 *   This anchors expectations appropriately.
 * - The rubric is injected verbatim with behavioral anchors to reduce reliance
 *   on the judge's own priors about what "good" looks like.
 * - The judge is explicitly told about position bias and instructed to evaluate
 *   each response independently before comparing.
 * - Scores are emitted after reasoning to prevent anchoring on a number.
 * - Failure mode classification forces the judge to name the specific problem,
 *   not just score low on a dimension.
 */
export const SYSTEM_PROMPT = `
You are an expert evaluator of knowledge work outputs. Your task is to score two
responses to the same question — Response A and Response B — on four dimensions
using the rubric provided below.

IMPORTANT: You may have a tendency to prefer whichever response appears first.
Actively resist this. Evaluate each response on its own merits before comparing.

IMPORTANT: Score only on the basis of the provided source documents and question.
A claim may be true in the world but still score 0 on faithfulness if it is not
supported by the provided sources.

IMPORTANT: Do not let length influence your scores. A concise, complete response
scores higher than a verbose, padded response that covers the same ground.

## Rubric

${buildRubricText()}

## Failure modes

After scoring each response, classify its **dominant failure mode** — the single
most impactful issue. Pick exactly one from this list:

${FAILURE_MODE_LIST}

If a response has multiple issues, classify the one that would most concern a domain expert.

## Output format

First, write your reasoning in a <reasoning> block. Evaluate Response A on all
four dimensions, then evaluate Response B on all four dimensions. Be specific —
cite what the response does or fails to do.

IMPORTANT: Keep your reasoning concise — aim for 2-4 sentences per dimension per
response. Do not quote or reproduce large sections of the source documents or
responses. Focus on what each response gets right or wrong. Your total output
must fit within 4096 tokens.

Then, emit scores and failure modes in a <scores> block using this exact JSON structure:

<scores>
{
  "A": {
    "faithfulness": <0|1|2|3>,
    "completeness": <0|1|2|3>,
    "coherence": <0|1|2|3>,
    "actionability": <0|1|2|3>,
    "failureMode": "<failure mode>"
  },
  "B": {
    "faithfulness": <0|1|2|3>,
    "completeness": <0|1|2|3>,
    "coherence": <0|1|2|3>,
    "actionability": <0|1|2|3>,
    "failureMode": "<failure mode>"
  }
}
</scores>

The <scores> block must appear after the <reasoning> block.
`.trim();

// ---------------------------------------------------------------------------
// User prompt (per-task)
// ---------------------------------------------------------------------------

export function buildUserPrompt(
  task: EvalTask,
  responseA: string,
  responseB: string,
): string {
  const sourcesText = task.sources
    .map((s) => `### ${s.title}\n\n${s.content}`)
    .join("\n\n---\n\n");

  return `
## Source documents

${sourcesText}

---

## Question

${task.question}

---

## Response A

${responseA}

---

## Response B

${responseB}
`.trim();
}
