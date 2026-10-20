// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Zod validation schemas for taxonomy and debate data structures.
 * Enforces ontological compliance on new data — prevents violations
 * without migrating existing data.
 */

import { z } from 'zod';
import { POV_KEYS } from './types.js';
import { validatePovTags } from '../schema/povTags.js';

// ── Shared enums ──────────────────────────────────────────

export const CategorySchema = z.enum(['Beliefs', 'Desires', 'Intentions']);

export const PovSchema = z.enum([...POV_KEYS]);

export const BdiLayerSchema = z.enum(['belief', 'desire', 'intention']);

export const NodeScopeSchema = z.enum(['claim', 'scheme', 'bridging']);

export const FallacyTierSchema = z.enum([
  'formal', 'informal_structural', 'informal_contextual', 'cognitive_bias',
]);

export const DialecticalSchemeSchema = z.enum([
  'CONCEDE', 'DISTINGUISH', 'REFRAME', 'COUNTEREXAMPLE', 'REDUCE', 'ESCALATE',
]);

export const AttackTypeSchema = z.enum(['rebut', 'undercut', 'undermine']);

export const EdgeStatusSchema = z.enum(['proposed', 'approved', 'rejected']);

export const CanonicalEdgeTypeSchema = z.enum([
  'SUPPORTS', 'CONTRADICTS', 'ASSUMES', 'WEAKENS',
  'RESPONDS_TO', 'TENSION_WITH', 'INTERPRETS', 'CONVERGES_WITH',
]);

export const ParentRelationshipSchema = z.enum(['is_a', 'part_of', 'specializes']);

export const DisagreementTypeSchema = z.enum(['definitional', 'interpretive', 'structural']);

// ── Genus-differentia description patterns ────────────────

/** POV node descriptions must follow: "A [Category] within [POV] discourse that [differentia]..." */
const povDescriptionPattern = /^A\s+(Desires|Beliefs|Intentions)\s+within\s+(accelerationist|safetyist|skeptic)\s+discourse\s+that\s+/i;

/** Situation node descriptions must follow: "A situation that [differentia]..." */
const situationDescriptionPattern = /^A\s+situation\s+that\s+/i;

// ── Graph attributes ──────────────────────────────────────

export const PossibleFallacySchema = z.object({
  fallacy: z.string().min(1),
  type: FallacyTierSchema.optional(),
  confidence: z.enum(['likely', 'possible', 'borderline']),
  explanation: z.string().min(1),
});

export const SteelmanVulnerabilitySchema = z.union([
  z.string(),
  z.object({
    from_accelerationist: z.string().optional(),
    from_safetyist: z.string().optional(),
    from_skeptic: z.string().optional(),
  }),
]);

export const GraphAttributesSchema = z.strictObject({
  epistemic_type: z.string().optional(),
  rhetorical_strategy: z.string().optional(),
  assumes: z.array(z.string()).optional(),
  falsifiability: z.string().optional(),
  audience: z.string().optional(),
  emotional_register: z.string().optional(),
  policy_actions: z.array(z.object({
    policy_id: z.string().optional(),
    action: z.string(),
    framing: z.string(),
  })).optional(),
  intellectual_lineage: z.array(z.union([z.string(), z.object({ name: z.string(), description: z.string().optional(), url: z.string().optional(), category: z.string().optional() })])).optional(),
  steelman_vulnerability: SteelmanVulnerabilitySchema.optional(),
  possible_fallacies: z.array(PossibleFallacySchema).optional(),
  node_scope: NodeScopeSchema.optional(),
});

// ── Taxonomy node schemas ─────────────────────────────────

const ChangeActionSchema = z.enum(['created', 'modified', 'deprecated']);

const ChangeHistoryEntrySchema = z.object({
  date: z.string(),
  action: ChangeActionSchema,
  fields: z.array(z.string()),
});

const WeightHistoryEntrySchema = z.object({
  date: z.string(),
  value: z.number(),
  delta: z.number(),
  reason: z.string(),
  supersedes: z.string().optional(),
  attack_claim: z.string().optional(),
  robustness: z.number().int().min(1).optional(),
  model_confirmations: z.array(z.string()).optional(),
});

export const PovNodeSchema = z.object({
  id: z.string().min(1),
  category: CategorySchema,
  label: z.string().min(1),
  description: z.string().regex(povDescriptionPattern, 'Must follow genus-differentia pattern: "A [Category] within [POV] discourse that..."'),
  parent_id: z.string().nullable(),
  parent_relationship: ParentRelationshipSchema.nullable().optional(),
  parent_rationale: z.string().nullable().optional(),
  children: z.array(z.string()),
  situation_refs: z.array(z.string()),
  conflict_ids: z.array(z.string()).optional(),
  graph_attributes: GraphAttributesSchema.optional(),
  debate_refs: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  confidence_history: z.array(WeightHistoryEntrySchema).optional(),
  doctrinally_anchored: z.boolean().optional(),
  evidential_confidence: z.number().min(0).max(1).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  priority_history: z.array(WeightHistoryEntrySchema).optional(),
  operationality: z.number().int().min(1).max(5).optional(),
  operationality_history: z.array(WeightHistoryEntrySchema).optional(),
  concession_history: z.array(z.object({
    debate_id: z.string(),
    speaker: z.string(),
    text: z.string(),
    turn: z.number(),
    conceded_to: z.string(),
    concession_type: z.enum(['full', 'conditional', 'tactical']),
    bdi_impact: z.enum(['belief', 'desire', 'intention']),
  })).optional(),
  change_history: z.array(ChangeHistoryEntrySchema).optional(),
  // POV tags (t/3955): curated, top-level, POV nodes only. Declared here because a plain z.object STRIPS
  // unknown keys, so a parse-then-save path would otherwise silently delete tags. Element-level checks
  // (kebab-case, unique, registered under this node's POV) run in the superRefine below, via the one
  // shared rule validatePovTags. Absent or empty = untagged (see taxonomy-schema.json node_fields).
  pov_tags: z.array(z.string()).optional(),
  // Selection skips superseded nodes; resolveNode still returns them. See taxonomyLoader.ts › loadTaxonomy.
  superseded_by: z.string().optional(),
}).superRefine((node, ctx) => {
  for (const message of validatePovTags(node.id, node.pov_tags)) {
    ctx.addIssue({ code: 'custom', path: ['pov_tags'], message });
  }
});

