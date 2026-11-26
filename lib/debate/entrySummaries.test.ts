// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/700: structured Brief (brief_claim + 2-3 brief_points) alongside the brief/medium strings.

import { describe, it, expect } from 'vitest';
import { parseEntrySummaries } from './entrySummaries.js';
import { entrySummarizationPrompt } from './prompts.js';

const strings = { brief: 'We must act now.', medium: 'A longer case for acting now.' };

describe('parseEntrySummaries', () => {
  it('accepts the new shape and keeps the structured Brief', () => {
    const raw = JSON.stringify({ ...strings, brief_claim: 'Labs should publish their evals.', brief_points: ['Anthropic published in 2024.', 'Secrecy hides failures.'] });
    expect(parseEntrySummaries(raw)).toEqual({
      summaries: { ...strings, brief_claim: 'Labs should publish their evals.', brief_points: ['Anthropic published in 2024.', 'Secrecy hides failures.'] },
    });
  });

  it('still parses the old shape (strings only) and flags the missing structure', () => {
    const r = parseEntrySummaries(JSON.stringify(strings));
    expect(r.summaries).toEqual(strings);
    expect(r.structuredDropped).toMatch(/absent/);
  });

  it('strips code fences', () => {
    const raw = '```json\n' + JSON.stringify({ ...strings, brief_claim: 'c', brief_points: ['a', 'b'] }) + '\n```';
    expect(parseEntrySummaries(raw).summaries?.brief_points).toEqual(['a', 'b']);
  });

  it.each([
    ['empty claim', { brief_claim: '  ', brief_points: ['a', 'b'] }, /brief_claim/],
    ['points not an array', { brief_claim: 'c', brief_points: 'a; b' }, /not an array/],
    ['one point', { brief_claim: 'c', brief_points: ['a'] }, /1 items/],
    ['four points', { brief_claim: 'c', brief_points: ['a', 'b', 'c', 'd'] }, /4 items/],
    ['a non-string point', { brief_claim: 'c', brief_points: ['a', 7] }, /brief_points\[1\]/],
    ['an over-long point', { brief_claim: 'c', brief_points: ['a', Array(60).fill('w').join(' ')] }, /60 words/],
    ['claim without points', { brief_claim: 'c' }, /not an array/],
  ])('falls back to the strings on a bad shape: %s', (_name, extra, reason) => {
    const r = parseEntrySummaries(JSON.stringify({ ...strings, ...extra }));
    expect(r.summaries).toEqual(strings);
    expect(r.structuredDropped).toMatch(reason);
  });

  it('keeps a long claim but warns past 20 words (Design, t/700#5)', () => {
    const claim = Array(22).fill('w').join(' ');
    const r = parseEntrySummaries(JSON.stringify({ ...strings, brief_claim: claim, brief_points: ['a', 'b'] }));
    expect(r.summaries?.brief_claim).toBe(claim);
    expect(r.structuredDropped).toBeUndefined();
    expect(r.structuredWarning).toMatch(/22 words/);
  });

  it('does not warn on a claim of 20 words or fewer', () => {
    const r = parseEntrySummaries(JSON.stringify({ ...strings, brief_claim: Array(20).fill('w').join(' '), brief_points: ['a', 'b'] }));
    expect(r.structuredWarning).toBeUndefined();
  });

  it('returns no summaries when brief or medium is missing', () => {
    expect(parseEntrySummaries(JSON.stringify({ brief: 'x' }))).toEqual({});
    expect(parseEntrySummaries(JSON.stringify({ medium: 'x', brief_claim: 'c', brief_points: ['a', 'b'] }))).toEqual({});
  });

  it('throws on unparseable JSON (the caller catches it)', () => {
    expect(() => parseEntrySummaries('not json')).toThrow();
  });
});

describe('entrySummarizationPrompt (t/700)', () => {
  const p = entrySummarizationPrompt('Regulation stifles innovation.', 'Prometheus');

  it('asks for the structured Brief in the JSON shape', () => {
    expect(p).toContain('"brief_claim"');
    expect(p).toContain('"brief_points"');
    expect(p).toMatch(/2 or 3 items/);
  });

  it('no longer asks for a tagline or one-liner, and forbids the label', () => {
    expect(p).not.toMatch(/catchy|one-liner|punchy/i);
    expect(p).not.toMatch(/\+ tagline/i);
    expect(p).toContain('no "Tagline:" line');
  });

  it("carries Design's tightening (t/700#5): claim length, total, no ids, neutral verbs", () => {
    expect(p).toMatch(/15 words or fewer, one main clause/);
    expect(p).toMatch(/not the reasons/);
    expect(p).toMatch(/70 words or fewer/);
    expect(p).toMatch(/Never write a raw document id/);
    expect(p).toMatch(/intensifiers/);
  });
});
