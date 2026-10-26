// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById, isSuperseded, povOfNode } from '../../hooks/useTaxonomyStore/superseded';
import type { Edge, EdgeType, EdgeStatus } from '../../types/taxonomy';
import { POV_META, povKeyFromNodeId, type PovMetaKey } from '@lib/electron-shared/povMeta';
import { TheoryLink } from '../shared/TheoryLink';
import './RelatedEdgesPanel.css';

interface RelatedEdgesPanelProps {
  width?: number;
}

function nodeColor(id: string): string {
  const key = povKeyFromNodeId(id);
  return key ? `var(${POV_META[key].cssVar})` : 'var(--text-muted)';
}

const STATUS_LABEL: Record<EdgeStatus, string> = {
  approved: 'Approved',
  proposed: 'Proposed',
  rejected: 'Rejected',
};

function EdgeMetrics({ confidence, weight }: { confidence: number; weight?: number }) {
  const cPct = Math.round(confidence * 100);
  const wPct = weight != null ? Math.round(weight * 100) : null;
  const title = wPct != null
    ? `w=${wPct}% Weight: how strongly this relationship is asserted (logical/rhetorical force)\nc=${cPct}% Confidence: how certain the annotator/system is that this edge is correct`
    : `c=${cPct}% Confidence: how certain the annotator/system is that this edge is correct`;
  return (
    <span className="related-confidence" title={title}>
      {wPct != null && <span className="related-wc-tag">w{wPct}</span>}
      <span className="related-wc-tag">c{cPct}</span>
    </span>
  );
}

function EdgeRow({
  edge,
  nodeId,
  isSelected,
  onSelect,
}: {
  edge: Edge;
  nodeId: string;
  isSelected: boolean;
  onSelect: (edge: Edge) => void;
}) {
  const isSource = edge.source === nodeId;
  const otherNodeId = isSource ? edge.target : edge.source;
  const direction = edge.bidirectional ? '\u2194' : isSource ? '\u2192' : '\u2190';
  const state = useTaxonomyStore.getState();
  const otherLabel = state.getLabelForId(otherNodeId);
  const otherSuperseded = isSuperseded(state, otherNodeId);
  const supersededByTarget = otherSuperseded ? allNodesById(state).get(otherNodeId)?.superseded_by : undefined;

  const openSupersededTarget = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!supersededByTarget) return;
    const pov = povOfNode(state, supersededByTarget);
    if (pov) state.navigateToNode(pov, supersededByTarget);
  };

  return (
    <div
      className={`related-edge-card${isSelected ? ' related-edge-selected' : ''}`}
      onClick={() => onSelect(edge)}
    >
      <div className="related-edge-header">
        <span className="related-edge-direction">{direction}</span>
        <span
          className="related-edge-label-primary"
          style={{ color: nodeColor(otherNodeId) }}
        >
          {otherLabel}
        </span>
        {otherSuperseded && (
          supersededByTarget ? (
            <button type="button" className="related-edge-superseded-mark related-edge-superseded-mark-link" title={`Superseded by ${supersededByTarget}`} onClick={openSupersededTarget}>superseded</button>
          ) : (
            <span className="related-edge-superseded-mark" title="Superseded">superseded</span>
          )
        )}
        {edge.status !== 'approved' && (
          <span className={`related-edge-status status-${edge.status}`}>
            {edge.status === 'rejected' ? '\u2717 ' : '\u25CF '}{STATUS_LABEL[edge.status]}
          </span>
        )}
      </div>
      <div className="related-edge-sub">
        <span className="related-edge-id">{otherNodeId}</span>
        <EdgeMetrics confidence={edge.confidence} weight={edge.weight} />
      </div>
    </div>
  );
}

function EdgeGroup({
  edgeType,
  edges,
  definition,
  nodeId,
  selectedEdge,
  onSelectEdge,
}: {
  edgeType: EdgeType;
  edges: Edge[];
  definition: string;
  nodeId: string;
  selectedEdge: Edge | null;
  onSelectEdge: (edge: Edge) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);

  // Auto-expand when this group contains the selected edge
  useEffect(() => {
    if (selectedEdge && edges.some(e => e.source === selectedEdge.source && e.target === selectedEdge.target && e.type === selectedEdge.type)) {
      setCollapsed(false);
    }
  }, [selectedEdge, edges]);

  return (
    <div className="related-edge-group">
      <div
        className="related-edge-group-header"
        title={definition}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="related-edge-group-toggle">{collapsed ? '\u25B6' : '\u25BC'}</span>
        <span className="related-edge-type-name">{edgeType.replace(/_/g, ' ')}</span>
        <span className="related-edge-type-count">{edges.length}</span>
      </div>
      {!collapsed && edges.map((edge, i) => {
        const isSelected = selectedEdge !== null
          && edge.source === selectedEdge.source
          && edge.target === selectedEdge.target
          && edge.type === selectedEdge.type;
        return (
          <EdgeRow
            key={`${edge.source}-${edge.target}-${edge.type}-${i}`}
            edge={edge}
            nodeId={nodeId}
            isSelected={isSelected}
            onSelect={onSelectEdge}
          />
        );
      })}
    </div>
  );
}

