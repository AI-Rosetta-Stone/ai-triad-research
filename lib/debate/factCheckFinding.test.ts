// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/763: pithy fact-check finding, validated against the verdict that survived the gate.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseFactCheckFinding } from './factCheckFinding.js';
import { validateFactCheckResult } from './factCheckValidator.js';
import { factCheckPrompt } from './prompts.js';
import { setGlobalRecorder, clearGlobalRecorder, type FlightRecorder, type RecordInput } from '../flight-recorder/index.js';

const good = { finding: 'Accurate. NHTSA data shows 40% fewer fatal crashes.', finding_points: ['NHTSA 2025 report, fatal crashes per mile.'] };

describe('parseFactCheckFinding', () => {
  it('accepts the new shape, with and without a limit', () => {
    expect(parseFactCheckFinding(good, 'supported')).toEqual({ value: good });
    expect(parseFactCheckFinding({ ...good, limit: 'One year of data.' }, 'supported').value?.limit).toBe('One year of data.');
  });

  it('flags the old shape (no finding fields) without failing', () => {
    expect(parseFactCheckFinding({ verdict: 'supported', explanation: 'x' }, 'supported')).toEqual({ dropped: 'finding fields absent' });
  });

  it.each([
    ['Partly accurate.', 'partially_accurate'],
    ['Overstated.', 'partially_accurate'],
    ['Disputed.', 'disputed'],
    ['False.', 'false'],
    ["Can't be verified.", 'unverifiable'],
    ['Can’t be verified.', 'unverifiable'],
  ] as const)('accepts "%s" for %s', (word, verdict) => {
    const r = parseFactCheckFinding({ finding: `${word} The evidence shows this much.`, finding_points: ['a'] }, verdict);
    expect(r.dropped).toBeUndefined();
    expect(r.value?.finding.startsWith(word.replace('’', "'"))).toBe(true);
  });

  it.each([
    ['empty finding', { finding: ' ', finding_points: ['a'] }, 'supported', /finding missing/],
    ['bare verdict word', { finding: "Can't be verified.", finding_points: ['a'] }, 'unverifiable', /no statement after the verdict word/],
    ['wrong verdict word', { finding: 'Disputed. Something.', finding_points: ['a'] }, 'supported', /verdict word for 'supported'/],
    ['Overstated on a supported verdict', { finding: 'Overstated. The figure was 10, not 12.', finding_points: ['a'] }, 'supported', /verdict word/],
    ['points not an array', { finding: 'Accurate. The report confirms it.', finding_points: 'a' }, 'supported', /not an array/],
    ['no points', { finding: 'Accurate. The report confirms it.', finding_points: [] }, 'supported', /0 items/],
    ['four points', { finding: 'Accurate. The report confirms it.', finding_points: ['a', 'b', 'c', 'd'] }, 'supported', /4 items/],
    ['over-long point', { finding: 'Accurate. The report confirms it.', finding_points: [Array(50).fill('w').join(' ')] }, 'supported', /50 words/],
    ['non-string limit', { finding: 'Accurate. The report confirms it.', finding_points: ['a'], limit: 7 }, 'supported', /limit is not a string/],
  ] as const)('drops a bad shape: %s', (_n, raw, verdict, reason) => {
    const r = parseFactCheckFinding(raw, verdict);
    expect(r.value).toBeUndefined();
    expect(r.dropped).toMatch(reason);
  });
});

describe('validateFactCheckResult carries the finding (t/763)', () => {
  afterEach(() => clearGlobalRecorder());

  it('keeps a valid finding with the verdict', () => {
    const r = validateFactCheckResult({ verdict: 'supported', explanation: 'e', ...good });
    expect(r).toMatchObject({ verdict: 'supported', ...good });
  });

  it('checks the word against the resolved verdict: a gated-down partially_accurate drops a "Partly accurate." finding with a WARN', () => {
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);
    // partially_accurate without a discrepancy is downgraded to unverifiable by the gate.
    const r = validateFactCheckResult({ verdict: 'partially_accurate', explanation: 'e', finding: 'Partly accurate. The count was 10, not 12.', finding_points: ['a'] });
    expect(r.verdict).toBe('unverifiable');
    expect(r.finding).toBeUndefined();
    const msgs = record.mock.calls.map(c => c[0].message ?? '');
    expect(msgs.some(m => /Fact-check finding dropped \(finding does not open with the verdict word for 'unverifiable'/.test(m))).toBe(true);
  });

  it('old-shape responses still validate, without finding fields', () => {
    const r = validateFactCheckResult({ verdict: 'false', explanation: 'e' });
    expect(r.verdict).toBe('false');
    expect(r.finding).toBeUndefined();
    expect(r.finding_points).toBeUndefined();
  });
});

describe('factCheckPrompt (t/763)', () => {
  const p = factCheckPrompt('claim', 'context', 'nodes', 'conflicts');
  it('asks for finding, finding_points and an optional limit, with the verdict words and the id rule', () => {
    for (const s of ['"finding"', '"finding_points"', '"limit"', 'Accurate.', 'Partly accurate.', 'Overstated.', "Can't be verified.", 'never by a raw document id', 'no intensifiers']) {
      expect(p).toContain(s);
    }
  });
});
