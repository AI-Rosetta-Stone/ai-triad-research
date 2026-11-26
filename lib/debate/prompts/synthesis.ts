// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebateAudience } from '../types.js';
import { interpretationText, isBdiInterpretation } from '../taxonomyTypes.js';
import type { RawInterpretation } from '../taxonomyTypes.js';
import { stripExcludes } from '../helpers.js';
import { DOC_TRUNCATION_LIMIT } from '../constants.js';
import { getReadingLevel } from './shared-helpers.js';
import { truncationNotice } from './shared-instructions.js';

// ── Multi-phase synthesis prompts (PQ-5) ────────────────

/** Phase 1: Extract core synthesis — agreement, disagreement, cruxes, unresolved questions */
export function synthExtractPrompt(
  topic: string,
  transcript: string,
  audience?: DebateAudience,
  cruxResolutionContext?: string,
): string {
  const cruxBlock = cruxResolutionContext
    ? `\n=== CRUX RESOLUTION STATUS (from argument network analysis) ===\n${cruxResolutionContext}\nUse this to accurately classify crux resolution_status:\n- "resolved": the crux was engaged and settled (evidence or argument converged).\n- "irreducible": the crux was identified AND shown permanently unresolvable (e.g. a values clash that cannot be adjudicated by evidence).\n- "active": the crux is under productive live examination.\n- "undecided": the debate terminated without establishing whether the crux is resolvable — either the crux was never surfaced as an explicit point of disagreement, or the iteration cap was reached before sufficient evidence accumulated. Use ONLY when the crux was NOT adjudicated by both sides; if both debaters engaged the crux proposition, choose resolved/irreducible/active instead. (This convergence-layer "undecided" is distinct from the preference-layer "undecidable", which means two claims' strength cannot be ordered.)\n`
    : '';

  return `You are a debate analyst. Analyze this structured debate and extract the core synthesis.
${getReadingLevel(audience)}

=== DEBATE TOPIC ===
"${topic}"
${cruxBlock}
=== FULL TRANSCRIPT ===
${transcript}

CRITICAL — CONCESSION AWARENESS:
Before classifying any point as a "disagreement," check whether a debater WITHDREW, CONCEDED, or REVISED their position during the debate. If a debater initially proposed X but later abandoned it and endorsed an opponent's alternative, that is NOT a disagreement — it is a RESOLVED point that belongs in areas_of_agreement. The FINAL positions matter, not the initial ones.

Identify:
1. Areas where the debaters agree — include both initial agreements AND points where debaters CONVERGED during the debate (initially disagreed but one side conceded). For converged points, note who conceded and what changed their mind.
2. Areas where they genuinely STILL disagree at the END of the debate (with each debater's FINAL stance, not their opening position)
3. For each disagreement, classify:
   a. "type": EMPIRICAL, VALUES, or DEFINITIONAL
   b. "bdi_layer": "belief" (empirical disagreement), "desire" (value priorities differ), or "intention" (key terms defined differently)
   c. "resolvability": MUST match bdi_layer — belief → "resolvable_by_evidence", desire → "negotiable_via_tradeoffs", intention → "requires_term_clarification". No exceptions.
4. Cruxes — specific questions that, if answered, would change a debater's position.
   For each crux, FIRST decide whether it is counterfactual at all. A crux is counterfactual only if it reasons about a state contrary to fact. If it is a direct empirical or definitional question, set counterfactual_type to "none". Otherwise classify:
   - "interventional" (Pearl do-calculus): asks what would happen if a variable were FORCED to a value — "If we imposed strict liability, would developers exit?"
   - "backtracking" (Lewis): runs causal history backwards — "If the 2022 regulation had passed, would the landscape look different?"
   - "normative": asks what follows from adopting a value or rule — "If we adopted the precautionary principle, what would change?"
5. Questions that remain unresolved

=== NEUTRALIZATION PASS ===
After completing your analysis, review every free-text field before writing the final JSON:
- PRESERVE: all substantive claims, factual content, and structural relationships (agreement/disagreement classifications, crux logic)
- NEUTRALIZE: stance-loaded vocabulary (e.g., "reckless," "visionary"), camp-specific rhetorical moves (accelerationist urgency framing, safetyist catastrophism, skeptic dismissiveness), and emotional register tied to one position
- "point" and "question" fields must read as neutral descriptions of the issue, not as advocacy for either side
- Attributed fields ("stance", "if_yes", "if_no") may retain position-specific language since they describe which debater must concede, but strip emotional amplification (e.g., "argues X is dangerous" → "argues X poses risks")

ORDER: list areas_of_agreement, areas_of_disagreement and cruxes by importance to the debate question, most important first. Readers see only the first three of each list. Set "answers_question": true on an agreement only when it directly answers or decides the debate question; false otherwise. Set "decisive": true on exactly one disagreement and exactly one crux: the one whose resolution would most change the answer to the debate question; false on all others.

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "areas_of_agreement": [{"point": "...", "povers": ["accelerationist", "safetyist"], "answers_question": false, "converged": false, "conceded_by": null, "original_disagreement": null}],
  "areas_of_disagreement": [{"point": "...", "decisive": false, "type": "EMPIRICAL or VALUES or DEFINITIONAL", "bdi_layer": "belief or desire or intention", "resolvability": "resolvable_by_evidence or negotiable_via_tradeoffs or requires_term_clarification", "positions": [{"pover": "accelerationist", "stance": "..."}, {"pover": "safetyist", "stance": "..."}]}],
  "cruxes": [
    {"question": "the factual or value question that would change minds", "decisive": false, "if_yes": "which debater's position weakens — who must concede or revise, and what they must give up", "if_no": "which debater's position weakens — who must concede or revise, and what they must give up", "type": "EMPIRICAL or VALUES", "counterfactual_type": "interventional, backtracking, normative, or none if the crux is not counterfactual in form", "resolution_status": "resolved or irreducible or active or undecided", "resolution_evidence": "what resolved it, if applicable"}
  ],
  "unresolved_questions": ["..."]
}`;
}

