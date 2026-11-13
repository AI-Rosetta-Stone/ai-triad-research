// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Prompt templates for the inquiry synthesis pass (t/3580).
// Per DebateTool convention: prompts are defined here, never inlined in engine logic.

/**
 * Standard single-run caveat for inquiry results.
 *
 * Named export so both the prompt template and the synthesis fallback path use
 * the same text — the pilot footer phrasing users have seen (TL t/3580#3).
 */
export const SINGLE_RUN_CAVEAT =
  'This result is based on a single debate run. Findings represent a strong exploratory draft, ' +
  'not a settled empirical result. Conclusions should be verified across ≥10 independent runs ' +
  'before being treated as reliable.';

/**
 * Build the synthesis prompt for the inquiry pipeline.
 *
 * The LLM must return a JSON object with this shape:
 * ```json
 * {
 *   "directAnswer": {"text": "...", "agreement": "consensus|split"},
 *   "campVerdicts": [{"camp": "acc|saf|skp|cc", "verdict": "...", "nodeIds": ["acc-beliefs-001"], "answeredLiteralQuestion": true, "answerNote": "..."}],
 *   "convergences": [{"claim": "...", "nodeIds": ["acc-beliefs-001", "saf-beliefs-002"]}],
 *   "evidenceLayers": [{"title": "...", "role": "...", "solves": "...", "sources": [...]}],
 *   "unresolvedGaps": [{"description": "...", "confidence": "..."}],
 *   "singleRunCaveat": "...",
 *   "synthesizedHeadline": "..."
 * }
 * ```
 *
 * Node IDs must be drawn exclusively from the provided grounding context.
 */
export function inquirySynthesisPrompt(
  question: string,
  transcriptHighlights: string,
  anSummary: string,
  groundingContext: string,
  debatedTopic?: string,
): string {
  // t/285: when the debate was run on a rewritten topic, show both so the synthesis can say whether it answered the question asked.
  const topicLines = debatedTopic
    ? `QUESTION (as asked): "${question}"\nTOPIC THE DEBATE ADDRESSED (rewritten from the question): "${debatedTopic}"`
    : `QUESTION: "${question}"`;
  return `You are a research analyst synthesizing a multi-perspective AI policy debate into a structured answer artifact.

${topicLines}

=== GROUNDING NODES (use ONLY these node IDs in your output) ===
${groundingContext}

=== DEBATE HIGHLIGHTS ===
${transcriptHighlights}

=== ARGUMENT NETWORK SUMMARY ===
${anSummary}

---

Your task: produce a structured JSON synthesis of this debate. Return ONLY valid JSON with NO prose outside it.

REQUIRED FIELDS:

DIRECT ANSWER (produce this first, before any other field):
   - "directAnswer": { "text": "...", "agreement": "consensus" | "split" }
   - "text": a short answer (1-3 sentences) to the QUESTION AS ASKED. Answer the literal question. If the camps have no consensus answer, say so explicitly and give the reason in one clause, e.g. "No consensus answer: the camps disagree on whether X applies."
   - "agreement": "consensus" if the camps agree on the answer, "split" if they diverge.
   - Do not describe the camps here. That belongs in synthesizedHeadline and campVerdicts.

FIGURES RULE (applies to every field): Do not introduce any number, percentage, date, or magnitude phrase (e.g. "hundreds of thousands", "millions", "dozens") that does not appear in the QUESTION or the DEBATE HIGHLIGHTS above. If a debater stated a figure, attribute it to that camp ("the Accelerationist cited …") rather than stating it as fact. If no figure was given, describe the claim qualitatively ("far more deaths").

1. campVerdicts — one entry per POV camp that appeared in the debate (acc, saf, skp, cc).
   - "camp": the camp code
   - "verdict": 2-4 sentences summarising this camp's position on the question
   - "nodeIds": 1-3 grounding node IDs (from the list above) most relevant to this camp's answer
   - "answeredLiteralQuestion": true if this camp directly answered the question as asked, false if it focused on something else
   - "answerNote": when answeredLiteralQuestion is false, one line on what the camp focused on instead (max 300 characters)
   - If the grounding context has a "NOTE (<camp>)" line, begin that camp's verdict with "The taxonomy has little that speaks directly to this question; " and do not present the camp's general position as its specific answer.

2. convergences — points where two or more camps agree despite different framings (0-5 items).
   - "claim": the shared claim or point of agreement, in one sentence
   - "nodeIds": 1-3 grounding node IDs that ground the claim

3. evidenceLayers — distinct types of reasoning or evidence used (2-4 items).
   - "title": short label
   - "role": what this layer contributes to the analysis
   - "solves": what question or uncertainty this layer resolves
   - "sources": list of brief source descriptions (e.g. "Transcript turn 4: Safetyist on alignment tax")

4. unresolvedGaps — significant questions the debate did not resolve (1-4 items).
   - "description": the unresolved question or gap
   - "confidence": your confidence the gap is genuine, e.g. "high" or "likely contingent on empirical data"

5. singleRunCaveat — one sentence acknowledging this is a single-run result, not a replicated finding.
   Use approximately this phrasing: "${SINGLE_RUN_CAVEAT.slice(0, 120)}..."

6. synthesizedHeadline — ONE sentence characterising the shape of the disagreement: which camps diverge and on what axis, plus any notable convergence. Describe the split, not the verdict. Must be ≤400 characters. Omit this field entirely if you cannot write it within the limit without truncating the meaning.

Return ONLY the JSON object. No preamble, no commentary, no markdown fences.`;
}

/** Format the grounding envelope's per-camp nodes as context lines for the prompt.
 * When campCoverage is provided, appends a NOTE line for any low-coverage camp (t/4374). */
export function formatGroundingContext(
  nodesByCamp: Partial<Record<string, Array<{ nodeId: string; label: string }>>>,
  campCoverage?: Partial<Record<string, { lowCoverage: boolean }>>,
): string {
  const lines: string[] = [];
  for (const [camp, refs] of Object.entries(nodesByCamp)) {
    for (const ref of refs ?? []) {
      lines.push(`  ${ref.nodeId} (${camp}): ${ref.label}`);
    }
    if (campCoverage?.[camp]?.lowCoverage) {
      lines.push(`  NOTE (${camp}): the taxonomy has no position that closely matches this question. The nodes above are this camp's nearest general positions, not a direct answer.`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(no grounding nodes available)';
}
