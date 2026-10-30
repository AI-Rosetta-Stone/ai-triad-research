// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Prompts for incremental argument network extraction.
 * Called after each debater's turn to extract claims and relationships.
 */

import { MOVE_EDGE_MAP } from '../helpers.js';
import { POVER_INFO, type SpeakerId } from '../types.js';
import { effectiveCamp } from './utils.js';
import { normalizeVerdict } from '../types/factVerdict.js';

const SUPPORT_SCHEMES = Object.entries(MOVE_EDGE_MAP)
  .filter(([, v]) => v.edgeType === 'support')
  .map(([k]) => k)
  .join(', ');

const ATTACK_SCHEMES = Object.entries(MOVE_EDGE_MAP)
  .filter(([, v]) => v.edgeType === 'attack')
  .map(([k]) => k)
  .join(', ');

const DOMAIN_VOCABULARY = `
PREFERRED DOMAIN TERMINOLOGY — use these standardized terms when the claim expresses the same concept:
- "AI alignment" — ensuring AI systems pursue intended objectives (not "making AI do what we want")
- "alignment tax" — performance cost imposed by safety constraints (not "safety overhead")
- "instrumental convergence" — tendency of agents to pursue convergent sub-goals (not "AI pursuing sub-goals")
- "capability overhang" — gap between developed and deployed capability (not "latent potential")
- "mesa-optimization" — learned sub-objectives that diverge from training objective (not "inner optimizer")
- "compute governance" — regulatory control over computational resources (not "chip controls")
- "existential risk" — risk of human extinction or permanent civilizational collapse
- "recursive self-improvement" — AI system iteratively improving its own capabilities
- "corrigibility" — property of an AI system that accepts human correction
- "scalable oversight" — maintaining effective human supervision as AI capability scales
- "differential technology development" — prioritizing safety capabilities over dangerous capabilities
- "regulatory capture" — regulated entities controlling their own regulatory framework
- "agentic AI" — AI systems that autonomously pursue goals over extended periods
- "algorithmic accountability" — obligation to explain and justify algorithmic decisions
- "dual-use" — technology with both beneficial and harmful applications
- "red-teaming" — adversarial testing to identify system vulnerabilities
- "deployment guardrails" — constraints on AI system behavior in production
- "formal verification" — mathematical proof that a system meets its specification
- "pre-deployment verification" — testing and validation before releasing an AI system
- "frontier models" — the most capable AI models at the boundary of current technology
- "deceptive alignment" — AI system appearing aligned during training while pursuing different objectives
- "systemic risk" — risk of cascading failures across interconnected systems
- "human-in-the-loop" — requiring human oversight at decision points in automated systems
- "catastrophic failure" — failure mode with severe, potentially irreversible consequences
- "safety-washing" — superficial safety claims used to deflect genuine accountability
- "regulatory sandboxes" — controlled environments for testing innovation under regulatory oversight
- "liability regime" — legal framework assigning responsibility for AI-caused harms
- "strict liability" — legal liability without requiring proof of fault or negligence
- "moat" / "barrier to entry" — competitive advantages that prevent new market participants
- "race to the bottom" — competitive dynamic where safety standards decrease to reduce costs
- "performative compliance" — appearing to meet requirements without genuine implementation
- "lock-in effects" — mechanisms that prevent switching away from a technology or vendor
- "human agency" — the capacity for humans to make autonomous decisions in AI-mediated contexts
- "adversarial robustness" — resilience of AI systems against deliberately crafted malicious inputs
- "capability elicitation" — methods for discovering and measuring what an AI system can do
These are advisory — use the debater's exact phrasing when it's already precise.
`;

export interface PriorClaim {
  id: string;
  text: string;
  speaker: string;
}

