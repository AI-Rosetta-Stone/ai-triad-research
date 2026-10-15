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
  /** Tag-aware reflection stamp (t/4214 R-2, spec t/4211 §3, §4), set after the DOLCE retries. `applyReflectionEdit`
   *  branches on it (the R-3 gate), and it is saved in the reflection snapshot for CL's M2. Absent on edits from
   *  before this field and on edit types the gate does not check. */
  tag_check?: ReflectionTagCheck;
}

/** The tag check on one reflection edit (t/4214 R-2). */
export interface ReflectionTagCheck {
  relation: import('@lib/debate/reflectionScope').TagRelation;
  /** Custodian soul ids the check ran against, e.g. `skeptic.institutional`. Empty when none were needed. */
  custodians: string[];
  seat_tag: string | null;
  target_tags: string[];
  /** Fingerprint of `target_tags`; a mismatch with the node's live tags makes the stamp stale. */
  tags_fp: string;
  /** Hash of the checked label and description; a reviewer override of either makes the stamp stale. */
  text_hash: string;
  verdicts?: import('@lib/debate/prompts/reflectionTagCheck').CustodianVerdictRow[];
  /** Set when the check ran but its result can't be trusted (or the call failed); the edit is gated. */
  unchecked?: string;
  /** Model id of the custodian check, when one ran. */
  model?: string;
  /** Spec §3 rule 4: a tagged seat deprecating shared ground is always a conflict. */
  deprecate_shared_note?: string;
}

/** A reflection decision (t/4214 R-5). `overridden` means applied with at least one gate overridden;
 *  `overrides` names which. */
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
