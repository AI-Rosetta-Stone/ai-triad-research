// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/388: plan-level steelman references. The plan records the ids it was offered, and an ATTACK tag
// is kept only when its id was offered. A tag outside the offered list is stripped, with a WARN.
// t/487: an AN id anywhere else in a challenge's prose is masked for later stages, and any AN id in
// the statement is masked. The stored plan keeps what the model wrote.

import type { OpeningPlanWorkProduct } from '../types/pipeline.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';
import { anchorPhrase, planClaimAnchors, verifyAttackAnchors, withoutAnchorPhrase } from './attackAnchors.js';
import { maskAnIds } from './anIds.js';

const ATTACK_TAG = /^ATTACK \[([^\]]+)\]:/;

/** The ids offered to a plan, from the pipeline input. */
export function offeredIdsOf(input: { steelmanRefsOffered?: { id: string }[] }): string[] {
  return (input.steelmanRefsOffered ?? []).map(r => r.id);
}

const CHALLENGE_TYPES = new Set(['ATTACK', 'ASSUMPTION']);
const NO_ANCHORS: ReadonlySet<string> = new Set();

function firstText(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * One anticipated challenge in the string form the prompt asks for (t/485). A model sometimes
 * returns an object ({ type, target, description }) instead. The object becomes "TYPE: text".
 * An ATTACK keeps "[target]" only when the target is an offered steelman id. An argument-network
 * id (AN-n) that was not offered is dropped from the text, so it cannot reach a later prompt. Any
 * other target (a taxonomy node id, for example) is kept as trailing text, never as a tag. The
 * model's own type label is kept; a missing or unusable one becomes OTHER. An item with no usable
 * text is kept as its JSON, minus an unoffered AN target.
 */
export function challengeToString(item: unknown, allowed: ReadonlySet<string>, claimAnchors: ReadonlySet<string> = new Set()): string {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return `OTHER: ${JSON.stringify(item)}`;
  const o = item as Record<string, unknown>;
  const type = challengeType(o.type);
  const target = typeof o.target === 'string' ? o.target.trim() : '';
  const unofferedAn = AN_ID.test(target) && !allowed.has(target);
  const ownText = firstText(o, ['description', 'text', 'challenge', 'claim']);
  const text = ownText ?? JSON.stringify(unofferedAn ? { ...o, target: undefined } : o);
  if (type === 'ATTACK') {
    const attack = attackWithKnownTarget(text, target, allowed, claimAnchors);
    if (attack) return attack;
  }
  // An item kept as its JSON already shows its target, so it is not appended again.
  return target && !unofferedAn && ownText ? `${type}: ${text} (target: ${target})` : `${type}: ${text}`;
}

/**
 * An ATTACK whose target the engine recognises: an offered steelman id becomes the tag, and one of
 * the plan's own claim anchors becomes the phrase the card reads (t/388). Otherwise undefined.
 */
function attackWithKnownTarget(text: string, target: string, allowed: ReadonlySet<string>, claimAnchors: ReadonlySet<string>): string | undefined {
  if (!target) return undefined;
  if (allowed.has(target)) return `ATTACK [${target}]: ${text}`;
  if (claimAnchors.has(target)) return `ATTACK: ${text}${anchorPhrase(target)}`;
  return undefined;
}

const AN_ID = /^AN-\d+$/;

/** The model's type label in upper case, when it is a short plain label; otherwise OTHER. */
function challengeType(raw: unknown): string {
  const t = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (CHALLENGE_TYPES.has(t)) return t;
  return /^[A-Z][A-Z_ -]{0,30}$/.test(t) ? t : 'OTHER';
}

/** The target of an object item when it is an argument-network id that was not offered, else undefined. */
function unofferedAnTarget(item: unknown, allowed: ReadonlySet<string>): string | undefined {
  const target = item && typeof item === 'object' ? (item as Record<string, unknown>).target : undefined;
  return typeof target === 'string' && AN_ID.test(target.trim()) && !allowed.has(target.trim()) ? target.trim() : undefined;
}

/** Put every anticipated challenge in string form, with one WARN per object that had to be converted (t/485). */
function normalizeChallenges(challenges: unknown[], allowed: ReadonlySet<string>, claimAnchors: ReadonlySet<string>, debateId?: string): string[] {
  return challenges.map(c => {
    if (typeof c === 'string') return c;
    const asString = challengeToString(c, allowed, claimAnchors);
    const dropped = unofferedAnTarget(c, allowed);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: debateId,
      message: `plan anticipated_challenges item was not a string; converted to "${asString.slice(0, 80)}"${dropped ? `; target ${dropped} is not in steelman_refs_offered and was dropped` : ''} (t/485)`,
      data: { original: JSON.stringify(c).slice(0, 600), ...(dropped ? { dropped_target: dropped } : {}) },
    });
    return asString;
  });
}

/** A challenge split into its leading "ATTACK [id]:" tag (or '') and the prose after it. */
function splitTag(challenge: string): { tag: string; body: string } {
  const m = ATTACK_TAG.exec(challenge);
  return m ? { tag: m[0], body: challenge.slice(m[0].length) } : { tag: '', body: challenge };
}

