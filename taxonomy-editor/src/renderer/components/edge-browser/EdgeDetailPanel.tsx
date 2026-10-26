// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useRef, useState } from 'react';
import { POV_META, povKeyFromNodeId } from '@lib/electron-shared/povMeta';
import { api } from '@bridge';
import { useTaxonomyStore, type TaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById, isSuperseded } from '../../hooks/useTaxonomyStore/superseded';
import type { Edge } from '../../types/taxonomy';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { TheoryLink } from '../shared/TheoryLink';
import './EdgeDetailPanel.css';

interface EdgeDetailPanelProps {
  width?: number;
}

function nodeColor(id: string): string {
  const key = povKeyFromNodeId(id);
  return key ? `var(${POV_META[key].cssVar})` : 'var(--text-muted)';
}

function povLabel(id: string): string {
  const key = povKeyFromNodeId(id);
  return key ? POV_META[key].label : 'Unknown';
}

/** t/4364: marks an edge endpoint that's a superseded node (kept, not hidden — TL p/336#633). */
function SupersededMark({ targetId, onNavigate }: { targetId: string | undefined; onNavigate: (id: string) => void }) {
  if (targetId === undefined) return null;
  if (!targetId) return <span className="edge-detail-superseded-mark" title="Superseded">superseded</span>;
  return (
    <button
      type="button"
      className="edge-detail-superseded-mark edge-detail-superseded-mark-link"
      title={`Superseded by ${targetId}`}
      onClick={(e) => { e.stopPropagation(); onNavigate(targetId); }}
    >superseded</button>
  );
}

/** Superseded endpoints need the full store (including held-aside nodes); the edge-list hook data alone doesn't carry them. */
function supersededTarget(store: TaxonomyStore, nodeId: string): string | undefined {
  if (!isSuperseded(store, nodeId)) return undefined;
  return allNodesById(store).get(nodeId)?.superseded_by ?? '';
}

/**
 * Resolve an edge's rationale on demand. Rationale is stripped from the edges list
 * response (lazy loading, t/672), so when a selected edge lacks it we fetch the full
 * edge via `api.getEdgeDetail(index)`. Results are cached by edge identity so
 * re-selecting the same edge doesn't refetch.
 *
 * `rationale` is `undefined` while resolution is pending, `''` when the edge has no
 * rationale, or the rationale text.
 */
