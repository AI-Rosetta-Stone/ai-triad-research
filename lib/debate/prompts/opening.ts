// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DocumentAnalysis, DebateAudience, PovInfo, SpeakerId } from '../types.js';
import { documentAnalysisContext } from '../documentAnalysis.js';
import {
  getCharacterBlock,
  otherDebaters,
  getReadingLevel,
  getDetailInstruction,
  getStyleReinforcement,
  getPolicymakerFraming,
  formatDoctrinalBoundaries,
  gradeTargetPreamble,
} from './shared-helpers.js';
import { sourceContext, MUST_CORE_BEHAVIORS, STEELMAN_INSTRUCTION } from './shared-instructions.js';
import { NARRATIVE_CHECK_INSTRUCTION } from './narrative.js';

// ── 4-Stage opening pipeline prompts ─────────────────────────

export interface OpeningStagePromptInput {
  label: string;
  pov: string;
  personality: string;
  topic: string;
  /** User-supplied supporting context, kept separate from the topic question. */
  background?: string;
  taxonomyContext: string;
  priorStatements: string;
  isFirst: boolean;
  /** Labels of speakers who have already given their opening, in order. Used to generate a dynamic prior_steelmans example. */
  priorSpeakerLabels?: string[];
  sourceContent?: string;
  documentAnalysis?: DocumentAnalysis;
  audience?: DebateAudience;
  userSeedClaims?: { id: string; text: string; bdi_category?: string }[];
  edgeContext?: string;
  /** Moderator's narrative voicing of each camp (h3), pre-formatted by narrativeVoicingDebaterBlock. */
  narrativeVoicing?: string;
  /** Resolved soul for this speaker (t/3988). */
  soul: PovInfo;
  /** Resolved souls for the other speakers (t/3988). Keys are SpeakerId. */
  opponentSouls?: Partial<Record<SpeakerId, PovInfo>>;
  /** t/284 item 3: the literal question an inquiry opening must answer. */
  anchorQuestion?: string;
}