export function extractClaimsPrompt(
  statement: string,
  speaker: string,
  priorClaims: PriorClaim[],
  audience?: string,
  topic?: string,
  // isOpeningPhase defaults to false — steelman framing is only meaningful in opening statements (t/3765).
  isOpeningPhase = false,
): string {
  const priorBlock = priorClaims.length > 0
    ? priorClaims.map(c => `  ${c.id} (${c.speaker}): ${c.text}`).join('\n')
    : '  (none yet — this is the first statement)';

  const topicBlock = topic
    ? `\nDEBATE TOPIC:\n"${topic}"\n\nTOPIC RELEVANCE: When classifying claims, evaluate whether each claim's examples, analogies, and evidence are proportionate to the topic's stated scope. If the topic specifies a risk level, domain, or product type, flag claims whose examples come from a materially different risk/domain category. Set "topic_relevance" to "on_topic" when the claim directly engages the stated scope, "adjacent" when it's related but requires inferential steps to connect, or "off_topic" when the claim's framing or examples contradict explicit topic constraints (e.g., citing catastrophic infrastructure failures for a low-risk consumer product).\n`
    : '';

  return `Extract the key claims from this debate statement and map their relationships to prior claims.
${topicBlock}
STATEMENT by ${speaker}:
"${statement}"

PRIOR CLAIMS IN THIS DEBATE:
${priorBlock}

For each distinct claim in the statement:
1. Extract the claim as a near-verbatim sentence from the statement
2. If it responds to a prior claim, classify the relationship:
   - "supports" with a warrant (WHY it supports — the reasoning pattern).
     Use "supports" for concession moves: when the speaker grants, agrees with, or accepts an opponent's claim. Schemes for support: ${SUPPORT_SCHEMES}.
   - "attacks" with attack_type ("rebut" = contradicts conclusion, "undercut" = denies the inference, "undermine" = attacks premise credibility) and scheme (${ATTACK_SCHEMES})
   NOTE: A CONCEDE-AND-PIVOT move often produces TWO edges — a "supports" edge for the conceded portion and an "attacks" edge for the pivot. Include both in responds_to.
   - "strength": classify the engagement strength as ONE of:
     "decisive" — directly rebuts/supports with specific evidence or logical entailment
     "substantial" — clear engagement with some evidence or reasoning
     "tangential" — loosely related, weak or indirect connection
     Do NOT output numeric weights. Use ONLY these three categories.
   - "argumentation_scheme": classify the reasoning pattern being used. Pick ONE:
     ARGUMENT_FROM_EVIDENCE — supported by specific data or measurements
     ARGUMENT_FROM_EXPERT_OPINION — supported by expert testimony or institutional authority
     ARGUMENT_FROM_PRECEDENT — supported by a historical case or legal precedent
     ARGUMENT_FROM_CONSEQUENCES — based on predicted outcomes of an action
     ARGUMENT_FROM_ANALOGY — draws a parallel to another domain
     PRACTICAL_REASONING — advocates an action as means to a stated goal
     ARGUMENT_FROM_DEFINITION — depends on how a key term is defined
     ARGUMENT_FROM_VALUES — grounded in an explicit value or ethical principle
     ARGUMENT_FROM_FAIRNESS — appeals to equal treatment or proportionality
     ARGUMENT_FROM_IGNORANCE — derives conclusion from absence of evidence
     SLIPPERY_SLOPE — claims a small action leads to extreme outcomes through a chain
     ARGUMENT_FROM_RISK — advocates caution based on magnitude of potential harm
     ARGUMENT_FROM_METAPHOR — uses a metaphor or figurative frame to structure reasoning about the target domain (e.g., "AI development is a race", "regulation is red tape", "alignment is taming a genie")
     OTHER — if none fit (include brief description)
3. If it's a new standalone claim, responds_to should be an empty array

Extract 3-6 claims. Each claim must be traceable to text actually in the statement. Do NOT invent claims. Prefer more rather than fewer — include secondary and supporting claims, not just the headline assertion.

For each claim, also classify:
- "extraction_confidence": how faithfully this claim captures what the speaker actually said (0-1):
  0.9-1.0: near-verbatim sentence from the statement
  0.7-0.89: faithful compression, core meaning preserved
  0.5-0.69: implicit premise or reading between the lines
  Below 0.5: do not include — you are editorializing beyond the statement
- "bdi_category": "belief" (empirical/factual claim), "desire" (normative/value claim), or "intention" (strategic/methodological claim)
  PRECEDENCE RULE when surface cues conflict:
    1. If the span specifies a METHOD or MECHANISM → "intention" (regardless of "should"/"must")
    2. If the span states a desired end-state WITHOUT mechanism → "desire"
    3. If the span makes an empirical claim (true/false evaluable) → "belief"
- "canonical_proposition": Rewrite the claim as a single formal sentence (≤30 words) stripped of debate rhetoric, hedging, and informal language. Match modal register to BDI type:
  Beliefs: indicative ("X is/causes Y")
  Desires: deontic ("X ought to be the case")
  Intentions: instrumental ("Achieve X by means of Y")
  SELF-CONTAINED: a reader who never saw the debate must understand the sentence on its own.
    1. Nothing may point outside the sentence: no "it", "they", "this policy", "the speaker", "the proposal", or a POV camp's own name used as the claim's subject ("Accelerationists believe...", "Safetyists counter that...", "Skeptics argue..."). State the position itself, not which camp holds it — the camp is already recorded elsewhere on the claim.
    2. Replace a name a debater coined mid-debate with what it is, using only what the debate itself says it is; never add detail the debate does not give: "the attestation" -> "a mandatory data-processing attestation" (when the debate has said so), "the two-year verification test" -> "a two-year test comparing sampled data-practice attestations against actual practice".
    3. Every date carries a year: "by 15 December 2025", never "by Dec. 15".
  Use controlled vocabulary terms where applicable. This field is used for taxonomy matching — precision matters.
- "attribution_text": Rewrite this claim mirroring taxonomy node description format:
  "A [Belief|Desire|Intention] within [POV] discourse that [differentia]. Encompasses: [2-3 specific concepts from the claim]."
  Rules:
  1. Use BDI modal form (beliefs=indicative, desires=deontic, intentions=instrumental)
  2. Replace colloquial phrasing with domain vocabulary (see PREFERRED DOMAIN TERMINOLOGY above)
  3. Be specific — name concrete mechanisms, not broad categories
  4. Resolve pronouns, decode metaphors, name the policy domain
  5. 40-80 words. Do not add claims not in the original.
- "base_strength": FOR BELIEF CLAIMS ONLY. Classify the evidential grounding as ONE of:
  "grounded" — cites specific data, named sources, dates, or directly verifiable facts
  "reasoned" — logical argument with internal coherence but no specific evidence
  "asserted" — claim stated without supporting reasoning or evidence
  Do NOT output numeric scores. Use ONLY these three categories.
  For desire and intention claims: OMIT base_strength entirely — use bdi_sub_scores instead.
- "bdi_sub_scores": for each criterion, answer "yes", "partial", or "no":
  For belief claims: OMIT bdi_sub_scores — use "belief_verification" instead (see below)
  For desire claims: {"values_grounding": "yes/partial/no", "tradeoff_acknowledgment": "yes/partial/no", "precedent_citation": "yes/partial/no"}
  For intention claims: {"mechanism_specificity": "yes/partial/no", "scope_bounding": "yes/partial/no", "failure_mode_addressing": "yes/partial/no"}
- "belief_verification": REQUIRED for belief claims ONLY. Answer each sub-step:
  {"evidence_cited": "what specific evidence does this claim cite (1 sentence, or 'none')",
   "source_located": "found" (evidence traceable to the source document) | "not_found" (claim cites evidence not in the source) | "no_source" (claim cites no specific evidence),
   "evidence_supports": "strongly" (evidence directly entails the claim) | "partially" (evidence is relevant but doesn't fully support) | "weakly" (loose connection) | "contradicts" (evidence works against the claim),
   "counter_evidence": "none" (no contradicting info in the source) | "minor" (some tension but not decisive) | "significant" (source contains strong counter-evidence),
   "ambiguity_resolved": "none" (the source makes a clear, unambiguous claim) | "acknowledged" (the source hedges or presents multiple readings, and this extraction preserves that uncertainty) | "collapsed" (the source hedges or presents multiple readings, but this extraction picks one and states it as settled)}
- "specificity": "precise" (contains specific numbers, dates, named entities, or directly verifiable facts), "general" (broad empirical claim without specific verifiable details), or "abstract" (theoretical/normative, not empirically testable)
${isOpeningPhase
  ? `- "steelman_of": null normally. Set to the opponent's camp id — exactly one of "accelerationist", "safetyist", "skeptic" — ONLY when this claim deliberately presents the STRONGEST version of that opponent's position, in terms its advocates would accept, before critiquing it. A steelman restates someone else's argument charitably. A claim that rebuts, dismisses, or concedes to the opponent is NOT a steelman, even when it names their position (e.g. "X's objection is baseless" is a rebuttal, not a steelman of X). Never use a claim id, document id, or the speaker's own camp.`
  : `- "steelman_of": ALWAYS null. Steelman framing is only valid in opening statements, not in cross-respond turns.`}
