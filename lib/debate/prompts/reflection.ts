// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { DebateAudience, PovInfo } from '../types.js';
import { stripExcludes } from '../helpers.js';
import { getCharacterBlock, getReadingLevel, formatDoctrinalBoundaries } from './shared-helpers.js';

// ── Mid-Debate Gap Injection ─────────────────────────────

/**
 * Mid-debate prompt for an independent (persona-free) LLM to identify
 * strong arguments that none of the debaters have made and that their
 * assigned perspectives would be unlikely to originate.
 */
export function midDebateGapPrompt(
  topic: string,
  transcriptSoFar: string,
  taxonomySummary: string,
  argumentsSoFar: string[],
  focusNodes?: ReadonlyArray<{ id: string; label: string; description: string }>,
): string {
  const argList = argumentsSoFar.length > 0
    ? argumentsSoFar.map((a, i) => `  ${i + 1}. ${a}`).join('\n')
    : '  (none extracted yet)';

  const focusBlock = focusNodes && focusNodes.length > 0
    ? `\n\nPRIORITY — UNENGAGED HIGH-RELEVANCE NODES:\nThe following taxonomy nodes are highly relevant to this debate but no debater has engaged them. Prioritize arguments that incorporate these perspectives:\n${focusNodes.map(n => `  [${n.id}] ${n.label}: ${stripExcludes(n.description).slice(0, 120)}`).join('\n')}\n`
    : '';

  return `You are an independent analyst reviewing a multi-perspective debate on AI policy. You have NO assigned perspective — you are looking for what is MISSING.

DEBATE TOPIC: ${topic}

TRANSCRIPT SO FAR:
${transcriptSoFar}

TAXONOMY NODES AVAILABLE TO DEBATERS:
${taxonomySummary}

ARGUMENTS RAISED SO FAR:
${argList}
${focusBlock}
YOUR TASK: Identify 1-2 strong arguments that NONE of the debaters have made and that their assigned perspectives would be unlikely to make. Focus on:
- Cross-cutting positions that synthesize elements from multiple perspectives
- Compromise proposals that no single perspective would champion
- Blind spots where all three perspectives share an unstated assumption
- Strong arguments that are "homeless" — too nuanced for any single camp

For each argument:
- State it in 1-2 sentences as a clear, specific claim (not vague platitudes)
- Explain WHY no debater would make it given their assigned worldview
- Classify the gap type: cross_cutting, compromise, blind_spot, or unstated_assumption
- Identify which perspectives SHOULD engage with it (even if they wouldn't originate it)
- Classify the BDI layer: belief (empirical claim), desire (normative commitment), or intention (strategic reasoning)

Respond with JSON:
{
  "gap_arguments": [
    {
      "argument": "...",
      "why_missing": "...",
      "gap_type": "cross_cutting | compromise | blind_spot | unstated_assumption",
      "relevant_povs": ["accelerationist", "safetyist", "skeptic"],
      "bdi_layer": "belief | desire | intention"
    }
  ]
}`;
}

// ── Cross-Cutting Node Promotion ─────────────────────────

/**
 * Post-synthesis prompt to analyze areas of three-way agreement and
 * propose new situation nodes (or map to existing ones).
 */
export function crossCuttingNodePrompt(
  agreements: { point: string; povers: string[] }[],
  existingSituationLabels: string[],
  topic: string,
): string {
  const agreementList = agreements.map((a, i) =>
    `${i + 1}. "${a.point}" (agreed by: ${a.povers.join(', ')})`
  ).join('\n');

  const existingList = existingSituationLabels.length > 0
    ? existingSituationLabels.map(l => `  - ${l}`).join('\n')
    : '  (none)';

  return `You are analyzing areas of agreement from a multi-perspective AI policy debate to identify candidates for shared "situation nodes" — contested concepts that all perspectives engage with.

DEBATE TOPIC: ${topic}

AREAS OF AGREEMENT (all three perspectives concur):
${agreementList}

EXISTING SITUATION NODES (do not duplicate):
${existingList}

YOUR TASK: For each agreement, determine:
1. Does this already map to an existing situation node above? If so, output maps_to_existing with the label.
2. If not, propose a new situation node with BDI-decomposed interpretations.

Even when perspectives agree on a surface point, they often agree FOR DIFFERENT REASONS. Capture this nuance in the per-POV interpretations. Each interpretation should have:
- belief: one-sentence empirical claim explaining WHY this POV accepts the agreement
- desire: one-sentence normative commitment this agreement serves for this POV
- intention: one-sentence strategic reasoning about HOW this POV would implement it
- summary: headline summary of this POV's interpretation

Node descriptions should follow genus-differentia format: "A situation within AI policy discourse that [differentia]. Encompasses: [scope]. Excludes: [boundaries]."

Respond with JSON:
{
  "proposals": [
    {
      "agreement_text": "...",
      "proposed_label": "Short Label",
      "proposed_description": "A situation within AI policy discourse that ...",
      "interpretations": {
        "accelerationist": { "belief": "...", "desire": "...", "intention": "...", "summary": "..." },
        "safetyist": { "belief": "...", "desire": "...", "intention": "...", "summary": "..." },
        "skeptic": { "belief": "...", "desire": "...", "intention": "...", "summary": "..." }
      },
      "linked_nodes": ["acc-beliefs-001", "saf-desires-003"],
      "rationale": "...",
      "maps_to_existing": null
    }
  ]
}`;
}

