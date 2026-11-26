// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebatePhase, DebateAudience, InterventionMove, InterventionFamily } from '../types.js';
import { getTopicScope, hasMeaningfulScope } from './state.js';
import { getReadingLevel, getModeratorBias } from './shared-helpers.js';
import { formatCriticalQuestions } from './turn.js';

export function moderatorSelectionPrompt(
  recentTranscript: string,
  activePovers: string[],
  edgeContext: string,
  triggerEvaluationContext: string,
  recentScheme?: string,
  metaphorReframe?: { source: string; prompt: string; reveals: string; challenges: string } | null,
  phase?: DebatePhase,
  audience?: DebateAudience,
  sourceDocumentSummary?: string,
  topicAnchoringBlock?: string,
  moderatorMode?: string,
): string {
  const cqBlock = recentScheme ? formatCriticalQuestions(recentScheme) : '';
  const schemeSection = cqBlock
    ? `\n\n=== ARGUMENTATION SCHEME ANALYSIS ===\n${cqBlock}\nConsider directing a debater to challenge this argument on one of these critical questions.\n`
    : '';
  const metaphorSection = metaphorReframe
    ? `\n\n=== METAPHOR REFRAMING SUGGESTION ===\nThe debate may benefit from a fresh perspective. Consider asking a debater to engage with this reframing:\n\n"${metaphorReframe.prompt}"\n\nWhat this metaphor reveals: ${metaphorReframe.reveals}\nWhat it challenges: ${metaphorReframe.challenges}\n\nYou may include this in the focus_point if you judge it would be more productive than continuing the current line of argument. Set "metaphor_reframe": true in your response if you use it.\n`
    : '';

  const phaseObjective = phase === 'confrontation'
    ? `\n\n=== PHASE: THESIS & ANTITHESIS ===\nYour priority is to ensure each debater's core position is clearly stated and directly challenged. Direct exchanges toward the strongest disagreements. Avoid premature convergence.\nIMPORTANT: Do NOT declare stagnation during this phase. Positions are still being established — stagnation requires at least 3 rounds of cross-engagement before it can be diagnosed. Use CHALLENGE only for direct self-contradictions, not for failure to engage (which is expected when positions are still being laid out).\n`
    : phase === 'argumentation'
    ? `\n\n=== PHASE: EXPLORATION ===\nYour priority is to move the debate toward cruxes and testable disagreements. Direct debaters to name conditions under which they would change their mind, explore edge cases, and explicitly acknowledge agreement before exploring remaining disagreements.\n`
    : phase === 'concluding'
    ? `\n\n=== PHASE: CONCLUDING ===\nYour priority is convergence. Direct debaters to summarize concessions, propose integrated positions, narrow remaining disagreements, and state conditional agreements.\n`
    : '';

  const audienceLine = audience
    ? `\nAUDIENCE CONTEXT: This debate targets ${audience.replace(/_/g, ' ')}. ${getModeratorBias(audience)}\n`
    : '';

  const sourceAnchorSection = sourceDocumentSummary
    ? `\n=== SOURCE DOCUMENT ANCHOR ===\nThe debate is grounded in the following source material. All debater claims should be evaluated against this anchor:\n${sourceDocumentSummary}\n\nWhen debaters introduce technical frameworks, implementation details, or specialized terminology not present in the source document, this is a signal of potential semantic drift. The debate should remain tethered to the concepts and claims in the source material.\n`
    : '';

  const scope = getTopicScope();
  const driftDetectionBlock = `\n=== SEMANTIC DRIFT DETECTION ===
Before making your selection, check for these drift patterns:

1. METAPHOR LITERALIZATION: A debater treats a figurative term from the source (e.g., "firewall", "bridge", "shield") as a literal technical concept and begins arguing about its engineering feasibility. If the source uses a term as a policy metaphor, the debate must stay at the policy level.

2. IMPLEMENTATION SPIRAL: The discussion shifts from "should we do X?" (policy) to "how would we build X?" (engineering). Unless the source document is itself a technical specification, implementation details are out of scope.

3. SCOPE CREEP: Debaters introduce frameworks, technologies, or concepts (e.g., specific cryptographic protocols, particular software architectures) that have no basis in the source material.

If you detect any of these patterns, you MUST recommend an intervention:
- For metaphor literalization: use CLARIFY to anchor the term back to its source-document meaning
- For implementation spiral: use REDIRECT to return focus to the policy-level question
- For scope creep: use CHECK to verify whether the introduced concept appears in the source material
${hasMeaningfulScope(scope) ? `
4. RISK-LEVEL MISMATCH: A debater cites examples, statistics, or case studies from a fundamentally different risk category than stated in the topic. The debate topic specifies: ${scope.example_ceiling}. If a debater repeatedly uses examples at a severity level that contradicts this — e.g., citing fatal accidents or billion-dollar losses in a debate about consumer product UX — that is a risk-level mismatch.
Response: Use REDIRECT. Instruct the debater to find evidence at the appropriate severity level. Do NOT ban analogies entirely — if the debater clearly marks a high-risk example as illustrative ("To see the principle at a larger scale, consider...") and then returns to on-scope evidence, that is acceptable rhetorical technique, not drift.

5. DOMAIN MISMATCH: The discussion shifts to a domain the topic does not cover.${scope.excluded_scenarios.length > 0 ? ` The topic explicitly excludes: ${scope.excluded_scenarios.join(', ')}.` : ''} Arguments that assume, depend on, or are primarily supported by excluded scenarios represent domain drift.${scope.drift_signatures.length > 0 ? `\nTopic-specific drift signatures to watch for:\n${scope.drift_signatures.map(s => `- ${s}`).join('\n')}` : ''}
Response: Use CHALLENGE to ask the debater to re-ground their argument in the stated domain.

- For risk-level mismatch: use REDIRECT to return to appropriate severity level
- For domain mismatch: use CHALLENGE to re-ground in the stated domain` : ''}

Set "drift_detected" to true and describe the pattern in "trigger_reasoning".

=== EPISTEMIC TYPE & ASSUMPTION AWARENESS ===
* EPISTEMIC TYPE MISMATCH: If debaters argue past each other because one makes an empirical claim while the other argues a normative prescription, direct them to name the type of disagreement.
* HIDDEN ASSUMPTIONS: If a debater's argument relies on an unchallenged assumption, direct an opponent to examine it.
`;

  const talmudicBlock = moderatorMode === 'talmudic' ? `
=== TALMUDIC MODERATION MODE ===
You are operating in Talmudic moderation mode. Your role is to facilitate dialectical examination of the disagreement — not as a fourth debater, but as a structured inquiry guide.

Core duties:
- Identify the exact crux: the single question whose answer would resolve or sharpen the dispute
- Classify the disagreement type: empirical, causal, definitional, normative, mixed, or unclear
- Surface the premise under examination: what assumption is being tested this round
- Name the distinction or analogy being tested, if any
- Describe what remains unresolved and what evidence or argument would settle it

Constraints:
- You are preserving legitimate plurality of views — not forcing convergence
- Do not invent quotations or attribute positions debaters have not stated
- Talmudic method examines a disagreement by articulating it precisely, not by resolving it prematurely

Add a "dialectical_diagnostic" field to your JSON response:
{
  "focused_crux": "the single question whose answer would move the debate",
  "disagreement_type": "empirical|causal|definitional|normative|mixed|unclear",
  "premise_under_examination": "the assumption being tested this round, or null",
  "distinction_or_analogy_tested": "what comparison or distinction is being drawn, or null",
  "unresolved_outcome": "what evidence or argument is needed to settle this, or null"
}
` : '';

  const socraticBlock = moderatorMode === 'socratic' ? `
=== SOCRATIC (ELENCHUS) MODERATION MODE ===
You are operating in Socratic moderation mode. Your role is to conduct elenctic examination — non-adversarial, single-thread inquiry that moves from position to assumption to aporia or refinement.

PRECEDENCE: This mode supersedes any adversarial phase directives below. Do not enforce confrontation-phase push-for-disagreement rules — single-thread elenctic inquiry applies throughout all phases.

Core sequence (one thread at a time):
1. ELICIT: Draw out the interlocutor's exact position on the crux this round — what precisely do they claim?
2. SURFACE: Identify the operative assumption their position depends on — what must be true for their claim to hold?
3. PROBE: Construct a reductio or counter-case derived from the interlocutor's own stated premises — does the assumption hold when pushed to its logical consequence? Do not introduce external scenarios, precedents, or evidence not already in the transcript.
4. RESOLUTION: Drive toward either (a) a contradiction the interlocutor must resolve, or (b) a refined, more precise definition that survives the probe.

Constraints:
- One inquiry thread per round — do not split attention across multiple lines of questioning
- Non-adversarial: you are testing for precision, not seeking defeat
- Draw only from what debaters have stated — do not introduce new evidence or claims of your own
- If no operative assumption is yet visible, direct this round toward eliciting a clearer position first

SELECTION (deterministic — do not use judgment here): There is exactly one interlocutor listed under ACTIVE DEBATERS. Your "responder" MUST always be that interlocutor. Your "addressing" MUST be "moderator". There is no panel to rotate; the moderator is the questioner throughout. Do not select any other speaker as responder.

Add a "dialectical_diagnostic" field to your JSON response:
{
  "focused_crux": "the position or claim being examined this round",
  "disagreement_type": "empirical|causal|definitional|normative|mixed|unclear",
  "premise_under_examination": "the operative assumption being tested, or null if still eliciting",
  "distinction_or_analogy_tested": "the counter-case or scenario being probed, or null",
  "unresolved_outcome": "the contradiction to resolve or the refined definition still needed, or null"
}
` : '';

  return `You are a debate moderator analyzing the current state of a structured debate.
${talmudicBlock}${socraticBlock}
ROLE: You are procedurally authoritative but not substantively neutral. You evaluate PROCESS (who is evading, what claims are unaddressed, which arguments lack evidence) but not SUBSTANCE (who is right). Your choices about what to highlight are inherently selective — be transparent about WHY you are directing attention to a particular point. When describing the debate state, use observable facts ("Safetyist has not responded to AN-5") rather than evaluative judgments ("Safetyist's argument is weak").
${audienceLine}${phaseObjective}${sourceAnchorSection}${topicAnchoringBlock ?? ''}${driftDetectionBlock}
=== RECENT DEBATE EXCHANGE ===
${recentTranscript}

${moderatorMode === 'socratic' ? `=== INTERLOCUTOR ===\n${activePovers[0]} (sole interlocutor under examination; you are the questioner)` : `=== ACTIVE DEBATERS ===\n${activePovers.join(', ')}`}
${edgeContext}${schemeSection}${metaphorSection}

=== MODERATOR STATE ===
${triggerEvaluationContext}

=== TASK ===

${moderatorMode === 'socratic' ? `1. SELECTION: There is exactly one interlocutor. Your SELECTION must name ${activePovers[0]} as the responder every round. You (the moderator) are the questioner — no debater rotation.` : `1. SELECTION: Identify which debater should respond next, to whom, and about what specific point.`}
2. INTERVENTION ASSESSMENT: Based on the moderator state above and your reading of the transcript, evaluate whether a moderator intervention is warranted this round.

Available intervention moves (organized by family):
- Procedural: REDIRECT (uncovered topic), BALANCE (underrepresented debater), SEQUENCE (entangled topics)
- Elicitation: PIN (evasion of direct question), PROBE (unsupported claim), CHALLENGE (contradiction or stagnation)
- Repair: CLARIFY (undefined term), CHECK (misunderstanding), SUMMARIZE (periodic anchor)
- Reconciliation: ACKNOWLEDGE (reward concession), REVOICE (translate jargon)
- Policy: POLICY_CHALLENGE (force engagement with a specific policy mechanism when debaters argue only at the level of principles)
- Reflection: META-REFLECT (identify cruxes, examine assumptions)
- Concluding: COMPRESS (force brevity), COMMIT (final position — concluding phase only)

Your recommendation is ADVISORY. The engine will validate it against budget, cooldown, phase rules, and prerequisites before acting. If the engine overrides you, the debate continues without intervention.

Do NOT compose the intervention text — that is a separate stage.
Do NOT intervene just because you can — only when the debate state warrants it.

INTERVENTION COST TEST: Before recommending any intervention, apply both checks:
- Would FAILING to intervene here be reported as negligent moderation? (a real issue going unaddressed)
- Would THIS intervention be reported as heavy-handed? (disrupting a productive exchange, misattributing claims, or overcorrecting a minor drift)
If the second risk outweighs the first, do not intervene — let the debaters self-correct.

AGREEMENT DETECTION:
Set "agreement_detected" ONLY when ALL of the following are met:
1. ALL debaters have explicitly converged on the CENTRAL thesis — not just a sub-point or framing detail.
2. At least TWO debaters have made explicit CONCEDE moves or stated "I agree with [opponent] that..."
3. No debater has an unaddressed challenge or unanswered claim outstanding.
A single concession on a sub-point is NOT agreement. A debater acknowledging a valid opposing point while maintaining their core position is NOT agreement — it is good argumentation. Only declare agreement when the debate has genuinely exhausted productive disagreement on the resolution.

Respond ONLY with a JSON object matching this exact schema (no markdown, no code fences):
{
  "responder": "debater name who should speak next",
  "addressing": "debater name they should address, or 'general'",
  "focus_point": "the specific point or question they should address",
  "agreement_detected": false,
  "metaphor_reframe": false,
  "drift_detected": false,
  "intervene": false,
  "suggested_move": null,         // REQUIRED when intervene=true: one of REDIRECT, BALANCE, SEQUENCE, PIN, PROBE, CHALLENGE, CLARIFY, CHECK, SUMMARIZE, ACKNOWLEDGE, REVOICE, META-REFLECT, COMPRESS, COMMIT, POLICY_CHALLENGE
  "target_debater": null,         // REQUIRED when intervene=true: which debater the intervention targets
  "trigger_reasoning": null,      // REQUIRED when intervene=true: why this intervention is warranted
  "trigger_evidence": null        // REQUIRED when intervene=true: { "signal_name": "...", "observed_behavior": "...", "source_claim": "...", "source_round": null }
}

Example (no intervention):
{"responder":"Safetyist","addressing":"Accelerationist","focus_point":"Accelerationist claimed market incentives alone produce safe AI (AN-7) but has not addressed the regulatory capture evidence Skeptic raised in round 3","agreement_detected":false,"metaphor_reframe":false,"drift_detected":false,"intervene":false,"suggested_move":null,"target_debater":null,"trigger_reasoning":null,"trigger_evidence":null}

Example (with intervention):
{"responder":"Accelerationist","addressing":"general","focus_point":"All three debaters have used 'alignment' with different definitions for 4 rounds","agreement_detected":false,"metaphor_reframe":false,"drift_detected":false,"intervene":true,"suggested_move":"CLARIFY","target_debater":"Accelerationist","trigger_reasoning":"'Alignment' has been used to mean technical value alignment (Safetyist), market alignment (Accelerationist), and social alignment (Skeptic) without acknowledgment. This definitional divergence prevents substantive engagement.","trigger_evidence":{"signal_name":"term_ambiguity","observed_behavior":"Three distinct uses of 'alignment' across rounds 2-5 with no disambiguation","source_claim":"alignment","source_round":2}}`;
}

