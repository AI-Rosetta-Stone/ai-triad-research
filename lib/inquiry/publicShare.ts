// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Public no-login share projection of an InquiryResult (t/3648 part 2, epic t/3618). The ANONYMOUS-read
// surface — the highest-stakes of the three (a leaked internal field here reaches the open internet).
//
// A SEPARATE schema with its OWN version integer, built by a CONSTRUCTIVE projector (named field reads
// only, never copy-then-delete), per SO e/201#2. A copy-then-delete projector over InquiryResult's
// `.passthrough()` would silently leak any future field (the exact `debateId` near-miss, t/3651). The
// field-level include/exclude decisions live in the shared matrix (fieldClassification.ts) — this module
// only IMPLEMENTS the public-share column; a test cross-checks that the schema shape equals
// includedFields('public-share') so the projector cannot drift from the matrix.
//
// Structurally aligned with InquiryResult (nested `request`/`derivation`/`grounding`) ON PURPOSE: it
// makes the shape ⟷ matrix cross-check exact, which is worth more than a flatter artifact.

import { z } from 'zod';
import { CampSchema, FidelitySchema, TagModeSchema, TrustVerdictSchema, HEADLINE_MAX_CHARS, type InquiryResult, type NodeRef, type SituationRef, type TagMode } from './schema.js';
import { PovNameSchema, type PovName } from '../schema/povTags.js';
import { TRUNCATION_REASONS } from './jobStatus.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';

/** Independent of INQUIRY_SCHEMA_VERSION — the public artifact is its own contract (SO e/201#2). */
export const PUBLIC_INQUIRY_SHARE_VERSION = 1;

// Public NodeRef snapshot: label + camp only. nodeId is EXCLUDED (private taxonomy id — matrix).
const PublicNodeRefSchema = z.object({ label: z.string(), camp: CampSchema }).strict();
// Public SituationRef snapshot: label only — no camp (situations aren't camp-scoped), nodeId EXCLUDED (t/4592).
const PublicSituationRefSchema = z.object({ label: z.string() }).strict();
const PublicTrustStateSchema = z.object({
  verdict: TrustVerdictSchema,
  reason: z.string(),
  terminationReason: z.string().optional(),
  metricFamily: z.string().optional(),
}).strict();
const PublicCampVerdictSchema = z.object({ camp: CampSchema, verdict: z.string(), nodes: z.array(PublicNodeRefSchema) }).strict();
const PublicConvergenceSchema = z.object({ claim: z.string(), nodes: z.array(PublicNodeRefSchema) }).strict();
const PublicEvidenceLayerSchema = z.object({ title: z.string(), role: z.string(), solves: z.string(), sources: z.array(z.string()) }).strict();
const PublicUnresolvedGapSchema = z.object({ description: z.string(), confidence: z.string() }).strict();
const PublicCalibrationEntrySchema = z.object({
  metric: z.string(),
  value: z.number(),
  displayValue: z.string().optional(),
  trust: PublicTrustStateSchema,
}).strict();
// POV tag (t/3965, SO e/252 conds 1-3): the ask and what ran are BOTH public. Without them, a Scope answer
// grounded on one wing of a camp reads as the whole camp's position.
const publicTagSelectionFields = { pov: PovNameSchema, tag: z.string(), mode: TagModeSchema };
const publicAppliedTagFields = { ...publicTagSelectionFields, included: z.number().int().nonnegative(), excludedUntagged: z.number().int().nonnegative() };
const PublicDerivationSchema = z.object({
  fidelity: FidelitySchema,
  models: z.record(z.string(), z.string()),
  rounds: z.number().int(),
  tag: z.object(publicAppliedTagFields).strict().optional(),
}).strict(); // NO callBudget / callsUsed / costUsd (operational internals — matrix)
const PublicRequestSchema = z.object({
  question: z.string(),
  fidelity: FidelitySchema,
  tagSelection: z.object(publicTagSelectionFields).strict().optional(),
}).strict(); // NO situationId / models
const PublicGroundingSchema = z.object({
  anchorSummary: z.string().optional(), // NO anchorSituationId (internal anchor id)
  nodesByCamp: z.partialRecord(CampSchema, z.array(PublicNodeRefSchema)),
  situationNodes: z.array(PublicSituationRefSchema).optional(),
}).strict();