${topic ? `- "topic_relevance": "on_topic" (directly engages the stated scope), "adjacent" (related but requires inference to connect), or "off_topic" (examples or framing contradict explicit topic constraints)
` : ''}${audience === 'policymakers' ? `
- "political_salience": classify each claim's relevance to political decision-making:
  "high" = Names a specific bill, agency, budget line, executive order, identifiable constituency, or references a specific court ruling or legal standard (e.g., Chevron deference, Section 230, strict liability standard). The claim could appear in a committee hearing or regulatory comment letter.
  "medium" = Relevant to governance but requires translation to connect to a pending decision. Discusses institutional structures, regulatory frameworks, or enforcement in general terms.
  "low" = Technically important but requires multiple inferential steps to connect to any pending political decision.
` : ''}
${DOMAIN_VOCABULARY}
Return ONLY a JSON object with a single key "claims" containing an array of claim objects. No markdown fences, no explanation. The EXACT structure must be:
{"claims": [<claim1>, <claim2>, ...]}

Example claim shapes (each goes inside the "claims" array):

Example 1 — Belief claim (includes base_strength, belief_verification; no bdi_sub_scores):
{"text": "...", "canonical_proposition": "X causes Y under condition Z", "attribution_text": "A Belief within accelerationist discourse that recursive self-improvement in frontier models produces capability overhang exceeding current scalable oversight methods. Encompasses: recursive self-improvement dynamics, capability overhang measurement, oversight scaling limitations.", "extraction_confidence": 0.92, "bdi_category": "belief", "base_strength": "grounded", "belief_verification": {"evidence_cited": "...", "source_located": "found", "evidence_supports": "strongly", "counter_evidence": "none", "ambiguity_resolved": "none"}, "specificity": "precise", "steelman_of": null, "responds_to": [...]${topic ? ', "topic_relevance": "on_topic"' : ''}${audience === 'policymakers' ? ', "political_salience": "high"' : ''}}