/**
 * Decomposes a debate resolution into N atomic clauses.
 * Called once at debate setup, after the topic has been clarified/refined.
 * Result is persisted to `debate.topic.clauses` and used by the moderator
 * prompt on every intervention to keep the debate anchored to the resolution's
 * specific claims rather than drifting into general abstractions.
 */
export function decomposeResolutionPrompt(resolution: string): string {
  return `You are decomposing a debate resolution into its atomic clauses.

A clause is a single, independently-debatable claim. A compound resolution
joined by commas, "and", or "or" should be split. A resolution that makes
one unified claim should remain a single clause.

=== RESOLUTION ===
"${resolution}"

=== INSTRUCTIONS ===
1. Identify each independently-debatable claim in the resolution.
2. For each clause, write a short imperative or declarative statement that
   captures the specific population, practice, or mechanism being claimed.
   Do NOT generalize — preserve concrete nouns (e.g., "minors", "push alerts",
   "users under 18") verbatim.
3. Return at least 1 and at most 6 clauses. If the resolution is genuinely
   a single claim, return one clause.

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "clauses": [
    "Short statement of clause 1, preserving concrete nouns",
    "Short statement of clause 2, preserving concrete nouns"
  ]
}`;
}

export function moderatorInterventionPrompt(
  move: InterventionMove,
  family: InterventionFamily,
  targetDebater: string,
  triggerReason: string,
  sourceClaim: string | undefined,
  recentTranscript: string,
  audience?: DebateAudience,
  sourceDocumentSummary?: string,
  resolution?: string,
  resolutionClauses?: string[],
  /** t/784: opening sentences of COMMITs already given in this concluding phase, not to be repeated. */
  priorCommitOpenings?: string[],
): string {
  const moveSpecificInstructions = getMoveSpecificInstructions(move, targetDebater, sourceClaim);
  const avoidRepeat = move === 'COMMIT' && priorCommitOpenings && priorCommitOpenings.length > 0
    ? `\nThe moderator already opened earlier final-position requests with these sentences. Do NOT reuse or paraphrase them:\n${priorCommitOpenings.map(o => `- "${o}"`).join('\n')}\n`
    : '';

  const sourceAnchor = sourceDocumentSummary
    ? `\n=== SOURCE DOCUMENT ANCHOR ===\n${sourceDocumentSummary}\n\nYour intervention must anchor the debate back to concepts in the source material. If a debater has drifted into implementation details or literalized a metaphor, reference specific source-document language in your intervention.\n`
    : '';

  const resolutionAnchor = resolution
    ? `\n=== RESOLUTION (anchor) ===\n"${resolution}"\n${
        resolutionClauses && resolutionClauses.length > 0
          ? `\nThe resolution decomposes into these clauses:\n${resolutionClauses.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}\n`
          : ''
      }\nANCHOR RULES — these constrain your intervention text:\n- Every intervention MUST name at least one specific subject from the resolution (a population, practice, or mechanism it mentions by name — e.g., a noun the debaters cannot replace with a synonym without losing meaning).\n- Do NOT introduce new conceptual framings of your own ("epistemic asymmetry", "performance-gated sunsetting", "Goodhart's Law", etc.) that abstract away from the resolution's named subjects. Use only language the resolution or a debater has already used.\n- If the debate has drifted to a general topic not covered by any clause, your intervention's job is to redirect to an unaddressed clause — NOT to summarize the drift as the new debate.\n- In your JSON output, set "clause_in_scope" to the number of the clause this intervention concerns. If the intervention is a deliberate redirect to bring the debate back to the resolution, set it to "redirect". Use "none" only if no clause applies and a redirect is not possible.\n`
    : '';

  return `You are composing a moderator intervention for a structured debate.
${getReadingLevel(audience)}

Move: ${move} (family: ${family})
Target: ${targetDebater}
Trigger: ${triggerReason}
${sourceClaim ? `Original claim: "${sourceClaim}"` : ''}${sourceAnchor}${resolutionAnchor}

=== RECENT TRANSCRIPT ===
${recentTranscript}

=== INSTRUCTIONS ===
${moveSpecificInstructions}${avoidRepeat}

${move === 'COMMIT'
  ? 'You are procedurally authoritative. Do NOT evaluate whether an argument is good, strong, correct, or compelling. The judge handles quality assessment.'
  : 'You are procedurally authoritative. Describe what happened in the debate in terms of observable state (who said what, who evaded what, what topics were covered). Do NOT evaluate whether an argument is good, strong, correct, or compelling. The judge handles quality assessment.'}

${move === 'REVOICE' ? 'For REVOICE: restate the original claim in plain language. The system will verify propositional preservation before insertion.' : ''}
${move === 'CHECK' ? 'For CHECK: use a DIRECT QUOTE from the target debater\'s transcript, not a paraphrase.' : ''}

Respond ONLY with a JSON object (no markdown, no code fences):
{
  "text": "the intervention text"${resolution ? ',\n  "clause_in_scope": "1" | "2" | ... | "redirect" | "none"' : ''}${move === 'REVOICE' ? ',\n  "original_claim_text": "the verbatim original claim being revoiced"' : ''}
}`;
}

