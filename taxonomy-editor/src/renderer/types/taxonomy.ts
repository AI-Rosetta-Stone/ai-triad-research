// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Shared taxonomy types (canonical source: lib/debate/taxonomyTypes.ts) ──

export type {
  Pov,
  Category,
  FallacyTier,
  PossibleFallacy,
  GraphAttributes,
  ParentRelationship,
  WeightHistoryEntry,
  TextEditSource,
  TextHistoryEntry,
  NodeEditMeta,
  EditHistoryEntry,
  PovNode,
  ChangeAction,
  ChangeHistoryEntry,
  ConcessionType,
  ConcessionRecord,
  BdiInterpretation,
  Interpretation,
  SituationNode,
  CrossCuttingNode,
  EdgeStatus,
  CanonicalEdgeType,
  EdgeType,
  Edge,
  EdgeTypeDefinition,
  EdgesFile,
} from '@lib/debate/taxonomyTypes';

export { interpretationText, isBdiInterpretation } from '@lib/debate/taxonomyTypes';

// ── TE-only types ──

import type { Pov, PovNode, SituationNode } from '@lib/debate/taxonomyTypes';

export interface PovTaxonomyFile {
  _schema_version: string;
  _doc: string;
  pov: Pov;
  color_hex: string;
  last_modified: string;
  nodes: PovNode[];
}

export interface SituationsFile {
  _schema_version: string;
  _doc: string;
  last_modified: string;
  nodes: SituationNode[];
}

/** @deprecated Use SituationsFile */
export type CrossCuttingFile = SituationsFile;

export type ConflictStance = 'supports' | 'disputes' | 'neutral' | 'qualifies';

export interface ConflictInstance {
  doc_id: string;
  stance: ConflictStance;
  assertion: string;
  date_flagged: string;
}

export interface ConflictNote {
  author: string;
  date: string;
  note: string;
}

export interface ConflictQbafNode {
  id: string;
  text: string;
  source_pov: string;
  base_strength: number;
  computed_strength: number;
  bdi_category?: string;
  bdi_sub_scores?: Record<string, number>;
  attribution_text_genus?: string;
}

export interface ConflictQbafEdge {
  source: string;
  target: string;
  type: 'attacks' | 'supports';
  attack_type?: 'rebut' | 'undercut' | 'undermine';
  weight: number;
}

export interface ConflictQbaf {
  graph: {
    nodes: ConflictQbafNode[];
    edges: ConflictQbafEdge[];
  };
  resolution?: {
    // Nullable on the undecided path (t/3151 Part 1, #1717): a QBAF with no clear winner
    // produces null for both + verdict/reason. Consumers null-guard (ConflictDetail.tsx).
    prevailing_claim: string | null;
    prevailing_strength: number | null;
    margin: number;
    criterion: string;
    verdict?: 'decided' | 'undecided';
    reason?: string;
  };
  computed_at: string;
  algorithm: string;
  iterations: number;
  oscillation_detected?: boolean;
  damping_level?: number;
}

export interface DialecticTraceStep {
  step: number;
  claim_id: string;
  speaker: string;
  claim: string;
  action: 'asserted' | 'attacked' | 'supported' | 'conceded' | 'unaddressed';
  scheme?: string;
  attack_type?: 'rebut' | 'undercut' | 'undermine';
  responds_to?: string;
  strength?: number;
  turn?: number;
}

export interface DialecticTrace {
  conflict: string;
  prevailing: string;
  criterion: string;
  steps: DialecticTraceStep[];
  debate_id: string;
  generated_at: string;
}

export interface ConflictVerdict {
  prevailing_stance?: string;
  criterion?: string;
  rationale?: string;
  debate_id?: string;
  dialectic_trace?: DialecticTrace;
}

export interface ConflictFile {
  claim_id: string;
  claim_label: string;
  description: string;
  status: 'open' | 'resolved' | 'wont-fix';
  linked_taxonomy_nodes: string[];
  instances: ConflictInstance[];
  human_notes: ConflictNote[];
  qbaf?: ConflictQbaf;
  verdict?: ConflictVerdict;
}

export type TabId = 'rosetta-stone' | 'accelerationist' | 'safetyist' | 'skeptic' | 'situations' | 'conflicts' | 'cruxes' | 'debate' | 'chat' | 'opeds' | 'summaries' | 'validation' | 'organizations' | 'inquiry';
