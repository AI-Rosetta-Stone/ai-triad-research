// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467: Design's final copy for anonymous and free-pool op-eds (t/467#72, #74, #77), verbatim.
import type { FreePoolCode, FreePoolRefusal } from '../../bridge/opedFreePool';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

/** (1) Shown to anonymous users under the Source selector. */
export const ANON_RETENTION_LINE = "You're not signed in. Only this browser can open the op-eds you create, and each one is removed 24 hours after you last open it. Sign in to keep them.";

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
