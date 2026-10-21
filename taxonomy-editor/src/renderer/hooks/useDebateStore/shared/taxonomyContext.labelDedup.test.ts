// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4369 gap 3: the per-turn label-dedup skip is logged as a WARN through the flight recorder.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const record = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

const { logLabelDedup } = await import('./taxonomyContext');

const entry = (n: number) => `skp-intentions-${150 + n} (dup of skp-intentions-146: "Resist concentration")`;

beforeEach(() => { record.mockClear(); });

describe('logLabelDedup (t/4369)', () => {
  it('WARNs with the skipped id, its twin and the label when twins were skipped', () => {
    logLabelDedup({ label_dedup: [entry(3)] });
    expect(record).toHaveBeenCalledTimes(1);
    const e = record.mock.calls[0][0];
    expect(e).toMatchObject({ component: 'debate-store', level: 'warn', data: { skipped_count: 1, label_dedup: [entry(3)] } });
    expect(e.message).toContain('skp-intentions-153 (dup of skp-intentions-146');
  });

  it('summarises long lists in the message but keeps the entries in data', () => {
    const many = [1, 2, 3, 4, 5].map(entry);
    logLabelDedup({ label_dedup: many });
    const e = record.mock.calls[0][0];
    expect(e.message).toContain('+ 2 more');
    expect(e.data.label_dedup).toEqual(many);
  });

  it('logs nothing when no twins were skipped (field absent, empty, or not an array)', () => {
    logLabelDedup({});
    logLabelDedup({ label_dedup: [] });
    logLabelDedup({ label_dedup: 'not-an-array' });
    expect(record).not.toHaveBeenCalled();
  });
});