Example 2 — Desire claim (includes bdi_sub_scores; NO base_strength):
{"text": "...", "canonical_proposition": "Regulators ought to require X for Y", "attribution_text": "A Desire within safetyist discourse that regulatory sandboxes ought to mandate pre-deployment verification for all frontier models before commercial release. Encompasses: regulatory sandbox frameworks, pre-deployment verification requirements, frontier model governance.", "extraction_confidence": 0.85, "bdi_category": "desire", "bdi_sub_scores": {"values_grounding": "yes", "tradeoff_acknowledgment": "partial", "precedent_citation": "no"}, "specificity": "abstract", "steelman_of": null, "responds_to": [...]${topic ? ', "topic_relevance": "adjacent"' : ''}${audience === 'policymakers' ? ', "political_salience": "medium"' : ''}}

Full example response:
{"claims": [{"text": "near-verbatim claim from the statement", "responds_to": [{"prior_claim_id": "AN-1", "relationship": "supports or attacks", "attack_type": "rebut or undercut or undermine (only if attacks)", "strength": "decisive or substantial or tangential", "scheme": "one of: DISTINGUISH, COUNTEREXAMPLE, CONCEDE-AND-PIVOT, REFRAME, EMPIRICAL CHALLENGE, EXTEND, UNDERCUT, SPECIFY, INTEGRATE, BURDEN-SHIFT", "argumentation_scheme": "ARGUMENT_FROM_EVIDENCE", "warrant": "1 sentence: WHY this claim relates to the prior claim"}]}]}`;
}

/**
 * Hybrid approach: the debater supplies claim sketches (my_claims) with
 * the claims it intended to make and which prior claims they target.
 * This lighter prompt validates those claims and classifies the relationship
 * types (supports/attacks, attack_type, scheme, warrant) — the debater
 * identified WHAT it's arguing, and this analyst classifies HOW.
 */
export function classifyClaimsPrompt(
  statement: string,
  speaker: string,
  debaterClaims: { claim: string; targets: string[]; steelman_of?: string }[],
  priorClaims: PriorClaim[],
  audience?: string,
  // allowSteelman defaults to true for backward compatibility.
  // Pass false on non-opening turns — steelman framing is only meaningful in opening statements (t/3759).
  allowSteelman = true,
): string {
  const priorBlock = priorClaims.length > 0
    ? priorClaims.map(c => `  ${c.id} (${c.speaker}): ${c.text}`).join('\n')
    : '  (none yet)';

  const claimsBlock = debaterClaims
    .map((c, i) => `  [${i + 1}] "${c.claim}"${c.targets.length > 0 ? ` → targets: ${c.targets.join(', ')}` : ' (standalone)'}${allowSteelman && c.steelman_of ? ` [STEELMAN of ${c.steelman_of} — set steelman_of: "${c.steelman_of}"]` : ''}`)
    .join('\n');

  return `The debater ${speaker} made the following statement and identified their key claims.
Your job is to CLASSIFY the relationship between each claim and its targets. Do NOT invent
new claims — work only with the claims the debater provided.

STATEMENT by ${speaker}:
"${statement}"

CLAIMS IDENTIFIED BY THE DEBATER:
${claimsBlock}

PRIOR CLAIMS IN THIS DEBATE:
${priorBlock}