/** The public share artifact. STRICT (not passthrough) — a public artifact must not carry unknown fields. */
export const PublicInquiryShareSchema = z.object({
  version: z.literal(PUBLIC_INQUIRY_SHARE_VERSION),
  request: PublicRequestSchema,
  campVerdicts: z.array(PublicCampVerdictSchema),
  convergences: z.array(PublicConvergenceSchema),
  evidenceLayers: z.array(PublicEvidenceLayerSchema),
  unresolvedGaps: z.array(PublicUnresolvedGapSchema),
  calibration: z.array(PublicCalibrationEntrySchema),
  derivation: PublicDerivationSchema,
  grounding: PublicGroundingSchema,
  singleRunCaveat: z.string(),
  /** Present only when the pipeline produced a characterization on a healthy (non-degraded) run.
   *  Absent for degraded runs by Condition A enforcement in `toPublicInquiryShare` — suppressed at
   *  construction if any calibration entry carries a `censored` trust verdict. Also absent when undefined
   *  (no field produced by the generator). Construction is the ONLY enforcement point (t/3667). */
  synthesizedHeadline: z.string().optional(),
}).strict();
export type PublicInquiryShare = z.infer<typeof PublicInquiryShareSchema>;

// Read-side variants — tolerant (passthrough) at every nested level to survive additive-field
// evolution across the ACA deploy-overlap window (t/3730). Strict on write, tolerant on read.
// Zod strictness is shallow, so every nested object must be replaced — not just the top level.
const PublicNodeRefReadSchema = z.object({ label: z.string(), camp: CampSchema }).passthrough();
const PublicSituationRefReadSchema = z.object({ label: z.string() }).passthrough();
const PublicTrustStateReadSchema = z.object({
  verdict: TrustVerdictSchema,
  reason: z.string(),
  terminationReason: z.string().optional(),
  metricFamily: z.string().optional(),
}).passthrough();
const PublicCampVerdictReadSchema = z.object({ camp: CampSchema, verdict: z.string(), nodes: z.array(PublicNodeRefReadSchema) }).passthrough();
const PublicConvergenceReadSchema = z.object({ claim: z.string(), nodes: z.array(PublicNodeRefReadSchema) }).passthrough();
const PublicEvidenceLayerReadSchema = z.object({ title: z.string(), role: z.string(), solves: z.string(), sources: z.array(z.string()) }).passthrough();
const PublicUnresolvedGapReadSchema = z.object({ description: z.string(), confidence: z.string() }).passthrough();
const PublicCalibrationEntryReadSchema = z.object({
  metric: z.string(),
  value: z.number(),
  displayValue: z.string().optional(),
  trust: PublicTrustStateReadSchema,
}).passthrough();
const PublicDerivationReadSchema = z.object({
  fidelity: FidelitySchema,
  models: z.record(z.string(), z.string()),
  rounds: z.number().int(),
  tag: z.object(publicAppliedTagFields).passthrough().optional(),
}).passthrough();
const PublicRequestReadSchema = z.object({
  question: z.string(),
  fidelity: FidelitySchema,
  tagSelection: z.object(publicTagSelectionFields).passthrough().optional(),
}).passthrough();
const PublicGroundingReadSchema = z.object({
  anchorSummary: z.string().optional(),
  nodesByCamp: z.partialRecord(CampSchema, z.array(PublicNodeRefReadSchema)),
  situationNodes: z.array(PublicSituationRefReadSchema).optional(),
}).passthrough();

/** Tolerant read-side counterpart to {@link PublicInquiryShareSchema} — passthrough at every nested
 *  level. Use this when deserializing blobs loaded from storage. A blob written by a NEWER build
 *  (carrying fields unknown to this build) will still parse successfully during the ACA deploy-overlap
 *  window; a blob written by an OLDER build (missing a field this build added as `.optional()`) is
 *  equally accepted. Use `safeParse` and WARN+null on failure (t/3730). */