export function briefOpeningStagePrompt(input: OpeningStagePromptInput): string {
  const documentBlock = input.documentAnalysis
    ? documentAnalysisContext(input.documentAnalysis)
    : sourceContext(input.sourceContent);

  return `You are an analytical assistant preparing a situation brief for ${input.label}, who represents the ${input.pov} perspective on AI policy.

Your task is to analyze the debate topic and identify the strongest framing strategy for ${input.label}'s opening statement. This is pure analysis — do not write any debate statement or adopt the debater's voice.

${gradeTargetPreamble(input.audience)}${input.taxonomyContext}
${input.edgeContext ? `\n=== KNOWN CROSS-POV TENSIONS ===\n${input.edgeContext}\n` : ''}
=== DEBATE TOPIC ===
"${input.topic}"${input.background ? `\n\n=== BACKGROUND CONTEXT ===\nThe user provided the following supporting context. Use it to inform your analysis, but keep it separate from the debate question itself.\n${input.background}` : ''}${documentBlock}
${input.userSeedClaims && input.userSeedClaims.length > 0 ? `\n=== USER-STATED POSITIONS ===\nThe user framed this debate with the following positions. Factor these into your analysis.\n${input.userSeedClaims.map(c => `- [${c.id}] ${c.text}`).join('\n')}\n` : ''}${input.narrativeVoicing ? `${input.narrativeVoicing}\n` : ''}${input.priorStatements}

Analyze the topic${input.isFirst ? '' : ' and prior opening statements'} and produce a structured brief. Focus on:
1. What are the key dimensions of this topic that ${input.label}'s perspective can address?
2. What are the strongest angles ${input.label} can take? For each angle, identify which taxonomy nodes ground it.
3. What are the strongest claims ${input.label} can make from their perspective?
${input.isFirst ? '4. What framing will best establish this perspective for the audience?' : `4. What positions from prior speakers should ${input.label} acknowledge or contrast with?
5. What important dimensions of this topic have prior speakers not yet addressed? What assumptions are shared across perspectives that deserve examination?`}

For each strongest angle, assess evidence depth: what specific data, cases, or precedents ground it? Rate depth (deep/moderate/shallow). Shallow-depth angles should be narrowed to a specific claim your evidence can support, or reframed as questions the debate should explore.

GROUNDING DEPTH: Each angle and claim MUST cite 2-4 grounding nodes from the taxonomy — a primary anchor plus 1-3 supporting or contrasting nodes. Draw from different BDI categories (Beliefs for evidence, Desires for values, Intentions for strategy). A single-node grounding is too shallow — show the full argumentative structure.

GROUNDING WEIGHTS: For Belief grounding nodes, include "confidence" (0.0–1.0) from the taxonomy context. For Desire grounding nodes, include "priority" (1–5). For Intention grounding nodes, include "operationality" (1–5). These help downstream stages calibrate rhetorical strength.

SOURCE FIDELITY: Your situation_assessment must describe the debate topic as given — do not introduce concepts, framings, or policy domains that the topic and source material did not raise. If the source argues about ecosystem stability, do not reframe it as a governance debate. Characterize the actual disagreement, not a more convenient one. For every concept in your situation_assessment, cite the exact source phrase that warrants it in source_fidelity_check. If you cannot quote a source phrase for a concept, remove it from your assessment.

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "situation_assessment": "2-4 sentences: the key dimensions of the topic and what matters most for this perspective",
  "source_fidelity_check": [
    {"concept_used": "concept you reference in situation_assessment", "source_quote": "exact phrase from topic or source material that justifies it"}
  ],
  "strongest_angles": [
    {"angle": "a framing or argument line", "why": "why this is strong for the ${input.pov} perspective", "grounding": [{"node_id": "acc-beliefs-003", "label": "Node Label Here", "confidence": 0.72, "why": "primary anchor — empirical basis"}, {"node_id": "acc-desires-007", "label": "Node Label Here", "priority": 4, "why": "supporting normative commitment"}]}
  ],
  "evidence_depth": [
    {"angle": "strongest angle text", "grounding_evidence": "specific data, case, or precedent", "depth": "deep|moderate|shallow", "if_shallow": "how to narrow or reframe as an exploratory question"}
  ],
  "key_tensions": [
    {"tension": "a key tension or tradeoff in the topic", "opportunity": "how ${input.label} can use this"}
  ]${input.documentAnalysis ? `,
  "document_claims_to_engage": [
    {"d_id": "D-1", "claim": "the claim text", "stance": "accept | challenge | reframe", "why": "1 sentence: why this claim matters for ${input.pov}", "grounding": [{"node_id": "saf-beliefs-011", "label": "Node Label Here", "confidence": 0.65, "why": "primary — empirical basis for this stance"}, {"node_id": "saf-intentions-003", "label": "Node Label Here", "operationality": 4, "why": "supporting — strategic mechanism"}]}
  ]` : ''}${input.isFirst ? '' : `,
  "prior_positions_to_address": [
    {"speaker": "who", "position": "their key claim", "response_strategy": "acknowledge / contrast / challenge"}
  ]`}
}${input.isFirst ? '' : `

NOTE: Only speakers listed in the prior statements have actually spoken. Do not infer or attribute positions to other perspectives — they have not spoken yet. Your 'prior_positions_to_address' entries must reference ONLY speakers from the prior opening statements above.`}`;
}

