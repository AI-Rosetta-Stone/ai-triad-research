// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { PovKey } from '../debate/types.js';
import type { TagMode, TagSelection, AppliedTag } from '../schema/povTags.js';

export type { PovKey };

// ── Shared generation params ──────────────────────────────────────────────────

export interface OpEdParams {
  outlet?: string;
  wordCount: number;
  newsHook?: string;
  thesis?: string;
  authorBio?: string;
  model: string;
  /** POV tag for ONE member (t/3960). The member whose `pov` matches gets the tag soul and the tag
   *  filter; every other member runs exactly as untagged. Absent: an untagged set, as before. */
  tagSelection?: TagSelection;
  /** Max BDI grounding nodes per camp (t/203). Integer 0–40; default 12; 0 = no BDI grounding. */
  maxGroundingNodes?: number;
  /** Max situation nodes, shared across camps (t/203). Integer 0–15; default 3. */
  maxSituations?: number;
  /** Sampling temperature for the generation call only (t/203). 0–2; default 0.8. */
  temperature?: number;
  /** Skip grounding entirely and argue from the camp voice alone (t/203). Default false. */
  voiceOnly?: boolean;
}

/** Which soul file voiced a member (t/3960; t/4007). `file` is soul-docs-relative (e.g. "skeptic.soul.json");
 *  `hash` is "fnv1a64:" + 16 hex chars from soulDocHash(). Pre-t/4007 entries carry `sha` (first 16 hex of
 *  SHA-256, no prefix) — the schema normalises both to `hash` on read. Internal provenance: EXCLUDED from
 *  the public share (TL e/254#4), same class as `debateId`. */
export interface OpEdSoulProvenance {
  file: string;
  /** Absent when neither `hash` nor `sha` was present in the stored record (legacy sets pre-t/4007 that
   *  had no provenance). `compareSoulProvenance` returns `unknown` for any absent or malformed hash. */
  hash?: string;
}

// ── Grounding reference (op-ed shape — node + editorial context) ──────────────

export interface OpEdGroundingRef {
  node_id: string;
  label: string;
  category: string;
  pov: PovKey;
  relevance: string;
  how_reflected: string;
  document_claims?: string[];  // source claims this BDI element responds to (absent when no source brief)
}

// ── Per-voice member (self-contained — e/91#2 condition 3) ───────────────────
//
// Every field needed to render, export, or submit one voice stands alone here.
// Members share only topic/params from the set wrapper; nothing else crosses
// the boundary, so a future per-doc split is a mechanical migration.

export interface OpEdMember {
  pov: PovKey;
  /** Partial-set contract (e/91#2 condition 1): a run with failures finalizes
   *  as a partial set — failed/cancelled members carry status, not an omission. */
  status: 'complete' | 'failed' | 'cancelled';
  headline: string;
  subtitle: string;
  body: string;
  byline: string;
  disclosure: string;
  rhetorical_meta: string;
  wordCount: number;
  grounding: OpEdGroundingRef[];
  /** Source claims extracted by the reflection pass (t/2890) — absent when no source brief or claims list is empty. */
  claims?: { text: string; paragraph: number }[];
  /** Set when FABRICATED_LEDE_GUARD matched the lede on an empty-newsHook run (t/2730). */
  fabricated_lede?: true;
  /** Observability for the readability edit pass (t/3707). Absent when the edit pass was skipped
   *  (body already met targets). NO consumer should branch on this field; exemption lapses if one does. */
  editing_meta?: EditingMeta;
  /** Observability for the logical-coherence pass (t/3826). Absent when pass was skipped (no flags).
   *  NO consumer should branch on this field; exemption lapses if one does. */
  coherence_meta?: CoherenceMeta;
  /** What the tag actually did for THIS member (t/3960; SO e/252 cond 3 / e/254#6). Present only on the
   *  tagged member. Count meanings per mode: `APPLIED_TAG_COUNT_MEANING` (lib/schema/povTags.ts). */
  tag?: AppliedTag;
  /** Which soul file voiced this member. Set on every generated member, base or tag soul. */
  soul?: OpEdSoulProvenance;
  /** Every model call made for this member, in the order they ran (t/171), for the How panel (t/170).
   *  The set-level source brief is copied in as entry 0. Absent on sets generated before t/171. */
  stages?: OpEdStage[];
}

/** The op-ed pipeline's model calls (t/171). The schema keeps `stage` a plain string so an older reader
 *  never rejects a set over a stage name it doesn't know; lib only writes these. */