export const PublicInquiryShareReadSchema = z.object({
  version: z.literal(PUBLIC_INQUIRY_SHARE_VERSION),
  request: PublicRequestReadSchema,
  campVerdicts: z.array(PublicCampVerdictReadSchema),
  convergences: z.array(PublicConvergenceReadSchema),
  evidenceLayers: z.array(PublicEvidenceLayerReadSchema),
  unresolvedGaps: z.array(PublicUnresolvedGapReadSchema),
  calibration: z.array(PublicCalibrationEntryReadSchema),
  derivation: PublicDerivationReadSchema,
  grounding: PublicGroundingReadSchema,
  singleRunCaveat: z.string(),
}).passthrough();
export type PublicInquiryShareRead = z.infer<typeof PublicInquiryShareReadSchema>;

/** Public-safe source predicate (Server Auth t/3648#2): `evidenceLayers.sources` is an unconstrained
 *  string[] that could carry a filesystem path or internal ref. Keep public URLs, DOIs, and plain
 *  citation titles; DROP anything that looks like a local/UNC path or a non-http scheme. */
function isPublicSafeSource(raw: string): boolean {
  const v = raw.trim();
  if (v.length === 0) return false;
  if (/^https?:\/\//i.test(v)) return true;                 // public URL
  if (/^(doi:)?10\.\d{4,}\/\S+$/i.test(v)) return true;     // DOI
  if (/^file:/i.test(v)) return false;                      // file: URL
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false;     // any OTHER scheme (ftp/smb/app/…)
  if (/^([/\\]|[A-Za-z]:[\\/]|\\\\)/.test(v)) return false; // unix abs / windows drive / UNC path
  if (v.includes('\\')) return false;                       // backslash anywhere → path-like
  return true;                                              // plain title / citation
}

function sanitizeSources(sources: string[]): string[] {
  const rec = getGlobalRecorder();
  return sources.filter((s) => {
    if (isPublicSafeSource(s)) return true;
    // Fallback-path logging (root AGENTS.md): a non-public-safe source was dropped from a public artifact.
    rec?.record({
      type: 'system.error',
      component: 'inquiry.publicShare',
      level: 'warn',
      message: `toPublicInquiryShare: dropped non-public-safe source (possible path/internal ref) from public share`,
    });
    return false;
  });
}

const publicNode = (n: NodeRef): z.infer<typeof PublicNodeRefSchema> => ({ label: n.label, camp: n.camp }); // omits nodeId by not reading it
const publicSituationRef = (s: SituationRef): z.infer<typeof PublicSituationRefSchema> => ({ label: s.label }); // omits nodeId by not reading it (t/4592)
// Named reads, so a field a newer build adds to the (passthrough) stored tagSelection never reaches the share.
const publicTagSelection = (t: { pov: PovName; tag: string; mode: TagMode }) => ({ pov: t.pov, tag: t.tag, mode: t.mode });

/** Condition A predicate: a run is degraded if any calibration entry carries a `censored` trust verdict
 *  OR terminated on any reason in `TRUNCATION_REASONS` (max_iterations / situation_cap / api_ceiling —
 *  "cut short by a binding budget/ceiling", per jobStatus.ts). These two arms are independent: `censored`
 *  is an explicit trust failure; a truncation reason marks an incomplete run that happened to pass the trust
 *  gate. `synthesizedHeadline` must not appear in the anonymous public projection for either (t/3667). */
function isRunDegraded(result: InquiryResult): boolean {
  return result.calibration.some(
    (c) => c.trust.verdict === 'censored' ||
           (c.trust.terminationReason !== undefined && TRUNCATION_REASONS.has(c.trust.terminationReason)),
  );
}

/** Excerpt cap for FREE-TEXT fields on the anonymous public surface (SO condition 5, e/201#2; Server
 *  Auth t/3648#2/#10). Mirrors `opedShareStore.ts`'s `GROUNDING_EXCERPT_MAX_CHARS` exactly: 280 chars,
 *  trim, ellipsis on overflow. Routine sanitization — NOT a fallback path, so no WARN (matches oped).
 *  Applied to anchorSummary / unresolvedGaps.description / convergences.claim / evidenceLayers.{title,
 *  role,solves}. NOT to campVerdicts.verdict — that is the core answer, not an excerpt (Server Auth's
 *  list omits it deliberately). */
const PUBLIC_EXCERPT_MAX_CHARS = 280;

function truncateExcerpt(text: string, max: number = PUBLIC_EXCERPT_MAX_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}…` : trimmed;
}

/**
 * Constructively project an InquiryResult onto the public share artifact — NAMED field reads only, so an
 * excluded field (nodeId, debateId, situationId, request.models, cost/budget internals, schemaVersion,
 * anchorSituationId) is omitted by simply never being read. The result is validated against
 * PublicInquiryShareSchema before return (defence-in-depth: a construction bug fails loud, not open).
 */
export function toPublicInquiryShare(result: InquiryResult): PublicInquiryShare {
  const share: PublicInquiryShare = {
    version: PUBLIC_INQUIRY_SHARE_VERSION,
    request: {
      question: result.request.question,
      fidelity: result.request.fidelity,
      ...(result.request.tagSelection ? { tagSelection: publicTagSelection(result.request.tagSelection) } : {}),
    },
    campVerdicts: result.campVerdicts.map((cv) => ({ camp: cv.camp, verdict: cv.verdict, nodes: cv.nodes.map(publicNode) })),
    convergences: result.convergences.map((c) => ({ claim: truncateExcerpt(c.claim), nodes: c.nodes.map(publicNode) })),
    evidenceLayers: result.evidenceLayers.map((e) => ({ title: truncateExcerpt(e.title), role: truncateExcerpt(e.role), solves: truncateExcerpt(e.solves), sources: sanitizeSources(e.sources) })),
    unresolvedGaps: result.unresolvedGaps.map((g) => ({ description: truncateExcerpt(g.description), confidence: g.confidence })),
    calibration: result.calibration.map((c) => ({
      metric: c.metric,
      value: c.value,
      ...(c.displayValue !== undefined ? { displayValue: c.displayValue } : {}),
      trust: {
        verdict: c.trust.verdict,
        reason: c.trust.reason,
        ...(c.trust.terminationReason !== undefined ? { terminationReason: c.trust.terminationReason } : {}),
        ...(c.trust.metricFamily !== undefined ? { metricFamily: c.trust.metricFamily } : {}),
      },
    })),
    derivation: {
      fidelity: result.derivation.fidelity,
      models: result.derivation.models,
      rounds: result.derivation.rounds,
      ...(result.derivation.tag ? { tag: { ...publicTagSelection(result.derivation.tag), included: result.derivation.tag.included, excludedUntagged: result.derivation.tag.excludedUntagged } } : {}),
    },
    grounding: {
      ...(result.grounding.anchorSummary !== undefined ? { anchorSummary: truncateExcerpt(result.grounding.anchorSummary) } : {}),
      nodesByCamp: Object.fromEntries(
        Object.entries(result.grounding.nodesByCamp ?? {}).map(([camp, nodes]) => [camp, (nodes ?? []).map(publicNode)]),
      ),
      ...(result.grounding.situationNodes ? { situationNodes: result.grounding.situationNodes.map(publicSituationRef) } : {}),
    },
    singleRunCaveat: result.singleRunCaveat,
    // Condition A: omit for degraded runs — enforced here at construction, NOT delegated to the generator.
    // Construction is the ONLY enforcement point (no read-side Zod validation on the anonymous path).
    // Condition B: omit over-bound headlines — never truncate (an over-bound value signals a producer bug).
    ...(() => {
      if (result.synthesizedHeadline === undefined) return {};
      if (isRunDegraded(result)) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'inquiry.publicShare', level: 'warn',
          message: `toPublicInquiryShare: synthesizedHeadline suppressed — degraded run (Condition A: censored verdict or truncation reason in TRUNCATION_REASONS)` });
        return {};
      }
      if (result.synthesizedHeadline.length > HEADLINE_MAX_CHARS) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'inquiry.publicShare', level: 'warn',
          message: `toPublicInquiryShare: synthesizedHeadline over bound (${result.synthesizedHeadline.length} > ${HEADLINE_MAX_CHARS} chars) — omitted (Condition B)` });
        return {};
      }
      return { synthesizedHeadline: result.synthesizedHeadline };
    })(),
  };
  return PublicInquiryShareSchema.parse(share);
}