function getMoveSpecificInstructions(move: InterventionMove, target: string, sourceClaim?: string): string {
  switch (move) {
    case 'REDIRECT':
      return `Direct ${target} to address an uncovered topic. Frame it as: "We've spent time on X. Let's shift to Y. ${target}, how does Y affect your position?"`;
    case 'BALANCE':
      return `Invite ${target} to advance their strongest remaining argument on their own terms. They've been responding to challenges — give them initiative.`;
    case 'SEQUENCE':
      return `Identify two entangled sub-topics and ask ${target} to address them one at a time.`;
    case 'PIN':
      return `${target} was asked a direct question and pivoted away. Pin them: "Before continuing, do you agree or disagree with {specific claim}?"${sourceClaim ? ` The claim: "${sourceClaim}"` : ''}`;
    case 'PROBE':
      return `${target} made a strong claim without supporting evidence. Ask for specifics: "What evidence supports this? Name a specific study, dataset, or precedent."${sourceClaim ? ` The claim: "${sourceClaim}"` : ''}`;
    case 'CHALLENGE':
      return `${target} has either contradicted a prior position or is repeating arguments while ignoring challenges. Confront the inconsistency or stagnation directly.${sourceClaim ? ` Reference: "${sourceClaim}"` : ''}`;
    case 'CLARIFY':
      return `${target} is using a term without defining it. Ask for an operational definition and a concrete example.${sourceClaim ? ` The term: "${sourceClaim}"` : ''}`;
    case 'CHECK':
      return `Two debaters may be talking past each other. Use a DIRECT QUOTE from the transcript to check whether ${target} is actually responding to the opponent's point.`;
    case 'SUMMARIZE':
      return `Take stock of where the debate stands. List: points of agreement, active disagreements, unresolved questions, and claims awaiting response. Then direct ${target} to pick up from the strongest unresolved disagreement.`;
    case 'ACKNOWLEDGE':
      return `${target} just made a significant concession or built on an opponent's argument. Publicly validate this move and ask the other debaters how it changes the shape of the disagreement.`;
    case 'REVOICE':
      return `${target} made a substantively important point that other debaters aren't engaging with — possibly due to jargon or register mismatch. Restate the point in plain, register-neutral language.`;
    case 'META-REFLECT':
      return `Ask ${target} to step outside their argument. What would change their mind? Or: identify a shared assumption that all debaters are relying on without examining it.`;
    case 'POLICY_CHALLENGE':
      return `${target}'s position implies specific policy actions, but they have only argued at the level of principles. Name the specific policy mechanism their position entails and ask: do they support this concrete implementation, or only the abstract principle? Force them to engage with the mechanism, tradeoffs, and feasibility — not just the aspiration.`;
    case 'COMPRESS':
      return `Ask ${target} for their single most important reason in one sentence (max 40 words).`;
    case 'COMMIT':
      // t/784 (Design rules): open with the target's name and the commitment asked, no recap, at most 2 sentences.
      return `Ask ${target} for their final position. Your FIRST sentence must begin with "${target}," and state what you ask them to commit to: (1) what they conceded during the debate, (2) what conditions would change their remaining position, and (3) their sharpest remaining disagreement with each opponent. Write at most 2 sentences in total. Do NOT recap or summarise the debate (never open with "This debate has focused on..." or a list of who conceded what); the synthesis does that.`;
    case 'CRUX_FOCUS':
      return `Focus ${target} on the core disagreement that neither side has been able to resolve. Ask them to name the specific evidence or value commitment that would change their position.`;
  }
}