function otherNodePovKey(edge: Edge, nodeId: string): PovMetaKey | undefined {
  const otherId = edge.source === nodeId ? edge.target : edge.source;
  return povKeyFromNodeId(otherId);
}

// Build edge-type groups for a node, applying status/confidence/POV filters,
// then sort edges within each group by confidence (descending).
function buildEdgeGroups(
  edges: Edge[],
  nodeId: string,
  statusFilter: EdgeStatus | '',
  confidenceThreshold: number,
  hiddenPovs: Set<PovMetaKey>,
): Map<EdgeType, Edge[]> {
  const groups = new Map<EdgeType, Edge[]>();
  for (const edge of edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    if (statusFilter && edge.status !== statusFilter) continue;
    if (edge.confidence < confidenceThreshold) continue;
    const key = otherNodePovKey(edge, nodeId);
    if (key && hiddenPovs.has(key)) continue;

    const existing = groups.get(edge.type);
    if (existing) {
      existing.push(edge);
    } else {
      groups.set(edge.type, [edge]);
    }
  }

  // Sort edges within each group by confidence (descending)
  for (const edges of groups.values()) {
    edges.sort((a, b) => b.confidence - a.confidence);
  }

  return groups;
}

// Order groups by fixed priority, appending any remaining types after.
function sortEdgeGroupsByPriority(groups: Map<EdgeType, Edge[]>): Map<EdgeType, Edge[]> {
  const EDGE_TYPE_PRIORITY: string[] = [
    'SUPPORTS',
    'CONTRADICTS',
    'ASSUMES',
    'WEAKENS',
    'RESPONDS_TO',
    'TENSION_WITH',
    'INTERPRETS',
    'CONVERGES_WITH',
  ];
  const sorted = new Map<EdgeType, Edge[]>();
  // First: types in priority order
  for (const type of EDGE_TYPE_PRIORITY) {
    const edges = groups.get(type as EdgeType);
    if (edges) sorted.set(type as EdgeType, edges);
  }
  // Then: any remaining types not in the priority list
  for (const [type, edges] of groups) {
    if (!sorted.has(type)) sorted.set(type, edges);
  }

  return sorted;
}