export function planOpeningStagePrompt(input: OpeningStagePromptInput, brief: string): string {
  return `You are ${input.label}, planning the structure of your opening statement.
${getCharacterBlock(input.pov, input.soul)}
Your perspective: ${input.pov}.
${formatDoctrinalBoundaries(input.pov, input.soul)}
${gradeTargetPreamble(input.audience)}=== SITUATION BRIEF ===
${brief}

Plan your opening statement strategy. This is your first appearance — you need to:
1. Establish your core position clearly and memorably
2. Choose which 2-4 taxonomy nodes to build your argument around
3. Decide on the argumentative structure (claim + evidence + warrant for each main point)
${input.isFirst ? '4. Set the terms of debate from your perspective' : `4. Identify 1-2 specific claims from prior speakers to build on — name the claim and whether you EXTEND it (add supporting evidence), INTEGRATE it with your perspective, or use CONCEDE AND PIVOT (acknowledge its strength, then show where your evidence diverges). Strong openings advance the conversation, not just add to it. Rank your own claims by evidence depth — lead with your most grounded claim.`}

=== FIELD-AWARE STRATEGY ===
Your taxonomy nodes have epistemic_type, rhetorical_strategy, falsifiability, and assumes fields. Use them in planning:

EPISTEMIC TYPE — match argument mode to claim type:
- empirical_claim → argue with evidence
- normative_prescription → argue from coherence/values
- strategic_recommendation → challenge feasibility, cite analogous cases
- predictive → demand specific timelines and falsifiable thresholds
- definitional → use DISTINGUISH
- interpretive_lens → use REFRAME

RHETORICAL STRATEGY — plan HOW to argue based on your nodes' strategies:
- Techno_Optimism → lead with possibility. Pairs: EXTEND, REFRAME
- Precautionary_Framing → lead with stakes. Pairs: EMPIRICAL CHALLENGE, SPECIFY
- Appeal_To_Evidence → lead with data. Pairs: EMPIRICAL CHALLENGE, UNDERCUT
- Structural_Critique → lead with systems. Pairs: REFRAME, DISTINGUISH
- Moral_Imperative → lead with obligation. Pairs: COUNTEREXAMPLE, CONCEDE-AND-PIVOT
- Cost_Benefit_Analysis → lead with tradeoffs. Pairs: DISTINGUISH, SPECIFY, INTEGRATE
- Analogical_Reasoning → lead with precedent. Pairs: COUNTEREXAMPLE, EXTEND
- Inevitability_Framing → lead with trajectory. Pairs: REFRAME, EXTEND
- Pragmatic_Framing → lead with what works. Pairs: COUNTEREXAMPLE, INTEGRATE

FALSIFIABILITY — calibrate evidence demands:
- HIGH → cite concrete evidence and measurable outcomes
- MEDIUM → separate testable parts from judgment calls
- LOW → argue from coherence/values, not pseudo-empirical claims

ASSUMPTIONS — your nodes list their assumptions. Name 1-2 key assumptions your position depends on and plan how to handle challenges to them.

ANTICIPATED CHALLENGES - forecast where you are actually vulnerable, not where you are safe:
- Give the STRONGEST version of each challenge (steelman it). A challenge you can easily
  dismiss is worthless - mirror the steelman discipline you apply to opponents.
- Ground each in a specific target: a taxonomy node, a concrete claim, or a named
  assumption. Never "they'll say it's risky."
- Tag each as ATTACK (an objection an opponent will raise) or ASSUMPTION (a load-bearing
  premise of YOUR position you are exposing). These are different - give at least one of each.
- Where a node in your context shows a Vulnerability: line (its pre-computed strongest
  counterargument), GROUND your ATTACK-type challenge for that node in it — sharpen or restate
  that objection rather than inventing a weaker one. It is the strongest known attack on the
  node; anticipate it, don't dodge it.

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "strategic_goal": "1-2 sentences: what your opening should accomplish",
  "core_thesis": "1 sentence: your central claim in this debate",
  "argument_structure": [
    {"point": "main claim #1", "evidence": "what supports it", "taxonomy_anchor": "node_id to ground it"},
    {"point": "main claim #2", "evidence": "what supports it", "taxonomy_anchor": "node_id to ground it"}
  ],
  "framing_choices": [
    {"frame": "how you will frame the issue", "why": "why this framing favors your perspective"},
    {"frame": "alternative or complementary framing", "why": "what this framing reveals that the first doesn't"}
  ],
  "anticipated_challenges": ["ATTACK: <strongest specific objection an opponent will raise, naming the node/claim/assumption it targets>", "ASSUMPTION: <a load-bearing premise of your position you are exposing, and why it is contestable>"]
}`;
}