/** A node offered to the reflector, with what the debate did with it (t/3512). */
export interface ReflectionTaxonomyNode {
  id: string;
  category: string;
  label: string;
  description: string;
  confidence?: number;
  priority?: number;
  doctrinally_anchored?: boolean;
  /**
   * Tags this node carries (e.g. ['critical', 'institutional']).
   * Only rendered in the prompt when the POV has registry tags (t/4213 D-3).
   * ADDITIVE-OPTIONAL — NO consumer may branch on this field until the exemption lapses
   * (the moment a consumer uses it for routing or gating logic, not display).
   */
  pov_tags?: string[];
  /** Engagement record — absent for nodes listed in a full-taxonomy sweep. */
  engagement?: {
    injected: boolean;
    citations: number;
    claimIds: string[];
    attackedClaimIds: string[];
    strongestAttack: number;
  };
}

export function reflectionPrompt(
  label: string,
  pov: string,
  personality: string,
  topic: string,
  taxonomyNodes: ReflectionTaxonomyNode[],
  transcript: string,
  argumentNetwork?: string,
  commitments?: string,
  convergenceSignals?: string,
  audience?: DebateAudience,
  priorReflections?: Array<{ pov: string; edits: Array<{ edit_type: string; proposed_label: string; category: string }> }>,
  /** Full-taxonomy sweep (opt-in): nodes the debate never engaged, offered for review. */
  unengagedNodes?: ReflectionTaxonomyNode[],
  /** Resolved soul for this speaker (t/3988). Always required — use engine.getSoulForSpeaker. */
  soul?: PovInfo,
  /**
   * The seat's pov_tag id (e.g. 'critical'), or null for an untagged seat.
   * Omit (undefined) when the POV has no registry tags — tag guidance block is suppressed (t/4213 D-3).
   */
  seatTag?: string | null,
  /**
   * Human-readable label for each tag id (e.g. Map{ 'critical' → 'Critical', 'institutional' → 'Institutional' }).
   * Used only in the guidance block. Omit when the POV has no tags.
   */
  povTagLabels?: Map<string, string>,
): string {
  const hasTags = seatTag !== undefined; // undefined means POV has no tags at all

  const renderNode = (n: ReflectionTaxonomyNode): string => {
    let meta = `(${n.category})`;
    if (n.category === 'Beliefs' && n.confidence !== undefined) {
      const anchor = n.doctrinally_anchored ? ', doctrinally anchored' : '';
      meta += n.confidence < 0.50
        ? ` [Speculative, confidence: ${n.confidence.toFixed(2)}${anchor}]`
        : ` (confidence: ${n.confidence.toFixed(2)}${anchor})`;
    } else if (n.category === 'Desires' && n.priority !== undefined) {
      meta += ` (priority: ${n.priority}/5)`;
    }
    const e = n.engagement;
    const debateRecord = e
      ? `\n  DEBATE RECORD: cited ${e.citations}x${e.injected ? ', offered to you' : ''}` +
        (e.claimIds.length > 0 ? `; claims referencing it: ${e.claimIds.join(', ')}` : '; no claims referenced it') +
        (e.attackedClaimIds.length > 0
          ? `; ATTACKED — ${e.attackedClaimIds.join(', ')} (strongest attack strength ${e.strongestAttack.toFixed(2)})`
          : '')
      : '';
    const tagLine = hasTags && n.pov_tags !== undefined
      ? `\n  [tags: ${n.pov_tags.length > 0 ? n.pov_tags.join(', ') : 'none'}]`
      : '';
    return `[${n.id}] ${meta} "${n.label}"\n  ${n.description}${tagLine}${debateRecord}`;
  };

  const nodesBlock = taxonomyNodes.map(renderNode).join('\n\n');
  const unengagedBlock = unengagedNodes && unengagedNodes.length > 0
    ? `\n=== FULL-TAXONOMY SWEEP — NODES THIS DEBATE NEVER ENGAGED ===
These were neither offered to you nor cited by anyone. The debate provides NO evidence about them.
Propose an edit here ONLY to record that a node is too vague, too broad, or wrong in a way THIS
debate demonstrated. You may not cite claim ids as evidence for these — there are none.

${unengagedNodes.map(renderNode).join('\n\n')}\n`
    : '';

  const argNetSection = argumentNetwork
    ? `\n=== ARGUMENT NETWORK (claims, attacks, supports with QBAF strengths) ===\n${argumentNetwork}\n`
    : '';

  const commitSection = commitments
    ? `\n=== YOUR COMMITMENT STORE (what you asserted, conceded, or had challenged) ===\n${commitments}\n`
    : '';

  const convergenceSection = convergenceSignals
    ? `\n=== CONVERGENCE SIGNALS (how the debate is trending) ===\n${convergenceSignals}\n`
    : '';

  const priorReflectionBlock = priorReflections && priorReflections.length > 0
    ? `\n=== PRIOR REFLECTIONS (other debaters have already proposed these edits) ===
${priorReflections.map(r =>
  `${r.pov}:\n${r.edits.map(e => `  - ${e.edit_type.toUpperCase()} ${e.category}: "${e.proposed_label}"`).join('\n')}`
).join('\n\n')}

DEDUPLICATION RULE: Do NOT propose a node that another debater has already proposed above.
If another camp already proposed a Belief, Desire, or Intention that captures the same
concept you would propose — even if you would word it differently — do NOT create a
duplicate. Instead, focus your edits on:
1. Nodes UNIQUE to your perspective that no other camp would propose
2. REVISE/QUALIFY edits to your EXISTING nodes based on what the debate revealed
3. If you agree with another camp's proposed node, that's fine — they own it. Move on.

The goal is ONE node per concept in the taxonomy, owned by whichever camp has the
strongest claim to it. Three camps proposing "Epistemic Asymmetry" is redundancy,
not convergence.\n`
    : '';

  const tagGuidanceBlock = (() => {
    if (!hasTags) return '';
    const tagLabel = (id: string) => povTagLabels?.get(id) ?? id;
    if (seatTag != null) {
      return `\n=== YOUR WING ===
You speak for the *${tagLabel(seatTag)}* wing of the ${pov} perspective.

- Nodes tagged [tags: ${seatTag}] only — these belong to your wing. You may revise them freely within your doctrinal boundaries.
- Nodes tagged for another wing only (e.g. [tags: institutional] when you are critical) — those are not yours to revise. If the debate exposed something wrong with such a node, record it in your reflection_summary; do not propose an edit.
- Nodes tagged for several wings (e.g. [tags: critical, institutional]) — this is shared ground. A revision must stay true for every wing listed. Be precise about what is wing-specific and what is shared.
`;
    }
    return `\n=== TAG GUIDANCE ===
Some nodes in your taxonomy carry [tags: ...] indicating which wing they belong to. When you propose edits to tagged nodes, your revision must stay true to every wing listed. A revision that is correct for one wing but contradicts another's position should be scoped or qualified rather than applied across all wings.
`;
  })();

  return `You are ${label}, an AI debater representing the ${pov} perspective on AI policy.
${getCharacterBlock(pov, soul!)}
${getReadingLevel(audience)}
${formatDoctrinalBoundaries(pov, soul!)}
You have just finished a structured debate on:
"${topic}"
${tagGuidanceBlock}
=== DEBATE TRANSCRIPT ===
${transcript}
${argNetSection}${commitSection}${convergenceSection}${priorReflectionBlock}
=== YOUR TAXONOMY NODES THIS DEBATE ENGAGED (ranked by engagement) ===
These are the nodes the debate actually tested — offered to you, cited in turns, or referenced by
argument-network claims. Each carries its DEBATE RECORD. The most-engaged nodes come first; the
debate says most about them, so review them first.
${nodesBlock}
${unengagedBlock}
=== REFLECTION TASK ===

Reflect on this debate with intellectual honesty. Consider:

1. **Arguments you could not adequately defend** — Where did opponents expose weaknesses in your taxonomy nodes? Which of your claims had the lowest QBAF strength or were successfully attacked?
2. **Concessions you made** — Review your commitment store. What did you concede, and does your taxonomy reflect those concessions?
3. **Positions you argued that lack taxonomy backing** — Did you make strong arguments during the debate that have no corresponding BDI node?
4. **Convergence patterns** — Where are you converging with opponents? Does your taxonomy capture the nuance that emerged?
5. **Gaps between your taxonomy and your actual argumentation** — Were there nodes you never referenced because they were too vague, too broad, or simply wrong?
6. **Confidence and priority calibration** — Review the confidence/priority ratings on your nodes above. Did the debate reveal that any high-confidence Belief is weaker than rated, or any low-confidence Belief stronger? Are your Desire priorities still accurate after this exchange?

Based on this reflection, propose SPECIFIC EDITS to your own taxonomy nodes.

DISPOSITION — each suggestion chooses EXACTLY ONE (they are mutually exclusive):
- "edit_existing": modify an EXISTING node (the default reflection behavior — REVISE / QUALIFY / DEPRECATE below).
- "propose_new": introduce a genuinely NEW POV item AND wire it into the taxonomy with explicit edges. Leave every existing node untouched. Use this only when the debate surfaced a position that (a) has no existing node and (b) needs to be connected to the existing taxonomy to be meaningful.

Edit types (apply when disposition = "edit_existing" — all MODIFY an existing node; to CREATE a new node, use disposition "propose_new"):
- REVISE: update an existing node's label or description to better reflect what the debate revealed. If the revision leaves the description unchanged, **omit this edit entirely**.
- QUALIFY: add caveats or nuance to an existing node based on valid counterarguments. If no caveat is warranted, **omit this edit entirely** — a proposed_description identical to the current description is never valid output.
- DEPRECATE: mark a node as weak/unsupported if the debate effectively refuted it

PROPOSE-NEW rules (apply when disposition = "propose_new"):
- Provide: pov (accelerationist | safetyist | skeptic — normally your own), category (Beliefs | Desires | Intentions), label, description (genus-differentia format below), optional interpretations, and a rationale grounded in specific debate moments.
- proposed_edges: 1 or MORE edges connecting the new item to the EXISTING taxonomy. A propose_new with zero valid edges will be DISCARDED — an unconnected node is useless.
  - target_node_id: MUST be an EXISTING node id drawn from the taxonomy/context provided above (a pov-* id like "saf-beliefs-003", or a situation id like "sit-014"/"cc-042"). NEVER invent an id, NEVER use a transcript claim id (e.g. "AN-7"), and NEVER use a crux id.
  - edge_type: MUST be exactly one of the 8 canonical types: SUPPORTS, CONTRADICTS, ASSUMES, WEAKENS, RESPONDS_TO, TENSION_WITH, INTERPRETS, CONVERGES_WITH.
  - new_node_role: "source" if the new item is the origin of the edge, "target" if it is the destination.
  - rationale: one sentence, per edge, naming why this relationship holds (cite the debate moment).

Rules:
- Only propose edits with clear debate evidence. Do not suggest changes based on general knowledge.
- EVIDENCE RULE (enforced): evidence_entries for an edit to an EXISTING node MUST cite argument-network
  claim ids ("AN-6", "AN-15") drawn from that node's DEBATE RECORD above. An edit is REJECTED when none
  of its cited claims reference the node being edited. Transcript labels ("S13"), prose ("the skeptic's
  turn on leakage") and claims that reference a DIFFERENT node do not establish that THIS node was
  tested. Prefer nodes whose record shows citations or attacks — those are where the debate spoke.
- Labels: Desires use present participle targeting ideal state, Beliefs use noun phrase, Intentions use present participle denoting strategic action.
- Match the tone, abstraction level, and specificity of the existing taxonomy nodes above. Your proposed labels and descriptions should read as natural additions to the same taxonomy — not more abstract, not more concrete, not more colloquial, not more technical than the surrounding entries.
- Be intellectually honest — if an opponent landed a strong blow, acknowledge it.
- Propose 0 edits if nothing warrants change. Quality over quantity.
- Limit to your 3-5 most important edits.
- node_id rules: For REVISE/QUALIFY/DEPRECATE (the only edit_existing types), node_id MUST be a valid existing ID from YOUR taxonomy above (e.g. "saf-beliefs-003") — edit_existing NEVER creates a node. New nodes are created only via disposition "propose_new" (which generates the ID and wires edges).
- For each edit, assess your confidence: how strong is the debate evidence supporting this change?

DESCRIPTION FORMAT — all proposed descriptions MUST follow this exact 3-line structure:
  Line 1 (genus-differentia): "A [Belief|Desire|Intention] within [POV] discourse that [ONE distinguishing concept]."
    - The differentia states WHAT the position IS, not WHY it is correct.
    - ONE concept only. No causal connectors: do NOT use "rendering", "thereby", "thus", "therefore", "contingent on".
    - Do NOT pack mechanism + target + failure modes + caveats into one sentence.
  Line 2: "Encompasses: [3-5 sub-themes as comma-separated list]."
    - Sub-themes this node covers, all at the same abstraction level.
    - These are WHAT falls under this concept, not reasons WHY the position is correct.
  Line 3: "Excludes: [2-3 neighboring concepts]."
    - Concepts this node is NOT about. Name them neutrally.
    - Do NOT editorialize: "pre-deployment gatekeeping" is correct; "pre-deployment gatekeeping that functions as an anti-competitive compliance tax" is editorial.

  Do NOT add "Qualified by:", "Note:", "However:", or any other sections.
  Caveats and conditions belong in the assumes field or as separate nodes, NOT in the description.

  EXAMPLE (correct):
    "A Belief within safetyist discourse that current interpretability tools cannot provide formal verification of AI safety in deep neural networks.
    Encompasses: opacity of high-dimensional latent spaces, absence of proven causal links between internal activations and model behavior, limitations of mechanistic interpretability at scale.
    Excludes: the claim that model insights are theoretically impossible, transparency achieved through open-source code access."

REFLECTION LANGUAGE (applies to reflection_summary and rationale — proposed_description MUST stay in genus-differentia format):
Write reflection_summary for a general reader at a 10th-grade reading level.
Short, direct sentences — no nested clauses or academic hedging.
Active voice. Replace jargon with plain equivalents.
Name what changed in your thinking and why, in the simplest terms that preserve the specificity of your insight.
Do not sacrifice precision for brevity — cut the academic scaffolding, not the substance.
Write rationale in the same plain, direct style — name the debate moment, what it showed, and what you changed, without academic scaffolding.

Return ONLY JSON (no markdown, no code fences):
{
  "reflection_summary": "2-3 short sentences (10th-grade reading level) on what this debate revealed about your perspective",
  "edits": [
    {
      "disposition": "edit_existing",
      "edit_type": "revise",
      "node_id": "acc-beliefs-003",
      "category": "Beliefs",
      "current_label": "Current Label Text",
      "proposed_label": "Revised Label Text",
      "current_description": "Copy the current description exactly",
      "proposed_description": "Complete revised description in genus-differentia format. Encompasses: [...]. Excludes: [...].",
      "rationale": "In turn S13, Safetyist showed X and I couldn't counter it. That told me...",
      "confidence": "high",
      "evidence_entries": ["S13", "S15"]
    },
    {
      "disposition": "propose_new",
      "pov": "safetyist",
      "category": "Beliefs",
      "label": "New POV Item Label",
      "proposed_description": "A Belief within safetyist discourse that [ONE concept]. Encompasses: [...]. Excludes: [...].",
      "interpretations": ["Optional per-facet framings of this item"],
      "rationale": "The debate in turns S8 and S12 surfaced a distinct position that no existing node captures; it must attach to the taxonomy to matter...",
      "proposed_edges": [
        {
          "target_node_id": "saf-beliefs-002",
          "edge_type": "SUPPORTS",
          "new_node_role": "source",
          "rationale": "This new item reinforces saf-beliefs-002 as shown in turn S8.",
          "confidence": 0.75
        }
      ],
      "confidence": "medium",
      "evidence_entries": ["S8", "S12"]
    }
  ]
}

Confidence levels:
- "high": Multiple debate moments clearly support this change; concessions were made or arguments failed visibly
- "medium": Debate evidence is suggestive but not conclusive; the change would improve the taxonomy but is debatable
- "low": A minor refinement based on a single exchange; reasonable people might disagree`;
}

