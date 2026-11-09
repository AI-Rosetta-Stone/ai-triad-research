// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4336 (t/4333): one row per real document (canonicalDocId), fetched per node through getNodeSources
// instead of the whole-corpus index. A per-node cache shows the last result at once and revalidates in the
// background; the server's indexVersion says whether the refetched data replaced it.

import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { SourceReference, SourceCardMeta } from '../../../../../lib/sourceIndex/types';
import { groupByDocument, sortDocumentGroups, type DocumentGroup } from './sourceGrouping';
import { SourceCard, safeExternalUrl } from './SourceCard';
import { SourcesSortControl, useSourcesSortMode } from './SourcesSortControl';
import './SourcesPanel.css';

export type { SourceReference } from '../../../../../lib/sourceIndex/types';

interface NodeSources {
  sources: SourceReference[];
  cards: Record<string, SourceCardMeta>;
  indexVersion: number;
}

// Per-node cache: node id -> the last data the server returned for it (and its indexVersion).
const _nodeCache = new Map<string, NodeSources>();

/** Test seam: empty the per-node cache. */
export function __resetSourcesCacheForTests(): void { _nodeCache.clear(); }

const STANCE_LABELS: Record<string, string> = {
  strongly_aligned: 'Strongly Aligned',
  aligned: 'Aligned',
  neutral: 'Neutral',
  qualifies: 'Qualifies',
  disputes: 'Disputes',
};

const POV_LABELS: Record<string, string> = {
  accelerationist: 'Acc',
  safetyist: 'Saf',
  skeptic: 'Skp',
  'situations': 'Sit',
};

const REF_KEY = (r: SourceReference) => `${r.point}\u0000${r.verbatim}`;
const group = (d: NodeSources) => groupByDocument(d.sources, { refKey: REF_KEY, component: 'sources-panel' });

/**
 * t/4336 step 0: time from opening a node's Sources tab to having its data, so the t/4333 change has a
 * like-for-like before/after taken from the same mark on hosted prod. `cache` is `hit` when this node's data
 * was already cached (shown at once, then revalidated); `rows` is the real-document row count.
 */
function recordFirstRender(nodeId: string, ms: number, cache: 'hit' | 'miss', d: NodeSources): void {
  getGlobalRecorder()?.record({
    type: 'lifecycle', component: 'sources-panel', level: 'info',
    message: 'sources-panel.first-render',
    data: { nodeId, ms: Math.round(ms), cache, refs: d.sources.length, rows: group(d).length },
  });
}

function recordFetchError(nodeId: string, err: unknown, keptCached: boolean): void {
  const e = err as Error;
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'sources-panel', level: 'error',
    message: `Failed to load sources for ${nodeId}`,
    error: { name: e?.name ?? 'Error', message: String(err), stack: e?.stack },
  });
  if (keptCached) {
    getGlobalRecorder()?.record({
      type: 'state.change', component: 'sources-panel', level: 'warn',
      message: 'sources fetch failed; showing the cached sources for this node (may be stale)',
      data: { nodeId },
    });
  }
}

/** Load a node's sources: the cached copy at once if there is one, then the server's (replacing it if newer). */
function useNodeSources(nodeId: string): { data: NodeSources | null; error: string | null; loadedFor: string | null } {
  const [data, setData] = useState<NodeSources | null>(() => _nodeCache.get(nodeId) ?? null);
  const [error, setError] = useState<string | null>(null);
  // t/4919 fix (TL review on #4648, p/356#162): the node id `data`/`error` actually belong to.
  // Right after `nodeId` changes, this hook's state still reflects the PREVIOUS node for one
  // render (this effect hasn't fired yet) — a caller defaulting an "open the first X" state off
  // `data` alone defaults against stale, previous-node data. Gate on `loadedFor === nodeId`.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const startedAt = performance.now();
    const cached = _nodeCache.get(nodeId);
    setData(cached ?? null);
    setError(null);
    setLoadedFor(nodeId); // data (cached-or-null) now legitimately reflects this node
    if (cached) recordFirstRender(nodeId, performance.now() - startedAt, 'hit', cached);

    api.getNodeSources(nodeId).then((fresh) => {
      if (cancelled) return;
      if (cached && cached.indexVersion === fresh.indexVersion) return; // unchanged: keep what's on screen
      _nodeCache.set(nodeId, fresh);
      setData(fresh);
      if (!cached) recordFirstRender(nodeId, performance.now() - startedAt, 'miss', fresh);
    }, (err: unknown) => {
      if (cancelled) return;
      recordFetchError(nodeId, err, !!cached);
      if (!cached) setError('Could not load the sources for this node. Try reopening the tab.');
    });
    return () => { cancelled = true; };
  }, [nodeId]);

  return { data, error, loadedFor };
}