For each claim:
1. Verify the claim text appears near-verbatim in the statement (if not, flag it)
2. For each target, classify the relationship:
   - "supports" with a warrant (WHY it supports — the reasoning pattern).
     Use "supports" for concession moves: when the speaker grants, agrees with, or accepts
     an opponent's claim. Schemes for support: ${SUPPORT_SCHEMES}.
   - "attacks" with attack_type ("rebut" = contradicts conclusion, "undercut" = denies the
     inference, "undermine" = attacks premise credibility) and scheme (${ATTACK_SCHEMES})
   NOTE: A CONCEDE-AND-PIVOT move often produces TWO edges — a "supports" edge for the
   conceded portion and an "attacks" edge for the pivot. Include both in responds_to.
   - "strength": classify the engagement strength as ONE of:
     "decisive" — directly rebuts/supports with specific evidence or logical entailment
     "substantial" — clear engagement with some evidence or reasoning
     "tangential" — loosely related, weak or indirect connection
     Do NOT output numeric weights. Use ONLY these three categories.
   - "argumentation_scheme": classify the reasoning pattern (ARGUMENT_FROM_EVIDENCE,
     ARGUMENT_FROM_EXPERT_OPINION, ARGUMENT_FROM_PRECEDENT, ARGUMENT_FROM_CONSEQUENCES,
     ARGUMENT_FROM_ANALOGY, PRACTICAL_REASONING, ARGUMENT_FROM_DEFINITION, ARGUMENT_FROM_VALUES,
     ARGUMENT_FROM_FAIRNESS, ARGUMENT_FROM_IGNORANCE, SLIPPERY_SLOPE, ARGUMENT_FROM_RISK, OTHER)
3. If the debater listed no targets but you see an obvious relationship to a prior claim,
   you may add it — but prefer the debater's own assessment.

Also classify each claim:
- "bdi_category": "belief" (empirical/factual), "desire" (normative/value), or "intention" (strategic/methodological)
- "base_strength": FOR BELIEF CLAIMS ONLY. Classify the evidential grounding as ONE of:
  "grounded" — cites specific data, named sources, dates, or directly verifiable facts
  "reasoned" — logical argument with internal coherence but no specific evidence
  "asserted" — claim stated without supporting reasoning or evidence
  Do NOT output numeric scores. Use ONLY these three categories.
  For desire and intention claims: OMIT base_strength entirely — use bdi_sub_scores instead.
- "bdi_sub_scores": for each criterion, answer "yes", "partial", or "no":
  For belief claims: OMIT bdi_sub_scores — use "belief_verification" instead (see below)
  desire: {"values_grounding": "yes/partial/no", "tradeoff_acknowledgment": "yes/partial/no", "precedent_citation": "yes/partial/no"}
  intention: {"mechanism_specificity": "yes/partial/no", "scope_bounding": "yes/partial/no", "failure_mode_addressing": "yes/partial/no"}
- "belief_verification": REQUIRED for belief claims ONLY. Answer each sub-step:
  {"evidence_cited": "what evidence this claim cites (1 sentence, or 'none')",
   "source_located": "found" | "not_found" | "no_source",
   "evidence_supports": "strongly" | "partially" | "weakly" | "contradicts",
   "counter_evidence": "none" | "minor" | "significant",
   "ambiguity_resolved": "none" | "acknowledged" | "collapsed"}
- "attribution_text": Rewrite this claim mirroring taxonomy node description format:
  "A [Belief|Desire|Intention] within [POV] discourse that [differentia]. Encompasses: [2-3 specific concepts from the claim]."
  Rules:
  1. Use BDI modal form (beliefs=indicative, desires=deontic, intentions=instrumental)
  2. Replace colloquial phrasing with domain vocabulary (see PREFERRED DOMAIN TERMINOLOGY below)
  3. Be specific — name concrete mechanisms, not broad categories
  4. Resolve pronouns, decode metaphors, name the policy domain
  5. 40-80 words. Do not add claims not in the original.
- "extraction_confidence": how faithfully this claim captures what the speaker actually said (0-1):
  0.9-1.0: near-verbatim sentence from the statement
  0.7-0.89: faithful compression, core meaning preserved
  0.5-0.69: implicit premise or reading between the lines
  Below 0.5: do not include — you are editorializing beyond the statement
- "specificity": "precise" (specific numbers, dates, named entities), "general" (broad empirical), or "abstract" (theoretical/normative)
${allowSteelman
  ? `- "steelman_of": null normally. Set to the opponent's camp id ("accelerationist", "safetyist", or "skeptic") ONLY when this claim deliberately presents the strongest version of that opponent's position in terms its advocates would accept. A rebuttal, dismissal, or concession is NOT a steelman. IMPORTANT: a claim may have BOTH "responds_to" populated AND "steelman_of" set — when the debater charitably restates a prior speaker's position (in terms that speaker would accept) before diverging from it, set "steelman_of" to that speaker's camp even if "responds_to" is also populated with an edge to that speaker's node.`
  : `- "steelman_of": ALWAYS null. Steelman framing is only valid in opening statements, not in cross-respond turns.`}