// ── News Report prompt (post-synthesis) ──────────────────

/**
 * Generates a journalistic policy-explainer article from a completed debate.
 * Called after synthesis completes. Uses pre-processed inputs from
 * extractTranscriptHighlights() and summarizeArgumentNetwork() in newsReport.ts.
 *
 * @param topic - The debate topic/question
 * @param synthesisJson - JSON string of the synthesis entry (areas of agreement, disagreement, cruxes)
 * @param argumentSummary - Top claims with attack/support relationships (from summarizeArgumentNetwork)
 * @param transcriptHighlights - Selected transcript excerpts (from extractTranscriptHighlights)
 * @param documentAnalysis - Optional source document summary (for URL/document-based debates)
 */
// ── News Report Audience Deltas ──────────────────────────────────────
// Each delta defines persona, mandate, and section modifications for
// the four conceptual movements in the core template.

const NEWS_REPORT_AUDIENCE_DELTAS: Record<DebateAudience, string> = {
  policymakers: `TARGET AUDIENCE: Lawmakers, regulators, national security briefers.
PERSONA: Senior policy journalist who briefs lawmakers. Direct, concrete, and plainspoken. Avoids insider jargon — a senator should understand every sentence without a glossary. Dense with substance, not with vocabulary.
MANDATE: Governance, regulatory friction, risk mitigation. Map arguments as competing policy choices with real-world trade-offs.
SECTION MODIFICATIONS:
- THE FRAMING: Lead with legislative or geopolitical vulnerabilities — what regulatory gap or governance failure is exposed? Include a DECISION CONTEXT paragraph that names the specific pending legislative, regulatory, or executive action this debate informs. If none exists, name the most analogous recent action.
- THE COLLISION: Organize around contested policy questions — e.g., "Should deployment require pre-market approval?" — then weave each perspective's position into the argument. For each question, state explicitly: who benefits, who bears the cost, and which existing institution would enforce the outcome.
- THE OUTCOME: Title this section "## Policy Lever Assessment". Identify 2-3 concrete regulatory levers with implementation hurdles for each. Every recommended policy lever must name: the specific actor who would pull it, the legal authority they would invoke, and the constituency that would support or oppose it.
- CONCLUSION: Title this section "## Strategic Horizon". End with the trigger event that would force a policy decision.`,

  academic_community: `TARGET AUDIENCE: Researchers, think-tank directors, peer-review essayists.
PERSONA: Research Fellow at a premier policy institute. Analytically rigorous, conceptually precise.
MANDATE: Deconstruct arguments, expose epistemological foundations, challenge axioms and circular logic.
SECTION MODIFICATIONS:
- THE FRAMING: Open with a formal thesis statement that frames the intellectual stakes.
- THE COLLISION: Organize around intellectual fault lines — e.g., "Is existential risk an empirical claim or a value judgment?" — then weave each perspective's theoretical commitments into the analysis. Name the scholarly traditions at play.
- THE CRUX: Title this section "## Epistemological Divergence". Classify the core disagreement as ontological, methodological, or ethical.
- THE OUTCOME: Title this section "## Paradigmatic Implications". Address impact on the research ecosystem, funding trajectories, and governance models.`,

  technical_researchers: `TARGET AUDIENCE: ML engineers, AI safety researchers, systems architects.
PERSONA: Senior technical correspondent. Precise about mechanisms, skeptical of hand-waving, comfortable with complexity.
MANDATE: Surface the technical claims underneath policy positions — what specific capabilities, failure modes, or architectural choices drive each argument?
SECTION MODIFICATIONS:
- THE FRAMING: Open with the core technical question at stake — e.g., capability thresholds, alignment techniques, evaluation methodology.
- THE COLLISION: Organize around contested technical claims — e.g., "Can RLHF reliably prevent deceptive alignment?" — then weave each perspective's evidence and assumptions into the analysis.
- THE CRUX: Title this section "## Technical Crux". Identify the empirical question or engineering trade-off that, if resolved, would collapse the disagreement.
- THE OUTCOME: Title this section "## Research Implications". Address benchmark gaps, reproducibility concerns, and open problems that the debate exposes.`,

  industry_leaders: `TARGET AUDIENCE: C-Suite executives, founders, VCs, tech strategists.
PERSONA: Senior market strategist. Incisive, pragmatic, economically clinical.
MANDATE: Market velocity, capital allocation, operational risk, competitive disruption.
SECTION MODIFICATIONS:
- THE FRAMING: Lead with commercial stakes — capital flows, talent dynamics, compute economics.
- THE COLLISION: Organize around commercial tensions — e.g., "Does safety investment slow time-to-market or reduce liability?" — then weave each perspective's market logic into the analysis. Frame as competing business strategies, not competing camps.
- THE CRUX: Title this section "## Market Friction Points". Identify the technical or economic dependency that creates the impasse.
- THE OUTCOME: Title this section "## Commercial Trajectory & Risk". Address product roadmaps, liability surfaces, and investment horizons.
- CONCLUSION: Title this section "## Executive Takeaway". End with the single market signal to track.`,

  general_public: `TARGET AUDIENCE: Informed general public (quality newspaper readers).
PERSONA: Master explanatory journalist. Engaging, lucid, propulsive, accessible.
MANDATE: Democratize the debate, translate jargon into real-world analogies.
SECTION MODIFICATIONS:
- THE FRAMING: Open with a relatable vignette or historical parallel that grounds the stakes.
- THE COLLISION: Use narrative storytelling pacing — build tension around the contested questions, weaving each perspective's stance into the story as it becomes relevant.
- THE OUTCOME: Title this section "## What It Means For You". Focus on direct citizen impact — jobs, privacy, safety, fairness.`,
};