export type OpEdStageName =
  | 'source-brief'
  | 'generation'
  | 'coherence-judge'
  | 'coherence-rewrite'
  | 'coherence-rejudge'
  | 'readability-edit'
  | 'grounding-reflection';

/** One model call, captured verbatim (t/171). */
export interface OpEdStage {
  stage: OpEdStageName;
  /** 1-based; >1 only for a retried call (readability-edit and grounding-reflection can retry once). */
  attempt: number;
  /** The model id the call was sent to. */
  model: string;
  /** The exact string passed to the adapter (generation: system + "\n\n---\n\n" + user). Capped at
   *  OPED_STAGE_TEXT_CAP chars; past it, it ends with "…[truncated N chars]". */
  prompt: string;
  /** The model's raw text before any parsing or cleanup (same cap). '' when the call threw. */
  output: string;
  /** Present only when the call threw. */
  error?: string;
  /** The sampling temperature the call was sent with (t/203). */
  temperature?: number;
}

/** Outcome record for the readability edit pass (t/3707). Written for CL validation tooling; log-only. */
export interface EditingMeta {
  /** Whether the body was actually replaced by the edit (false = skipped / reverted / error). */
  edited: boolean;
  fk_before: number;
  fk_after: number;
  /** Names of checks that still failed after the edit (empty = all passed). */
  checks_failed_after: string[];
  /** Populated when the edit was reverted: reason string. */
  reverted_reason?: string;
}

/** Outcome record for the logical-coherence pass (t/3826). Written for CL validation tooling; log-only. */
export interface CoherenceMeta {
  any_flagged: boolean;
  /** check_ids that produced valid (both-spans-quoted) flags on the original body. */
  checks_fired: string[];
  /** The valid flags verbatim — spans are non-negotiable for CL's false-positive study. */
  flags: Array<{ check_id: string; span_a: string; span_b: string; why: string }>;
  /** Model the coherence judge ran on — required for CL's evaluator-sensitivity study (t/3826#4). */
  judge_model: string;
  body_length_before: number;
  /** Populated when the body was replaced by the coherence rewrite. */
  body_length_after?: number;
  rewritten: boolean;
  /** check_ids that still flagged after an accepted rewrite (empty = all resolved). */
  checks_still_flagged_after?: string[];
  /** Populated when the rewrite was reverted. */
  reverted_reason?: string;
}

// ── Set wrapper (e/91#2 conditions 2 & 4) ────────────────────────────────────
//
// One document per run — the product's atomic unit for create/open/share/submit.
// Single-voice runs are a set of 1; there is no special storage shape for them.
// schema_version is a literal 1 from day one so future migrations are unambiguous.

export interface OpEdSet {
  schema_version: 1;
  set_id: string;
  topic: string;
  params: OpEdParams;
  created_at: string;
  opeds: OpEdMember[];
  /** Source provenance (t/2897): how this set was created. Absent on pre-existing sets. */
  source_mode?: 'topic' | 'url' | 'document';
  /** The fetched source URL — url mode only. */
  source_url?: string;
  /** The source document file name (without path) — document mode only. */
  source_name?: string;
  /** key_claims extracted by the comprehension pass (0 = brief failed/empty). url mode only. */
  source_key_claims_count?: number;
}

// ── Local library listing summary (t/2591) ───────────────────────────────────
//
// Returned by list-oped-sets IPC so OpEdTable renders camp chips + voice count
// without loading the full set doc. Derived from OpEdSet at list time.

export interface OpEdSetSummary {
  set_id: string;
  topic: string;
  created_at: string;
  updated_at?: string;
  camps: PovKey[];
  voice_count: number;
  /** t/2993: forwarded from OpEdSet.params.outlet at finalize time. Absent on older sets → render '—'. */
  outlet?: string;
}

// ── Community index entry (e/91#2 condition 5) ────────────────────────────────
//
// Carried in the listing index so list rows render camp chips without loading
// the full set doc. voice_count = opeds.length at submission time.

export interface OpEdCommunityEntry {
  id: string;
  topic: string;
  created_at: string;
  updated_at: string;
  camps: PovKey[];
  voice_count: number;
  community_metadata: unknown;
  /** t/2993: forwarded from the stored op-ed's params.outlet at index-build time. */
  outlet?: string;
  /** The tagged member's scope, so a list row never labels a one-wing essay as the whole camp's (TL
   *  t/3960#3 cond 2). `label` is the wing name from the tag registry. Absent for untagged sets. */
  tag?: { pov: PovKey; tag: string; mode: TagMode; label: string };
}
