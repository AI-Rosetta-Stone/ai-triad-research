// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467: free-pool and anonymous-limit refusals become stable codes, before and during the stream
// (TaxonomyServer p/74#27, #29, #32). No server text reaches the progress panel for a pool refusal.
import { describe, it, expect, vi } from 'vitest';

const record = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

import { runOpEdCreate, opedProgressBus } from './opedStream';
import { preStreamFreePoolCode, midStreamFreePoolCode, freePoolRefusalOf } from './opedFreePool';

const params = { outlet: 'x', model: 'm', temperature: 0.2 } as never;
const payload = { params, voices: ['acc', 'saf'], topic: 'x' } as never;

const sse = (events: Record<string, unknown>[]) => new Response(
  events.map((e, seq) => `data: ${JSON.stringify({ runId: 'r1', seq, event: e })}\n\n`).join(''),
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
);
const refusalFor = async (res: Response) => {
  const err = await runOpEdCreate(vi.fn().mockResolvedValue(res), payload).then(() => null, (e: unknown) => e);
  return freePoolRefusalOf(err);
};

describe('free-pool refusal codes (t/467)', () => {
  it('maps each pre-stream status and code; anything else stays unmapped', () => {
    expect(preStreamFreePoolCode(403, { error: 'free_pool_region' })).toBe('free_pool_region');
    // Design p/25#196: the session mint's refusal is its own code, not the free pool's 503; the word-cap 400 is the guard.
    expect(preStreamFreePoolCode(503, { error: 'anon_session_unavailable' })).toBe('anon_session_unavailable');
    expect(preStreamFreePoolCode(400, { error: 'Anonymous op-eds allow at most 1500 words per voice. Sign in for longer op-eds.' })).toBe('anon_word_cap');
    expect(preStreamFreePoolCode(400, { error: 'Anonymous op-eds allow at most 3 voices. Sign in for more.' })).toBeNull();
    expect(preStreamFreePoolCode(503, { error: 'free_pool_empty' })).toBe('free_pool_unavailable');
    expect(preStreamFreePoolCode(503, { error: 'free_pool_unavailable' })).toBe('free_pool_unavailable');
    // Quality t/467#84: a 503 without a free-pool code is not a pool refusal.
    expect(preStreamFreePoolCode(503, {})).toBeNull();
    expect(preStreamFreePoolCode(503, { error: 'Free tier is not available' })).toBeNull();
    expect(preStreamFreePoolCode(503, { error: 'upstream connect error' })).toBeNull();
    expect(preStreamFreePoolCode(429, { error: 'free_pool_exhausted' })).toBe('free_pool_exhausted');
    expect(preStreamFreePoolCode(429, { error: 'free_pool_oped_limit' })).toBe('free_pool_oped_limit');
    expect(preStreamFreePoolCode(429, { error: 'anon_oped_limit', limit: 10, used: 10 })).toBe('anon_oped_limit');
    expect(preStreamFreePoolCode(429, { error: 'concurrency_limit' })).toBeNull();
    expect(preStreamFreePoolCode(403, { reason: 'anon_route_blocked' })).toBeNull();
    expect(preStreamFreePoolCode(400, { error: 'too many voices' })).toBeNull();
  });

  it('a 503 with no JSON body (the ingress) is a plain create error, never the add-a-key line', async () => {
    const res = new Response('upstream connect error or disconnect/reset before headers', { status: 503 });
    const err = await runOpEdCreate(vi.fn().mockResolvedValue(res), payload).then(() => null, (e: unknown) => e);
    expect(freePoolRefusalOf(err)).toBeNull();
    expect((err as { httpStatus?: number }).httpStatus).toBe(503);
    expect((err as { problem: string }).problem).toBe('Create failed with HTTP 503');
  });

  it('maps the mid-stream codes only', () => {
    expect(['FREE_POOL_EXHAUSTED', 'FREE_POOL_UNAVAILABLE', 'ANON_RUN_COST_CEILING', 'OTHER', undefined].map(midStreamFreePoolCode))
      .toEqual(['free_pool_exhausted', 'free_pool_unavailable', 'run_cost_ceiling', null, null]);
  });

  it('a pre-stream refusal carries its code and records the raw body with a WARN', async () => {
    record.mockClear();
    expect(await refusalFor(new Response(JSON.stringify({ error: 'free_pool_exhausted', resetsAt: 'x' }), { status: 429 }))).toEqual({ code: 'free_pool_exhausted', midStream: false });
    expect(record.mock.calls.some(([e]) => e.level === 'warn' && /free_pool_exhausted/.test(e.message))).toBe(true);
  });

  it('an error frame with a pool code is a mid-stream refusal without a set id', async () => {
    expect(await refusalFor(sse([{ type: 'run_started', runId: 'r1' }, { type: 'error', code: 'ANON_RUN_COST_CEILING', problem: 'raw' }])))
      .toEqual({ code: 'run_cost_ceiling', midStream: true });
  });

  it("t/703: when run_started carries setId, an error-frame refusal has it, so the dialog can check the set", async () => {
    expect(await refusalFor(sse([{ type: 'run_started', runId: 'r1', setId: 'set-9' }, { type: 'error', code: 'ANON_RUN_COST_CEILING', problem: 'raw' }])))
      .toEqual({ code: 'run_cost_ceiling', midStream: true, setId: 'set-9' });
  });

  it('voices refused by the pool, then complete: a mid-stream refusal with the set id; no raw text in progress', async () => {
    const seen: Array<{ voice: string; error?: string }> = [];
    const off = opedProgressBus.onProgress((e) => { seen.push(e); });
    const refusal = await refusalFor(sse([
      { type: 'voice_complete', pov: 'acc' },
      { type: 'voice_failed', pov: 'saf', code: 'FREE_POOL_EXHAUSTED', error: 'ActionableError: Goal: … $5 …' },
      { type: 'complete', set: { set_id: 'set-9' } },
    ]));
    off();
    expect(refusal).toEqual({ code: 'free_pool_exhausted', midStream: true, setId: 'set-9' });
    expect(seen.find((e) => e.voice === 'saf')?.error).toBeUndefined();
  });

  it('t/741: voices refused by the pool, then the stream ends without complete: still the pool refusal, with no run-status call', async () => {
    const events = [{ type: 'run_started', runId: 'r1' }, { type: 'voice_start', pov: 'acc' }, { type: 'voice_failed', pov: 'acc', error: 'raw', code: 'FREE_POOL_EXHAUSTED' }];
    const fetchFn = vi.fn().mockResolvedValue(sse(events));
    const err = await runOpEdCreate(fetchFn, payload).then(() => null, (e: unknown) => e);
    expect(freePoolRefusalOf(err)).toEqual({ code: 'free_pool_exhausted', midStream: true });
    expect(fetchFn).toHaveBeenCalledTimes(1); // the create only; /api/oped-runs is not asked
  });

  it("t/741: the same, when run_started carried setId: the refusal has it, so the dialog can check the set", async () => {
    const events = [{ type: 'run_started', runId: 'r1', setId: 'set-7' }, { type: 'voice_failed', pov: 'acc', error: 'raw', code: 'FREE_POOL_EXHAUSTED' }];
    expect(await refusalFor(sse(events))).toEqual({ code: 'free_pool_exhausted', midStream: true, setId: 'set-7' });
  });

  it('a voice_failed without a code (before t/668) stays a generic failure, and the set resolves', async () => {
    const res = sse([{ type: 'voice_failed', pov: 'saf', error: 'boom' }, { type: 'complete', set: { set_id: 'set-1' } }]);
    await expect(runOpEdCreate(vi.fn().mockResolvedValue(res), payload)).resolves.toEqual({ set_id: 'set-1' });
  });
});
