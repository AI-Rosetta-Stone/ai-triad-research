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
    ['raw arXiv id in the finding', { finding: "Can't be verified. No source checked here reports '2601.11699v4' at all.", finding_points: ['a'] }, 'unverifiable', /raw identifier \('2601\.11699v4'/],
    ['node id in the finding', { finding: 'Accurate. The claim matches acc-beliefs-012 closely enough.', finding_points: ['a'] }, 'supported', /raw identifier/],
    ['url in the finding', { finding: 'Accurate. Confirmed by https://example.org/report on the figure.', finding_points: ['a'] }, 'supported', /raw identifier/],
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

describe('finding length bounds (Quality, #5597)', () => {
  const pts = { finding_points: ['A point.'] };
  const after = (n: number) => `Accurate. ${Array(n).fill('word').join(' ')}`;

  it.each([1, 2, 3])('drops a finding with %i word(s) after the verdict word', (n) => {
    const r = parseFactCheckFinding({ finding: after(n), ...pts }, 'supported');
    expect(r.value).toBeUndefined();
    expect(r.dropped).toMatch(/no statement after the verdict word/);
  });

  it('keeps a finding with exactly 4 words after the verdict word', () => {
    expect(parseFactCheckFinding({ finding: after(4), ...pts }, 'supported').value?.finding).toBe(after(4));
  });

  it('drops a 41-word finding and keeps a 40-word one (cap includes the verdict word)', () => {
    const forty = after(39);
    const fortyOne = after(40);
    expect(forty.split(/\s+/)).toHaveLength(40);
    expect(fortyOne.split(/\s+/)).toHaveLength(41);
    expect(parseFactCheckFinding({ finding: forty, ...pts }, 'supported').value?.finding).toBe(forty);
    const r = parseFactCheckFinding({ finding: fortyOne, ...pts }, 'supported');
    expect(r.value).toBeUndefined();
    expect(r.dropped).toMatch(/finding has 41 words \(cap 40\)/);
  });
});

describe('reader wording rules (Design, t/763#12)', () => {
  const ok = "Can't be verified. No source checked here reports the cited 2026 report.";
  it.each([
    ["Can't be verified. Public databases and taxonomy records contain no mention of it.", /internal store \('taxonomy records'\)/],
    ['Accurate. Internal conflict data confirms that women lead 18% of them.', /internal store \('conflict data'\)/],
    ['Accurate. The conflict records confirm that women lead 18% of them.', /internal store \('conflict records'\)/],
    ["Can't be verified. Public software engineering data does not contain these metrics.", /absence from public data/],
  ])('drops a finding that breaks them: %s', (finding, reason) => {
    const verdict = finding.startsWith('Accurate') ? 'supported' : 'unverifiable';
    const r = parseFactCheckFinding({ finding, finding_points: ['a fine point here'] }, verdict);
    expect(r.value).toBeUndefined();
    expect(r.dropped).toMatch(reason);
  });

  it("allows the renamed stores: this project's taxonomy, the debate so far", () => {
    const r = parseFactCheckFinding({ finding: "Can't be verified. No source in this project's taxonomy or the debate so far reports it.", finding_points: ['The debate so far cites no study for it.'] }, 'unverifiable');
    expect(r.dropped).toBeUndefined();
    expect(r.removed).toBeUndefined();
  });

  it('removes an offending point and keeps the rest, reporting it', () => {
    const r = parseFactCheckFinding({ finding: ok, finding_points: ['Conflict data confirms the 93% figure.', 'The speaker generalises the finding.'], limit: 'Nothing in the debate record covers 2026.' }, 'unverifiable');
    expect(r.value?.finding_points).toEqual(['The speaker generalises the finding.']);
    expect(r.value?.limit).toBeUndefined();
    expect(r.removed).toEqual([expect.stringMatching(/finding_points\[0\] names an internal store/), expect.stringMatching(/limit names an internal store \('debate record'\)/)]);
  });

  it('drops the finding when every point is removed', () => {
    const r = parseFactCheckFinding({ finding: ok, finding_points: ['The available conflict data has nothing.'] }, 'unverifiable');
    expect(r.dropped).toMatch(/every finding_point removed/);
  });

  it('validateFactCheckResult logs a WARN per removed point', () => {
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);
    const v = validateFactCheckResult({ verdict: 'unverifiable', explanation: 'e', finding: ok, finding_points: ['Conflict data has nothing.', 'A clean point here.'] });
    expect(v.finding_points).toEqual(['A clean point here.']);
    expect(record.mock.calls.map(c => c[0].message ?? '').some(m => /finding_points\[0\] names an internal store.*removed/.test(m))).toBe(true);
    clearGlobalRecorder();
  });
});

describe('raw ids in points (t/763 ruling 1)', () => {
  it("allows the speaker's bad id in a point", () => {
    const r = parseFactCheckFinding({ finding: "Can't be verified. No source checked here reports the cited figure.", finding_points: ["The statement cites '2601.11699v4', which doesn't match a known paper."] }, 'unverifiable');
    expect(r.dropped).toBeUndefined();
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
    for (const s of ['Never put it in the finding', 'No source checked here reports', "this project's taxonomy", 'Never write \"conflict data\"', 'Never invent a source', 'Never leave it as the bare verdict words', '"finding"', '"finding_points"', '"limit"', 'Accurate.', 'Partly accurate.', 'Overstated.', "Can't be verified.", 'never by a raw document id', 'no intensifiers']) {
      expect(p).toContain(s);
    }
  });
});

describe('factCheckPrompt web-search line (t/763 ruling 3)', () => {
  it('says no web search ran, and forbids mentioning it, when none ran', () => {
    expect(factCheckPrompt('c', 'ctx', 'n', 'conflicts only')).toContain('WEB SEARCH: none ran for this check. Do not mention web search');
    expect(factCheckPrompt('c', 'ctx', 'n', 'x', undefined, false)).toContain('none ran');
  });
  it('says a web search ran when the host says so, or when the results block is present', () => {
    expect(factCheckPrompt('c', 'ctx', 'n', 'x', undefined, true)).toContain('a web search ran for this check');
    expect(factCheckPrompt('c', 'ctx', 'n', 'x\n\n=== WEB SEARCH RESULTS ===\nr')).toContain('a web search ran for this check');
  });
});
