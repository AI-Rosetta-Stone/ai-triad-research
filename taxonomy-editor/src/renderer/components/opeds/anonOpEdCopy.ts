// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467: Design's final copy for anonymous and free-pool op-eds (t/467#72, #74, #77, p/25#196), verbatim.
import type { FreePoolCode, FreePoolRefusal } from '../../bridge/opedFreePool';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

/** (1) Shown to anonymous users under the Source selector. */
export const ANON_RETENTION_LINE = "You're not signed in. Only this browser can open the op-eds you create, and each one is removed 24 hours after you last open it. Sign in to keep them.";

/** Under the voice chips for an anonymous visitor (Design t/725#3). */
export const ANON_ONE_VOICE_LINE = 'Without signing in, you can create one voice at a time. Sign in to create all three side by side.';

/** The server's words-per-voice cap for anonymous creates (sessions.anonOpEdMaxWords, 1,500). The dialog keeps
 *  anonymous choices inside it so the create isn't refused (Design p/25#196 a). */
export const ANON_MAX_WORDS = 1500;

/** Shown under Outlet when the cap changed what the outlet would otherwise offer. */
export const ANON_WORD_CAP_NOTE = 'Without signing in, op-eds are up to 1,500 words.';

/** An outlet's band line for an anonymous user: a range that runs past the cap ends at the cap. */
export function anonBand(band: string): { band: string; clamped: boolean } {
  const m = /^(\d+)–(\d+) words/.exec(band);
  if (!m || Number(m[2]) <= ANON_MAX_WORDS) return { band, clamped: false };
  return { band: band.replace(m[0], `${m[1]}–${ANON_MAX_WORDS} words`), clamped: true };
}

function remedy(anonymous: boolean): string {
  return anonymous
    ? 'sign in and add your own API key for this model in Settings > API Keys'
    : 'add your own API key for this model in Settings > API Keys';
}

/** Lines (2) to (7), without {PARTIAL}. */
export function freePoolLine(code: FreePoolCode, anonymous: boolean): string {
  switch (code) {
    case 'anon_oped_limit': return "You've reached the limit of 10 op-eds without signing in. Sign in to create more, or wait for an older one to be removed 24 hours after you last opened it.";
    case 'free_pool_exhausted': return `Free op-eds have run out for now. Try again later, or ${remedy(anonymous)}.`;
    case 'free_pool_unavailable': return `Free op-eds aren't available right now. To continue, ${remedy(anonymous)}.`;
    case 'free_pool_region': return `Free op-eds aren't available in your region. To continue, ${remedy(anonymous)}.`;
    case 'free_pool_oped_limit': return 'You already have op-eds generating. Wait for one to finish, then try again.';
    case 'run_cost_ceiling': return 'This op-ed was stopped because it reached the spending limit for one free run.';
    case 'anon_word_cap': return 'Without signing in, op-eds can be up to 1,500 words. Choose a shorter length, or sign in.';
    case 'anon_session_unavailable': return "Couldn't start creating op-eds without signing in. Try again in a minute.";
    case 'anon_oped_voices': return 'Sign in to create more than one voice at a time.';
  }
}

/** What the reopen check found after a mid-stream stop (t/467#77). */
export type PartialState = 'saved' | 'none' | 'unknown';

export function partialLine(state: PartialState): string {
  if (state === 'saved') return 'The voices that finished are saved. Open them from the My tab.';
  if (state === 'none') return 'Nothing from this run was saved.';
  return 'Some voices may have been saved. Check the My tab.';
}

/** The full line for a refusal; mid-stream refusals get {PARTIAL}, and (7) its closing advice. */
export function refusalLine(refusal: FreePoolRefusal, anonymous: boolean, partial: PartialState): string {
  const base = freePoolLine(refusal.code, anonymous);
  if (!refusal.midStream) return base;
  const tail = refusal.code === 'run_cost_ceiling' ? ' Choosing fewer voices or a shorter length uses less.' : '';
  return `${base} ${partialLine(partial)}${tail}`;
}

/** The reopen check: load the set by id and see whether any voice finished. Never retries. */
export async function partialStateFor(setId: string | undefined, load: (id: string) => Promise<{ opeds?: Array<{ status?: string }> } | null>): Promise<PartialState> {
  if (!setId) return 'unknown';
  try {
    const set = await load(setId);
    return (set?.opeds ?? []).some((m) => m.status === 'complete') ? 'saved' : 'none';
  } catch (err) {
    if ((err as { httpStatus?: number }).httpStatus === 404) return 'none';
    getGlobalRecorder()?.record({ type: 'system.error', component: 'oped-new-dialog', level: 'warn', message: "WARN: couldn't load the stopped op-ed's set to see what was saved; showing the 'may have been saved' line (no retry)", error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return 'unknown';
  }
}
