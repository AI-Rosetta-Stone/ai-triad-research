// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467: free-pool and anonymous-limit refusals of an op-ed create, as stable codes the dialog maps to Design's copy
// (t/467#72, #74, #77). The server's contract (TaxonomyServer p/74#27, #29, #32):
//   before the stream: 403 free_pool_region; 503 (free_pool_empty, free_pool_unavailable, or none yet); 429
//   free_pool_exhausted, free_pool_oped_limit, anon_oped_limit.
//   mid-stream: the SSE error frame's `code`, or voice_failed's `code` (t/668), as FREE_POOL_EXHAUSTED,
//   FREE_POOL_UNAVAILABLE or ANON_RUN_COST_CEILING. Both fields are optional; without them a failure stays generic.
// No server text, codes or amounts reach the user. The raw response is recorded with a WARN.
import { ActionableError } from '@lib/debate/errors';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export type FreePoolCode =
  | 'anon_oped_limit' | 'free_pool_exhausted' | 'free_pool_unavailable' | 'free_pool_region'
  | 'free_pool_oped_limit' | 'run_cost_ceiling';

export interface FreePoolRefusal {
  code: FreePoolCode;
  /** True when the run had started (some voices may have been written). */
  midStream: boolean;
  /** The set's id, when the stream told us (a run that completed with pool-refused voices). */
  setId?: string;
}

/** A refusal before the stream opened, from the HTTP status and the JSON body's `error`. */
export function preStreamFreePoolCode(status: number, data: Record<string, unknown>): FreePoolCode | null {
  const error = data.error;
  if (status === 403 && error === 'free_pool_region') return 'free_pool_region';
  if (status === 503) return 'free_pool_unavailable'; // free_pool_empty, free_pool_unavailable, or the older sentence
  if (status !== 429) return null;
  if (error === 'anon_oped_limit') return 'anon_oped_limit';
  if (error === 'free_pool_exhausted') return 'free_pool_exhausted';
  if (error === 'free_pool_oped_limit') return 'free_pool_oped_limit';
  return null;
}

const MID_STREAM: Record<string, FreePoolCode> = {
  FREE_POOL_EXHAUSTED: 'free_pool_exhausted',
  FREE_POOL_UNAVAILABLE: 'free_pool_unavailable',
  ANON_RUN_COST_CEILING: 'run_cost_ceiling',
};

/** A refusal during the run, from the error frame's or voice_failed's `code`. */
export function midStreamFreePoolCode(code: unknown): FreePoolCode | null {
  return typeof code === 'string' ? MID_STREAM[code] ?? null : null;
}

/** The create error carrying the refusal. `problem` is a plain fallback; the dialog shows Design's line instead. */
export function freePoolError(refusal: FreePoolRefusal, raw: unknown): ActionableError {
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'web-bridge', level: 'warn',
    message: `WARN: op-ed create refused by the free pool or an anonymous limit (${refusal.code}${refusal.midStream ? ', mid-stream' : ''}); the dialog shows Design's line, the raw response is here`,
    data: { raw },
  });
  const err = new ActionableError({
    goal: 'Op-Ed Studio: create an op-ed',
    problem: 'Free op-eds are not available for this request right now.',
    location: 'opedStream.runOpEdCreate',
    nextSteps: ['Try again later'],
  });
  (err as ActionableError & { freePool: FreePoolRefusal }).freePool = refusal;
  return err;
}

/** The refusal on a create error, if it is one. */
export function freePoolRefusalOf(err: unknown): FreePoolRefusal | null {
  const r = (err as { freePool?: FreePoolRefusal } | null)?.freePool;
  return r && typeof r.code === 'string' ? r : null;
}