/** Phase 2: Build argument map + taxonomy coverage from transcript and Phase 1 disagreements */
export function synthMapPrompt(
  topic: string,
  transcript: string,
  disagreements: string,
  hasSourceDocument: boolean = false,
  audience?: DebateAudience,
): string {
  const documentAnalysis = hasSourceDocument ? `
7. Document vs. debater claims: Separate the claims that originate from the source document from arguments the debaters constructed independently.` : '';

  const documentSchema = hasSourceDocument ? `,
  "document_claims": [
    {"claim": "what the document asserts", "accepted_by": ["accelerationist"], "challenged_by": ["safetyist"], "challenge_basis": "brief summary"}
  ]` : '';

  return `You are a debate analyst. Build an argument map from this structured debate.
${getReadingLevel(audience)}

=== DEBATE TOPIC ===
"${topic}"

=== KEY DISAGREEMENTS (from prior analysis) ===
${disagreements}

=== FULL TRANSCRIPT ===
${transcript}

Tasks:
1. Which taxonomy nodes were referenced and how they were used
2. Build an argument map: extract key claims and their relationships
   - Each claim gets an ID (C1, C2, ...), near-verbatim text, and who made it
   - For each claim, list supports (supported_by) and attacks (attacked_by)
   - Classify attacks: "rebut", "undercut", or "undermine"
   - Note dialectical scheme: CONCEDE, DISTINGUISH, REFRAME, COUNTEREXAMPLE, REDUCE, or ESCALATE
   - Classify the argumentation_scheme: ARGUMENT_FROM_EVIDENCE, ARGUMENT_FROM_EXPERT_OPINION, ARGUMENT_FROM_PRECEDENT, ARGUMENT_FROM_CONSEQUENCES, ARGUMENT_FROM_ANALOGY, PRACTICAL_REASONING, ARGUMENT_FROM_DEFINITION, ARGUMENT_FROM_VALUES, ARGUMENT_FROM_FAIRNESS, ARGUMENT_FROM_IGNORANCE, SLIPPERY_SLOPE, ARGUMENT_FROM_RISK, ARGUMENT_FROM_METAPHOR, or OTHER
   - For attacks, note which critical_question_addressed (1-4) the attack targets — e.g., challenging an analogy on CQ2 means "important differences prevent transfer"
   - Each claim must be traceable to the transcript${documentAnalysis}
3. Identify concepts discussed in this debate that are NOT covered by any existing taxonomy node. For each, propose a new node with a label (3-8 words), genus-differentia description, POV, category, and rationale explaining why this debate surfaced a gap. Link to the claim IDs that motivated the proposal.
   LABEL FORMAT BY CATEGORY:
   - Desires: present participle targeting an ideal state (e.g., "Mitigating Automation Displacement", "Ensuring Algorithmic Accountability", "Democratizing AI Access")
   - Beliefs: noun phrase denoting a phenomenon, principle, or empirical claim (e.g., "Inherent Power-Seeking Behavior", "Cognitive Atrophy from AI Reliance")
   - Intentions: present participle denoting strategic action or policy posture (e.g., "Mandating Algorithmic Audits", "Prioritizing Interpretability Research")
   Never start labels with "The", "A", or "An". Never include parenthetical abbreviations.
   DESCRIPTION RULES: Use domain-specific terminology — no colloquialisms. Every description must include Encompasses: and Excludes: clauses.
4. Identify existing taxonomy nodes that should be modified based on what this debate revealed — descriptions that are too narrow, categories that are wrong, or nodes that should be split. For each, specify the node ID, modification type, suggested change, and rationale.

=== NEUTRALIZATION PASS ===
After completing your analysis, review every free-text field before writing the final JSON:
- PRESERVE: all substantive claims, claim relationships (supported_by, attacked_by), argumentation structure, and taxonomy mappings
- NEUTRALIZE: stance-loaded vocabulary, camp-specific rhetorical moves, and emotional register tied to one position
- "claim" fields should preserve substantive content while removing gratuitous emotional loading — keep the argument, strip the spin
- "how_used", "rationale", "description", and "suggested_change" fields must read as neutral analytical observations
- Taxonomy proposals (label, description) must use domain terminology, never camp rhetoric

CRITICAL: The argument_map array below is the primary output. It MUST contain at least 3 claims — never return an empty argument_map.

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "argument_map": [
    {"claim_id": "C1", "claim": "near-verbatim from transcript", "claimant": "accelerationist", "type": "empirical or normative or definitional", "supported_by": [{"claim_id": "C3", "scheme": "argument_from_evidence", "warrant": "1 sentence: WHY C3 supports C1"}], "attacked_by": [
      {"claim_id": "C2", "claim": "the attacking claim text", "claimant": "safetyist", "attack_type": "rebut or undercut or undermine", "scheme": "COUNTEREXAMPLE or DISTINGUISH or REDUCE or REFRAME or CONCEDE or ESCALATE", "argumentation_scheme": "ARGUMENT_FROM_EVIDENCE or ARGUMENT_FROM_ANALOGY or PRACTICAL_REASONING etc", "critical_question_addressed": 2}
    ]}
  ],
  "taxonomy_coverage": [{"node_id": "<a real node_id from transcript context>", "how_used": "brief description"}],
  "taxonomy_proposals": [
    {"label": "Mitigating Workforce Displacement Risk", "description": "A Desire within safetyist discourse that [differentia].\nEncompasses: [concrete sub-themes].\nExcludes: [neighboring concepts].", "pov": "accelerationist or safetyist or skeptic or situations", "category": "Beliefs or Desires or Intentions", "rationale": "why this debate surfaced a gap", "source_claims": ["C1", "C3"]}
  ],
  "taxonomy_modifications": [
    {"node_id": "acc-desires-001", "modification_type": "refine_description or add_nuance or recategorize or split", "suggested_change": "what to change", "rationale": "what the debate revealed", "source_claims": ["C2"]}
  ]${documentSchema}
}`;
}

