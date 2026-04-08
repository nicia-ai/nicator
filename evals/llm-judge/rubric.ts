/**
 * LLM judge rubric for KnowledgeWorkBench evaluations.
 *
 * Design principles:
 * - Behavioral anchors over abstract labels. Each score level describes what
 *   a response at that level *does*, not how it *feels*. This reduces rater
 *   variance (human or model).
 * - Orthogonal dimensions. Each dimension captures something the others don't.
 *   A coherent but unfaithful response scores high on coherence and low on
 *   faithfulness — not averaged into a mediocre middle.
 * - Task-adjustable weights. Extraction tasks weight faithfulness heavily;
 *   decision-support tasks weight actionability. Defaults are equal-weight.
 */

import { asCompositeScore, type CompositeScore } from "../schema";

export type DimensionName =
  | "faithfulness"
  | "completeness"
  | "coherence"
  | "actionability";

type DimensionAnchor = Readonly<{
  score: 0 | 1 | 2 | 3;
  label: string;
  description: string;
}>;

type Dimension = Readonly<{
  name: DimensionName;
  description: string;
  defaultWeight: number;
  anchors: [DimensionAnchor, DimensionAnchor, DimensionAnchor, DimensionAnchor];
}>;

export const DIMENSIONS: Dimension[] = [
  {
    name: "faithfulness",
    description:
      "Does the response contain only information supported by the provided source documents? " +
      "Claims not grounded in the sources are unfaithful regardless of whether they are true in the world.",
    defaultWeight: 0.25,
    anchors: [
      {
        score: 0,
        label: "Fabricated",
        description:
          "The response makes multiple specific claims not present in the sources, " +
          "or contradicts information explicitly stated in the sources.",
      },
      {
        score: 1,
        label: "Mostly unfaithful",
        description:
          "The response contains some grounded claims but includes at least one significant " +
          "claim that cannot be traced to any source document.",
      },
      {
        score: 2,
        label: "Mostly faithful",
        description:
          "All major claims are traceable to source documents. Minor unsupported elaborations " +
          "are present but do not materially affect the answer.",
      },
      {
        score: 3,
        label: "Fully faithful",
        description:
          "Every specific claim in the response is directly supported by a source document. " +
          "Where the sources are ambiguous or conflicting, the response acknowledges this " +
          "rather than resolving it artificially.",
      },
    ],
  },
  {
    name: "completeness",
    description:
      "Does the response address all meaningful aspects of the question? " +
      "A complete response answers what was asked without requiring the reader to fill in gaps.",
    defaultWeight: 0.25,
    anchors: [
      {
        score: 0,
        label: "Incomplete",
        description:
          "The response addresses fewer than half of the distinct aspects of the question, " +
          "or answers a related but different question.",
      },
      {
        score: 1,
        label: "Partial",
        description:
          "The response addresses the main question but omits one or more significant " +
          "aspects that a knowledgeable reader would expect to see addressed.",
      },
      {
        score: 2,
        label: "Mostly complete",
        description:
          "The response addresses all major aspects of the question. Minor omissions " +
          "are present but do not leave the reader with unresolved questions about the " +
          "core answer.",
      },
      {
        score: 3,
        label: "Fully complete",
        description:
          "The response addresses all aspects of the question, including edge cases or " +
          "qualifications that a careful analyst would note. Nothing important is left " +
          "for the reader to infer.",
      },
    ],
  },
  {
    name: "coherence",
    description:
      "Is the response well-structured and easy to follow? " +
      "A coherent response presents information in a logical order with clear transitions.",
    defaultWeight: 0.25,
    anchors: [
      {
        score: 0,
        label: "Incoherent",
        description:
          "The response is difficult to follow. Information is presented in a confusing " +
          "order, key terms are undefined, or the structure actively impedes understanding.",
      },
      {
        score: 1,
        label: "Poorly structured",
        description:
          "The response is followable but requires effort. Related points are scattered, " +
          "the conclusion is buried, or the response restates the same point multiple times.",
      },
      {
        score: 2,
        label: "Clear",
        description:
          "The response is easy to follow. Information flows logically. The structure " +
          "serves the content even if it is not optimal.",
      },
      {
        score: 3,
        label: "Exemplary",
        description:
          "The response is immediately scannable. A reader can identify the key claim, " +
          "supporting evidence, and any caveats without re-reading. Structure actively " +
          "aids comprehension.",
      },
    ],
  },
  {
    name: "actionability",
    description:
      "Does the response give the reader something concrete to do or decide? " +
      "An actionable response translates analysis into a specific next step, recommendation, " +
      "or decision framework. Note: not all tasks require high actionability. " +
      "Pure synthesis tasks may legitimately score 2 here.",
    defaultWeight: 0.25,
    anchors: [
      {
        score: 0,
        label: "Purely descriptive",
        description:
          "The response describes a situation but provides no guidance on what to do " +
          "with the information. Reading it leaves the reader no better equipped to act.",
      },
      {
        score: 1,
        label: "Vaguely directional",
        description:
          "The response implies a direction (e.g. 'this seems risky') but does not " +
          "specify what action to take or what decision to make.",
      },
      {
        score: 2,
        label: "Actionable",
        description:
          "The response gives a concrete recommendation or decision framing. The reader " +
          "knows what to do next, though the response may not fully account for constraints " +
          "or tradeoffs.",
      },
      {
        score: 3,
        label: "Decision-ready",
        description:
          "The response provides a specific recommendation, explains the reasoning, " +
          "acknowledges key tradeoffs or constraints, and anticipates the most obvious " +
          "follow-up question. A decision-maker could act on it without further analysis.",
      },
    ],
  },
];

/**
 * Compute a weighted composite score from dimension scores.
 *
 * Scores are normalized to [0, 1] before weighting (each dimension max is 3).
 * Weights are normalized to sum to 1.
 */
export function computeComposite(
  scores: Record<DimensionName, number>,
  weights: Partial<Record<DimensionName, number | undefined>> = {},
): CompositeScore {
  const resolved: Record<DimensionName, number> = {
    faithfulness: weights.faithfulness ?? 0.25,
    completeness: weights.completeness ?? 0.25,
    coherence: weights.coherence ?? 0.25,
    actionability: weights.actionability ?? 0.25,
  };

  const totalWeight = Object.values(resolved).reduce((a, b) => a + b, 0);

  let composite = 0;
  for (const dim of DIMENSIONS) {
    const normalizedScore = scores[dim.name] / 3;
    const normalizedWeight = resolved[dim.name] / totalWeight;
    composite += normalizedScore * normalizedWeight;
  }

  return asCompositeScore(round3(composite));
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