export function RelatedEdgesPanel({ width }: RelatedEdgesPanelProps) {
  const { edgesFile, edgesLoading, relatedNodeId, showRelatedEdges, selectedEdge, selectEdge } = useTaxonomyStore();
  const [collapsed, setCollapsed] = useState(false);
  const [statusFilter, setStatusFilter] = useState<EdgeStatus | ''>('');
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.75);
  const [hiddenPovs, setHiddenPovs] = useState<Set<PovMetaKey>>(new Set());
  const panelRef = useRef<HTMLDivElement>(null);

  const nodeId = relatedNodeId;

  // Per-POV counts after status/confidence filter (before POV filter)
  const povCounts = useMemo(() => {
    const counts: Record<PovMetaKey, number> = { accelerationist: 0, safetyist: 0, skeptic: 0, situations: 0 };
    if (!edgesFile || !nodeId) return counts;
    for (const edge of edgesFile.edges) {
      if (edge.source !== nodeId && edge.target !== nodeId) continue;
      if (statusFilter && edge.status !== statusFilter) continue;
      if (edge.confidence < confidenceThreshold) continue;
      const key = otherNodePovKey(edge, nodeId);
      if (key) counts[key]++;
    }
    return counts;
  }, [edgesFile, nodeId, statusFilter, confidenceThreshold]);

  // Reset hidden POVs when node changes
  useEffect(() => { setHiddenPovs(new Set()); }, [nodeId]);

  const togglePov = useCallback((prefix: PovMetaKey) => {
    setHiddenPovs(prev => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix); else next.add(prefix);
      return next;
    });
  }, []);

  // Find all edges where this node is source or target, grouped by edge type
  const groupedEdges = useMemo(() => {
    if (!edgesFile || !nodeId) return new Map<EdgeType, Edge[]>();
    const groups = buildEdgeGroups(edgesFile.edges, nodeId, statusFilter, confidenceThreshold, hiddenPovs);
    return sortEdgeGroupsByPriority(groups);
  }, [edgesFile, nodeId, statusFilter, confidenceThreshold, hiddenPovs]);

  // Get edge type definitions for labels
  const edgeTypeDefs = useMemo(() => {
    if (!edgesFile) return new Map<string, string>();
    const m = new Map<string, string>();
    for (const def of edgesFile.edge_types) {
      m.set(def.type, def.definition);
    }
    return m;
  }, [edgesFile]);

  const totalEdges = useMemo(() => {
    let count = 0;
    for (const edges of groupedEdges.values()) count += edges.length;
    return count;
  }, [groupedEdges]);

  // Flat list of all visible edges for keyboard navigation
  const allEdges = useMemo(() => {
    const flat: Edge[] = [];
    for (const edges of groupedEdges.values()) {
      flat.push(...edges);
    }
    return flat;
  }, [groupedEdges]);

  const handleSelectEdge = useCallback((edge: Edge) => {
    selectEdge(edge);
  }, [selectEdge]);

  // Keyboard: up/down to navigate edges
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (allEdges.length === 0) return;
    e.preventDefault();
    e.stopPropagation();

    const currentIdx = selectedEdge
      ? allEdges.findIndex(ed => ed.source === selectedEdge.source && ed.target === selectedEdge.target && ed.type === selectedEdge.type)
      : -1;

    let nextIdx: number;
    if (e.key === 'ArrowDown') {
      nextIdx = currentIdx < allEdges.length - 1 ? currentIdx + 1 : 0;
    } else {
      nextIdx = currentIdx > 0 ? currentIdx - 1 : allEdges.length - 1;
    }
    selectEdge(allEdges[nextIdx]);
  }, [allEdges, selectedEdge, selectEdge]);

  if (!nodeId) return null;

  if (collapsed) {
    return (
      <div className="pane-collapsed" onClick={() => setCollapsed(false)} title="Expand Related Edges">
        <span className="pane-collapsed-label">Related Edges</span>
      </div>
    );
  }

  const nodeLabel = useTaxonomyStore.getState().getLabelForId(nodeId);

  return (
    <div className="related-edges-panel" style={width ? { width, minWidth: width } : undefined} ref={panelRef} tabIndex={0} onKeyDown={handleKeyDown} onMouseDown={() => panelRef.current?.focus()}>
      <div className="related-edges-node-banner">
        <span className="related-edges-node-id" style={{ color: nodeColor(nodeId) }}>{nodeId}</span>
        <span className="related-edges-node-label">{nodeLabel}</span>
      </div>
      <div className="related-edges-header">
        <div className="related-edges-title">
          <h3>Related Edges</h3>
          <span className="related-edges-count">{totalEdges}</span>
          <TheoryLink docPath="docs/pov-edges.md" size={12} label="Open POV Edges doc in GitHub" />
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button className="pane-collapse-btn" onClick={() => setCollapsed(true)} title="Collapse">&lsaquo;</button>
          <button
            className="related-edges-close"
            onClick={() => showRelatedEdges(null)}
            title="Close"
          >
            &times;
          </button>
        </div>
      </div>

      {/* POV filter buttons */}
      <div className="related-edges-pov-filters">
        {(Object.keys(POV_META) as PovMetaKey[]).filter(k => povCounts[k] > 0).map(k => (
          <button
            key={k}
            className={`related-edges-pov-btn${hiddenPovs.has(k) ? ' related-edges-pov-btn-hidden' : ''}`}
            style={{ '--pov-color': `var(${POV_META[k].cssVar})` } as React.CSSProperties}
            onClick={() => togglePov(k)}
            title={`${hiddenPovs.has(k) ? 'Show' : 'Hide'} ${POV_META[k].label}`}
          >
            {POV_META[k].label}
            <span className="related-edges-pov-btn-count">{povCounts[k]}</span>
          </button>
        ))}
      </div>

      <div className="related-edges-toolbar">
        <select
          className="related-edges-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as EdgeStatus | '')}
        >
          <option value="">All statuses</option>
          <option value="approved">Approved</option>
          <option value="proposed">Proposed</option>
          <option value="rejected">Rejected</option>
        </select>
        <div className="related-edges-threshold">
          <label className="related-edges-threshold-label">
            Confidence &ge; {Math.round(confidenceThreshold * 100)}%
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(confidenceThreshold * 100)}
            onChange={(e) => setConfidenceThreshold(Number(e.target.value) / 100)}
            className="related-edges-threshold-slider"
          />
        </div>
      </div>

      <div className="related-edges-body">
        {edgesLoading && (
          <div className="related-edges-loading">Loading edges...</div>
        )}

        {!edgesLoading && !edgesFile && (
          <div className="related-edges-empty">
            No edges.json found in the active taxonomy directory.
          </div>
        )}

        {!edgesLoading && edgesFile && totalEdges === 0 && (
          <div className="related-edges-empty">
            No edges found for this node{statusFilter ? ` with status "${statusFilter}"` : ''}.
          </div>
        )}

        {Array.from(groupedEdges.entries()).map(([edgeType, edges]) => (
          <EdgeGroup
            key={edgeType}
            edgeType={edgeType}
            edges={edges}
            definition={edgeTypeDefs.get(edgeType) || ''}
            nodeId={nodeId}
            selectedEdge={selectedEdge}
            onSelectEdge={handleSelectEdge}
          />
        ))}
      </div>
    </div>
  );
}
