// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4336 (t/4333): one row per REAL document. Split parts and re-ingested copies of a document carry the same
// `canonicalDocId` (t/4334), so they collapse into one row, and identical references (the same point and the
// same verbatim quote, repeated across the parts) count once. SourcesPanel and PolicySourcesPanel share this.

import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { SourceReference } from '../../../../../lib/sourceIndex/types';

export const STANCE_ORDER: Record<string, number> = {
  strongly_aligned: 0,
  aligned: 1,
  neutral: 2,
  qualifies: 3,
  disputes: 4,
};

export interface DocumentGroup {
  canonicalDocId: string;
  /** Title, date and URL of the group's first reference (the parts of one document share them). */
  title: string;
  datePublished: string;
  url: string | null;
  /** The distinct references, sorted by stance. */
  refs: SourceReference[];
}

let warnedMissingCanonical = false;

/** The grouping key: `canonicalDocId`, or `docId` for older data that doesn't carry one (WARN once). */
function groupKey(r: SourceReference): string {
  if (r.canonicalDocId) return r.canonicalDocId;
  if (!warnedMissingCanonical) {
    warnedMissingCanonical = true;
    getGlobalRecorder()?.record({
      type: 'state.change', component: 'sources-panel', level: 'warn',
      message: 'source reference has no canonicalDocId; grouping by docId instead (older index)',
      data: { docId: r.docId },
    });
  }
  return r.docId;
}

/** Group references into real documents, drop repeated references, and order by distinct-reference count. */
export function groupByDocument(refs: readonly SourceReference[]): DocumentGroup[] {
  const groups = new Map<string, { first: SourceReference; seen: Set<string>; refs: SourceReference[] }>();
  for (const r of refs) {
    const key = groupKey(r);
    let g = groups.get(key);
    if (!g) { g = { first: r, seen: new Set(), refs: [] }; groups.set(key, g); }
    const refKey = `${r.point}\u0000${r.verbatim}`;
    if (g.seen.has(refKey)) continue;
    g.seen.add(refKey);
    g.refs.push(r);
  }
  return [...groups.entries()]
    .map(([canonicalDocId, g]) => ({
      canonicalDocId,
      title: g.first.title,
      datePublished: g.first.datePublished,
      url: g.first.url,
      refs: [...g.refs].sort((a, b) => (STANCE_ORDER[a.stance] ?? 9) - (STANCE_ORDER[b.stance] ?? 9)),
    }))
    .sort((a, b) => b.refs.length - a.refs.length);
}

/** Test seam: re-arm the once-per-session WARN. */
export function __resetGroupingWarnForTests(): void { warnedMissingCanonical = false; }