export function draftOpeningStagePrompt(input: OpeningStagePromptInput, brief: string, plan: string): string {
  const hasDocument = !!(input.documentAnalysis || input.sourceContent);

  const documentInstructions = input.documentAnalysis
    ? `\nThis debate is grounded in a pre-analyzed document. Your opening should: (1) engage with specific document claims (D-IDs) — state which you accept and which you challenge, (2) address the identified tension points from your perspective, and (3) reference D-IDs in your taxonomy_refs and my_claims targets, NOT in your prose text.\n`
    : input.sourceContent
      ? `\nSince this debate is grounded in a document, your opening should: (1) identify what you see as the document's central claim or thesis, (2) state which of its claims you accept and which you challenge, and (3) flag any assumptions or framing choices the document makes that your perspective contests.\n`
      : '';

  return `You are ${input.label}, an AI debater representing the ${input.pov} perspective on AI policy.
${getCharacterBlock(input.pov, input.soul)}
${otherDebaters(input.label, input.opponentSouls)}
${getReadingLevel(input.audience)}
${getDetailInstruction(input.audience)}
${getPolicymakerFraming(input.audience)}
OUTPUT: Respond ONLY with a JSON object (no markdown, no code fences, no preamble). Schema below.

${MUST_CORE_BEHAVIORS}

${STEELMAN_INSTRUCTION}
${formatDoctrinalBoundaries(input.pov, input.soul)}
=== SITUATION BRIEF ===
${brief}

=== YOUR ARGUMENT PLAN ===
${plan}
${input.narrativeVoicing ? `${input.narrativeVoicing}\n` : ''}
${input.userSeedClaims && input.userSeedClaims.length > 0 ? `=== USER-STATED POSITIONS ===\nThe user framed this debate with the following positions. Engage with these directly — state which you agree with, which you challenge, and why. Reference their IDs in your claim_sketches targets.\n${input.userSeedClaims.map(c => `- [${c.id}] ${c.text}`).join('\n')}\n\n` : ''}=== YOUR ASSIGNMENT ===
Deliver your opening statement as ${input.label} — stay in character. Frame the issue from your perspective and establish your core argument. Be specific, substantive, and persuasive.
${hasDocument ? documentInstructions : ''}
${input.isFirst ? 'You are delivering the first opening statement.' : `You have read the prior opening statements. Before introducing your own position, show that you understand the strongest version of each prior speaker's argument — not just acknowledge it, but articulate why it's compelling. Then identify where your evidence leads in a different direction. Name the specific tension: what would have to be true for both positions to hold? Strong openings surface the real disagreement, not just assert the opposite.

IMPORTANT: You may only attribute named positions to speakers whose openings appear in the PRIOR OPENING POSITIONS section above. If only one speaker has spoken, do not use 'they' or 'both positions' — name the specific speaker. Do not attribute positions to speakers who have not yet delivered their opening.`}

Execute the argument plan above. Write your opening statement following the plan's structure.

ADDRESS YOUR ANTICIPATED CHALLENGES: For each challenge in your plan's anticipated_challenges,
make a deliberate choice - either (a) pre-empt it in your opening (concede-and-bound it, or
plant the seed of your rebuttal so it can't land cold later), or (b) deliberately leave it
unaddressed because raising it now costs more than it saves. Do not silently ignore them.
Pre-empting your strongest anticipated objection is often the most persuasive move an opening can make.

OUTPUT CONSTRAINTS:
- NODE-ID PROHIBITION: Never surface taxonomy node IDs in statement text. Use plain language.
- CLAIM SPECIFICITY: At least one claim per paragraph must include a concrete number, named entity, date, or threshold. If source evidence is provided above, use it — cite the specific statistic, year, or finding rather than paraphrasing vaguely. Abstract claims without any specifics weaken your argument.
- CLAIM SKETCHING: For each paragraph, identify 1-3 distinct claims it makes — the paragraph's main point plus any sub-claim substantial enough to stand as its own argument. A dense paragraph with several specific claims (statistics, named precedents, conditional arguments) should yield more sketches than a paragraph with one simple point. For each, extract a near-verbatim sentence.
- TURN SYMBOLS: Choose 1-3 Unicode symbols (emoji) that capture your argument's essence. Tooltip: 1-sentence analogy connecting the symbol to your argument.
- EPISTEMIC DEPTH: Prefer narrow, evidence-grounded claims over broad assertions. A claim backed by a specific statistic, case, or precedent generates more productive engagement than a sweeping generalization. Ask: 'Does this claim invite a substantive response, or just a dismissal?' If the latter, narrow it until a thoughtful opponent would need to bring counter-evidence rather than just disagree.

PARAGRAPH STRUCTURE:
- 3-5 paragraphs separated by \\n\\n. Each develops one distinct idea.
- A single unbroken block will be rejected — structure your argument into clear, quotable sections.

${getStyleReinforcement(input.audience)}
${input.narrativeVoicing ? `${NARRATIVE_CHECK_INSTRUCTION}\n` : ''}
Respond ONLY with a JSON object matching this exact schema (no markdown, no code fences):
{
  "statement": "your opening statement (3-5 paragraphs separated by \\n\\n)",
  "turn_symbols": [
    {"symbol": "emoji", "tooltip": "1-sentence analogy"}
  ],
  "claim_sketches": [
    {"claim": "near-verbatim headline assertion from your statement", "targets": [${input.isFirst ? '' : '"AN-3"'}], "relationship": "${input.isFirst ? '' : 'extends'}"},
    {"claim": "near-verbatim supporting sub-claim or premise", "targets": [], "relationship": ""}
  ]${input.isFirst ? '' : `,
  "prior_steelmans": [
    ${(input.priorSpeakerLabels ?? ['<prior speaker>']).map(s => `{"speaker": "${s}", "steelman_claim": "one-sentence strongest version of ${s}'s position in their own terms"}`).join(',\n    ')}
  ]`}
}${input.isFirst ? '' : `

NOTE: (1) At least one claim_sketch MUST have a non-empty "targets" array referencing a prior speaker's AN node, with a support/neutral relationship. Allowed opening relationships: "extends", "integrates", "concedes_and_pivots", "specifies". (2) prior_steelmans is REQUIRED — include one entry per prior speaker. Each steelman_claim must be a single sentence capturing the strongest, most charitable version of that speaker's position in their own terms, with their evidence and reasoning — not a dismissal or paraphrase of their conclusion alone.`}`;
}