export const SituationNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().regex(situationDescriptionPattern, 'Must follow genus-differentia pattern: "A situation that..."'),
  interpretations: z.object({
    accelerationist: z.union([z.string(), z.object({ belief: z.string().optional(), desire: z.string().optional(), intention: z.string().optional(), summary: z.string().optional() })]),
    safetyist: z.union([z.string(), z.object({ belief: z.string().optional(), desire: z.string().optional(), intention: z.string().optional(), summary: z.string().optional() })]),
    skeptic: z.union([z.string(), z.object({ belief: z.string().optional(), desire: z.string().optional(), intention: z.string().optional(), summary: z.string().optional() })]),
  }),
  linked_nodes: z.array(z.string()),
  conflict_ids: z.array(z.string()),
  graph_attributes: GraphAttributesSchema.optional(),
  disagreement_type: DisagreementTypeSchema.optional(),
  debate_refs: z.array(z.string()).optional(),
  // Situations never carry POV tags (t/3955; spec §2.2). Declared as never so a present value is
  // REJECTED rather than silently stripped by z.object's unknown-key handling.
  pov_tags: z.never({ error: 'pov_tags is only allowed on POV nodes; situations ignore tags (t/3955)' }).optional(),
});

// ── Edge schemas ──────────────────────────────────────────

export const EdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1), // Accept canonical + legacy
  bidirectional: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  status: EdgeStatusSchema,
  discovered_at: z.string(),
  model: z.string(),
  strength: z.enum(['strong', 'moderate', 'weak']).optional(),
  notes: z.string().optional(),
});

export const EdgesFileSchema = z.object({
  _schema_version: z.string(),
  _doc: z.string(),
  last_modified: z.string(),
  edge_types: z.array(z.object({
    type: z.string().min(1),
    bidirectional: z.boolean(),
    definition: z.string(),
    llm_proposed: z.boolean().optional(),
  })),
  edges: z.array(EdgeSchema),
  discovery_log: z.array(z.unknown()).optional(),
});

// ── Argument map schemas ──────────────────────────────────

export const ArgumentAttackSchema = z.object({
  claim_id: z.string().min(1),
  claim: z.string().min(1),
  claimant: z.string().min(1),
  attack_type: AttackTypeSchema,
  scheme: DialecticalSchemeSchema.optional(),
});

export const SupportLinkSchema = z.object({
  claim_id: z.string().min(1),
  scheme: DialecticalSchemeSchema.optional(),
  warrant: z.string().optional(),
  critical_questions: z.array(z.object({
    question: z.string(),
    addressed: z.boolean(),
  })).optional(),
});

export const ArgumentClaimSchema = z.object({
  claim_id: z.string().min(1),
  claim: z.string().min(1),
  claimant: z.string().min(1),
  type: z.enum(['empirical', 'normative', 'definitional']).optional(),
  supported_by: z.array(z.union([z.string(), SupportLinkSchema])).optional(),
  attacked_by: z.array(ArgumentAttackSchema).optional(),
});

// ── Session schemas ───────────────────────────────────────

/**
 * Zod schema for soul-file provenance (matches SoulProvenance from soulDocSchema.ts).
 * Declared here for use in DebateSessionSchema without circular deps.
 */
export const SessionSoulProvenanceSchema = z.object({
  file: z.string(),
  hash: z.string(),
});

/**
 * Persisted Zod schema for DebateSession optional fields.
 * `.passthrough()` preserves all existing fields in saved sessions.
 * Declare every new optional session field here so it is not stripped on
 * re-parse (t/2890 class). Old debates without the field still load (`.optional()`).
 */
export const DebateSessionSchema = z.object({
  soul_provenance: z.record(z.string(), SessionSoulProvenanceSchema).optional(),
  failover_untracked: z.boolean().optional(),
}).passthrough();

// ── Synthesis schemas ─────────────────────────────────────

export const SynthesisDisagreementSchema = z.object({
  point: z.string(),
  positions: z.array(z.object({
    pover: z.string(),
    stance: z.string(),
  })),
  bdi_layer: BdiLayerSchema.optional(),
  resolvability: z.enum([
    'resolvable_by_evidence',
    'negotiable_via_tradeoffs',
    'requires_term_clarification',
  ]).optional(),
});
