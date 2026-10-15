// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { ConfigSlice } from './slices/configSlice';
import type { SessionSlice } from './slices/sessionSlice';
import type { TopicCritiqueSlice } from './slices/topicCritiqueSlice';
import type { ClarificationSlice } from './slices/clarificationSlice';
import type { ArgumentNetworkSlice } from './slices/argumentNetworkSlice';
import type { SynthesisSlice } from './slices/synthesisSlice';
import type { DebateLoopSlice } from './slices/debateLoopSlice';
import type { DebatePhaseSlice } from './slices/debatePhaseSlice';
import type { RunLeaseSlice } from './slices/runLeaseSlice';
import type { DebateReflectionSlice } from './slices/debateReflectionSlice';
import type { ExplorationSlice } from './slices/explorationSlice';
import type { NewPovItemProposal } from '@lib/debate/types/session';

export type DebateStore =
  ConfigSlice &
  SessionSlice &
  TopicCritiqueSlice &
  ClarificationSlice &
  ArgumentNetworkSlice &
  SynthesisSlice &
  DebateLoopSlice &
  DebatePhaseSlice &
  RunLeaseSlice &
  DebateReflectionSlice &
  ExplorationSlice;

// ── Shared types used across slices ──────────────────────────

export interface ReflectionEdit {
  edit_type: 'revise' | 'add' | 'qualify' | 'deprecate';
  node_id: string | null;
  category: 'Beliefs' | 'Desires' | 'Intentions';
  current_label: string | null;
  proposed_label: string;
  current_description: string | null;
  proposed_description: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  evidence_entries: string[];
  status: 'pending' | 'approved' | 'dismissed';
  /** Evidence check (t/3512): false when no cited claim references `node_id`. Such an edit is
   *  flagged, not applied — `applyReflectionEdit` refuses it unless explicitly overridden. */
  evidence_supported?: boolean;
  /** Human-readable outcome of the evidence check (shown on the edit, logged on refusal). */
  evidence_note?: string;
  /** Engagement of `node_id` in this debate — drives the "never engaged" badge. */
  engagement?: { injected: boolean; citations: number; claim_count: number; attacked_count: number };
  /** The reviewer's final decision, saved into the debate file's reflection snapshot (t/4214 R-5). Absent
   *  while pending, and in debates saved before this field existed. Read by CL's M2 measurement (t/4211 §6). */
  decision?: ReflectionDecision;
}

/** A reflection decision (t/4214 R-5). `overridden` means applied with at least one gate overridden;
 *  `overrides` names which. `cross_tag` joins `evidence` once the R-3 tag gate lands. */
export interface ReflectionDecision {
  outcome: 'applied' | 'dismissed' | 'overridden';
  at: string;
  overrides?: ('evidence' | 'cross_tag')[];
}

export interface ReflectionResult {
  pover: string;
  label: string;
  reflection_summary: string;
  edits: ReflectionEdit[];
  /** Validated new-node proposals (disposition:'propose_new') from the shared generator.
   *  Additive front-half of t/1773; the accept/apply + UI land in the follow-on. */
  new_item_proposals?: NewPovItemProposal[];
  /** Saved decisions on `new_item_proposals`, keyed by proposal index (t/4214 R-5). Kept here rather than on
   *  the lib-owned proposal type. Read by CL's M2 measurement (t/4211 §6). */
  proposal_decisions?: Record<number, ReflectionDecision>;
}

// t/3257: source of truth relocated to lib/debate/relevanceSelection.ts (the pure relevance-
// selection fn produces it; server + client type against the same definition). Re-exported here
// so existing renderer imports (`from '../types'`) keep working.
export type { NodeScoringSource } from '@lib/debate/relevanceSelection';

export interface RelevanceSourceEntry {
  node_id: string;
  source: 'an' | 'topic';
  an_score: number;
  topic_score: number;
  best_claim_id?: string;
  best_claim_text?: string;
  best_claim_sim?: number;
}