function DocumentRow({ group: g, card, expanded, onToggle }: {
  group: DocumentGroup<SourceReference>;
  card: SourceCardMeta | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { first, refs } = g;
  // The card carries the link; without one, fall back to the reference's own URL (http/https only).
  const href = card ? null : safeExternalUrl(first.url);
  return (
    <div className="sources-panel-doc">
      <button
        className={`sources-panel-doc-header${expanded ? ' sources-panel-doc-expanded' : ''}`}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="sources-panel-doc-title">{card?.title || first.title}</span>
        <span className="sources-panel-doc-meta">
          <span className="sources-panel-doc-count">{refs.length}</span>
          {first.datePublished && <span className="sources-panel-doc-date">{first.datePublished}</span>}
        </span>
      </button>

      {expanded && (
        <div className="sources-panel-doc-body">
          {card && <SourceCard card={card} />}
          {href && (
            <a
              className="sources-panel-doc-url"
              href={href}
              onClick={(e) => { e.preventDefault(); void api.openExternal(href); }}
              title={href}
            >
              {href.replace(/^https?:\/\//, '').slice(0, 60)}...
            </a>
          )}
          {refs.map((ref, i) => (
            <div key={i} className="sources-panel-ref">
              <div className="sources-panel-ref-header">
                <span className={`sources-panel-stance sources-panel-stance-${ref.stance}`}>
                  {STANCE_LABELS[ref.stance] || ref.stance}
                </span>
                <span className="sources-panel-ref-pov">{POV_LABELS[ref.pov] || ref.pov}</span>
                {ref.excerptContext && <span className="sources-panel-ref-context">{ref.excerptContext}</span>}
              </div>
              <div className="sources-panel-ref-point">{ref.point}</div>
              {ref.verbatim && <blockquote className="sources-panel-ref-verbatim">{ref.verbatim}</blockquote>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SourcesPanelProps {
  nodeId: string;
}

export function SourcesPanel({ nodeId }: SourcesPanelProps) {
  const { data, error, loadedFor } = useNodeSources(nodeId);
  const [expanded, setExpanded] = useState<string | null>(null);
  // t/4919: track which node's first group we've already defaulted open, so a background
  // revalidation (new `data` identity, same node) doesn't reopen a group the user collapsed.
  const defaultAppliedFor = useRef<string | null>(null);

  useEffect(() => { setExpanded(null); defaultAppliedFor.current = null; }, [nodeId]);

  const [sortMode, setSortMode] = useSourcesSortMode();
  // t/4389: rows ordered by the displayed title (the source card's title when there is one), or by count.
  const groups = useMemo(
    () => (data ? sortDocumentGroups(group(data), sortMode, g => data.cards[g.canonicalDocId]?.title || g.first.title) : []),
    [data, sortMode],
  );

  // t/4919: default the first group open, once per node, only after the data has loaded.
  // `loadedFor === nodeId` guards against the stale render right after a node switch, where
  // `groups` (and this effect's own closure) can still reflect the PREVIOUS node (fix, p/356#162).
  useEffect(() => {
    if (loadedFor === nodeId && groups.length > 0 && defaultAppliedFor.current !== nodeId) {
      setExpanded(groups[0].canonicalDocId);
      defaultAppliedFor.current = nodeId;
    }
  }, [loadedFor, groups, nodeId]);

  if (error) return <div className="sources-panel-error" role="alert">{error}</div>;
  if (!data) return <div className="sources-panel-loading">Loading source references...</div>;
  if (groups.length === 0) return <div className="sources-panel-empty">No sources reference this node.</div>;

  const refCount = groups.reduce((n, g) => n + g.refs.length, 0);
  return (
    <div className="sources-panel">
      <div className="sources-summary-row">
        <div className="sources-panel-summary">
          {refCount} reference{refCount !== 1 ? 's' : ''} across {groups.length} document{groups.length !== 1 ? 's' : ''}
        </div>
        <SourcesSortControl mode={sortMode} onChange={setSortMode} />
      </div>
      {groups.map(g => (
        <DocumentRow
          key={g.canonicalDocId}
          group={g}
          card={data.cards[g.canonicalDocId]}
          expanded={expanded === g.canonicalDocId}
          onToggle={() => setExpanded(expanded === g.canonicalDocId ? null : g.canonicalDocId)}
        />
      ))}
    </div>
  );
}
