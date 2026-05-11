/**
 * Per-fact LLM judge — checks whether a response correctly states each
 * reference fact, independent of surface form.
 *
 * Unlike `judge.ts` (which produces a comparative 4-dimension composite),
 * this judge treats each reference fact as an atomic claim and returns
 * one pass/fail verdict per fact. It exists to decouple the
 * decomposition-value measurement from regex proximity windows that
 * cannot tolerate reasonable phrasing variation.
 *
 * Design notes:
 * - One judge call per output (batched across all facts) so the judge
 *   sees the full response at once. Avoids N separate calls per task.
 * - Temperature 0. Facts are evaluated against the response only;
 *   external knowledge is explicitly disallowed.
 * - The judge must emit its reasoning before its verdicts, to mirror
 *   the anchoring discipline used in the comparative judge.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { JUDGE_MODEL } from "../constants";
import type { ReferenceFact } from "../schema";

const JUDGE_MAX_TOKENS = 8192;

const client = new Anthropic();

export type PerFactVerdict = Readonly<{
  factId: string;
  matched: boolean;
  justification: string;
}>;

export type PerFactJudgeResult = Readonly<{
  verdicts: readonly PerFactVerdict[];
  reasoning: string;
  score: number;
}>;

const VerdictSchema = z.object({
  factId: z.string(),
  matched: z.boolean(),
  justification: z.string(),
});
const VerdictsArraySchema = z.object({
  verdicts: z.array(VerdictSchema),
});

export const PER_FACT_SYSTEM_PROMPT = `
You are a strict fact verification judge. You will be given a candidate
response and a list of reference facts. For each reference fact, decide
whether the response correctly states that fact.

CRITICAL RULES:

1. Use ONLY the candidate response as evidence. Do not consult external
   knowledge. If the response does not state a fact, it does not matter
   whether the fact is true in the world — mark it as NOT matched.

2. Each reference fact names a specific entity (e.g. a vendor name). The
   response matches the fact ONLY if the response correctly attributes
   that fact to that specific entity. A response that states the correct
   value but attaches it to the wrong entity does NOT match. Wrong-entity
   assignment is the primary failure mode to detect.

3. Tolerate reasonable surface-form variation. "US-only", "U.S. only",
   "United States only", "exclusively U.S. regions", and "U.S. AWS
   regions only" all express the same residency fact. "24 hours", "24h",
   and "within 24 hours of confirming a material incident" all express
   the same SLA. Paraphrasing is fine as long as the substantive claim
   and the entity-attribution are both correct.

4. Be strict about distractor confusion. If the reference fact is about
   the entity's CURRENT status and the response cites a SUPERSEDED,
   EXPIRED, DEPRECATED, HYPOTHETICAL, or PILOT-ONLY variant, that does
   not match. If the response says both and the distractor is clearly
   framed as historical context, that does match.

5. A fact is matched only if the response makes the claim. Mentioning
   the entity in a nearby sentence without stating the specific fact
   does not count.

OUTPUT FORMAT:

First, write your reasoning in a <reasoning> block. For each fact, write
one concise sentence naming the fact and whether the response correctly
states it. Do not restate the response or the fact description verbatim.

Then emit a <verdicts> block containing strict JSON with one entry per
reference fact:

<verdicts>
{
  "verdicts": [
    { "factId": "<fact id>", "matched": true|false, "justification": "<one short sentence>" }
  ]
}
</verdicts>

Return exactly one verdict per provided fact, in the same order. Do not
omit facts. Do not add facts that were not provided.
`.trim();

export function buildPerFactUserPrompt(
  facts: readonly ReferenceFact[],
  response: string,
): string {
  const factList = facts
    .map((f, i) => `${i + 1}. factId="${f.id}" — ${f.description}`)
    .join("\n");
  return `
## Reference facts to check

${factList}

---

## Candidate response

${response}
`.trim();
}

export function parsePerFactResponse(
  text: string,
  expectedFactIds: readonly string[],
): { reasoning: string; verdicts: PerFactVerdict[] } {
  const reasoningMatch = text.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
  const verdictsMatch = text.match(/<verdicts>([\s\S]*?)<\/verdicts>/);
  if (!reasoningMatch || !verdictsMatch) {
    throw new Error(
      `Per-fact judge response missing required blocks.\n` +
        `Has <reasoning>: ${!!reasoningMatch}\n` +
        `Has <verdicts>: ${!!verdictsMatch}\n` +
        `Raw response (first 500 chars):\n${text.slice(0, 500)}`,
    );
  }
  const reasoning = (reasoningMatch[1] ?? "").trim();
  const rawJson = (verdictsMatch[1] ?? "").trim();
  let parsed: z.infer<typeof VerdictsArraySchema>;
  try {
    parsed = VerdictsArraySchema.parse(JSON.parse(rawJson));
  } catch (cause: unknown) {
    throw new Error(
      `Per-fact judge verdict JSON failed to parse: ${rawJson.slice(0, 200)}`,
      { cause },
    );
  }

  const byId = new Map(parsed.verdicts.map((v) => [v.factId, v]));
  const verdicts: PerFactVerdict[] = [];
  for (const factId of expectedFactIds) {
    const v = byId.get(factId);
    if (!v) {
      throw new Error(`Judge omitted verdict for factId=${factId}`);
    }
    verdicts.push(v);
  }
  return { reasoning, verdicts };
}

export async function runPerFactJudge(
  facts: readonly ReferenceFact[],
  response: string,
): Promise<PerFactJudgeResult> {
  if (facts.length === 0) {
    return { verdicts: [], reasoning: "", score: 0 };
  }
  const aiResponse = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: JUDGE_MAX_TOKENS,
    temperature: 0,
    system: PER_FACT_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: buildPerFactUserPrompt(facts, response) },
    ],
  });
  const text = aiResponse.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const expectedIds = facts.map((f) => f.id);
  const { reasoning, verdicts } = parsePerFactResponse(text, expectedIds);

  const totalWeight = facts.reduce((s, f) => s + f.weight, 0);
  const matchedWeight = verdicts.reduce((s, v, i) => {
    const fact = facts[i];
    return s + (v.matched && fact ? fact.weight : 0);
  }, 0);
  const score = totalWeight === 0 ? 0 : matchedWeight / totalWeight;

  return { verdicts, reasoning, score };
}