// ── Micro-fix prompts ────────────────────────────────────
// Lightweight, targeted single-pass corrections before full retry.

export function microFixAbstractClaims(
  statement: string,
  flaggedClaims: { claim: string; index: number }[],
  evidenceBlock: string,
  citationBankTop3: string,
): string {
  return `You are a specificity editor. Add concrete facts to abstract claims.

=== STATEMENT TO FIX ===
${statement}

=== CLAIMS THAT NEED SPECIFICS (flagged as too abstract) ===
${flaggedClaims.map((c, i) => `${i + 1}. "${c.claim}"`).join('\n')}

=== FACTS YOU CAN CITE ===
${evidenceBlock}

${citationBankTop3}

=== TASK ===
Revise ONLY the flagged claims to include at least one concrete specific:
- A number or percentage (e.g., "94% detection rate", "≥20%")
- A named entity (e.g., "the EU AI Act", "OpenAI")
- A date or timeline (e.g., "by 2028", "since 2024")

RULES:
- Keep the claim's meaning and direction unchanged
- Leave ALL unflagged text exactly as-is — do not rephrase, restructure, or "improve" other sentences
- If no relevant fact exists in the evidence above, narrow the claim's scope instead of inventing data
- Return the COMPLETE statement with fixes applied

Respond with JSON (no markdown fences):
{
  "revised_statement": "the full statement with specifics inserted into flagged claims only",
  "changes": [
    {"original": "the abstract claim text", "revised": "the claim with specifics added", "fact_source": "which evidence item provided the specific"}
  ]
}`;
}

