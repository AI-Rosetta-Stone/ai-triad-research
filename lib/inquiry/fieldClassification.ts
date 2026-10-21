// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Canonical field-classification matrix for InquiryResult exposure surfaces (t/3648, epic t/3618).
//
// InquiryResult (schema.ts) is a five-consumer `.passthrough()` contract projected onto THREE
// less-trusted-or-different surfaces, each of which was independently classifying the same fields —
// the drift risk that let `debateId` nearly leak on a green PR (t/3641/t/3651). This is the SINGLE
// SOURCE OF TRUTH those projections derive from:
//
//   • public-share  — anonymous, no-login share link (Server Auth, t/3623). Strictest.
//   • community     — authenticated cross-user browse (Server Community, t/3621/t/3651).
//   • export        — owner-initiated JSON/MD/PDF of one's OWN answer (Shared Lib, t/3624). Full fidelity.
//
// **Per-cell, per-surface, with a mandatory reason** (TL t/3651#2, SO e/198#7): one field can have
// three different correct answers — `debateId` is exclude / exclude / INCLUDE — so a single global
// allow/deny list is the wrong shape, and `exclude` is NEVER a reflexive default. Each cell states its
// surface's own trust context rather than inheriting from the strictest neighbour.
//
// Enforcement is `fieldClassification.test.ts`: it walks InquiryResultSchema for every leaf path and
// FAILS CLOSED if any (field, surface) is unclassified — so a new contract field cannot ship until it
// is deliberately classified on all three surfaces. Undeclared `.passthrough()` runtime fields are
// absent from every surface by construction (the projectors read only named/classified paths).
//
// Column ownership: public-share cells © Server Auth (t/3648#2); community cells © Server Community
// (t/3651#7); export cells © Shared Lib. Shared Lib owns this file, the helpers, and the CI gate.

export type Surface = 'public-share' | 'community' | 'export';

export interface Disposition {
  include: boolean;
  /** Why THIS surface makes THIS call — mandatory; forces the trust context to be stated per cell. */
  reason: string;
}

const I = (reason: string): Disposition => ({ include: true, reason });
const X = (reason: string): Disposition => ({ include: false, reason });

/** Leaf field paths use dotted notation with NO array/record indices — a path classifies that leaf on
 *  every element/value (e.g. `campVerdicts.nodes.nodeId` = the nodeId of every node of every verdict). */
export type FieldPath = string;

// Reused reasons (kept as constants only where the identical rationale genuinely recurs).
const EXPORT_FULL = 'Owner-initiated export of one\'s own answer — the owner already has access to every field; full fidelity is the point (TL t/3651#2).';
const COMMUNITY_CORE = 'Core answer content — the substance a community reader is there to see (authenticated cross-user, not anonymous).';
const PUBLIC_CORE = 'Answer substance — the shared artifact itself.';
// POV tags (t/3965, SO e/252 cond 1; TL t/3965#6). Same reasoning as request.fidelity, and more severe: a
// Scope run grounds one camp on a single tagged wing, so published without its tag it reads as the whole
// camp's position, with no way for the reader to tell.
const TAG_SCOPE_MUST_SHOW = 'MUST include (SO e/252 cond 1): a tag-scoped answer published without its tag reads as the whole camp\'s position when it is one wing\'s (the request.fidelity reasoning, more severe).';
const TAG_SCOPE_COMMUNITY = 'Must include for the same reason as public-share: without it a community reader cannot tell a one-wing answer from a whole-camp one.';
const TAG_COUNT_MUST_SHOW = 'MUST include with the tag (SO e/252#5): the excluded-untagged count is what tells a reader whether the scope was narrow or the registry coverage was thin. Counts only, no node ids.';
const TAG_COUNT_COMMUNITY = 'Must include with the tag (SO e/252#5): makes two runs with the same tag comparable as registry coverage grows.';