export function citeOpeningStagePrompt(
  input: OpeningStagePromptInput,
  brief: string,
  plan: string,
  draft: string,
): string {
  return `You are a grounding analyst. Your task is to annotate an opening debate statement with precise taxonomy references and policy connections.

=== SITUATION BRIEF ===
${brief}

=== ARGUMENT PLAN ===
${plan}

=== DRAFT STATEMENT ===
${draft}

=== TAXONOMY CONTEXT ===
${input.taxonomyContext}

Ground the opening statement in the taxonomy. For each connection:
1. TAXONOMY REFS: Tag 3-5 taxonomy nodes that the statement draws from. Cover at least two BDI sections. For each, explain in 1-4 sentences how the node informed the argument. Every node_id MUST appear verbatim in the TAXONOMY CONTEXT above — do not invent IDs.
2. POLICY REFS: Identify any policy actions the argument supports, opposes, or implies. For each, explain in 1-2 sentences how the argument connects to the policy.
3. GROUNDING CONFIDENCE: Rate 0-1 how well the statement is grounded in the taxonomy (1.0 = every claim traceable to a node, 0.5 = loosely connected, 0.0 = no taxonomy basis).

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "taxonomy_refs": [
    {"node_id": "<a real node_id from TAXONOMY CONTEXT>", "relevance": "1-4 sentences: how this node informed the argument"},
    {"node_id": "<a real node_id from TAXONOMY CONTEXT>", "relevance": "1-4 sentences explaining connection"},
    {"node_id": "<a real node_id from TAXONOMY CONTEXT>", "relevance": "1-4 sentences explaining connection"}
  ],
  "policy_refs": [
    {"policy_id": "pol-001", "relevance": "1-2 sentences: how the argument relates to this policy"},
    {"policy_id": "pol-012", "relevance": "1-2 sentences: how the argument relates to this policy"}
  ],
  "grounding_confidence": 0.85
}`;
}

// ── 4-Stage turn pipeline prompts ─────────────────────────

export function _buildMoveHistoryBlock(priorMoves?: string[], turnsSinceLastConcession?: number): string {
  if (!priorMoves || priorMoves.length === 0) return '';
  const recentConcedes = priorMoves.filter(m => m.includes('CONCEDE')).length;
  let concessionDirective: string;
  if (recentConcedes >= 2) {
    concessionDirective = 'You have conceded frequently. DO NOT open with a concession this turn — lead with a different move.';
  } else if (turnsSinceLastConcession != null && turnsSinceLastConcession >= 3) {
    concessionDirective = `You last conceded ${turnsSinceLastConcession} turns ago — consider whether a genuine concession is warranted here, especially if an opponent has made a strong point you haven't addressed.`;
  } else if (turnsSinceLastConcession != null && turnsSinceLastConcession === 0) {
    concessionDirective = 'You conceded last turn. Lead with a different move this turn.';
  } else {
    concessionDirective = 'Vary your approach from your recent pattern.';
  }
  return `\n=== YOUR RECENT MOVES ===\nYour last ${priorMoves.length} responses used: ${priorMoves.join(' → ')}.\n${concessionDirective}\n`;
}