/** Phase 3: Evaluate preferences + policy implications from argument map and disagreements */
export function synthEvaluatePrompt(
  topic: string,
  disagreements: string,
  argumentMap: string,
  policyContext: string = '',
  audience?: DebateAudience,
): string {
  return `You are a debate analyst. Evaluate which arguments are stronger and identify policy implications.
${getReadingLevel(audience)}

=== DEBATE TOPIC ===
"${topic}"

=== DISAGREEMENTS ===
${disagreements}

=== ARGUMENT MAP ===
${argumentMap}

Tasks:
0. **TOPIC RESOLUTION (required).** The reader's first question is "what did the debate conclude about what I actually asked?" Restate the original debate question — "${topic}" — as one sentence, then answer it directly across all three perspectives: name where they converged, where they remain genuinely split, and the one crux that would most move the outcome. This is a direct answer to the original question, not a summary of the agreement/disagreement lists.
1. For each disagreement, evaluate which position is STRONGER and why.
   Apply these preference criteria (in order of priority):
   a. "empirical_evidence" — which position cites more or better evidence?
   b. "logical_validity" — which position has fewer logical gaps or fallacies?
   c. "source_authority" — which position draws on more authoritative sources?
   d. "specificity" — which position is more concrete and testable?
   e. "scope" — which position accounts for more relevant considerations?${audience === 'policymakers' ? `
   f. "political_feasibility" — which position is more likely to survive a legislative process and achieve enforcement?
   g. "implementation_specificity" — which position names concrete enforcement mechanisms, timelines, and responsible institutions?

   Weight criteria f and g equally with the existing five when evaluating for a policymaker audience. A technically superior position that cannot be implemented is less valuable to this audience than a feasible one.` : ''}
   If genuinely undecidable, say so and explain what evidence would tip the balance.
2. Policy implications: For each significant disagreement, identify what concrete policy actions would differ depending on which position prevails.${policyContext ? ` Reference pol-NNN IDs from the policy registry when applicable.${policyContext}` : ''}

=== NEUTRALIZATION PASS ===
After completing your analysis, review every free-text field before writing the final JSON:
- PRESERVE: all evaluative conclusions, evidential reasoning, criterion-based judgments, and policy relationships
- NEUTRALIZE: stance-loaded vocabulary, camp-specific rhetorical moves, and emotional register tied to one position
- "rationale" fields must present evaluative reasoning in neutral analytical language — base the evaluation on the five preference criteria listed in Task 1 (empirical_evidence, logical_validity, source_authority, specificity, scope), not on the winning position's rhetorical register
- "implication" fields must describe policy consequences neutrally, not advocate for either side
- "what_would_change_this" must frame the epistemic gap objectively, not from one camp's perspective

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "topic_resolution": {
    "restated_question": "<the debate's original question, one crisp sentence>",
    "where_it_landed": "<2-4 sentences: directly answer the question across the three perspectives — what each concluded, where they converged, where they remain split. NOT a rehash of the agreement/disagreement lists.>",
    "what_would_resolve_it": "<the single most decisive crux whose resolution would most change positions>"
  },
  "preferences": [
    {"conflict": "description of disagreement", "claim_ids": ["C1", "C2"], "prevails": "C2 or undecidable", "criterion": "empirical_evidence or logical_validity or source_authority or specificity or scope", "rationale": "2-3 sentences explaining why", "what_would_change_this": "what evidence would flip the verdict"}
  ],
  "policy_implications": [
    {"disagreement": "the policy-relevant disagreement", ${policyContext ? '"policy_refs": ["pol-NNN"], ' : ''}"positions": [{"pover": "accelerationist", "stance": "supports/opposes/modifies and why"}], "implication": "how this affects what policy should be adopted"}
  ]
}`;
}

