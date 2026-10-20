// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4336: one row per real document (canonicalDocId), distinct references counted once.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SourceReference } from '../../../../../lib/sourceIndex/types';

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: mockRecord }) }));

const { groupByDocument, __resetGroupingWarnForTests } = await import('./sourceGrouping');

const ref = (over: Partial<SourceReference>): SourceReference => ({
  docId: 'doc-a-1', canonicalDocId: 'doc-a', title: 'Report A', pov: 'accelerationist', stance: 'aligned',
  point: 'p1', verbatim: 'v1', excerptContext: '', url: null, sourceType: 'paper', datePublished: '2025-06-01', ...over,
});
const opts = { refKey: (r: SourceReference) => `${r.point}\u0000${r.verbatim}`, component: 'sources-panel' };
const group = (refs: SourceReference[]) => groupByDocument(refs, opts);
const warns = () => mockRecord.mock.calls.filter(c => c[0].level === 'warn');

beforeEach(() => { mockRecord.mockClear(); __resetGroupingWarnForTests(); });

describe('groupByDocument', () => {
  it('collapses the split parts of one document into one row', () => {
    const groups = group([
      ref({ docId: 'doc-a-1', point: 'p1' }),
      ref({ docId: 'doc-a-2', point: 'p2' }),
      ref({ docId: 'doc-a-3', point: 'p3' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalDocId).toBe('doc-a');
    expect(groups[0].first.title).toBe('Report A');
    expect(groups[0].refs).toHaveLength(3);
  });

  it('counts a reference repeated across parts once (same refKey)', () => {
    const groups = group([
      ref({ docId: 'doc-a-1', point: 'p1', verbatim: 'v1' }),
      ref({ docId: 'doc-a-2', point: 'p1', verbatim: 'v1' }),
      ref({ docId: 'doc-a-2', point: 'p1', verbatim: 'different quote' }),
    ]);
    expect(groups[0].refs).toHaveLength(2);
  });

  it('keeps different documents apart and orders them by distinct-reference count', () => {
    const groups = group([
      ref({ canonicalDocId: 'doc-b', docId: 'doc-b', title: 'Report B', point: 'x' }),
      ref({ point: 'p1' }), ref({ point: 'p2' }),
    ]);
    expect(groups.map(g => g.canonicalDocId)).toEqual(['doc-a', 'doc-b']);
  });

  it('sorts each document\'s references by stance', () => {
    const groups = group([
      ref({ point: 'p1', stance: 'disputes' }),
      ref({ point: 'p2', stance: 'strongly_aligned' }),
    ]);
    expect(groups[0].refs.map(r => r.stance)).toEqual(['strongly_aligned', 'disputes']);
  });

  it('a reference with no canonicalDocId groups by docId, with one WARN per component', () => {
    const groups = group([
      ref({ canonicalDocId: '', docId: 'old-1', point: 'p1' }),
      ref({ canonicalDocId: '', docId: 'old-1', point: 'p2' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].canonicalDocId).toBe('old-1');
    expect(warns()).toHaveLength(1);
    expect(warns()[0][0].component).toBe('sources-panel');

    // A second component warns separately; the first doesn't warn again.
    groupByDocument([{ docId: 'p-1', stance: 'aligned' }], { refKey: () => 'k', component: 'policy-sources' });
    group([ref({ canonicalDocId: '', docId: 'old-2' })]);
    expect(warns().map(c => c[0].component)).toEqual(['sources-panel', 'policy-sources']);
  });
});
