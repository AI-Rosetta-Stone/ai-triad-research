// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { computeCanonicalDocIds, normalizeTitleForCanonicalId, normalizeUrlForCanonicalId } from './types.js';

// t/4344 superseded the full canonical-grouping algorithm (content hash,
// parentDocId/sameAs links, confidence-gated URL trust, the conditional
// suffix edge, title-collision reporting) — that behavior is tested against
// the real shared fixture in `sourceIdentityFixture.test.ts` (87 cases,
// agreeing with the PowerShell implementation). `computeCanonicalDocIds`
// here is the narrower, deprecated back-compat shim kept only for
// ElectronMain's t/4341 (`src/main/fileIO.ts`, PR #3510), which only ever
// supplies `{url, title}` — no hash, no links, no provenance confidence.
describe('computeCanonicalDocIds (deprecated shim, t/4334/t/4344)', () => {
  // t/4334#11 (TL): the shim has no provenance data, so it can't distinguish
  // a verified URL from a search-provenance guess — it must default to
  // untrusted, the opposite of the real spec's "no evidence = trusted"
  // default, which only applies when provenance data actually exists to check.
  it('never merges two docs on a matching URL alone — the shim cannot verify provenance, so it never trusts a URL', () => {
    const meta = {
      'doc-a': { url: 'https://example.com/shared', title: 'Doc A' },
      'doc-b': { url: 'https://example.com/shared', title: 'Doc B (different title, same URL, no suffix relation)' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['doc-a']).not.toBe(canonical['doc-b']);
  });

  it('does not merge two distinct YouTube videos that share a path but differ only by ?v= (also never merges via URL at all)', () => {
    const meta = {
      'ai-triad-dialogue-across-differences-2026': { url: 'https://www.youtube.com/watch?v=kGa0ZPFsRuo', title: 'AI Triad Dialogue Across Differences' },
      'artificial-intelligence-index-report-2025-2026': { url: 'https://www.youtube.com/watch?v=D03EJhztsHQ', title: 'Artificial Intelligence Index Report 2025' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['ai-triad-dialogue-across-differences-2026']).not.toBe(canonical['artificial-intelligence-index-report-2025-2026']);
  });

  it('a -N suffix still joins its base when titles match, even with no URL to compare (the shim never populates one)', () => {
    const meta = {
      'doc-2026': { url: 'https://example.com/x', title: 'Shared Title' },
      'doc-2026-1': { url: null as string | null, title: 'Shared Title' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['doc-2026-1']).toBe(canonical['doc-2026']);
  });

  it('a -N suffix does NOT join its base when titles differ (the shim has no hash to override it)', () => {
    const meta = {
      'doc-2026': { url: null as string | null, title: 'Title One' },
      'doc-2026-1': { url: null as string | null, title: 'Title Two' },
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['doc-2026-1']).not.toBe(canonical['doc-2026']);
  });

  it('never merges two distinct documents with similar titles alone (title adds no edge, t/4344 4.5)', () => {
    const meta = {
      'doc-a': { url: 'https://example.com/a', title: 'AI Governance in 2026: A Survey' },
      'doc-b': { url: 'https://example.com/b', title: 'AI Governance in 2026: A Survey' }, // equal title, different URL, no suffix relation
    };
    const canonical = computeCanonicalDocIds(Object.keys(meta), meta);
    expect(canonical['doc-a']).not.toBe(canonical['doc-b']);
  });

  it('is deterministic regardless of input array order (ordinal-smallest representative)', () => {
    const meta = {
      'alpha-2026': { url: null as string | null, title: 'Shared Title' },
      'alpha-2026-1': { url: null as string | null, title: 'Shared Title' },
    };
    const forward = computeCanonicalDocIds(['alpha-2026', 'alpha-2026-1'], meta);
    const reverse = computeCanonicalDocIds(['alpha-2026-1', 'alpha-2026'], meta);
    expect(forward).toEqual(reverse);
    expect(forward['alpha-2026']).toBe('alpha-2026');
    expect(forward['alpha-2026-1']).toBe('alpha-2026');
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

  it('strips utm_*, fbclid, gclid, mc_cid and mc_eid before comparing', () => {
    expect(normalizeUrlForCanonicalId('https://example.com/x?id=1&utm_source=a&utm_medium=b&fbclid=c&gclid=d&mc_cid=e&mc_eid=f'))
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
