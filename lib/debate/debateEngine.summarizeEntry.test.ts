// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/730: pin DebateEngine.summarizeEntry's use of parseEntrySummaries (t/700) and its WARNs.
// Quality (p/132#52) found that disabling the dropped-Brief WARN left every test green.

import { describe, it, expect, vi, afterEach } from 'vitest';

// t/57: keep the engine off the real ai-triad-data calibration log.
vi.mock('./calibrationLogger.js', async (importOriginal) =>
  (await import('./__tests__/hermeticCalibration.js')).hermeticCalibrationLogger(importOriginal));
import { DebateEngine } from './debateEngine.js';
import { createMockAdapter, createMinimalTaxonomy, createDefaultConfig } from './debateEngine.testHelpers.js';
import { setGlobalRecorder, clearGlobalRecorder, type FlightRecorder, type RecordInput } from '../flight-recorder/index.js';
import type { TranscriptEntry } from './types.js';

type Summarizable = { summarizeEntry(entry: TranscriptEntry): Promise<void> };

function setup(response: string) {
  const record = vi.fn<(e: RecordInput) => void>();
  setGlobalRecorder({ record } as unknown as FlightRecorder);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const engine = new DebateEngine(createDefaultConfig({ rounds: 1 }), createMockAdapter([response]), createMinimalTaxonomy());
  const entry = { id: 'e1', timestamp: 't', type: 'statement', speaker: 'safetyist', content: 'We should audit.', taxonomy_refs: [] } as unknown as TranscriptEntry;
  const run = () => (engine as unknown as Summarizable).summarizeEntry(entry);
  const warns = () => record.mock.calls.map(c => c[0]).filter(e => e.level === 'warn').map(e => e.message ?? '');
  return { entry, run, warns };
}

const strings = { brief: 'We should audit.', medium: 'A longer case for audits.' };

describe('DebateEngine.summarizeEntry (t/700, t/730)', () => {
  afterEach(() => { clearGlobalRecorder(); vi.restoreAllMocks(); });

  it('stores the structured Brief and logs no WARN on the full shape', async () => {
    const s = setup(JSON.stringify({ ...strings, brief_claim: 'Audit first.', brief_points: ['Point one.', 'Point two.'] }));
    await s.run();
    expect(s.entry.summaries).toEqual({ ...strings, brief_claim: 'Audit first.', brief_points: ['Point one.', 'Point two.'] });
    expect(s.warns()).toEqual([]);
  });

  it('keeps the strings and WARNs when the structured Brief is malformed', async () => {
    const s = setup(JSON.stringify({ ...strings, brief_claim: 'Audit first.', brief_points: ['only one'] }));
    await s.run();
    expect(s.entry.summaries).toEqual(strings);
    expect(s.warns()).toEqual([expect.stringMatching(/Structured Brief dropped for entry e1 \(brief_points has 1 items/)]);
  });

  it('keeps a long claim and WARNs (soft cap)', async () => {
    const claim = Array(22).fill('w').join(' ');
    const s = setup(JSON.stringify({ ...strings, brief_claim: claim, brief_points: ['a', 'b'] }));
    await s.run();
    expect(s.entry.summaries?.brief_claim).toBe(claim);
    expect(s.warns()).toEqual([expect.stringMatching(/kept with a warning for entry e1: brief_claim has 22 words/)]);
  });

  it('WARNs when the response lacks brief or medium, and stores nothing', async () => {
    const s = setup(JSON.stringify({ brief: 'only a brief' }));
    await s.run();
    expect(s.entry.summaries).toBeUndefined();
    expect(s.warns()).toEqual([expect.stringMatching(/Entry summary dropped for entry e1: response lacked brief or medium/)]);
  });
});
