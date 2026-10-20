// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { computeCanonicalDocIds, normalizeTitleForCanonicalId, normalizeUrlForCanonicalId } from './types.js';

describe('computeCanonicalDocIds (t/4334)', () => {
  // The exact PI example (acc-desires-021, t/4333): confirmed real data shows
  // this is TWO distinct outlet reprints, not one document — TL ruled ship
  // 7→2, never widen title matching to force a false merge (t/4334#2).
  it('eight-ways-ai-will-shape-geopolitics: suffix parts collapse per outlet, outlets stay separate', () => {
    const meta = {
      'eight-ways-ai-will-shape-geopolitics-2026-2026': { url: 'https://www.brookings.edu/articles/artificial-intelligence-and-the-future-of-geopolitics/', title: 'Eight ways AI will shape geopolitics in 2026' },
      'eight-ways-ai-will-shape-geopolitics-2026-2026-1': { url: 'https://etcjournal.com/2026/02/05/whither-ai-in-2026-14-insights/', title: 'Eight ways AI will shape geopolitics in 2026' },
      'eight-ways-ai-will-shape-geopolitics-2026-2026-2': { url: 'https://example.com/other-outlet', title: 'Eight ways AI will shape geopolitics in 2026' },
      'eight-ways-ai-will-shape-geopolitics-2026-2026-3': { url: 'https://example.com/yet-another', title: 'Eight ways AI will shape geopolitics in 2026' },
      'eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026': { url: 'https://www.atlanticcouncil.org/dispatches/eight-ways-ai-will-shape-geopolitics-in-2026/', title: 'Eight ways AI will shape geopolitics in 2026   Atlantic Council' },
      'eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026-1': { url: 'https://example.com/ac-reprint-1', title: 'Eight ways AI will shape geopolitics in 2026   Atlantic Council' },
      'eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026-2': { url: 'https://example.com/ac-reprint-2', title: 'Eight ways AI will shape geopolitics in 2026   Atlantic Council' },
    };
    const docIds = Object.keys(meta);
    const canonical = computeCanonicalDocIds(docIds, meta);

    const distinctCanonicalIds = new Set(Object.values(canonical));
    expect(distinctCanonicalIds.size).toBe(2); // 7 rows -> 2, never 1 (no false merge across outlets)

    expect(canonical['eight-ways-ai-will-shape-geopolitics-2026-2026-1']).toBe('eight-ways-ai-will-shape-geopolitics-2026-2026');
    expect(canonical['eight-ways-ai-will-shape-geopolitics-2026-2026-2']).toBe('eight-ways-ai-will-shape-geopolitics-2026-2026');
    expect(canonical['eight-ways-ai-will-shape-geopolitics-2026-2026-3']).toBe('eight-ways-ai-will-shape-geopolitics-2026-2026');
    expect(canonical['eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026-1']).toBe('eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026');
    expect(canonical['eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026-2']).toBe('eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026');

    // The two outlet clusters never merge into each other.
    expect(canonical['eight-ways-ai-will-shape-geopolitics-2026-2026'])
      .not.toBe(canonical['eight-ways-ai-will-shape-geopolitics-2026-atlantic-council-2026']);
  });

  it('merges a URL-encoded-title duplicate via normalized title (managing-risks pair)', () => {
    const meta = {
      'managing-risks-from-internal-ai-systems-2026': { url: '', title: 'Managing Risks from Internal AI Systems' },
      'managingrisksfrominternalaisystems-2026': { url: '', title: 'Managing+Risks+from+Internal+AI+Systems' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['managing-risks-from-internal-ai-systems-2026']).toBe(canonical['managingrisksfrominternalaisystems-2026']);
  });

  it('merges a suffix part with a different URL and slightly different title into its base (is-ai-sovereignty pair)', () => {
    const meta = {
      'is-ai-sovereignty-possible-balancing-autonomy-2026': { url: 'https://www.brookings.edu/articles/is-ai-sovereignty-possible-balancing-autonomy-and-interdependence/', title: 'Is AI sovereignty possible  Balancing autonomy and interdependence   Brookings' },
      'is-ai-sovereignty-possible-balancing-autonomy-2026-1': { url: 'https://muckrack.com/cameron-f-kerry/articles', title: 'Is AI sovereignty possible? Balancing autonomy and interdependence' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['is-ai-sovereignty-possible-balancing-autonomy-2026-1'])
      .toBe('is-ai-sovereignty-possible-balancing-autonomy-2026');
  });

  it('never merges two distinct documents with similar titles (false-merge guard)', () => {
    const meta = {
      'doc-a': { url: 'https://example.com/a', title: 'AI Governance in 2026: A Survey' },
      'doc-b': { url: 'https://example.com/b', title: 'AI Governance in 2026: A Review' }, // different last word, different URL, no suffix relation
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['doc-a']).not.toBe(canonical['doc-b']);
  });

  it('a matching normalized URL merges two docs regardless of title (tier 2)', () => {
    const meta = {
      'first-seen-slug': { url: 'https://example.com/path/to/article/', title: 'Original Title' },
      'second-ingestion-slug': { url: 'HTTPS://WWW.EXAMPLE.COM/path/to/article', title: 'Completely Different Title String' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['second-ingestion-slug']).toBe(canonical['first-seen-slug']);
  });

  it('a -N suffix whose base does NOT exist in the known set is left standalone, not merged', () => {
    const meta = {
      'standalone-doc-2026-1': { url: 'https://example.com/x', title: 'Standalone' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['standalone-doc-2026-1']).toBe('standalone-doc-2026-1');
  });

  it('is deterministic regardless of input array order (lexicographically-first representative)', () => {
    const meta = {
      'alpha-2026': { url: 'https://example.com/shared', title: 'Doc' },
      'zeta-2026': { url: 'https://example.com/shared', title: 'Doc' },
    };
    const forward = computeCanonicalDocIds(['alpha-2026', 'zeta-2026'], meta);
    const reverse = computeCanonicalDocIds(['zeta-2026', 'alpha-2026'], meta);
    expect(forward).toEqual(reverse);
    expect(forward['alpha-2026']).toBe('alpha-2026');
    expect(forward['zeta-2026']).toBe('alpha-2026');
  });
});

describe('normalizeTitleForCanonicalId', () => {
  it('lowercases, replaces + with space, strips punctuation, collapses whitespace', () => {
    expect(normalizeTitleForCanonicalId('Managing+Risks+from+Internal+AI+Systems'))
      .toBe(normalizeTitleForCanonicalId('Managing Risks from Internal AI Systems'));
  });
});

describe('normalizeUrlForCanonicalId', () => {
  it('treats empty string and null as no URL', () => {
    expect(normalizeUrlForCanonicalId('')).toBeNull();
    expect(normalizeUrlForCanonicalId(null)).toBeNull();
  });

  it('ignores a www. prefix, scheme case, and a trailing slash', () => {
    expect(normalizeUrlForCanonicalId('https://www.Example.com/path/'))
      .toBe(normalizeUrlForCanonicalId('HTTPS://example.com/path'));
  });
});