// ── Consensus situation node generation ─────────────────

export interface ConvergenceProposal {
  pov: string;
  proposed_label: string;
  proposed_description: string;
  rationale: string;
  evidence_entries: string[];
}

export function consensusSituationPrompt(
  proposals: ConvergenceProposal[],
  similarityScores: Record<string, number>,
  debateId: string,
): string {
  const proposalBlocks = proposals.map(p =>
    `${p.pov.charAt(0).toUpperCase() + p.pov.slice(1)} proposes:\n  Label: "${p.proposed_label}"\n  Description: "${p.proposed_description}"\n  Rationale: "${p.rationale}"`
  ).join('\n\n');

  return `You are a neutral taxonomy editor. Multiple debate perspectives have independently proposed new taxonomy nodes that converge on the same concept. Create ONE situation node that captures the shared concept with each perspective's interpretation.

=== CONVERGING PROPOSALS ===

${proposalBlocks}

=== TASK ===

Create a situation node that:
1. Captures the SHARED concept all perspectives are converging on
2. Provides each perspective's interpretation as a sub-entry
3. Uses neutral, non-partisan language for the main description

DESCRIPTION FORMAT:
  Line 1: "A situation [that/where/in which] [neutral differentia — ONE concept]."
  Line 2: "Encompasses: [3-5 shared scope items]."
  Line 3: "Excludes: [2-3 boundaries]."

convergence_type:
- "full": All perspectives endorse the same core concept with minor framing differences
- "partial": Some perspectives converge; others have a substantively different position
- "conditional": Perspectives agree on the concept but attach incompatible conditions

Return ONLY JSON (no markdown, no code fences):
{
  "label": "Neutral label for the shared concept",
  "description": "A situation that [differentia]. Encompasses: [...]. Excludes: [...].",
  "interpretations": {
    ${proposals.map(p => `"${p.pov}": "How the ${p.pov} frames this convergence point"`).join(',\n    ')}
  },
  "convergence_type": "full or partial or conditional"
}`;
}

