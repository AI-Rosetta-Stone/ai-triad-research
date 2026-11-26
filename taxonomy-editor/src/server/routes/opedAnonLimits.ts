// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/500 part C (t/666): the limits on a STORED anonymous op-ed, all checked before any spend and all from runtime config
// (sessions.*, t/500 rulings):
//   - admission shape (TL t/500#27): at most anonOpEdMaxVoices voices (1, t/723) and anonOpEdMaxWords words per voice (1,500),
//     More voices is a 403 anon_oped_voices (t/723); more words is a 400.
//   - live sets (PI, t/500#4): at most anonOpEdLiveSetLimit (10) live sets per visitor; the next create is 429
//     anon_oped_limit and nothing is written. Expired sets don't count (the store drops them on list).
//   - byte cap (TL t/500#60): the run's worst-case stored size must fit anonOpEdByteCap (106,496 B) at admission, so a
//     finished, paid run is never discarded. A saved set over two thirds of the cap logs a WARN (t/500#61).

import type { ServerResponse } from 'http';
import { json, error } from '../httpKit.js';
import { getConfig } from '../runtimeConfig.js';
import { listOpedSets, getOpedSetsQuotaStatus } from '../storage/opedStore.js';
import { isAnonymousUser } from '../security/userContext.js';
import { resolveOutletBand } from '../../../../lib/oped/outletBands.js';
import { log } from '../logger.js';
import { refuseAnonLimit } from './anonDebateLimits.js';

/** Stored bytes per body word (measured 6.2 on a real set, t/500#59), rounded up. */
export const ANON_OPED_BYTES_PER_WORD = 7;
/** Per-voice metadata bound (measured: about 25.5 KB of metadata for 3 voices, t/500#59), with margin. */
export const ANON_OPED_METADATA_BYTES_PER_VOICE = 12_000;

/** The effective words per voice: the request's wordCount, or the outlet band's default when it sends none. */
export function effectiveWords(wordCount: number, outlet: string | undefined): number {
  return wordCount > 0 ? wordCount : resolveOutletBand(outlet).words;
}

/** The worst-case stored size of an anonymous set, from its shape. */
export function anonOpEdWorstCaseBytes(voices: number, words: number): number {
  return voices * (words * ANON_OPED_BYTES_PER_WORD + ANON_OPED_METADATA_BYTES_PER_VOICE);
}

/** Refuse (400, before any spend) an anonymous request over the admission shape or the byte cap. True when written.
 *  Each refusal carries a stable `code` (anon_oped_voices (403), anon_oped_too_many_words, anon_oped_too_large), so
 *  the client never matches on the sentence (Rosetta Stone p/74#36). */
export function refuseAnonOpEdShape(res: ServerResponse, voices: number, wordCount: number, outlet: string | undefined): boolean {
  const s = getConfig().sessions;
  const words = effectiveWords(wordCount, outlet);
  // t/723 (PI 2026-11-26): more voices than the limit is a sign-in limit, so 403 anon_oped_voices (shared refusal shape).
  if (voices > s.anonOpEdMaxVoices) return refuseAnonLimit(res, 'POST /api/oped-sets', { code: 'anon_oped_voices', detail: `voices=${voices}`, limit: s.anonOpEdMaxVoices });
  if (words > s.anonOpEdMaxWords) {
    error(res, `Anonymous op-eds allow at most ${s.anonOpEdMaxWords} words per voice. Sign in for longer op-eds.`, 400, undefined, { code: 'anon_oped_too_many_words', limit: s.anonOpEdMaxWords });
    return true;
  }
  const worst = anonOpEdWorstCaseBytes(voices, words);
  if (worst > s.anonOpEdByteCap) {
    log.server.warn({ component: 'oped', voices, words, worst, cap: s.anonOpEdByteCap }, 'Anonymous op-ed refused at admission: worst-case size exceeds the byte cap (t/500)');
    error(res, 'This op-ed would be too large to keep for an anonymous visitor. Choose fewer voices or words, or sign in.', 400, undefined, { code: 'anon_oped_too_large' });
    return true;
  }
  return false;
}

/** An anonymous visitor's live-set use: { limit, used, remaining }. */
export async function anonLiveSetStatus(): Promise<{ limit: number; used: number; remaining: number }> {
  const limit = getConfig().sessions.anonOpEdLiveSetLimit;
  const used = (await listOpedSets()).length;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

/** Refuse (429 anon_oped_limit, nothing written) an anonymous create at the live-set limit. True when written. */
export async function refuseAnonLiveSetLimit(res: ServerResponse): Promise<boolean> {
  const st = await anonLiveSetStatus();
  if (st.used < st.limit) return false;
  json(res, { error: 'anon_oped_limit', limit: st.limit, used: st.used, message: `You can keep ${st.limit} op-eds without signing in. Delete one, or sign in to keep more.` }, 429);
  return true;
}

/** t/500#61: WARN when a saved anonymous set passes two thirds of the byte cap, with its size and voice count only. */
export function warnIfNearAnonByteCap(set: { opeds?: unknown[] }): void {
  if (!isAnonymousUser()) return;
  const cap = getConfig().sessions.anonOpEdByteCap;
  const bytes = Buffer.byteLength(JSON.stringify(set), 'utf8');
  if (bytes * 3 <= cap * 2) return;
  log.server.warn({ component: 'oped', bytes, cap, voices: Array.isArray(set.opeds) ? set.opeds.length : null }, 'Anonymous op-ed set is over two thirds of the byte cap (t/500#61)');
}

/** The anonymous create checks in order (shape and byte cap, then the live-set limit). A no-op for signed-in callers.
 *  True when a refusal was written. */
export async function refuseAnonOpEdCreate(res: ServerResponse, voices: number, wordCount: number, outlet: string | undefined): Promise<boolean> {
  if (!isAnonymousUser()) return false;
  return refuseAnonOpEdShape(res, voices, wordCount, outlet) || refuseAnonLiveSetLimit(res);
}

/** GET /api/oped-sets/quota-status: the usual quota, plus { limit, used, remaining } live sets for an anonymous visitor. */
export async function opedQuotaStatus(): Promise<Record<string, unknown>> {
  const base = await getOpedSetsQuotaStatus();
  return isAnonymousUser() ? { ...base, ...(await anonLiveSetStatus()) } : { ...base };
}