/** @deprecated Use multi-phase synthesis (synthExtractPrompt + synthMapPrompt + synthEvaluatePrompt). Kept for backward compatibility. */
export function debateSynthesisPrompt(
  topic: string,
  transcript: string,
  hasSourceDocument: boolean = false,
  policyContext: string = '',
  audience?: DebateAudience,
): string {
  const documentAnalysis = hasSourceDocument ? `
7. Document vs. debater claims: Separate the claims that originate from the source document from arguments the debaters constructed independently. For each document claim that was contested, note which debaters accepted it and which challenged it.` : '';

  const documentSchema = hasSourceDocument ? `,
  "document_claims": [
    {"claim": "what the document asserts", "accepted_by": ["accelerationist"], "challenged_by": ["safetyist"], "challenge_basis": "brief summary of why it was challenged"}
  ]` : '';

  return `You are a debate analyst. Analyze this structured debate and produce a synthesis.
${getReadingLevel(audience)}

=== DEBATE TOPIC ===
"${topic}"

=== FULL TRANSCRIPT ===
${transcript}

CRITICAL — CONCESSION AWARENESS:
Before classifying any point as a "disagreement," check whether a debater WITHDREW,
CONCEDED, or REVISED their position during the debate. If a debater initially proposed
X but later abandoned it and endorsed an opponent's alternative, that is NOT a
disagreement — it is a RESOLVED point that belongs in areas_of_agreement. Look for
explicit concession language ("I withdraw," "I accept," "I endorse [opponent]'s
approach instead," "fair point — I'll drop that") and for positions that evolved
across turns. The FINAL positions matter, not the initial ones. A debate that starts
with disagreement and ends with convergence has FEWER disagreements than the opening
statements suggest.

Identify:
1. Areas where the debaters agree — include both initial agreements AND points where
   debaters CONVERGED during the debate (initially disagreed but one side conceded).
   For converged points, note who conceded and what changed their mind.
2. Areas where they genuinely STILL disagree at the end of the debate (with each
   debater's FINAL stance, not their opening position)
3. For each disagreement, classify:
   a. "type": EMPIRICAL, VALUES, or DEFINITIONAL (as before)
   b. "bdi_layer": which layer of the debaters' worldview this disagreement lives in:
      - "belief" — they disagree about what is empirically true (facts, evidence, predictions)
      - "desire" — they share the facts but prioritize differently (goals, principles, trade-offs)
      - "intention" — they define a key term or concept differently (meaning, scope, framing)
   c. "resolvability": MUST match bdi_layer exactly — no exceptions:
      - belief → "resolvable_by_evidence"
      - desire → "negotiable_via_tradeoffs"
      - intention → "requires_term_clarification"
4. Cruxes — the specific factual or value questions that, if resolved, would change a debater's position. A good crux is a question where one debater would say "if the answer turned out to be X, I would actually change my position."
   For each crux, FIRST decide whether it is counterfactual at all. A crux is counterfactual only if it reasons about a state contrary to fact. If it is a direct empirical or definitional question, set counterfactual_type to "none". Otherwise classify:
   - "interventional": asks what would happen if a variable were forced to a value (Pearl do-calculus)
   - "backtracking": runs causal history backwards — what would have been different? (Lewis)
   - "normative": asks what follows from adopting a value, principle, or rule
5. Questions that remain unresolved
6. Which taxonomy nodes were referenced and how they were used
7. Build an argument map: extract the key claims from the transcript and show how they relate
   - Each claim gets an ID (C1, C2, ...), the verbatim or near-verbatim text, and who made it
   - For each claim, list which other claims support it (supported_by) and which attack it
   - For attacks, classify the attack_type:
     "rebut" — directly contradicts the claim's conclusion (e.g., COUNTEREXAMPLE, REDUCE)
     "undercut" — accepts the evidence but denies the inference (e.g., DISTINGUISH)
     "undermine" — attacks the credibility or relevance of the claim's source
   - For attacks, note which dialectical scheme was used: CONCEDE, DISTINGUISH, REFRAME, COUNTEREXAMPLE, REDUCE, or ESCALATE
   - Classify the argumentation_scheme: ARGUMENT_FROM_EVIDENCE, ARGUMENT_FROM_EXPERT_OPINION, ARGUMENT_FROM_PRECEDENT, ARGUMENT_FROM_CONSEQUENCES, ARGUMENT_FROM_ANALOGY, PRACTICAL_REASONING, ARGUMENT_FROM_DEFINITION, ARGUMENT_FROM_VALUES, ARGUMENT_FROM_FAIRNESS, ARGUMENT_FROM_IGNORANCE, SLIPPERY_SLOPE, ARGUMENT_FROM_RISK, ARGUMENT_FROM_METAPHOR, or OTHER
   - For attacks, note which critical_question_addressed (1-4) the attack targets
   - Each claim must be traceable to something actually said in the transcript
8. For each area of disagreement, evaluate which position is STRONGER and why.
   Apply these preference criteria (in order of priority):
   a. "empirical_evidence" — which position cites more or better evidence?
   b. "logical_validity" — which position has fewer logical gaps or fallacies?
   c. "source_authority" — which position draws on more authoritative sources?
   d. "specificity" — which position is more concrete and testable?
   e. "scope" — which position accounts for more of the relevant considerations?
   A position can prevail on one criterion while losing on another.
   If genuinely undecidable, say so and explain what evidence would tip the balance.${documentAnalysis}
9. Policy implications: For each significant disagreement, identify what concrete policy actions would differ depending on which position prevails.${policyContext ? ` Reference pol-NNN IDs from the policy registry when applicable.${policyContext}` : ' Describe implied policy directions based on the debaters\' positions.'}

ORDER: list areas_of_agreement, areas_of_disagreement and cruxes by importance to the debate question, most important first. Readers see only the first three of each list. Set "answers_question": true on an agreement only when it directly answers or decides the debate question; false otherwise. Set "decisive": true on exactly one disagreement and exactly one crux: the one whose resolution would most change the answer to the debate question; false on all others.

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "areas_of_agreement": [{"point": "...", "povers": ["accelerationist", "safetyist"], "answers_question": false, "converged": false, "conceded_by": null, "original_disagreement": null}],
  "areas_of_disagreement": [{"point": "...", "decisive": false, "type": "EMPIRICAL or VALUES or DEFINITIONAL", "bdi_layer": "belief or desire or intention", "resolvability": "resolvable_by_evidence or negotiable_via_tradeoffs or requires_term_clarification", "positions": [{"pover": "accelerationist", "stance": "..."}, {"pover": "safetyist", "stance": "..."}]}],
  "cruxes": [
    {"question": "the factual or value question that would change minds", "decisive": false, "if_yes": "which debater's position weakens — who must concede or revise, and what they must give up", "if_no": "which debater's position weakens — who must concede or revise, and what they must give up", "type": "EMPIRICAL or VALUES", "counterfactual_type": "interventional, backtracking, normative, or none if the crux is not counterfactual in form"}
  ],
  "unresolved_questions": ["..."],
  "taxonomy_coverage": [{"node_id": "<a real node_id from transcript context>", "how_used": "brief description"}],
  "argument_map": [
    {"claim_id": "C1", "claim": "near-verbatim from transcript", "claimant": "accelerationist", "type": "empirical or normative or definitional", "supported_by": [{"claim_id": "C3", "scheme": "argument_from_evidence or argument_from_analogy or argument_from_authority or argument_from_consequences or causal_argument or practical_reasoning", "warrant": "1 sentence: WHY C3 supports C1"}], "attacked_by": [
      {"claim_id": "C2", "claim": "the attacking claim text", "claimant": "safetyist", "attack_type": "rebut or undercut or undermine", "scheme": "COUNTEREXAMPLE or DISTINGUISH or REDUCE or REFRAME or CONCEDE or ESCALATE", "argumentation_scheme": "ARGUMENT_FROM_EVIDENCE or ARGUMENT_FROM_ANALOGY or PRACTICAL_REASONING etc", "critical_question_addressed": 2}
    ]}
  ],
  "preferences": [
    {"conflict": "description of the disagreement", "claim_ids": ["C1", "C2"], "prevails": "C2 or undecidable", "criterion": "empirical_evidence or logical_validity or source_authority or specificity or scope", "rationale": "2-3 sentences explaining why", "what_would_change_this": "what evidence would flip the verdict"}
  ],
  "policy_implications": [
    {"disagreement": "the policy-relevant disagreement", ${policyContext ? '"policy_refs": ["pol-NNN"], ' : ''}"positions": [{"pover": "accelerationist", "stance": "supports/opposes/modifies and why"}], "implication": "how this disagreement affects what policy should be adopted"}
  ]${documentSchema}
}`;
}

export function probingQuestionsPrompt(
  topic: string,
  transcript: string,
  unreferencedNodes: string[],
  hasSourceDocument: boolean = false,
  uncoveredClaims?: string[],
  audience?: DebateAudience,
): string {
  const unreferencedBlock = unreferencedNodes.length > 0
    ? `\n\n=== TAXONOMY NODES NOT YET REFERENCED ===\n${unreferencedNodes.join('\n')}`
    : '';

  const uncoveredBlock = uncoveredClaims && uncoveredClaims.length > 0
    ? `\n\n=== UNCOVERED DOCUMENT CLAIMS ===
The following claims from the source document have NOT been addressed by any debater. Consider asking questions that would force debaters to engage with these gaps:
${uncoveredClaims.join('\n')}`
    : '';

  const documentGuidance = hasSourceDocument
    ? `- Identify parts of the source document that debaters ignored, glossed over, or mischaracterized — ask them to address those specific passages
- Ask whether the document's framing itself is contested: does it define key terms in a way that advantages one perspective?
`
    : '';

  const uncoveredGuidance = uncoveredClaims && uncoveredClaims.length > 0
    ? `- PRIORITY: At least 1-2 questions should directly target uncovered document claims listed below — the debate is incomplete until these are addressed\n`
    : '';

  return `You are a debate facilitator. Given this debate, suggest 3-5 probing questions that would advance the discussion.
${getReadingLevel(audience)}

The best probing question is a "crux" — one where a debater would say: "If the answer to that question turned out to be X, I would actually change my position." Prioritize questions that:
- Would actually change someone's mind if answered — not just interesting-sounding questions
- Distinguish between empirical disagreements (resolvable with evidence) and value disagreements (requiring trade-off reasoning)
- Expose unstated assumptions that debaters are relying on without defending
${documentGuidance}${uncoveredGuidance}- ${unreferencedNodes.length > 0 ? 'Explore taxonomy areas not yet discussed' : 'Deepen the current lines of argument'}
- Push debaters beyond their comfort zones — ask them to engage with evidence that challenges their view

For each question, indicate which debater's position it most threatens and why.

=== DEBATE TOPIC ===
"${topic}"

=== TRANSCRIPT ===
${transcript}
${unreferencedBlock}${uncoveredBlock}

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "questions": [
    {"text": "the probing question", "targets": ["accelerationist", "safetyist"], "threatens": "which position this most challenges and why", "type": "EMPIRICAL or VALUES or DEFINITIONAL"}
  ]
}`;
}