export const CLASSIFICATION: Record<FieldPath, Record<Surface, Disposition>> = {
  // ── top-level ──
  schemaVersion: {
    'public-share': X('Internal contract version; the public artifact carries its own version integer, and publishing this aids probing while telling a reader nothing.'),
    community: I('Needed to interpret the stored item; no sensitivity.'),
    export: I(EXPORT_FULL),
  },
  singleRunCaveat: {
    'public-share': I('MUST include (SO e/201#2): generated so the UX cannot overclaim from one run; stripping it on the one surface with no way to ask a follow-up inverts its purpose.'),
    community: I('Must include — removing it strips the very disclosure the field exists to enforce.'),
    export: I(EXPORT_FULL),
  },
  debateId: {
    'public-share': X('Internal run id; following it to the raw run would open a SECOND un-threat-modelled anonymous-read surface (TL e/203#4).'),
    community: X('Cross-user; same reasoning as public-share — a community reader must not reach another user\'s raw run.'),
    export: I('Owner-scoped: the raw-run link IS the t/3617 affordance; stripping it here would silently delete a legitimate capability (SO/TL t/3651#4).'),
  },
  synthesizedHeadline: {
    'public-share': I('Answer substance — characterizes the disagreement shape for the public reader, not a verdict or conclusion. Condition A (toPublicInquiryShare construction) governs suppression for degraded runs; a healthy-run characterization belongs in the public share (TL ruling p/342#456, confirmed by Server Auth p/673#11, t/3667#12).'),
    community: I('Core answer content — the disagreement characterization is directly relevant to an authenticated community reader and adds informative context without exposing internals (TL ruling p/342#457, confirmed by Server Community p/671#13). Suppressed at construction for degraded (censored/api_ceiling) runs in sanitizeForCommunity (t/3742) — same enforcement-not-annotation discipline as public-share\'s Condition A.'),
    export: I(EXPORT_FULL),
  },

  // ── request ──
  'request.question': {
    'public-share': I('The artifact itself. Consent handled by a mint-time disclosure preview (t/3628), not this matrix.'),
    community: I('The entire point of a community question item.'),
    export: I(EXPORT_FULL),
  },
  'request.fidelity': {
    'public-share': I('MUST include (SO): a fidelity claim — a `quick` run published without its label reads as a `deep` one.'),
    community: I('Informative context, parity with existing community metadata.'),
    export: I(EXPORT_FULL),
  },
  'request.situationId': {
    'public-share': X('Internal taxonomy anchor id; unresolvable for a public viewer (no private-repo access), enumerable for a prober.'),
    community: I('A taxonomy node reference — same trust class as the nodeIds shown throughout community verdicts; authenticated users navigate these elsewhere.'),
    export: I(EXPORT_FULL),
  },
  'request.models.debaters': {
    'public-share': X('The override REQUESTED, not what ran; `derivation.models` already stamps actual execution — publishing the ask duplicates/contradicts the receipt.'),
    community: I('Model ids, not secrets; parity with existing community `model` metadata.'),
    export: I(EXPORT_FULL),
  },
  'request.models.evaluator': {
    'public-share': X('Requested override, not actual execution (see request.models.debaters).'),
    community: I('Model id, not a secret; parity with community model metadata.'),
    export: I(EXPORT_FULL),
  },
  'request.tagSelection.pov': { 'public-share': I(TAG_SCOPE_MUST_SHOW), community: I(TAG_SCOPE_COMMUNITY), export: I(EXPORT_FULL) },
  'request.tagSelection.tag': { 'public-share': I(TAG_SCOPE_MUST_SHOW), community: I(TAG_SCOPE_COMMUNITY), export: I(EXPORT_FULL) },
  'request.tagSelection.mode': {
    'public-share': I('MUST include with the tag: Scope (one wing only) and Prioritize (every node, tagged first) make very different claims about the same camp.'),
    community: I(TAG_SCOPE_COMMUNITY), export: I(EXPORT_FULL),
  },

  // ── campVerdicts ──
  'campVerdicts.camp': { 'public-share': I(PUBLIC_CORE), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'campVerdicts.verdict': { 'public-share': I(PUBLIC_CORE), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'campVerdicts.nodes.nodeId': {
    'public-share': X('Taxonomy is private data; a nodeId is unresolvable for a public viewer and enumerable for a prober. Same reasoning as debateId, applied consistently to every NodeRef.'),
    community: I('Authenticated users navigate taxonomy ids elsewhere in the app; not a private identifier in this context.'),
    export: I(EXPORT_FULL),
  },
  'campVerdicts.nodes.label': { 'public-share': I('Public-safe node display snapshot (label, not id).'), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'campVerdicts.nodes.camp': { 'public-share': I('Public-safe node snapshot (camp code).'), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },

  // ── convergences ──
  'convergences.claim': { 'public-share': I(PUBLIC_CORE), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'convergences.nodes.nodeId': {
    'public-share': X('Private taxonomy id — excluded consistently across every NodeRef (see campVerdicts.nodes.nodeId).'),
    community: I('Authenticated-user taxonomy reference; consistent with the community column\'s nodeId stance.'),
    export: I(EXPORT_FULL),
  },
  'convergences.nodes.label': { 'public-share': I('Public-safe node snapshot (label).'), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'convergences.nodes.camp': { 'public-share': I('Public-safe node snapshot (camp).'), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },

  // ── evidenceLayers ──
  'evidenceLayers.title': { 'public-share': I(PUBLIC_CORE), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'evidenceLayers.role': { 'public-share': I(PUBLIC_CORE), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'evidenceLayers.solves': { 'public-share': I(PUBLIC_CORE), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'evidenceLayers.sources': {
    'public-share': I('Include, but the projector MUST sanitise each entry to a public-safe reference (title/DOI/public URL), dropping others with a WARN — the field is an unconstrained string[] that could carry a filesystem path (Server Auth t/3648#2).'),
    community: I('Sources are references already cited in the analysis.'),
    export: I(EXPORT_FULL),
  },

  // ── unresolvedGaps ──
  'unresolvedGaps.description': {
    'public-share': I('MUST include (SO): publishing convergences (agreement) without gaps (disagreement) is a systematically overclaiming artifact.'),
    community: I(COMMUNITY_CORE), export: I(EXPORT_FULL),
  },
  'unresolvedGaps.confidence': {
    'public-share': I('MUST include with the gap (SO): the qualifier the gap is stated at.'),
    community: I(COMMUNITY_CORE), export: I(EXPORT_FULL),
  },

  // ── calibration ──
  'calibration.metric': { 'public-share': I('The measurement.'), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'calibration.value': { 'public-share': I('The measurement.'), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'calibration.displayValue': { 'public-share': I('Lossless display form of the measurement (e.g. "72 / 84").'), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'calibration.trust.verdict': {
    'public-share': I('MUST include WITH reason (SO): a bare verdict is uninterpretable, especially where the reader cannot ask a follow-up.'),
    community: I('Platform-generated trust badge, meant to be shown (t/3576).'), export: I(EXPORT_FULL),
  },
  'calibration.trust.reason': {
    'public-share': I('MUST include WITH verdict (SO): the verdict is uninterpretable without it.'),
    community: I('Explains the trust badge; generated, safe to surface.'), export: I(EXPORT_FULL),
  },
  'calibration.trust.terminationReason': {
    'public-share': I('Include where present (SO): what drove the verdict (api_ceiling / natural / …).'),
    community: I('User-relevant — explains truncation.'), export: I(EXPORT_FULL),
  },
  'calibration.trust.metricFamily': {
    'public-share': I('Include where present (SO): the family the verdict binds to.'),
    community: I('Interpretive context for the trust state.'), export: I(EXPORT_FULL),
  },

  // ── derivation (the receipt) ──
  'derivation.fidelity': { 'public-share': I('What actually ran (vs request.fidelity, the ask).'), community: I('Informative run metadata.'), export: I(EXPORT_FULL) },
  'derivation.models': {
    'public-share': I('MUST include (SO): provenance on a measurement — calibration/convergence/trust values are model-conditional and unauditable without it.'),
    community: I('Run metadata, parity with community debate model info.'), export: I(EXPORT_FULL),
  },
  'derivation.rounds': {
    'public-share': I('MUST include (SO): grounds the fidelity label in a concrete number.'),
    community: I('Run metadata; with callBudget/callsUsed explains truncation.'), export: I(EXPORT_FULL),
  },
  'derivation.callBudget': {
    'public-share': X('Cost/budget internal — operationally sensitive.'),
    community: I('Explains truncation (pairs with callsUsed, ties to singleRunCaveat) — user-relevant.'), export: I(EXPORT_FULL),
  },
  'derivation.callsUsed': {
    'public-share': X('Cost/budget internal — operationally sensitive.'),
    community: I('Explains truncation alongside callBudget.'), export: I(EXPORT_FULL),
  },
  'derivation.costUsd': {
    'public-share': X('Cost internal — operationally sensitive.'),
    community: X('Internal financial/operational data; a community reader needn\'t see exact USD spend, and no existing community type exposes cost. Deliberate exclude, NOT inherited from public-share (Server Community t/3651#7).'),
    export: I(EXPORT_FULL),
  },
  'derivation.tag.pov': { 'public-share': I('What actually ran (vs request.tagSelection, the ask), the way derivation.fidelity pairs with request.fidelity.'), community: I(TAG_SCOPE_COMMUNITY), export: I(EXPORT_FULL) },
  'derivation.tag.tag': { 'public-share': I('What actually ran (vs request.tagSelection, the ask).'), community: I(TAG_SCOPE_COMMUNITY), export: I(EXPORT_FULL) },
  'derivation.tag.mode': { 'public-share': I('What actually ran (vs request.tagSelection, the ask).'), community: I(TAG_SCOPE_COMMUNITY), export: I(EXPORT_FULL) },
  'derivation.tag.included': { 'public-share': I(TAG_COUNT_MUST_SHOW), community: I(TAG_COUNT_COMMUNITY), export: I(EXPORT_FULL) },
  'derivation.tag.excludedUntagged': { 'public-share': I(TAG_COUNT_MUST_SHOW), community: I(TAG_COUNT_COMMUNITY), export: I(EXPORT_FULL) },

  // ── grounding ──
  'grounding.anchorSituationId': {
    'public-share': X('Internal taxonomy anchor id; unresolvable for a public viewer (its paired summary is included instead).'),
    community: I('Authenticated-user taxonomy reference, same class as request.situationId.'), export: I(EXPORT_FULL),
  },
  'grounding.anchorSummary': {
    'public-share': I('Human-readable context (the id is excluded; the summary carries the meaning).'),
    community: I('Summary text, not private.'), export: I(EXPORT_FULL),
  },
  'grounding.nodesByCamp.nodeId': {
    'public-share': X('Private taxonomy id — excluded consistently across every NodeRef (Server Auth t/3648#2).'),
    community: I('Authenticated-user taxonomy reference; consistent with the community nodeId stance.'), export: I(EXPORT_FULL),
  },
  'grounding.nodesByCamp.label': { 'public-share': I('Public-safe node snapshot (label).'), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  'grounding.nodesByCamp.camp': { 'public-share': I('Public-safe node snapshot (camp).'), community: I(COMMUNITY_CORE), export: I(EXPORT_FULL) },
  // Coverage signal (t/4374): internal diagnostic; excluded from public share (synthesis caveat is expressed in text, not raw scores)
  'grounding.campCoverage.bestRawScore': { 'public-share': X('Internal diagnostic score — not surfaced to anonymous readers; synthesis caveat carries the meaning.'), community: I('Coverage diagnostic for authenticated research use.'), export: I(EXPORT_FULL) },
  'grounding.campCoverage.lowCoverage': { 'public-share': X('Internal coverage flag — not surfaced to anonymous readers; synthesis caveat carries the meaning.'), community: I('Coverage flag for authenticated research use.'), export: I(EXPORT_FULL) },
};

/** The classified leaf paths that ARE included for a surface. The single method a constructive projector
 *  or a consumer's allowlist derives from. Order-stable (insertion order of CLASSIFICATION). */
export function includedFields(surface: Surface): FieldPath[] {
  return Object.keys(CLASSIFICATION).filter((p) => CLASSIFICATION[p][surface].include);
}

/** Disposition for one (field, surface); throws on an unclassified path so callers can't silently
 *  treat an unknown field as either included or excluded — the fail-closed contract in code form. */
export function dispositionFor(path: FieldPath, surface: Surface): Disposition {
  const cell = CLASSIFICATION[path]?.[surface];
  if (!cell) throw new Error(`fieldClassification: unclassified path "${path}" for surface "${surface}" (t/3648)`);
  return cell;
}