/**
 * t/487: an AN id in a challenge's prose that was not offered is an invented reference, like an
 * unoffered tag. One WARN per challenge names the ids. The stored plan is left as the model wrote
 * it, since it is the record and the card reads it (Comp-Linguist ruling p/183#60). Later stages
 * and the statement never get the id (planForLaterStages, stripSteelmanIdsFromStatement).
 */
function warnUnofferedIdsInProse(challenge: unknown, allowed: ReadonlySet<string>, debateId?: string): void {
  if (typeof challenge !== 'string') return;
  const { masked } = maskAnIds(splitTag(challenge).body, allowed);
  if (masked.length === 0) return;
  const ids = [...new Set(masked)];
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: debateId,
    message: `plan challenge names ${ids.length} argument id(s) in its text that are not in steelman_refs_offered (${ids.join(', ')}); kept in the stored plan, masked for later stages (t/487)`,
    data: { unoffered_ids: ids, challenge: challenge.slice(0, 400) },
  });
}

/**
 * Apply the offered list to a plan: record the offered ids, put every challenge in string form,
 * and strip any ATTACK tag not among the offered ids. With attackAnchors on (config.planAttackAnchors,
 * t/388) it also checks each "targeting node <anchor>" phrase. With it off, anchors are not looked at
 * and a plan is stored exactly as it would be without that feature.
 */
export function applyPlanSteelmanRefs(plan: OpeningPlanWorkProduct | undefined, offeredIds: string[], debateId?: string, attackAnchors = false): void {
  if (!plan) return;
  plan.steelman_refs_offered = offeredIds;
  if (!Array.isArray(plan.anticipated_challenges)) return;
  const allowed = new Set(offeredIds);
  plan.anticipated_challenges = normalizeChallenges(plan.anticipated_challenges as unknown[], allowed, attackAnchors ? planClaimAnchors(plan) : NO_ANCHORS, debateId);
  plan.anticipated_challenges = plan.anticipated_challenges.map(c => {
    const m = typeof c === 'string' ? ATTACK_TAG.exec(c) : null;
    if (!m || allowed.has(m[1])) return c;
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: debateId,
      message: `plan ATTACK tag [${m[1]}] is not in steelman_refs_offered; tag stripped (t/388)`,
    });
    return c.replace(ATTACK_TAG, 'ATTACK:');
  });
  for (const c of plan.anticipated_challenges) warnUnofferedIdsInProse(c, allowed, debateId);
  // t/388: keep a "targeting node <anchor>" phrase only when the anchor is one of this plan's claims.
  if (attackAnchors) verifyAttackAnchors(plan, debateId);
}

/**
 * The plan as later stages see it (draft, cite): ATTACK tags reduced to plain "ATTACK:" and the
 * offered list removed. With attackAnchors on, any "targeting node <anchor>" phrase is removed too.
 * Both are for the plan card only, so they never enter a later prompt. A plan with neither is
 * passed on unchanged, and with attackAnchors off the phrase is not looked at. Any AN id left in a
 * challenge's prose is masked too, offered or not (t/487): the ids are for the card, not for a prompt.
 */
export function planForLaterStages<T extends OpeningPlanWorkProduct | undefined>(plan: T, attackAnchors = false): T {
  if (!plan) return plan;
  const { steelman_refs_offered: _offered, ...rest } = plan;
  const challenges = Array.isArray(rest.anticipated_challenges)
    ? rest.anticipated_challenges.map(c => (typeof c === 'string' ? maskAnIds((attackAnchors ? withoutAnchorPhrase(c) : c).replace(ATTACK_TAG, 'ATTACK:')).text : c))
    : rest.anticipated_challenges;
  return { ...rest, anticipated_challenges: challenges } as T;
}

/**
 * Guard for the statement text: mask any argument-network id that reached it, bracketed or bare,
 * offered or not (t/388, widened by t/487), with a WARN. Later stages get the plan without ids, so
 * this should find nothing. A statement with no AN id is returned unchanged.
 */
export function stripSteelmanIdsFromStatement(statement: string, offeredIds: string[], debateId?: string): string {
  if (!statement) return statement;
  const { text, masked } = maskAnIds(statement);
  if (masked.length === 0) return statement;
  const offered = new Set(offeredIds);
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: debateId,
    message: `statement carried ${masked.length} argument id(s); masked (t/388, t/487)`,
    data: { masked_ids: [...new Set(masked)], offered: [...new Set(masked)].filter(id => offered.has(id)) },
  });
  return text;
}

/** Apply the statement guard to a parsed draft, in place. A draft with no statement is left alone. */
export function stripSteelmanIdsFromDraft(draft: { statement?: string } | undefined, offeredIds: string[], debateId?: string): void {
  if (!draft?.statement) return;
  draft.statement = stripSteelmanIdsFromStatement(draft.statement, offeredIds, debateId);
}