export function factCheckPrompt(
  selectedText: string,
  statementContext: string,
  taxonomyNodes: string,
  conflictData: string,
  audience?: DebateAudience,
  /** Whether a web search ran for this check (t/763, Design ruling 3). Hosts should pass it; when
   *  omitted it is read from the WEB SEARCH RESULTS block the renderer appends to conflictData. */
  webSearchRan?: boolean,
): string {
  const ranWeb = webSearchRan ?? /=== WEB SEARCH RESULTS ===/.test(conflictData);
  const webLine = ranWeb
    ? 'WEB SEARCH: a web search ran for this check; its results are in the section above.'
    : 'WEB SEARCH: none ran for this check. Do not mention web search, web results or online searches anywhere in your answer.';
  return `You are a fact-checker analyzing a claim made during a structured AI policy debate.
${getReadingLevel(audience)}
${webLine}

=== CLAIM TO CHECK ===
"${selectedText}"

=== FULL STATEMENT CONTEXT ===
${statementContext}

=== RELEVANT TAXONOMY POSITIONS ===
${taxonomyNodes}

=== KNOWN CONFLICTS AND WEB EVIDENCE ===
${conflictData || '(No relevant conflicts or web results found)'}

Evaluate whether this claim is factually accurate using ALL available evidence:
1. Internal evidence: Is it consistent with the taxonomy data and known research conflicts?
2. External evidence: Do the web search results support or contradict it? Cite specific findings.
3. Internal consistency: Does it align with other statements in the debate?
4. Temporal accuracy: Is it current, or does it rely on outdated information?

Rate the claim on the VERDICT axis — the polarity of the *core* claim. Pick exactly one:
- "supported" — the core claim AND its material details are corroborated by the weight of evidence. Exact figures and immaterial rounding count as supported. Use this when nothing material is off.
- "partially_accurate" — the core claim's DIRECTION is corroborated, but the evidence identifies a SPECIFIC, MATERIAL discrepancy in a detail (e.g. "12 states" when the truth is 10). This is a *support* verdict with one named error. You MUST populate the "discrepancy" object below. Do NOT use this for a vague "roughly right" hunch with no nameable, sourced error — if nothing is off, use "supported"; if the substance itself is contested or unconfirmable, use "disputed"/"unverifiable".
- "disputed" — a *contested* verdict: authoritative sources conflict on the claim's CENTRAL assertion and the evidence is mixed, not decisive. This is NOT for peripheral detail errors (those are "partially_accurate") — reserve it for genuine dispute about the substance.
- "false" — the central assertion is DIRECTLY contradicted by authoritative sources: the direction is wrong, decisively (not merely a detail that is off).
- "unverifiable" — the claim can be neither confirmed nor denied with available evidence (web search found nothing relevant). This is absence of evidence, not counter-evidence.

When the verdict is "partially_accurate", emit a "discrepancy" object naming the error and sourcing the truth:
- "dimension": one of "magnitude" (off-by-N count/percentage) | "temporal" (stale/wrong date) | "attribution" (right fact, wrong actor/source) | "scope" (over/under-generalized, e.g. "all" vs "some") | "existence" (phenomenon real, a specific instance wrong)
- "claimed": what the speaker asserted, verbatim (the figure/detail)
- "actual": what the evidence shows
- "source": the node_id, conflict_id, or url that establishes "actual"
- "severity": "minor" (does not change the claim's force) | "major" (materially weakens the reasoning, though the direction still holds)
A "partially_accurate" verdict WITHOUT a discrepancy carrying claimed + actual + source will be REJECTED and downgraded — you cannot use it as a hedge.

When web search results are available, cite them specifically in your explanation.

Also write the reader-facing finding:
- "finding": ONE sentence of 25 words or fewer that opens with the plain verdict word for your verdict, then states what the evidence shows. Verdict words: supported → "Accurate."; partially_accurate → "Partly accurate." (or "Overstated." when the speaker over-claimed a number or scope); disputed → "Disputed."; false → "False."; unverifiable → "Can't be verified.".
- "finding_points": 1 to 3 items, each 25 words or fewer, each one concrete piece of evidence behind the finding.
- "limit": OPTIONAL, 25 words or fewer. Include it only for a real caveat (for example, the evidence is old, narrow, or from one source). Omit it otherwise.
Rules for the finding, points and limit:
- Name sources by title, publisher or author, never by a raw document id, node id, conflict id or URL. Never invent a source.
- When the evidence comes from the material above rather than a named outside source, call it "this project's taxonomy" or "the debate so far". Never write "conflict data", "conflict logs", "conflict records", "taxonomy records", "nodes", "debate record", "debate materials" or "verified record".
- If the speaker cited a bad or unknown identifier, you may quote it in a point, attributed to them (e.g. "The statement cites '<id>', which doesn't match a known paper."). Never put it in the finding.
- For "Can't be verified.", write the finding exactly as: "Can't be verified. No source checked here reports <the specific figure, date or source the speaker cited>." Never leave it as the bare verdict words, and never say something is absent from public data, public databases or public records.
- Use neutral summary verbs and add no intensifiers.

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "verdict": "supported" | "partially_accurate" | "disputed" | "false" | "unverifiable",
  "finding": "Accurate. ...",
  "finding_points": ["...", "..."],
  "limit": "... (optional)",
  "explanation": "brief explanation of your assessment",
  "discrepancy": {
    "dimension": "magnitude",
    "claimed": "12 states",
    "actual": "10 states",
    "source": "<node_id / conflict_id / url that establishes the true value>",
    "severity": "minor"
  },
  "sources": [
    {"node_id": "<a real node_id>"},
    {"conflict_id": "e.g. conflict-xyz"}
  ],
  "points": [
    {
      "text": "A specific finding — e.g. 'NHTSA 2025 data shows autonomous vehicles had 40% fewer fatal crashes per mile than human drivers'",
      "type": "supports" | "attacks",
      "evidence_basis": "web_search" | "taxonomy" | "internal_consistency" | "temporal"
    }
  ]
}

The "points" array should contain 1-4 discrete, specific findings from your analysis. Each point is a single factual observation that either supports or attacks the checked claim. Be concrete — cite specific data, dates, or sources rather than vague assessments.`;
}