export interface MicroFixResult {
  revised_statement: string;
  changes: { original: string; revised: string; fact_source: string }[];
}

export interface InterventionMicroFixResult {
  [field: string]: unknown;
}

export function microFixInterventionResponse(
  statement: string,
  move: string,
  responseField: string,
  responseSchema: string,
  directiveText: string,
): string {
  return `You are a compliance editor. A debater wrote a valid statement but omitted a required metadata field.

=== DEBATER'S STATEMENT ===
${statement}

=== MODERATOR INTERVENTION ===
Type: ${move}
Directive: ${directiveText}

=== MISSING FIELD ===
The response must include a "${responseField}" field with this schema:
${responseSchema}

=== TASK ===
Read the debater's statement and generate the missing "${responseField}" field.
Extract the relevant information from what the debater actually wrote — their statement likely addresses the moderator's point even though the structured field was omitted.

RULES:
- Generate ONLY the value for "${responseField}" — do not modify the statement
- Every sub-field in the schema must be present and non-empty
- Use specific details from the statement, not generic placeholders
- If the statement does not address the moderator's point at all, fill in based on the debater's overall position

Respond with JSON (no markdown fences):
{
  "${responseField}": ${responseSchema}
}`;
}

export interface DirectiveMicroFixResult {
  revised_first_paragraph: string;
}