${audience === 'policymakers' ? `
- "political_salience": classify each claim's relevance to political decision-making:
  "high" = Names a specific bill, agency, budget line, executive order, identifiable constituency, or references a specific court ruling or legal standard (e.g., Chevron deference, Section 230, strict liability standard). The claim could appear in a committee hearing or regulatory comment letter.
  "medium" = Relevant to governance but requires translation to connect to a pending decision. Discusses institutional structures, regulatory frameworks, or enforcement in general terms.
  "low" = Technically important but requires multiple inferential steps to connect to any pending political decision.
` : ''}
${DOMAIN_VOCABULARY}
Return ONLY a JSON object with a single key "claims" containing an array of claim objects. No markdown fences, no explanation. The EXACT structure must be:
{"claims": [<claim1>, <claim2>, ...]}

Example claim shapes (each goes inside the "claims" array):

Example 1 — Belief claim (includes base_strength, belief_verification; no bdi_sub_scores):
{"text": "...", "attribution_text": "A Belief within accelerationist discourse that recursive self-improvement in frontier models produces capability overhang exceeding current scalable oversight methods. Encompasses: recursive self-improvement dynamics, capability overhang measurement, oversight scaling limitations.", "extraction_confidence": 0.92, "bdi_category": "belief", "base_strength": "grounded", "belief_verification": {"evidence_cited": "...", "source_located": "found", "evidence_supports": "strongly", "counter_evidence": "none", "ambiguity_resolved": "none"}, "specificity": "precise", "steelman_of": null, "responds_to": [...]${audience === 'policymakers' ? ', "political_salience": "high"' : ''}}

Example 2 — Intention claim (includes bdi_sub_scores; NO base_strength):
{"text": "...", "attribution_text": "An Intention within skeptic discourse that regulatory sandboxes should implement formal verification of frontier model behavior before permitting broader deployment. Encompasses: regulatory sandbox design, formal verification methodology, staged deployment protocols.", "extraction_confidence": 0.85, "bdi_category": "intention", "bdi_sub_scores": {"mechanism_specificity": "yes", "scope_bounding": "partial", "failure_mode_addressing": "no"}, "specificity": "general", "steelman_of": null, "responds_to": [...]${audience === 'policymakers' ? ', "political_salience": "low"' : ''}}