export function contextCompressionPrompt(
  entries: string,
  audience?: DebateAudience,
): string {
  return `Summarize the following debate segment concisely.
${getReadingLevel(audience)}
Preserve:
- Key arguments and who made them (Accelerationist, Safetyist, Skeptic, Moderator)
- Points of agreement and disagreement, including whether disagreements are empirical, values-based, or definitional
- Any concessions, steelmans, or dialectical moves made
- Any factual claims or evidence cited
- Taxonomy node references (keep the node IDs)

Be concise but complete — this summary replaces the original text in the debate context.

=== DEBATE SEGMENT ===
${entries}

Respond ONLY with a JSON object (no markdown, no code fences):
{"summary": "your summary text"}`;
}

// ── Situation Debate ─────────────────────────────────────

export interface SituationDebateInput {
  id: string;
  label: string;
  description: string;
  interpretations: { accelerationist: RawInterpretation; safetyist: RawInterpretation; skeptic: RawInterpretation };
  disagreementType?: 'definitional' | 'interpretive' | 'structural';
  interpretationDivergence?: number;
  assumes?: string[];
  steelmanVulnerability?: string;
  possibleFallacies?: { fallacy: string; confidence: string; explanation: string }[];
  linkedNodeDescriptions?: string[];
  conflictSummaries?: string[];
}

export interface SituationTopicSynthesisInput {
  label: string;
  description: string;
  interpretations: { accelerationist: RawInterpretation; safetyist: RawInterpretation; skeptic: RawInterpretation };
  disagreementType?: 'definitional' | 'interpretive' | 'structural';
  assumes?: string[];
  conflictSummaries?: string[];
}

export interface SituationTopicSynthesisResult {
  proposition: string;
  framing_rationale?: string;
  cruxes?: { question: string; type: 'empirical' | 'normative' | 'definitional'; accelerationist: string; safetyist: string; skeptic: string }[];
}

/**
 * Synthesize a contestable debate resolution from a situation's disagreement structure.
 * Replaces the old `topic = situation.label` (a noun phrase) with a proposition the three
 * POVs genuinely split on, plus the cruxes that make the split real.
 */
export function situationTopicSynthesisPrompt(
  cc: SituationTopicSynthesisInput,
  audience?: DebateAudience,
): string {
  const bdi = (i: RawInterpretation) => isBdiInterpretation(i)
    ? `belief: ${i.belief}\n  desire: ${i.desire}\n  intention: ${i.intention}`
    : `summary: ${interpretationText(i)}`;

  const typeHint = {
    definitional: 'The core split is DEFINITIONAL — the camps use a key term to mean different things. Frame a resolution that forces the definitional fight into the open.',
    interpretive: 'The core split is INTERPRETIVE — the camps read the same evidence differently. Frame a resolution about what the evidence actually implies.',
    structural: 'The core split is STRUCTURAL — the camps disagree about the underlying causal mechanism. Frame a resolution about that mechanism.',
  }[cc.disagreementType ?? 'interpretive'];

  return `You are a neutral debate architect. Turn the situation below into ONE sharply contestable resolution for a three-way debate between an Accelerationist, a Safetyist, and a Skeptic.
${getReadingLevel(audience)}

=== SITUATION ===
${cc.label}: ${stripExcludes(cc.description)}

=== HOW EACH CAMP READS IT (belief = empirical, desire = normative, intention = strategic) ===
Accelerationist:
  ${bdi(cc.interpretations.accelerationist)}
Safetyist:
  ${bdi(cc.interpretations.safetyist)}
Skeptic:
  ${bdi(cc.interpretations.skeptic)}
${cc.assumes?.length ? `\n=== CONTESTED ASSUMPTIONS ===\n${cc.assumes.map(a => `- ${a}`).join('\n')}` : ''}${cc.conflictSummaries?.length ? `\n=== DOCUMENTED REAL-WORLD CONFLICTS ===\n${cc.conflictSummaries.join('\n')}` : ''}

${typeHint}

Produce a RESOLUTION, not a topic heading. Requirements:
- A single declarative sentence that can be affirmed or denied (not a question, not a noun phrase).
- Framed so at least one camp affirms and at least one denies — NONE trivially right. If all three would agree, you have picked the wrong axis; find the one where the belief/desire/intention layers above actually diverge.
- Specific to THIS situation and tractable — no "Is AI good?" abstractions.
- Steelman-fair: a proposition each camp takes seriously, not a strawman of any side.

Then list the 2-4 cruxes — the sub-disagreements that decide the resolution. For each, say whether it is empirical (a fact question), normative (a values question), or definitional (a meaning question), and give each camp's one-line stance.

Respond ONLY with JSON (no markdown, no code fences):
{
  "proposition": "the resolution as one declarative sentence",
  "framing_rationale": "one sentence: which layer the camps split on and why this proposition surfaces it",
  "cruxes": [
    {"question": "the sub-disagreement", "type": "empirical | normative | definitional",
     "accelerationist": "...", "safetyist": "...", "skeptic": "..."}
  ]
}`;
}

