// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467: Design's copy table (t/467#72, #74, #77), each code in both the anonymous and signed-in variants, and the
// three set-check outcomes after a stop partway through.
import { describe, it, expect, vi } from 'vitest';

const record = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

import { freePoolLine, refusalLine, partialStateFor, ANON_RETENTION_LINE } from './anonOpEdCopy';

const ANON = 'sign in and add your own API key for this model in Settings > API Keys';
const SIGNED = 'add your own API key for this model in Settings > API Keys';

describe('anonymous op-ed copy (t/467)', () => {
  it('(1) the retention line is verbatim', () => {
    expect(ANON_RETENTION_LINE).toBe("You're not signed in. Only this browser can open the op-eds you create, and each one is removed 24 hours after you last open it. Sign in to keep them.");
  });

  it('(2) to (6) map to their lines, with the remedy for each audience', () => {
    for (const anonymous of [true, false]) {
      const r = anonymous ? ANON : SIGNED;
      expect(freePoolLine('anon_oped_limit', anonymous)).toBe("You've reached the limit of 10 op-eds without signing in. Sign in to create more, or wait for an older one to be removed 24 hours after you last opened it.");
      expect(freePoolLine('free_pool_exhausted', anonymous)).toBe(`Free op-eds have run out for now. Try again later, or ${r}.`);
      expect(freePoolLine('free_pool_unavailable', anonymous)).toBe(`Free op-eds aren't available right now. To continue, ${r}.`);
      expect(freePoolLine('free_pool_region', anonymous)).toBe(`Free op-eds aren't available in your region. To continue, ${r}.`);
      expect(freePoolLine('free_pool_oped_limit', anonymous)).toBe('You already have op-eds generating. Wait for one to finish, then try again.');
    }
  });

  it('a pre-stream refusal has no {PARTIAL}', () => {
    expect(refusalLine({ code: 'free_pool_region', midStream: false }, true, 'unknown')).toBe(`Free op-eds aren't available in your region. To continue, ${ANON}.`);
  });

  it('mid-stream (3), (4) and (7) get {PARTIAL}; (7) adds its advice', () => {
    expect(refusalLine({ code: 'free_pool_exhausted', midStream: true }, false, 'saved'))
      .toBe(`Free op-eds have run out for now. Try again later, or ${SIGNED}. The voices that finished are saved. Open them from the My tab.`);
    expect(refusalLine({ code: 'free_pool_unavailable', midStream: true }, true, 'none'))
      .toBe(`Free op-eds aren't available right now. To continue, ${ANON}. Nothing from this run was saved.`);
    expect(refusalLine({ code: 'run_cost_ceiling', midStream: true }, true, 'unknown'))
      .toBe('This op-ed was stopped because it reached the spending limit for one free run. Some voices may have been saved. Check the My tab. Choosing fewer voices or a shorter length uses less.');
  });

  it('the set check: finished voices → saved; none or 404 → none; a load error or no id → unknown with a WARN', async () => {
    expect(await partialStateFor('s', async () => ({ opeds: [{ status: 'failed' }, { status: 'complete' }] }))).toBe('saved');
    expect(await partialStateFor('s', async () => ({ opeds: [{ status: 'failed' }, { status: 'cancelled' }] }))).toBe('none');
    expect(await partialStateFor('s', async () => { throw Object.assign(new Error('nf'), { httpStatus: 404 }); })).toBe('none');
    record.mockClear();
    const load = vi.fn(async () => { throw Object.assign(new Error('502'), { httpStatus: 502 }); });
    expect(await partialStateFor('s', load)).toBe('unknown');
    expect(load).toHaveBeenCalledTimes(1); // no retry loop
    expect(record.mock.calls[0][0]).toMatchObject({ level: 'warn' });
    expect(await partialStateFor(undefined, load)).toBe('unknown');
  });
});
