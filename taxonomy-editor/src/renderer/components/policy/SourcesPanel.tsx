// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useMemo } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import './SourcesPanel.css';

export interface SourceReference {
  docId: string;
  title: string;
  pov: string;
  stance: string;
  point: string;
  verbatim: string;
  excerptContext: string;
  url: string | null;
  sourceType: string;
  datePublished: string;
}

type NodeSourceIndex = Record<string, SourceReference[]>;

// Module-level cache — built once, reused across renders
let _indexCache: NodeSourceIndex | null = null;
let _indexLoading = false;
let _indexListeners: Array<() => void> = [];

async function getNodeSourceIndex(): Promise<NodeSourceIndex> {
  if (_indexCache) return _indexCache;
  if (_indexLoading) {
    return new Promise((resolve) => {
      _indexListeners.push(() => resolve(_indexCache!));
    });
  }
  _indexLoading = true;
  try {
    _indexCache = (await api.buildNodeSourceIndex()) as NodeSourceIndex;
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'sources-panel', level: 'error', message: 'Failed to build node source index', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    _indexCache = {};
  }
  _indexLoading = false;
  for (const cb of _indexListeners) cb();
  _indexListeners = [];
  return _indexCache;
}

const STANCE_ORDER: Record<string, number> = {
  strongly_aligned: 0,
  aligned: 1,
  neutral: 2,
  qualifies: 3,
  disputes: 4,
};

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

/**
 * t/4336 step 0: time from opening a node's Sources tab to having its data, so the t/4333 change has a
 * like-for-like before/after taken from the same mark on hosted prod. `cache` says whether the whole-corpus
 * index was already loaded; the cold `miss` is the number the change targets.
 */
function recordFirstRender(nodeId: string, ms: number, cache: 'hit' | 'miss', refs: SourceReference[]): void {
  getGlobalRecorder()?.record({
    type: 'lifecycle', component: 'sources-panel', level: 'info',
    message: 'sources-panel.first-render',
    data: { nodeId, ms: Math.round(ms), cache, refs: refs.length, rows: new Set(refs.map(r => r.docId)).size },
  });
}

interface SourcesPanelProps {
  nodeId: string;
}

export function SourcesPanel({ nodeId }: SourcesPanelProps) {
  const [refs, setRefs] = useState<SourceReference[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setExpanded(null);
    const startedAt = performance.now();
    const cache = _indexCache ? 'hit' : 'miss';
    void getNodeSourceIndex().then((index) => {
      const nodeRefs = index[nodeId] || [];
      setRefs(nodeRefs);
      setLoading(false);
      recordFirstRender(nodeId, performance.now() - startedAt, cache, nodeRefs);
    });
  }, [nodeId]);

  // Group by docId, then sort by stance
  const grouped = useMemo(() => {
    if (!refs) return [];
    const byDoc: Record<string, SourceReference[]> = {};
    for (const r of refs) {
      if (!byDoc[r.docId]) byDoc[r.docId] = [];
      byDoc[r.docId].push(r);
    }
    // Sort each group by stance
    for (const arr of Object.values(byDoc)) {
      arr.sort((a, b) => (STANCE_ORDER[a.stance] ?? 9) - (STANCE_ORDER[b.stance] ?? 9));
    }
    // Sort groups by number of references descending
    return Object.entries(byDoc).sort((a, b) => b[1].length - a[1].length);
  }, [refs]);

  if (loading) {
    return <div className="sources-panel-loading">Loading source references...</div>;
  }

  if (!refs || refs.length === 0) {
    return <div className="sources-panel-empty">No sources reference this node.</div>;
  }

  return (
    <div className="sources-panel">
      <div className="sources-panel-summary">
        {refs.length} reference{refs.length !== 1 ? 's' : ''} across {grouped.length} document{grouped.length !== 1 ? 's' : ''}
      </div>

      {grouped.map(([docId, docRefs]) => {
        const first = docRefs[0];
        const isExpanded = expanded === docId;

        return (
          <div key={docId} className="sources-panel-doc">
            <button
              className={`sources-panel-doc-header${isExpanded ? ' sources-panel-doc-expanded' : ''}`}
              onClick={() => setExpanded(isExpanded ? null : docId)}
            >
              <span className="sources-panel-doc-title">{first.title}</span>
              <span className="sources-panel-doc-meta">
                <span className="sources-panel-doc-count">{docRefs.length}</span>
                {first.datePublished && (
                  <span className="sources-panel-doc-date">{first.datePublished}</span>
                )}
              </span>
            </button>

            {isExpanded && (
              <div className="sources-panel-doc-body">
                {first.url && (
                  <a
                    className="sources-panel-doc-url"
                    href="#"
                    onClick={(e) => { e.preventDefault(); void api.openExternal(first.url!); }}
                    title={first.url}
                  >
                    {first.url.replace(/^https?:\/\//, '').slice(0, 60)}...
                  </a>
                )}

                {docRefs.map((ref, i) => (
                  <div key={i} className="sources-panel-ref">
                    <div className="sources-panel-ref-header">
                      <span className={`sources-panel-stance sources-panel-stance-${ref.stance}`}>
                        {STANCE_LABELS[ref.stance] || ref.stance}
                      </span>
                      <span className="sources-panel-ref-pov">{POV_LABELS[ref.pov] || ref.pov}</span>
                      {ref.excerptContext && (
                        <span className="sources-panel-ref-context">{ref.excerptContext}</span>
                      )}
                    </div>
                    <div className="sources-panel-ref-point">{ref.point}</div>
                    {ref.verbatim && (
                      <blockquote className="sources-panel-ref-verbatim">{ref.verbatim}</blockquote>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
