// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { computeCanonicalDocIds, normalizeTitleForCanonicalId, normalizeUrlForCanonicalId } from './types.js';

describe('computeCanonicalDocIds (t/4334)', () => {
  // The exact PI example (acc-desires-021, t/4333). Without a content hash
  // (not populated in this fixture — the corpus's real copies are actually
  // byte-identical per TL's revised ruling, t/4334#6, and belong in ONE
  // cluster once `contentSha256` is available), URL/title alone correctly
  // keep these as 2 clusters (one per outlet) rather than guessing they're
  // the same article from title/URL resemblance — "no fuzzy matching beyond
  // the stated tiers" still holds for this fixture as given.
  it('eight-ways-ai-will-shape-geopolitics (no content hash): suffix parts collapse per outlet, outlets stay separate', () => {
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

  // t/4334 (PowerShell p/783#6, TL p/801#1): the query-string false merge —
  // real corpus examples where the query IS the item id. Confirmed against
  // actual sources/*/metadata.json before this fix landed.
  it('does not merge distinct YouTube videos that share a path but differ only by ?v=', () => {
    const meta = {
      'ai-triad-dialogue-across-differences-2026': { url: 'https://www.youtube.com/watch?v=kGa0ZPFsRuo', title: 'AI Triad Dialogue Across Differences' },
      'artificial-intelligence-index-report-2025-2026': { url: 'https://www.youtube.com/watch?v=D03EJhztsHQ', title: 'Artificial Intelligence Index Report 2025' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['ai-triad-dialogue-across-differences-2026']).not.toBe(canonical['artificial-intelligence-index-report-2025-2026']);
  });

  it('does not merge distinct Hacker News items that differ only by ?id=', () => {
    const meta = {
      'ai-agent-published-hit-piece-me-2026': { url: 'https://news.ycombinator.com/item?id=47051956', title: 'An AI agent published a hit piece on me' },
      'evaluating-impact-ai-labor-market-current-state-affairs-2026': { url: 'https://news.ycombinator.com/item?id=45442743', title: 'Evaluating the impact of AI on the labor market' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['ai-agent-published-hit-piece-me-2026']).not.toBe(canonical['evaluating-impact-ai-labor-market-current-state-affairs-2026']);
  });

  it('merges two docs on the same URL once query order and tracking params are normalized away', () => {
    const meta = {
      'doc-a': { url: 'https://example.com/article?utm_source=newsletter&id=42&ref=home', title: 'A' },
      'doc-b': { url: 'https://example.com/article?ref=home&id=42&fbclid=xyz', title: 'B (different title, same article)' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['doc-b']).toBe(canonical['doc-a']);
  });

  it('keeps path and query case-sensitive, only folding the host', () => {
    const meta = {
      'doc-a': { url: 'https://YouTube.com/watch?v=AbCdEf', title: 'A' },
      'doc-b': { url: 'https://youtube.com/watch?v=abcdef', title: 'B' }, // different case id = a different video
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['doc-a']).not.toBe(canonical['doc-b']);
  });

  // t/4334 (TL p/801#1): a search-provenance URL is a citation the pipeline
  // found, not an asserted canonical address — never trusted for merging,
  // even when it happens to match exactly.
  it('never merges on a URL whose provenance confidence is "search"', () => {
    const meta = {
      'doc-a': { url: 'https://scholar.google.com/citations?user=ABC123', title: 'Paper A', urlConfidence: 'search' },
      'doc-b': { url: 'https://scholar.google.com/citations?user=ABC123', title: 'Paper B (different paper, same author page cited)', urlConfidence: 'search' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['doc-a']).not.toBe(canonical['doc-b']);
  });

  it('a non-search-confidence URL still merges normally', () => {
    const meta = {
      'doc-a': { url: 'https://example.com/x', title: 'A', urlConfidence: 'verified' },
      'doc-b': { url: 'https://example.com/x', title: 'B (different title, same verified URL)', urlConfidence: 'extracted' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['doc-a']).toBe(canonical['doc-b']);
  });

  // t/4334 (TL p/801#1, condition 1): exact content hash is the strongest
  // possible signal — checked before URL/suffix/title, and merges even when
  // every other field differs (the "same byte-identical article, different
  // outlet URLs attached by provenance search" case).
  it('an exact content hash match merges two docs even with completely different URLs and titles', () => {
    const meta = {
      'eight-ways-brookings-2026': { url: 'https://www.brookings.edu/articles/x/', title: 'Eight ways AI will shape geopolitics', contentSha256: 'same-hash-abc', urlConfidence: 'search' },
      'eight-ways-atlantic-council-2026': { url: 'https://www.atlanticcouncil.org/dispatches/x/', title: 'Eight ways AI will shape geopolitics   Atlantic Council', contentSha256: 'same-hash-abc', urlConfidence: 'search' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['eight-ways-brookings-2026']).toBe(canonical['eight-ways-atlantic-council-2026']);
  });

  it('different content with the same non-search URL still merges (URL tier, hash tier does not apply)', () => {
    const meta = {
      'doc-a': { url: 'https://example.com/same-url', title: 'A', contentSha256: 'hash-a' },
      'doc-b': { url: 'https://example.com/same-url', title: 'B', contentSha256: 'hash-b' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    // Hashes differ (tier 0 doesn't fire for this pair), but both still
    // trust the same exact non-search URL (tier 3) — merges, as designed.
    expect(canonical['doc-a']).toBe(canonical['doc-b']);
  });

  it('a parentDocId link merges a doc into its stated parent', () => {
    const meta = {
      'parent-doc': { url: 'https://example.com/parent', title: 'Parent' },
      'chunk-doc': { url: 'https://example.com/chunk-only', title: 'Chunk (totally different URL/title)', parentDocId: 'parent-doc' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['chunk-doc']).toBe('parent-doc');
  });

  it('a sameAs link merges a doc into its stated alias, without touching URL/title tiers', () => {
    const meta = {
      'canonical-doc': { url: 'https://outlet-a.example.com/article', title: 'Title A' },
      'reprint-doc': { url: 'https://outlet-b.example.com/article', title: 'Title B (different outlet reprint)', sameAs: 'canonical-doc' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['reprint-doc']).toBe('canonical-doc');
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

  it('keeps the query string', () => {
    expect(normalizeUrlForCanonicalId('https://www.youtube.com/watch?v=kGa0ZPFsRuo'))
      .not.toBe(normalizeUrlForCanonicalId('https://www.youtube.com/watch?v=D03EJhztsHQ'));
  });

  it('sorts query params so order does not matter', () => {
    expect(normalizeUrlForCanonicalId('https://example.com/x?b=2&a=1'))
      .toBe(normalizeUrlForCanonicalId('https://example.com/x?a=1&b=2'));
  });

  it('strips utm_*, fbclid, and gclid before comparing', () => {
    expect(normalizeUrlForCanonicalId('https://example.com/x?id=1&utm_source=a&utm_medium=b&fbclid=c&gclid=d'))
      .toBe(normalizeUrlForCanonicalId('https://example.com/x?id=1'));
  });

  it('drops the fragment', () => {
    expect(normalizeUrlForCanonicalId('https://example.com/x#section-2'))
      .toBe(normalizeUrlForCanonicalId('https://example.com/x'));
  });

  it('preserves path and query case (only the host is case-folded)', () => {
    expect(normalizeUrlForCanonicalId('https://YouTube.com/watch?v=AbCdEf'))
      .not.toBe(normalizeUrlForCanonicalId('https://youtube.com/watch?v=abcdef'));
    expect(normalizeUrlForCanonicalId('https://YouTube.com/watch?v=AbCdEf'))
      .toBe(normalizeUrlForCanonicalId('https://youtube.com/watch?v=AbCdEf'));
  });
});
