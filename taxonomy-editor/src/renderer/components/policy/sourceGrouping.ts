// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4336 (t/4333): one row per REAL document. Split parts and re-ingested copies of a document carry the same
// `canonicalDocId` (t/4334), so they collapse into one row, and identical references (same `refKey`, repeated
// across the parts) count once. SourcesPanel and PolicySourcesPanel share this.

import { getGlobalRecorder } from '@lib/flight-recorder/index';

export const STANCE_ORDER: Record<string, number> = {
  strongly_aligned: 0,
  aligned: 1,
  neutral: 2,
  qualifies: 3,
  disputes: 4,
};

/** What grouping needs from a reference. `canonicalDocId` is optional: an index without it groups by `docId`. */
export interface GroupableRef {
  docId: string;
  canonicalDocId?: string;
  stance: string;
}

export interface DocumentGroup<T extends GroupableRef> {
  canonicalDocId: string;
  /** The group's first reference; the parts of one document share its title, date and URL. */
  first: T;
  /** The distinct references, sorted by stance. */
  refs: T[];
}

export interface GroupingOptions<T> {
  /** Two references with the same key are the same reference (counted once). */
  refKey: (r: T) => string;
  /** Flight-recorder component for the fallback WARN. */
  component: string;
}

const warnedComponents = new Set<string>();

/** The grouping key: `canonicalDocId`, or `docId` when the index doesn't carry one (WARN once per component). */
function groupKey(r: GroupableRef, component: string): string {
  if (r.canonicalDocId) return r.canonicalDocId;
  if (!warnedComponents.has(component)) {
    warnedComponents.add(component);
    getGlobalRecorder()?.record({
      type: 'state.change', component, level: 'warn',
      message: 'source reference has no canonicalDocId; grouping by docId instead (split parts stay separate rows)',
      data: { docId: r.docId },
    });
  }
  return r.docId;
}

/** Group references into real documents, drop repeated references, and order by distinct-reference count. */
export function groupByDocument<T extends GroupableRef>(refs: readonly T[], opts: GroupingOptions<T>): DocumentGroup<T>[] {
  const groups = new Map<string, { first: T; seen: Set<string>; refs: T[] }>();
  for (const r of refs) {
    const key = groupKey(r, opts.component);
    let g = groups.get(key);
    if (!g) { g = { first: r, seen: new Set(), refs: [] }; groups.set(key, g); }
    const k = opts.refKey(r);
    if (g.seen.has(k)) continue;
    g.seen.add(k);
    g.refs.push(r);
  }
  return [...groups.entries()]
    .map(([canonicalDocId, g]) => ({
      canonicalDocId,
      first: g.first,
      refs: [...g.refs].sort((a, b) => (STANCE_ORDER[a.stance] ?? 9) - (STANCE_ORDER[b.stance] ?? 9)),
    }))
    .sort((a, b) => b.refs.length - a.refs.length);
}

/** Test seam: re-arm the once-per-session WARN. */
export function __resetGroupingWarnForTests(): void { warnedComponents.clear(); }