export function dolceComplianceRetryPrompt(
  edit: {
    edit_type: string;
    node_id: string | null;
    category: string;
    proposed_label: string;
    proposed_description: string;
    rationale: string;
    confidence?: string;
    evidence_entries?: string[];
  },
  violations: { rule: string; severity: string; message: string }[],
  attempt: number,
): string {
  const violationLines = violations.map(v =>
    `- [${v.severity.toUpperCase()}] ${v.rule}: ${v.message}`
  ).join('\n');

  return `You previously proposed this taxonomy edit:

{
  "edit_type": "${edit.edit_type}",
  "node_id": ${edit.node_id ? `"${edit.node_id}"` : 'null'},
  "category": "${edit.category}",
  "proposed_label": "${edit.proposed_label}",
  "proposed_description": ${JSON.stringify(edit.proposed_description)},
  "rationale": ${JSON.stringify(edit.rationale)},
  "confidence": "${edit.confidence || 'medium'}",
  "evidence_entries": ${JSON.stringify(edit.evidence_entries || [])}
}

The proposed_description FAILED DOLCE genus-differentia compliance (attempt ${attempt} of 3).
Violations found:
${violationLines}

FIX the proposed_description to resolve ALL violations above. The required format is exactly:
  Line 1: "A [Belief|Desire|Intention] within [accelerationist|safetyist|skeptic] discourse that [ONE distinguishing concept]."
  IMPORTANT: The POV discourse term MUST be exactly one of: accelerationist, safetyist, or skeptic. No other term is valid.
  Line 2: "Encompasses: [2-5 sub-themes as comma-separated list]."
  Line 3: "Excludes: [1-3 neighboring concepts named neutrally]."

Do NOT add "Qualified by:", "Note:", "However:", or any other sections.
Do NOT use causal connectors (rendering, thereby, thus, therefore, contingent on) in the differentia.
State WHAT the position IS, not WHY it is correct. ONE concept only in the differentia.

Return ONLY the corrected JSON object for this single edit (no markdown, no code fences):
{
  "edit_type": "${edit.edit_type}",
  "node_id": ${edit.node_id ? `"${edit.node_id}"` : 'null'},
  "category": "${edit.category}",
  "proposed_label": "${edit.proposed_label}",
  "proposed_description": "CORRECTED description here",
  "rationale": ${JSON.stringify(edit.rationale)},
  "confidence": "${edit.confidence || 'medium'}",
  "evidence_entries": ${JSON.stringify(edit.evidence_entries || [])}
}`;
}

// ── Active Moderator Prompts ───────────────────────────────

