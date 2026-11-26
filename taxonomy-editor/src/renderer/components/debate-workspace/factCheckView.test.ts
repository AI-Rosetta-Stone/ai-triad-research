// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import {
  pillTextOf, fallbackFindingOf, findingOf, pointsOf, limitOf, sourceLinksOf, quotedClaim, collapsedFindingOf,
} from './factCheckView';

describe('factCheckView (t/764)', () => {
  it('pill text follows the §3 table', () => {
    expect(pillTextOf('supported')).toBe('SUPPORTED');
    expect(pillTextOf('partially_accurate')).toBe('PARTLY ACCURATE');
    expect(pillTextOf('disputed')).toBe('DISPUTED');
    expect(pillTextOf('false')).toBe('FALSE');
    expect(pillTextOf('unverifiable')).toBe("CAN'T VERIFY");
    expect(pillTextOf(undefined)).toBe('CHECKING…');
  });

  it('the stored finding wins over the fallback', () => {
    expect(findingOf({ finding: ' Accurate. Yes. ', explanation: 'Other.' })).toBe('Accurate. Yes.');
  });

  it('the fallback skips "This matters…" and refuses a sentence over 30 words', () => {
    expect(fallbackFindingOf('This matters a lot. The data agree.')).toBe('The data agree.');
    const long = `${Array.from({ length: 31 }, () => 'word').join(' ')}.`;
    expect(fallbackFindingOf(long)).toBeNull();
    expect(fallbackFindingOf(undefined)).toBeNull();
  });

  it('points are capped at 3 and a malformed value gives none', () => {
    expect(pointsOf({ finding_points: ['a', 'b', 'c', 'd'] })).toEqual(['a', 'b', 'c']);
    expect(pointsOf({ finding_points: 'nope' })).toEqual([]);
    expect(pointsOf({ finding_points: ['', 5, 'x'] })).toEqual(['x']);
  });

  it('limit is one trimmed string or null', () => {
    expect(limitOf({ limit: ' One caveat. ' })).toBe('One caveat.');
    expect(limitOf({ limit: '' })).toBeNull();
    expect(limitOf({ limit: 3 })).toBeNull();
  });

  it('source links prefer a real short title, fall back to the domain, show at most 3 and count the rest', () => {
    const { shown, more } = sourceLinksOf([
      { uri: 'https://www.nature.com/a', title: 'Simulated labs, 2017' }, { uri: 'https://b.org/x', title: 'b.org' },
      { uri: '', title: 'A very long title that exceeds thirty characters' }, { uri: 'https://d.org', title: 'T4' },
    ]);
    expect(shown.map(s => s.label)).toEqual(['Simulated labs, 2017', 'b.org', 'A very long title that exceed…']);
    expect(more).toBe(1);
  });

  it('a citation with no title uses the domain', () => {
    expect(sourceLinksOf([{ uri: 'https://www.nature.com/a', title: '' }]).shown[0].label).toBe('nature.com');
  });

  it('quotes the claim with typographic quotes and does not double them', () => {
    expect(quotedClaim('a claim')).toBe('“a claim”');
    expect(quotedClaim('"a claim"')).toBe('“a claim”');
  });

  it('the collapsed line falls back from the finding to the explanation to the claim', () => {
    expect(collapsedFindingOf({ finding: 'Accurate.', explanation: 'e' })).toBe('Accurate.');
    expect(collapsedFindingOf({ explanation: 'First sentence here. Second.' })).toBe('First sentence here.');
    expect(collapsedFindingOf({ explanation: '', checked_text: 'The claim' })).toBe('The claim');
  });
});
