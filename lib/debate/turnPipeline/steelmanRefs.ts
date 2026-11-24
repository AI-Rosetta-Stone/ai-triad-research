// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/388: plan-level steelman references. The plan records the ids it was offered, and an ATTACK tag
// is kept only when its id was offered. A tag outside the offered list is stripped, with a WARN.

import type { OpeningPlanWorkProduct } from '../types/pipeline.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';

const ATTACK_TAG = /^ATTACK \[([^\]]+)\]:/;

/** The ids offered to a plan, from the pipeline input. */
export function offeredIdsOf(input: { steelmanRefsOffered?: { id: string }[] }): string[] {
  return (input.steelmanRefsOffered ?? []).map(r => r.id);
}

const CHALLENGE_TYPES = new Set(['ATTACK', 'ASSUMPTION']);

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
 * An ATTACK keeps "[target]" only when the target is an offered steelman id; any other target
 * (a taxonomy node id, for example) is kept as trailing text, never as a tag. An item with no
 * usable text is kept as its JSON, so nothing the model wrote is dropped.
 */
export function challengeToString(item: unknown, allowed: ReadonlySet<string>): string {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return `ATTACK: ${JSON.stringify(item)}`;
  const o = item as Record<string, unknown>;
  const rawType = typeof o.type === 'string' ? o.type.trim().toUpperCase() : '';
  const type = CHALLENGE_TYPES.has(rawType) ? rawType : 'ATTACK';
  const text = firstText(o, ['description', 'text', 'challenge', 'claim']) ?? JSON.stringify(item);
  const target = typeof o.target === 'string' ? o.target.trim() : '';
  if (type === 'ATTACK' && target && allowed.has(target)) return `ATTACK [${target}]: ${text}`;
  return target ? `${type}: ${text} (target: ${target})` : `${type}: ${text}`;
}

/** Put every anticipated challenge in string form, with one WARN per object that had to be converted (t/485). */
function normalizeChallenges(challenges: unknown[], allowed: ReadonlySet<string>, debateId?: string): string[] {
  return challenges.map(c => {
    if (typeof c === 'string') return c;
    const asString = challengeToString(c, allowed);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: debateId,
      message: `plan anticipated_challenges item was not a string; converted to "${asString.slice(0, 80)}" (t/485)`,
      data: { original: JSON.stringify(c).slice(0, 600) },
    });
    return asString;
  });
}

/**
 * Apply the offered list to a plan: record the offered ids, put every challenge in string form,
 * and strip any ATTACK tag not among the offered ids.
 */
export function applyPlanSteelmanRefs(plan: OpeningPlanWorkProduct | undefined, offeredIds: string[], debateId?: string): void {
  if (!plan) return;
  plan.steelman_refs_offered = offeredIds;
  if (!Array.isArray(plan.anticipated_challenges)) return;
  const allowed = new Set(offeredIds);
  plan.anticipated_challenges = normalizeChallenges(plan.anticipated_challenges as unknown[], allowed, debateId);
  plan.anticipated_challenges = plan.anticipated_challenges.map(c => {
    const m = typeof c === 'string' ? ATTACK_TAG.exec(c) : null;
    if (!m || allowed.has(m[1])) return c;
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: debateId,
      message: `plan ATTACK tag [${m[1]}] is not in steelman_refs_offered; tag stripped (t/388)`,
    });
    return c.replace(ATTACK_TAG, 'ATTACK:');
  });
}

/**
 * The plan as later stages see it (draft, cite): ATTACK tags reduced to plain "ATTACK:" and the
 * offered list removed. The ids are for the plan card only, so they never enter a later prompt,
 * and with nothing offered the later prompts are unchanged.
 */
export function planForLaterStages<T extends OpeningPlanWorkProduct | undefined>(plan: T): T {
  if (!plan) return plan;
  const { steelman_refs_offered: _offered, ...rest } = plan;
  const challenges = Array.isArray(rest.anticipated_challenges)
    ? rest.anticipated_challenges.map(c => (typeof c === 'string' ? c.replace(ATTACK_TAG, 'ATTACK:') : c))
    : rest.anticipated_challenges;
  return { ...rest, anticipated_challenges: challenges } as T;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Guard for the statement text: remove any bracketed offered id ("[AN-3]") that reached it, with a
 * WARN. Later stages get the plan without tags, so this should find nothing.
 */
export function stripSteelmanIdsFromStatement(statement: string, offeredIds: string[], debateId?: string): string {
  if (!statement || offeredIds.length === 0) return statement;
  const pattern = new RegExp(` ?\\[(?:${offeredIds.map(escapeRegExp).join('|')})\\]`, 'g');
  let removed = 0;
  const out = statement.replace(pattern, () => { removed++; return ''; });
  if (removed > 0) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: debateId,
      message: `statement carried ${removed} steelman reference id(s) from the plan; removed (t/388)`,
    });
  }
  return out;
}

/** Apply the statement guard to a parsed draft, in place. A draft with no statement is left alone. */
export function stripSteelmanIdsFromDraft(draft: { statement?: string } | undefined, offeredIds: string[], debateId?: string): void {
  if (!draft?.statement) return;
  draft.statement = stripSteelmanIdsFromStatement(draft.statement, offeredIds, debateId);
}