Full example response:
{"claims": [{"text": "the debater's claim text (unchanged)", "responds_to": [{"prior_claim_id": "AN-1", "relationship": "supports or attacks", "attack_type": "rebut or undercut or undermine (only if attacks)", "strength": "decisive or substantial or tangential", "scheme": "one of: DISTINGUISH, COUNTEREXAMPLE, CONCEDE-AND-PIVOT, REFRAME, EMPIRICAL CHALLENGE, EXTEND, UNDERCUT, SPECIFY, INTEGRATE, BURDEN-SHIFT", "argumentation_scheme": "ARGUMENT_FROM_EVIDENCE", "warrant": "1 sentence: WHY this claim relates to the prior claim"}]}]}`;
}

/** Format the argument network for injection into moderator prompts */
export function formatArgumentNetworkContext(
  nodes: { id: string; text: string; speaker: string }[],
  edges: { source: string; target: string; type: string; attack_type?: string; scheme?: string; argumentation_scheme?: string; warrant?: string }[],
): string {
  if (nodes.length === 0) return '';

  const lines = ['', '=== ARGUMENT NETWORK (claims made so far) ==='];

  // Build adjacency for display
  const attacksOn = new Map<string, { source: string; type: string; scheme?: string; argumentation_scheme?: string; warrant?: string }[]>();
  for (const e of edges) {
    if (e.type === 'attacks') {
      const list = attacksOn.get(e.target) || [];
      list.push({ source: e.source, type: e.attack_type || 'rebut', scheme: e.scheme, argumentation_scheme: e.argumentation_scheme, warrant: e.warrant });
      attacksOn.set(e.target, list);
    }
  }

  for (const n of nodes) {
    const attacks = attacksOn.get(n.id) || [];
    const attackSuffix = attacks.length > 0
      ? ` [attacked ${attacks.length}x]`
      : ' [unaddressed]';
    lines.push(`${n.id} (${n.speaker}): "${n.text}"${attacks.length > 0 || edges.some(e => e.source === n.id) ? '' : attackSuffix}`);
    for (const a of attacks) {
      const schemeInfo = a.argumentation_scheme ? ` [${a.argumentation_scheme}]` : '';
      lines.push(`  <- ${a.source} ${a.type}${a.scheme ? ` via ${a.scheme}` : ''}${schemeInfo}${a.warrant ? ` — ${a.warrant}` : ''}`);
    }
  }

  // Identify unaddressed claims (no attacks, not supporting anything)
  const responded = new Set(edges.map(e => e.target));
  const responding = new Set(edges.map(e => e.source));
  const unaddressed = nodes.filter(n => !responded.has(n.id) && !responding.has(n.id));
  if (unaddressed.length > 0) {
    lines.push('');
    lines.push(`Unaddressed claims: ${unaddressed.map(n => n.id).join(', ')}`);
  }

  return lines.join('\n');
}

/** t/4644: appends the attributed node's synthetic-statement grounding line, if available.
 *  Extracted out of formatEstablishedPoints/formatConcessionCandidatesHint to keep the branch
 *  out of their already-high complexity. */
export function appendGroundingLine(
  lines: string[],
  primaryRef: string | undefined,
  embedding: number[] | undefined,
  groundingLookup: ((nodeId: string, claimEmbedding: number[] | undefined) => string | undefined) | undefined,
): void {
  if (!primaryRef || !groundingLookup) return;
  const grounding = groundingLookup(primaryRef, embedding);
  if (grounding) lines.push(`  Taxonomy grounding [${primaryRef}]: "${grounding}"`);
}

/** Format claims from other debaters, prioritized by response-relevance.
 *  Tier 1: Claims that respond to this agent's prior claims.
 *  Tier 2: Unaddressed claims targeting this agent.
 *  Tier 3: Recency (fallback). */
export function formatEstablishedPoints(
  allNodes: { id: string; text: string; speaker: string; steelman_of?: string; verification_status?: string; verification_evidence?: string; embedding?: number[]; claim_taxonomy_attribution?: { primary_ref?: string } }[],
  currentSpeaker: string,
  maxPoints: number = 10,
  edges?: { source: string; target: string; type: 'supports' | 'attacks' }[],
  /** t/4644: looks up the attributed node's best-matching synthetic statement for a claim. */
  groundingLookup?: (nodeId: string, claimEmbedding: number[] | undefined) => string | undefined,
): string {
  if (allNodes.length === 0) return '';

  const otherClaims = allNodes.filter(n => effectiveCamp(n) !== currentSpeaker);
  const ownSteelmans = allNodes.filter(n => effectiveCamp(n) === currentSpeaker && n.steelman_of != null);
  if (otherClaims.length === 0 && ownSteelmans.length === 0) return '';

  // Identify this speaker's claim IDs
  const myClaims = new Set(allNodes.filter(n => effectiveCamp(n) === currentSpeaker).map(n => n.id));
  const otherIds = new Set(otherClaims.map(n => n.id));

  // Tier 1: Claims that directly respond to my claims (via edges)
  const tier1 = new Set<string>();
  // Tier 2: Claims targeting me that I haven't responded to
  const tier2 = new Set<string>();

  if (edges && edges.length > 0) {
    // Claims from others that target my claims
    for (const e of edges) {
      if (otherIds.has(e.source) && myClaims.has(e.target)) {
        tier1.add(e.source);
      }
    }

    // Claims targeting me that I haven't addressed (no edge from my claims to theirs)
    const myTargets = new Set(edges.filter(e => myClaims.has(e.source)).map(e => e.target));
    for (const id of tier1) {
      // Already in tier 1 — skip
    }
    for (const c of otherClaims) {
      if (!tier1.has(c.id) && !myTargets.has(c.id)) {
        // Check if this claim targets any of my claims
        const targetsMe = edges.some(e => e.source === c.id && myClaims.has(e.target));
        if (targetsMe) tier2.add(c.id);
      }
    }
  }

  // Build prioritized list
  const result: { id: string; text: string; speaker: string; steelman_of?: string; verification_status?: string; verification_evidence?: string; embedding?: number[]; claim_taxonomy_attribution?: { primary_ref?: string }; tag: string }[] = [];

  for (const c of otherClaims) {
    if (tier1.has(c.id)) {
      result.push({ ...c, tag: '[RESPONDS TO YOUR CLAIM]' });
    }
  }
  for (const c of otherClaims) {
    if (tier2.has(c.id)) {
      result.push({ ...c, tag: '[UNADDRESSED — TARGETING YOU]' });
    }
  }
  // Tier 3: remaining by recency
  for (const c of otherClaims.slice().reverse()) {
    if (!tier1.has(c.id) && !tier2.has(c.id) && result.length < maxPoints) {
      result.push({ ...c, tag: '' });
    }
  }

  const capped = result.slice(0, maxPoints);

  const lines: string[] = [];

  // Gift section — own-camp steelmans, rendered first (primacy)
  if (ownSteelmans.length > 0) {
    lines.push(
      '',
      '=== YOUR POSITION, AS CHARITABLY RESTATED BY ANOTHER DEBATER ===',
      'Another debater has stated your camp\'s position in its strongest form. Treat it as a shared reference point and YOUR foundation — not an opponent\'s claim.',
      '- If it represents you well: BUILD on it — adopt as common ground and advance, sharpen it, or add the evidence it lacks.',
      '- If it subtly misframes or weakens your position: CORRECT the misframing and state the stronger version.',
      '- Do NOT attack it as an opponent claim, and do NOT simply restate it.',
    );
    for (const c of ownSteelmans) {
      const campLabel = `Charitable restatement of the ${POVER_INFO[c.steelman_of as Exclude<SpeakerId, 'user'>]?.label ?? c.steelman_of} position, authored by ${POVER_INFO[c.speaker as Exclude<SpeakerId, 'user'>]?.label ?? c.speaker}`;
      lines.push(`- ${c.id} (${campLabel}): ${c.text}`);
    }
  }

  if (capped.length > 0) {
    const hasFactChecked = capped.some(c => {
      const v = c.verification_status ? normalizeVerdict(c.verification_status) : undefined;
      return v === 'false' || v === 'disputed';
    });
    lines.push(
      '',
      '=== POINTS ALREADY ESTABLISHED BY OTHER DEBATERS ===',
      'These points have already been made. Do NOT restate them in your own words.',
      'If you agree, say so briefly ("as [name] noted") and move to what you can ADD.',
      'If you disagree, attack the specific claim rather than restating it.',
    );
    if (hasFactChecked) {
      lines.push(
        'Some points carry a fact-check tag. A point tagged [FACT-CHECKED FALSE] was checked against sources and found false — do NOT assert it as true or build on it; if it matters, note only that it was fact-checked false. A point tagged [FACT-CHECKED DISPUTED] has conflicting authoritative sources — you may engage it, but present it as contested, never as settled fact.',
      );
    }
    for (const c of capped) {
      const tag = c.tag ? ` ${c.tag}` : '';
      const campLabel = c.steelman_of
        ? `Charitable restatement of the ${POVER_INFO[c.steelman_of as Exclude<SpeakerId, 'user'>]?.label ?? c.steelman_of} position, authored by ${POVER_INFO[c.speaker as Exclude<SpeakerId, 'user'>]?.label ?? c.speaker}`
        : (POVER_INFO[c.speaker as Exclude<SpeakerId, 'user'>]?.label ?? c.speaker);
      const normalized = c.verification_status ? normalizeVerdict(c.verification_status) : undefined;
      let factTag = '';
      if (normalized === 'false' || normalized === 'disputed') {
        const raw = (c.verification_evidence ?? '').replace(/\s+/g, ' ').trim();
        const ev = raw ? ` — ${raw.length > 120 ? raw.slice(0, 119).trimEnd() + '…' : raw}` : '';
        factTag = normalized === 'false' ? ` [FACT-CHECKED FALSE${ev}]` : ` [FACT-CHECKED DISPUTED${ev}]`;
      }
      lines.push(`- ${c.id} (${campLabel}):${tag}${factTag} ${c.text}`);
      appendGroundingLine(lines, c.claim_taxonomy_attribution?.primary_ref, c.embedding, groundingLookup);
    }
  }

  return lines.join('\n') + '\n';
}

/** Format commitments and prior claims for injection into debater prompts */
export function formatCommitments(
  commitments: { asserted: string[]; conceded: string[]; challenged: string[] },
  priorClaims?: { text: string }[],
): string {
  const lines: string[] = [];

  if (commitments.asserted.length > 0 || (priorClaims && priorClaims.length > 0)) {
    lines.push('POINTS YOU HAVE ALREADY MADE (do NOT repeat these — build on them or make NEW arguments):');
    // Use AN claims if available (more precise), fall back to commitment assertions
    const claims = priorClaims && priorClaims.length > 0
      ? priorClaims.map(c => c.text)
      : commitments.asserted;
    for (const a of claims.slice(-8)) lines.push(`- ${a}`);
  }
  if (commitments.conceded.length > 0) {
    lines.push('Points you have CONCEDED (do not contradict these without acknowledging the change):');
    for (const c of commitments.conceded) lines.push(`- ${c}`);
  }
  if (commitments.challenged.length > 0) {
    lines.push('Points you have CHALLENGED:');
    for (const c of commitments.challenged) lines.push(`- ${c}`);
  }

  if (lines.length === 0) return '';

  return `\n=== YOUR PRIOR ARGUMENTS ===\n${lines.join('\n')}\n
REPETITION RULE: Do NOT restate a point you have already made. The audience has heard it.
If an opponent hasn't addressed your point, say "I note that no one has responded to my argument
that [brief reference]" — then move to a NEW argument or develop a DIFFERENT angle.
If you want to reinforce a prior point, add NEW evidence or a NEW example — do not restate
the same logic with different words.

CONSISTENCY RULE: Do not contradict your prior assertions without explicitly acknowledging
the change. If you now believe differently, say "I previously argued X, but on reflection..."
— do not silently flip.\n`;
}