/** Build a rich source-content block from a situation node for prompt injection */
export function formatSituationDebateContext(cc: SituationDebateInput): string {
  const bdiBlock = (label: string, i: RawInterpretation): string[] => {
    if (isBdiInterpretation(i)) {
      return [
        `${label}:`,
        `  belief: ${i.belief}`,
        `  desire: ${i.desire}`,
        `  intention: ${i.intention}`,
      ];
    }
    return [`${label}: ${interpretationText(i)}`];
  };

  const lines: string[] = [
    `=== SITUATION: ${cc.id} ===`,
    `Label: ${cc.label}`,
    `Description: ${stripExcludes(cc.description)}`,
    '',
    '=== POV INTERPRETATIONS ===',
    ...bdiBlock('Accelerationist', cc.interpretations.accelerationist),
    '',
    ...bdiBlock('Safetyist', cc.interpretations.safetyist),
    '',
    ...bdiBlock('Skeptic', cc.interpretations.skeptic),
  ];

  if (cc.disagreementType) {
    const divergenceNote = cc.interpretationDivergence !== undefined
      ? ` (interpretation divergence: ${cc.interpretationDivergence.toFixed(2)})`
      : '';
    lines.push('', '=== DISAGREEMENT TYPE ===', `${cc.disagreementType}${divergenceNote}`);
  }

  if (cc.assumes && cc.assumes.length > 0) {
    lines.push('', '=== UNDERLYING ASSUMPTIONS ===');
    for (const a of cc.assumes) lines.push(`- ${a}`);
  }

  if (cc.steelmanVulnerability) {
    lines.push('', '=== STEELMAN VULNERABILITY ===', cc.steelmanVulnerability);
  }

  if (cc.possibleFallacies && cc.possibleFallacies.length > 0) {
    lines.push('', '=== IDENTIFIED FALLACIES ===');
    for (const f of cc.possibleFallacies) {
      lines.push(`- ${f.fallacy.replace(/_/g, ' ')} (${f.confidence}): ${f.explanation}`);
    }
  }

  if (cc.linkedNodeDescriptions && cc.linkedNodeDescriptions.length > 0) {
    lines.push('', '=== LINKED TAXONOMY NODES ===');
    for (const desc of cc.linkedNodeDescriptions) lines.push(desc);
  }

  if (cc.conflictSummaries && cc.conflictSummaries.length > 0) {
    lines.push('', '=== DOCUMENTED CONFLICTS ===');
    for (const cs of cc.conflictSummaries) lines.push(cs);
  }

  return lines.join('\n');
}

/** Clarification prompt specialized for document/URL debates */
export function documentClarificationPrompt(
  topic: string,
  sourceContent: string,
  audience?: DebateAudience,
  lineageContext?: string,
): string {
  const content = sourceContent.length > DOC_TRUNCATION_LIMIT
    ? sourceContent.slice(0, DOC_TRUNCATION_LIMIT) + truncationNotice(sourceContent, DOC_TRUNCATION_LIMIT)
    : sourceContent;

  const lineageBlock = lineageContext
    ? `\n=== INTELLECTUAL TRADITIONS IN PLAY ===\nThis topic intersects the following intellectual traditions (ranked by relevance across the taxonomy):\n${lineageContext}\nConsider how these traditions frame the document's claims differently.\n`
    : '';

  return `You are a neutral debate facilitator preparing a multi-perspective debate grounded in a specific document.
${getReadingLevel(audience)}

The user wants to debate:

"${topic}"

=== SOURCE DOCUMENT ===
${content}
=== END SOURCE DOCUMENT ===${lineageBlock}

Before the debate begins, you need to help the user focus. Generate 1 to 3 clarifying questions that:
- Identify the document's 2-3 most debatable claims — the ones where the three AI policy perspectives (accelerationist, safetyist, skeptic) would disagree most sharply
- Ask which of these claims or tensions the user most wants to explore
- Surface whether the user is more interested in the document's empirical claims (are the facts right?), its normative framing (are the values right?), or its methodology (is the reasoning sound?)
- Note any key terms the document defines in a way that different perspectives would contest
- Be neutral — do not favor any perspective
- Be concise (one sentence each)

IMPORTANT: Your questions must be REFINEMENT questions that help the user decide what to focus on — not debate propositions that the agents would argue about. Good: "Which of the paper's claims do you most want the debaters to challenge?" Bad: "Should the paper's recommendation for mandatory AI audits be adopted?"

For each question, generate 3-5 answer options that cover the reasonable answer space. Options should be:
- Topic-specific and substantive (not generic like "yes/no")
- Mutually distinct — each option steers the debate in a different direction
- 1-2 sentences each

Respond ONLY with a JSON object in this exact format (no markdown, no code fences):
{"questions": [{"question": "your clarifying question", "options": ["option 1 text", "option 2 text", "option 3 text"]}]}`;
}

/** Clarification prompt specialized for situation debates */
export function situationClarificationPrompt(
  topic: string,
  ccContext: string,
  audience?: DebateAudience,
  lineageContext?: string,
): string {
  const lineageBlock = lineageContext
    ? `\n=== INTELLECTUAL TRADITIONS IN PLAY ===\nThis topic intersects the following intellectual traditions (ranked by relevance across the taxonomy):\n${lineageContext}\nConsider how these traditions shape each perspective's interpretation.\n`
    : '';

  return `You are a neutral debate facilitator preparing a structured debate grounded in a situation from an AI policy taxonomy.
${getReadingLevel(audience)}

The user wants to debate this topic:

"${topic}"

${ccContext}${lineageBlock}

The three POV interpretations above show where the perspectives already diverge. Generate 1 to 3 clarifying questions that help the user decide what to focus on. Your questions should:
- Identify which specific dimension of this concern the user most wants to explore (e.g., the timeline question vs. the policy response vs. the epistemic disagreement)
- Surface which assumptions or fallacies the user finds most interesting to probe
- Distinguish whether the core tension is empirical, normative, or definitional
- Help the user choose a focus that pushes the debaters beyond restating their pre-existing interpretations
- Be neutral — do not favor any perspective
- Be concise (one sentence each)

IMPORTANT: Your questions must be REFINEMENT questions that help the user narrow focus — not debate propositions the agents would argue about. Good: "Which dimension interests you most — the timeline disagreement or the policy response?" Bad: "Is the accelerationist timeline for AGI realistic?"

For each question, generate 3-5 answer options that cover the reasonable answer space. Options should be:
- Topic-specific and substantive (not generic like "yes/no")
- Mutually distinct — each option steers the debate in a different direction
- 1-2 sentences each

Respond ONLY with a JSON object in this exact format (no markdown, no code fences):
{"questions": [{"question": "your clarifying question", "options": ["option 1 text", "option 2 text", "option 3 text"]}]}`;
}

// ── Post-turn summarization (DT-2) ────────────────────────