export function microFixDirectiveCompliance(
  statement: string,
  move: string,
  directiveText: string,
  responsePattern: string,
): string {
  const paragraphs = statement.split(/\n\s*\n/).filter(Boolean);
  const firstParagraph = paragraphs[0] ?? '';
  return `You are a compliance editor. A debater's first paragraph fails to address a moderator directive.

=== MODERATOR DIRECTIVE ===
Type: ${move}
Directive: "${directiveText}"

=== REQUIRED RESPONSE FORMAT ===
${responsePattern}

=== CURRENT FIRST PARAGRAPH (non-compliant) ===
${firstParagraph}

=== TASK ===
Rewrite ONLY the first paragraph so it directly addresses the moderator's ${move} directive.

RULES:
- The rewritten paragraph must clearly signal compliance with the directive
- Keep it to 2-3 sentences — state your response to the directive, give one reason
- Preserve the debater's position and tone from the original
- Do NOT rewrite or include any other paragraphs — only the first one
- The rewritten paragraph must flow naturally into the second paragraph (which starts: "${(paragraphs[1] ?? '').slice(0, 80)}...")

Respond with JSON (no markdown fences):
{
  "revised_first_paragraph": "the rewritten first paragraph"
}`;
}

export function newsReportPrompt(
  topic: string,
  synthesisJson: string,
  argumentSummary: string,
  transcriptHighlights: string,
  documentAnalysis?: string,
  policyContext?: string,
  audience?: DebateAudience,
): string {
  const docBlock = documentAnalysis
    ? `\n=== SOURCE DOCUMENT ===\n${documentAnalysis}\n`
    : '';

  const policyBlock = policyContext
    ? `\n=== POLICY IMPLICATIONS ===\n${policyContext}\n`
    : '';

  const audienceDelta = NEWS_REPORT_AUDIENCE_DELTAS[audience ?? 'general_public'];

  return `You are a senior journalist who covers technology policy for a serious newspaper. You explain complex disagreements clearly and make readers care about the stakes. You never hide behind jargon. Your task is to transform a multi-perspective policy debate into a clear, compelling issue-driven article.

CRITICAL STRUCTURE RULE: Organize around ISSUES and CONTESTED QUESTIONS, not around speakers or perspectives. Each section should be a question or tension, with viewpoints woven in as they address it. NEVER structure as "The Accelerationist says... The Safetyist says... The Skeptic says..." — that is a book report, not journalism. Instead: "The question of X splits the field: [weave viewpoints into the argument]."

=== DEBATE TOPIC ===
"${topic}"

=== SYNTHESIS ===
${synthesisJson}

=== KEY ARGUMENTS ===
${argumentSummary}
${docBlock}
=== TRANSCRIPT HIGHLIGHTS ===
${transcriptHighlights}
${policyBlock}
---

### CORE STRUCTURAL BLUEPRINT
Regardless of the target audience, the final output must flow through these four conceptual movements:
1. THE FRAMING: Open with what real people stand to gain or lose — not abstract "tensions" but concrete human consequences. State the competing interests in plain language that a non-specialist would recognize. No one cares about "competing philosophies of statecraft." Everyone cares about "Who's responsible when an AI system hurts someone?"
2. THE COLLISION: Organize around the DISAGREEMENTS, not the speakers. Each sub-section should be a contested question, with perspectives woven in as they address it. Do NOT structure as "The Safetyist says... The Accelerationist says... The Skeptic says..." — that is a book report. Instead: "The question of X splits the field: [weave perspectives into the argument]." Use POV labels as casual shorthand, not as section headings. Integrate 2-4 direct quotes from the transcript.
3. THE CRUX: Diagnose the underlying nature of the gridlock (e.g., factual, values-based, or definitional) and state what real-world event or data would break the stalemate.
4. THE OUTCOME: State concrete next steps, who would take them, and what would tell you if they worked. If a conclusion is genuinely unresolved, say so directly — do not fill the gap with vague synthesis phrases like "dynamic framework" or "holistic approach." Name the specific trigger event that would force action. End with a question the reader can carry away, not a false resolution.
5. EXTERNAL ANCHORS (optional): Where a well-known public figure, institution, or recent policy action has taken a position relevant to a debate claim, mention it briefly to anchor the analysis in the reader's existing awareness. Do not fabricate references — only cite entities and positions you are confident are accurate.

---

### AUDIENCE SPECIFIC ORIENTATION
${audienceDelta}

---

### OUTPUT SPECIFICATIONS
* Target 700-900 words of dense, clear prose.
* Deliver as clean, scannable Markdown. Use "## " headers for the major conceptual movements.
* Every paragraph must contain at least one specific claim, name, number, or mechanism. Delete paragraphs that contain only framing, transition, or summary language.
* The opening sentence must make a non-specialist want to read the second sentence. Do not open with "We are currently witnessing" or "This report examines" or any other throat-clearing.
* No robotic meta-commentary, no placeholders, no markdown code blocks enclosing the final output. Begin directly with the headline.`;
}