export function useEdgeRationale(
  selectedEdge: Edge | null,
  edges: Edge[] | undefined,
): { rationale: string | undefined; loading: boolean } {
  const cacheRef = useRef<Map<string, string>>(new Map());
  const [rationale, setRationale] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedEdge) {
      setRationale(undefined);
      setLoading(false);
      return;
    }

    // Already carried inline (e.g. ?include=rationale) — nothing to fetch.
    if (selectedEdge.rationale != null && selectedEdge.rationale !== '') {
      setRationale(selectedEdge.rationale);
      setLoading(false);
      return;
    }

    // NUL separator can't appear in node IDs or edge types, so keys never collide.
    const cacheKey = [selectedEdge.source, selectedEdge.target, selectedEdge.type].join('\0');
    const cached = cacheRef.current.get(cacheKey);
    if (cached !== undefined) {
      setRationale(cached);
      setLoading(false);
      return;
    }

    // Resolve the edge's position in the full edges array for the detail fetch.
    // indexOf works for the live reference; the triple fallback covers edges whose
    // reference broke across an edgesFile reload.
    let index = edges ? edges.indexOf(selectedEdge) : -1;
    if (index < 0 && edges) {
      index = edges.findIndex(
        (e) => e.source === selectedEdge.source && e.target === selectedEdge.target && e.type === selectedEdge.type,
      );
    }
    if (index < 0) {
      setRationale('');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setRationale(undefined);
    setLoading(true);
    void (async () => {
      try {
        const detail = (await api.getEdgeDetail(index)) as Edge | null;
        if (cancelled) return;
        const text = detail?.rationale ?? '';
        // Cap the cache so a long browsing session can't grow it unbounded.
        if (cacheRef.current.size >= 200) {
          const oldest = cacheRef.current.keys().next().value;
          if (oldest !== undefined) cacheRef.current.delete(oldest);
        }
        cacheRef.current.set(cacheKey, text);
        setRationale(text);
      } catch (err) {
        if (cancelled) return;
        getGlobalRecorder()?.record({
          type: 'state.error',
          component: 'edge-detail-panel',
          level: 'error',
          message: 'Edge rationale fetch failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setRationale('');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedEdge, edges]);

  return { rationale, loading };
}

function RationaleSection({ rationale, loading, clamped, onToggleClamp }: {
  rationale: string | undefined;
  loading: boolean;
  clamped: boolean;
  onToggleClamp: () => void;
}) {
  // `rationale` is undefined until resolved (the hook already merges inline + fetched).
  const text = rationale;
  const pending = loading || rationale === undefined;
  return (
    <div className="edge-detail-section">
      <div className="edge-detail-section-label">Rationale</div>
      {pending ? (
        <div className="edge-detail-rationale" style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
          Loading rationale&hellip;
        </div>
      ) : text ? (
        <>
          <div className={`edge-detail-rationale${clamped ? ' clamped' : ''}`}>{text}</div>
          {text.length > 200 && (
            <button className="edge-detail-rationale-toggle" onClick={onToggleClamp}>
              {clamped ? 'Show more' : 'Show less'}
            </button>
          )}
        </>
      ) : (
        <div className="edge-detail-rationale" style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>No rationale recorded for this edge.</div>
      )}
    </div>
  );
}

export function EdgeDetailPanel({ width }: EdgeDetailPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [rationaleClamped, setRationaleClamped] = useState(true);
  const store = useTaxonomyStore();
  const { selectedEdge, selectEdge, getLabelForId, edgesFile, setActiveTab, setSelectedNodeId, showRelatedEdges } = store;

  const { rationale: resolvedRationale, loading: rationaleLoading } = useEdgeRationale(selectedEdge, edgesFile?.edges);

  // Reset clamp when the selected edge changes.
  useEffect(() => { setRationaleClamped(true); }, [selectedEdge]);

  if (!selectedEdge) return null;

  if (collapsed) {
    return (
      <div className="pane-collapsed" onClick={() => setCollapsed(false)} title="Expand Edge Detail">
        <span className="pane-collapsed-label">Edge Detail</span>
      </div>
    );
  }

  const edge = selectedEdge;
  const sourceLabel = getLabelForId(edge.source);
  const targetLabel = getLabelForId(edge.target);
  const pct = Math.round(edge.confidence * 100);
  const wPct = edge.weight != null ? Math.round(edge.weight * 100) : null;

  // Find the edge type definition
  const typeDef = edgesFile?.edge_types.find((t) => t.type === edge.type);

  const handleNavigate = (nodeId: string) => {
    const pov = povKeyFromNodeId(nodeId);
    const tab = (pov as 'accelerationist' | 'safetyist' | 'skeptic' | 'situations') || 'situations';
    setActiveTab(tab);
    setSelectedNodeId(nodeId);
    showRelatedEdges(nodeId);
  };

  return (
    <div className="edge-detail-panel" style={{ flex: 1, minWidth: 280 }}>
      <div className="edge-detail-header">
        <h3>Edge Detail</h3>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button className="pane-collapse-btn" onClick={() => setCollapsed(true)} title="Collapse" aria-label="Collapse panel">&lsaquo;</button>
          <button
            className="edge-detail-close"
            onClick={() => selectEdge(null)}
            title="Close"
          >
            &times;
          </button>
        </div>
      </div>

      <div className="edge-detail-body">
        {/* Edge type */}
        <div className="edge-detail-type-banner">
          <span className="edge-detail-type-name">{edge.type.replace(/_/g, ' ')}</span>
          {edge.bidirectional && <span className="edge-detail-bidir" title="Bidirectional">&harr;</span>}
        </div>
        {typeDef && (
          <div className="edge-detail-type-def">{typeDef.definition}</div>
        )}

        {/* Source → Target */}
        <div className="edge-detail-endpoints">
          <div className="edge-detail-endpoint">
            <div className="edge-detail-endpoint-role">Source</div>
            <div
              className="edge-detail-endpoint-label"
              style={{ color: nodeColor(edge.source) }}
              onClick={() => handleNavigate(edge.source)}
            >
              {sourceLabel}
            </div>
            <div className="edge-detail-endpoint-id">{edge.source}</div>
            <SupersededMark targetId={supersededTarget(store, edge.source)} onNavigate={handleNavigate} />
          </div>

          <div className="edge-detail-arrow">
            {edge.bidirectional ? '↔' : '→'}
          </div>

          <div className="edge-detail-endpoint">
            <div className="edge-detail-endpoint-role">Target</div>
            <div
              className="edge-detail-endpoint-label"
              style={{ color: nodeColor(edge.target) }}
              onClick={() => handleNavigate(edge.target)}
            >
              {targetLabel}
            </div>
            <div className="edge-detail-endpoint-id">{edge.target}</div>
            <SupersededMark targetId={supersededTarget(store, edge.target)} onNavigate={handleNavigate} />
          </div>
        </div>

        {/* Rationale */}
        <RationaleSection
          rationale={resolvedRationale}
          loading={rationaleLoading}
          clamped={rationaleClamped}
          onToggleClamp={() => setRationaleClamped(!rationaleClamped)}
        />

        {/* Weight & Confidence */}
        <div className="edge-detail-section">
          <div className="edge-detail-section-label">Weight &amp; Confidence <TheoryLink docPath="docs/pov-edges.md" anchor="weight-and-confidence" size={12} label="Open POV Edges doc in GitHub" /></div>
          {wPct != null && (
            <div className="edge-detail-confidence" style={{ marginBottom: 4 }}>
              <span
                className="edge-detail-wc-label"
                tabIndex={0}
                title="Weight: how strongly this edge relationship is asserted — a measure of the logical or rhetorical force connecting source to target node within the POV camp's argument structure."
                aria-label="Weight: how strongly this edge relationship is asserted — a measure of the logical or rhetorical force connecting source to target node within the POV camp's argument structure."
              >w</span>
              <div className="edge-detail-confidence-track">
                <div className="edge-detail-confidence-fill edge-detail-weight-fill" style={{ width: `${wPct}%` }} />
              </div>
              <span className="edge-detail-confidence-pct">{wPct}%</span>
            </div>
          )}
          <div className="edge-detail-confidence">
            <span
              className="edge-detail-wc-label"
              tabIndex={0}
              title="Confidence: how certain the annotator/system is that this edge is correct — reflects evidentiary support or annotation reliability, not the claim's truth."
              aria-label="Confidence: how certain the annotator/system is that this edge is correct — reflects evidentiary support or annotation reliability, not the claim's truth."
            >c</span>
            <div className="edge-detail-confidence-track">
              <div className="edge-detail-confidence-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="edge-detail-confidence-pct">{pct}%</span>
          </div>
        </div>

        {/* Status — only show if not approved */}
        {edge.status !== 'approved' && (
          <div className="edge-detail-section">
            <div className="edge-detail-section-label">Status</div>
            <span className={`edge-detail-status-badge status-${edge.status}`}>
              {edge.status === 'rejected' ? '✗ ' : '● '}{edge.status}
            </span>
          </div>
        )}

        {/* Strength */}
        {edge.strength && (
          <div className="edge-detail-section">
            <div className="edge-detail-section-label">Strength</div>
            <span className="edge-detail-strength-badge">{edge.strength}</span>
          </div>
        )}

        {/* Notes */}
        {edge.notes && (
          <div className="edge-detail-section">
            <div className="edge-detail-section-label">Notes</div>
            <div className="edge-detail-notes">{edge.notes}</div>
          </div>
        )}
      </div>
    </div>
  );
}