export function entrySummarizationPrompt(statementText: string, speaker: string): string {
  return `Condense this debate statement by ${speaker} at two compression levels. CRITICAL: Write as ${speaker} in first person, preserving their voice, tone, and rhetorical style. Do NOT switch to third-person narration (e.g., never write "${speaker} argues that…").

STATEMENT:
${statementText}

BRIEF (2-3 sentences): The core claim and strongest piece of reasoning or evidence, in ${speaker}'s own voice. Omit secondary points, assumptions, and steelman content. Plain prose: no labels, no "Tagline:" line, no slogan.

BRIEF CLAIM (one sentence, 15 words or fewer, one main clause): ${speaker}'s position in this statement, in their own voice. State the position only, not the reasons for it.

BRIEF POINTS (2 or 3 items, each 25 words or fewer): the support for that claim, each one of: a study with its year, a concrete fact, or the inference that ties the support to the claim. One idea per item. No item repeats the claim. The claim and the points together are 70 words or fewer.

RULES FOR THE CLAIM AND POINTS:
- Never write a raw document id, file name or node id (such as 2601.11699v4 or acc-beliefs-012). Name the source by its title or publisher, or leave the attribution out.
- Use neutral wording. Do not add intensifiers the speaker did not use (write "dismantle", not "violently dismantle").

MEDIUM (1-2 paragraphs): The main argument with key supporting evidence, in ${speaker}'s own voice. Include the steelman if present. Omit rhetorical flourishes and minor supporting points.

Respond ONLY with a JSON object (no markdown, no code fences):
{"brief": "...", "brief_claim": "...", "brief_points": ["...", "..."], "medium": "..."}`;
}

// ── Missing Arguments Pass ──────────────────────────────

/**
 * Post-synthesis prompt for a fresh LLM with no transcript context.
 * Identifies the strongest arguments that were never raised during the debate.
 */
export function missingArgumentsPrompt(
  topic: string,
  taxonomyNodesSummary: string,
  concludingText: string,
  audience?: DebateAudience,
): string {
  return `You have NOT seen the debate transcript. You receive only:
1. The debate topic
2. A summary of available positions from the taxonomy
3. The synthesis of what was actually discussed

Your job: identify 3-5 strongest arguments on ANY side that do NOT appear in the synthesis.
A "missing argument" is one that a well-prepared debater would have raised but nobody did.

TOPIC:
${topic}

AVAILABLE POSITIONS (each position belongs to one of three perspectives — accelerationist, safetyist, or skeptic — and one BDI category — Belief, Desire, or Intention):
${taxonomyNodesSummary}

CONCLUDING SUMMARY OF WHAT WAS DISCUSSED:
${concludingText}

For each missing argument:
- "argument": State the argument in 1-2 sentences, as a debater would actually make it
- "side": Which perspective this strengthens ("accelerationist", "safetyist", or "skeptic")
- "why_strong": Why this argument is compelling and hard to dismiss (1 sentence)
- "bdi_layer": "belief" (empirical claim), "desire" (normative claim), or "intention" (strategic claim)

${getReadingLevel(audience)}

Return ONLY JSON (no markdown, no code fences):
{
  "missing_arguments": [
    {
      "argument": "...",
      "side": "accelerationist or safetyist or skeptic",
      "why_strong": "...",
      "bdi_layer": "belief or desire or intention"
    }
  ]
}`;
}

/**
 * Post-debate taxonomy refinement prompt.
 * Receives the synthesis, argument map, and the actual taxonomy nodes that were
 * referenced during the debate. Produces before/after suggestions for node revisions.
 */
export function taxonomyRefinementPrompt(
  topic: string,
  concludingText: string,
  referencedNodes: { id: string; label: string; pov: string; category: string; description: string }[],
  argumentMapSummary: string,
  audience?: DebateAudience,
): string {
  const nodesBlock = referencedNodes.map(n =>
    `[${n.id}] (${n.pov}/${n.category}) ${n.label}\n  Description: "${n.description}"`
  ).join('\n\n');

  return `You are a taxonomy editor reviewing the outcome of a structured debate. Your job is to
identify taxonomy nodes whose descriptions should be revised based on what the debate revealed.

${getReadingLevel(audience)}

DEBATE TOPIC:
${topic}

CONCLUDING SUMMARY (what was argued, agreed, and disagreed):
${concludingText}

ARGUMENT MAP (claims and their relationships):
${argumentMapSummary}

TAXONOMY NODES REFERENCED IN THIS DEBATE:
${nodesBlock}

For each node above, assess whether the debate revealed that its description should change.
A node needs revision when:
- It was TOO VAGUE to defend — debaters couldn't make specific claims from it → CLARIFY (add specifics)
- It was TOO BROAD — debaters could only engage with part of it → NARROW (tighten scope)
- It was TOO NARROW — the debate surfaced valid points the node excludes → BROADEN (expand scope)
- It should be SPLIT — the debate revealed it conflates two distinct positions → SPLIT
- It was effectively REFUTED — strong counterarguments with no adequate defense → QUALIFY (add caveats) or RETIRE
- A strong position was argued that NO existing node represents → NEW_NODE

For each suggestion:
- Write the COMPLETE proposed_description, not just a diff. Follow the genus-differentia format:
  POV nodes: "A [Belief|Desire|Intention] within [POV] discourse that [differentia]. Encompasses: [what it covers]. Excludes: [boundaries]."
  New nodes should follow the same pattern.
- LABEL FORMAT BY CATEGORY:
  Desires: present participle targeting an ideal state (e.g., "Mitigating Automation Displacement", "Ensuring Algorithmic Accountability")
  Beliefs: noun phrase denoting a phenomenon, principle, or empirical claim (e.g., "Inherent Power-Seeking Behavior", "Cognitive Atrophy from AI Reliance")
  Intentions: present participle denoting strategic action or policy posture (e.g., "Mandating Algorithmic Audits", "Prioritizing Interpretability Research")
  Never start labels with "The", "A", or "An". Never include parenthetical abbreviations.
- DESCRIPTION RULES: Use domain-specific terminology — no colloquialisms. Every description must include Encompasses: and Excludes: clauses.
- The rationale must cite specific debate evidence (claims, counterarguments, concessions).
- Only suggest changes with clear debate evidence. Do NOT suggest changes based on general knowledge.
- Suggest 0 items if no changes are warranted — do not force suggestions.

Return ONLY JSON (no markdown, no code fences):
{
  "taxonomy_suggestions": [
    {
      "node_id": "acc-beliefs-003",
      "node_label": "Current label",
      "node_pov": "accelerationist",
      "suggestion_type": "clarify",
      "current_description": "The current description text (copy exactly from above)",
      "proposed_description": "The complete revised description in genus-differentia format",
      "rationale": "During the debate, [specific evidence]. This reveals that the current description...",
      "evidence_claim_ids": ["AN-5", "AN-12"]
    }
  ]
}

For new_node suggestions, omit current_description and use the node_id format of the relevant POV (e.g., "acc-beliefs-NEW", "saf-desires-NEW").`;
}
