// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import React, { useState, useMemo } from 'react';
import './ArgumentNetworkTab.css';
import type { DebateSession, ArgumentNetworkNode, ArgumentNetworkEdge } from '../../../../types/debate';
import type { WeightHistoryEntry } from '../../../../types/taxonomy';
import { computeQbafStrengths } from '@lib/debate/qbaf';
import type { QbafNode, QbafEdge } from '@lib/debate/qbaf';
import { useTaxonomyStore } from '../../../../hooks/useTaxonomyStore';
import { allPovNodes } from '../../../../hooks/useTaxonomyStore/superseded';
import { INodeRow } from '../shared';
import { TheoryLink } from '../../../shared/TheoryLink';
import { Highlight, speakerLabel } from '../helpers';
import type { OverviewTab } from '../types';
import { POV_META, type PovMetaKey } from '@lib/electron-shared/povMeta';

interface ArgumentNetwork {
  nodes: ArgumentNetworkNode[];
  edges: ArgumentNetworkEdge[];
}

interface ArgumentNetworkTabProps {
  debate: DebateSession;
  an: ArgumentNetwork;
  anFilterMode: 'all' | 'unattributed' | 'novel' | 'anchored';
  anFilterNodeId: string;
  setAnFilterMode: (mode: 'all' | 'unattributed' | 'novel' | 'anchored') => void;
  setAnFilterNodeId: (id: string) => void;
  focusedNodeId: string | null;
  handleUpdateSubScore: (nodeId: string, key: string, value: number) => void;
  setOverviewTab: (tab: OverviewTab) => void;
  setSelectedEntry: (id: string | null) => void;
  setLocalOverride: (v: boolean) => void;
  /** Taxonomy node-id → human-readable label map, used to lead attribution tooltips with the node's title. */
  nodeLabels: Map<string, string>;
}

export function ArgumentNetworkTab({
  debate,
  an,
  anFilterMode,
  anFilterNodeId,
  setAnFilterMode,
  setAnFilterNodeId,
  focusedNodeId,
  handleUpdateSubScore,
  setOverviewTab,
  setSelectedEntry,
  setLocalOverride,
  nodeLabels,
}: ArgumentNetworkTabProps) {
  // Community/older debates may omit edges entirely — guard all usages
  const edges = an.edges ?? [];
  const caCount = edges.filter(e => e.type === 'attacks').length;
  const raCount = edges.filter(e => e.type === 'supports').length;
  // Statement-ID map — matches S{round} from the main transcript view.
  const stmtIdByEntry = new Map<string, string>();
  debate.transcript.forEach((e, i) => stmtIdByEntry.set(e.id, `S${i + 1}`));

  // Compute QBAF strengths from edges
  const qbafNodes: QbafNode[] = an.nodes.map(n => ({ id: n.id, base_strength: n.base_strength ?? 0.5 }));
  const qbafEdges: QbafEdge[] = edges.map(e => ({
    source: e.source, target: e.target,
    type: e.type as 'attacks' | 'supports',
    weight: e.weight ?? 0.5,
    attack_type: e.attack_type,
  }));
  const qbafResult = computeQbafStrengths(qbafNodes, qbafEdges);
  const strengthMap = qbafResult.strengths;

  // Build moderator trace lookup: entry ID -> trace
  const modTraceByEntryId = new Map<string, {
    selected: string; focus_point: string; addressing?: string;
    excluded_last_speaker?: string | null;
    selection_reason?: string;
    recent_scheme?: string | null;
    convergence_score?: number | null; convergence_triggered?: boolean;
    candidates?: { debater: string; computed_strength: number | null; rank: number }[];
    argument_network_snapshot?: { total_claims: number; total_edges: number; unaddressed_claims: number } | null;
  }>();
  debate.transcript.forEach(e => {
    const meta = e.metadata as Record<string, unknown> | undefined;
    if (meta?.moderator_trace) {
      modTraceByEntryId.set(e.id, meta.moderator_trace as NonNullable<ReturnType<typeof modTraceByEntryId.get>>);
    }
  });

  // Group AN nodes by source_entry_id to interleave with moderator traces
  const entryGroups: { entryId: string; nodes: typeof an.nodes; trace: ReturnType<typeof modTraceByEntryId.get> }[] = [];
  const seenEntries = new Set<string>();
  for (const n of an.nodes) {
    const eid = n.source_entry_id;
    if (!seenEntries.has(eid)) {
      seenEntries.add(eid);
      entryGroups.push({
        entryId: eid,
        nodes: an.nodes.filter(x => x.source_entry_id === eid),
        trace: modTraceByEntryId.get(eid),
      });
    }
  }

  // Also show moderator traces for entries that produced no AN nodes
  debate.transcript.forEach(e => {
    const meta = e.metadata as Record<string, unknown> | undefined;
    if (meta?.moderator_trace && !seenEntries.has(e.id)) {
      entryGroups.push({ entryId: e.id, nodes: [], trace: meta.moderator_trace as ReturnType<typeof modTraceByEntryId.get> });
    }
  });

  const modCount = [...modTraceByEntryId.values()].length;

  // Apply AN claim filters (t/117)
  const anNodeFilter = (n: ArgumentNetworkNode): boolean => {
    const attr = n.claim_taxonomy_attribution;
    if (anFilterMode === 'unattributed') return !!attr?.unattributed_reason;
    if (anFilterMode === 'novel') return attr?.unattributed_reason === 'novel_argument';
    if (anFilterMode === 'anchored') return !!attr && !attr.unattributed_reason;
    if (anFilterNodeId.trim()) {
      const q = anFilterNodeId.trim().toLowerCase();
      return !!attr?.primary_ref?.toLowerCase().includes(q)
        || !!attr?.secondary_refs?.some(s => s.node_id.toLowerCase().includes(q));
    }
    return true;
  };
  const filteredGroups = entryGroups.map(g => ({
    ...g,
    nodes: g.nodes.filter(anNodeFilter),
  })).filter(g => g.nodes.length > 0 || g.trace);

  const filteredNodeCount = filteredGroups.reduce((sum, g) => sum + g.nodes.length, 0);
  const isFiltered = anFilterMode !== 'all' || anFilterNodeId.trim() !== '';
  const [allExpanded, setAllExpanded] = useState(false);

  return (
    <div className="ant-root">
      <ArgNetMinimap nodes={an.nodes} edges={edges} />
      <div className="ant-header-row">
        <span className="ant-header-summary">
          {an.nodes.length} I-nodes · {caCount} CA · {raCount} RA{modCount > 0 ? ` · ${modCount} moderator decisions` : ''}
        </span>
        <TheoryLink docPath="docs/reading-the-argument-network.md" anchor="node-types" size={12} />
        <button
          onClick={() => setAllExpanded(!allExpanded)}
          className="ant-expand-btn"
        >
          {allExpanded ? 'Collapse All' : 'Expand All'}
        </button>
      </div>
      {/* AN claim filter bar */}
      <div className="ant-filter-bar">
        <select
          value={anFilterMode}
          onChange={e => setAnFilterMode(e.target.value as typeof anFilterMode)}
          className="ant-filter-select"
        >
          <option value="all">All claims</option>
          <option value="unattributed">Unattributed only</option>
          <option value="novel">Novel arguments</option>
          <option value="anchored">Attributed only</option>
        </select>
        <input
          type="text"
          placeholder="Filter by node ID…"
          value={anFilterNodeId}
          onChange={e => setAnFilterNodeId(e.target.value)}
          className="ant-filter-input"
        />
        {isFiltered && (
          <span className="ant-muted">
            {filteredNodeCount}/{an.nodes.length} shown
            <button
              onClick={() => { setAnFilterMode('all'); setAnFilterNodeId(''); }}
              className="ant-clear-btn"
            >clear</button>
          </span>
        )}
      </div>
      {filteredGroups.map(({ entryId, nodes: groupNodes, trace }) => {
        const srcEntry = debate.transcript.find(e => e.id === entryId);
        const stmtId = stmtIdByEntry.get(entryId);
        return (
        <div key={entryId}>
          {/* Source statement header */}
          {srcEntry && groupNodes.length > 0 && (
            <div
              className="ant-src-header"
              onClick={() => { setOverviewTab('transcript'); setSelectedEntry(entryId); setLocalOverride(true); }}
              title={`Go to ${stmtId ?? entryId} in transcript`}
            >
              <span className="ant-stmt-id">{stmtId ?? entryId}</span>
              {/* eslint-disable-next-line local/no-inline-style -- color is per-camp, derived from POV_META.cssVar */}
              <span className="ant-speaker" style={{ color: `var(${POV_META[srcEntry.speaker as PovMetaKey]?.cssVar ?? '--text-primary'})` }}>{speakerLabel(srcEntry.speaker)}</span>
              <span className="ant-muted">
                {srcEntry.content.length > 200 ? srcEntry.content.slice(0, 200) + '…' : srcEntry.content}
              </span>
            </div>
          )}
          {/* Moderator deliberation banner */}
          {trace && (
            <div className="ant-mod-banner">
              <div className="ant-mod-row">
                <span className="ant-mod-label">Moderator</span>
                {/* eslint-disable-next-line local/no-inline-style -- color is per-camp, derived from POV_META.cssVar */}
                <span className="ant-bold" style={{ color: `var(${POV_META[trace.selected as PovMetaKey]?.cssVar ?? '--text-primary'})` }}>→ {speakerLabel(trace.selected)}</span>
                {trace.selection_reason && (
                  <span className="ant-reason-chip">
                    {trace.selection_reason.replace(/_/g, ' ')}
                  </span>
                )}
                {trace.recent_scheme && (
                  <span className="ant-scheme-chip">
                    {trace.recent_scheme}
                  </span>
                )}
                {trace.convergence_score != null && (
                  <span className="ant-muted">
                    conv: {(trace.convergence_score * 100).toFixed(0)}%
                    {trace.convergence_triggered && <span className="ant-triggered">triggered</span>}
                  </span>
                )}
              </div>
              <div className="ant-focus-line">
                <strong>Focus:</strong> <Highlight text={trace.focus_point} />
              </div>
              {trace.candidates && trace.candidates.length > 0 && (
                <div className="ant-candidates">
                  {trace.candidates.map((c, i) => (
                    // eslint-disable-next-line local/no-inline-style -- opacity/fontWeight/color are data-driven (selected candidate, per-camp from POV_META.cssVar)
                    <span key={i} style={{
                      fontSize: 'var(--text-2xs)',
                      opacity: c.debater === trace.selected ? 1 : 0.6,
                      fontWeight: c.debater === trace.selected ? 700 : 400,
                      color: `var(${POV_META[c.debater as PovMetaKey]?.cssVar ?? '--text-primary'})`,
                    }}>
                      #{c.rank} {speakerLabel(c.debater)}
                      {c.computed_strength != null && ` (${c.computed_strength.toFixed(2)})`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* AN nodes from this entry */}
          {groupNodes.map(n => {
            const attacks = edges.filter(e => e.target === n.id && e.type === 'attacks');
            const supports = edges.filter(e => e.target === n.id && e.type === 'supports');
            const isSource = edges.some(e => e.source === n.id);
            return (
              <INodeRow
                key={n.id}
                node={n}
                attacks={attacks}
                supports={supports}
                allNodes={an.nodes}
                allEdges={edges}
                isSource={isSource}
                computedStrength={strengthMap.get(n.id)}
                strengthMap={strengthMap}
                statementId={stmtIdByEntry.get(n.source_entry_id)}
                onGotoEntry={(eid) => { setOverviewTab('transcript'); setSelectedEntry(eid); setLocalOverride(true); }}
                stmtIdByEntry={stmtIdByEntry}
                focused={focusedNodeId === n.id}
                onUpdateSubScore={handleUpdateSubScore}
                nodeLabels={nodeLabels}
                defaultExpanded={allExpanded}
              />
            );
          })}
        </div>
        );
      })}
      {/* Confidence evolution trace — shows taxonomy nodes whose confidence changed from this debate */}
      <ConfidenceImpactTrace debateId={debate.id} />
    </div>
  );
}

const MINIMAP_SPEAKER_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(POV_META).filter(([k]) => k !== 'situations').map(([k, v]) => [k, `var(${v.cssVar})`])
);
const MINIMAP_DEGRADE_CEILING = 80;

const effectiveSpeaker = (n: ArgumentNetworkNode) => n.steelman_of ?? n.speaker;

function ArgNetMinimap({ nodes, edges }: { nodes: ArgumentNetworkNode[]; edges: ArgumentNetworkEdge[] }) {
  const layout = useMemo(() => {
    if (nodes.length === 0 || nodes.length > MINIMAP_DEGRADE_CEILING) return null;

    const speakers = [...new Set(nodes.map(n => effectiveSpeaker(n)))];
    const W = 280, H = 140, CX = W / 2, CY = H / 2, R = 52;
    const arcPerSpeaker = (2 * Math.PI) / Math.max(speakers.length, 1);
    const positions = new Map<string, { x: number; y: number }>();

    speakers.forEach((spk, si) => {
      const spkNodes = nodes.filter(n => effectiveSpeaker(n) === spk);
      const arcStart = si * arcPerSpeaker - Math.PI / 2;
      spkNodes.forEach((n, ni) => {
        const angle = arcStart + ((ni + 0.5) / spkNodes.length) * arcPerSpeaker;
        const jitter = spkNodes.length > 10 ? (ni % 2 === 0 ? 0.82 : 1.15) : 1;
        positions.set(n.id, {
          x: CX + R * jitter * Math.cos(angle),
          y: CY + R * jitter * Math.sin(angle),
        });
      });
    });

    return { W, H, CX, CY, positions, speakers };
  }, [nodes, edges]);

  if (nodes.length > MINIMAP_DEGRADE_CEILING) {
    return (
      <div className="ant-minimap-toolarge">
        Network too large for minimap ({nodes.length} nodes, {edges.length} edges)
      </div>
    );
  }

  if (!layout || nodes.length === 0) return null;

  const { W, H, positions } = layout;

  return (
    <div className="ant-minimap-wrap">
      {/* eslint-disable-next-line local/no-inline-style -- height is computed from layout dimensions */}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 360, height: H }}>
        {edges.map((e, i) => {
          const s = positions.get(e.source);
          const t = positions.get(e.target);
          if (!s || !t) return null;
          return (
            <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
              stroke={e.type === 'attacks' ? 'var(--danger, var(--danger))' : 'var(--success, var(--success))'}
              strokeWidth={0.6} opacity={0.35} />
          );
        })}
        {nodes.map(n => {
          const pos = positions.get(n.id);
          if (!pos) return null;
          return (
            <circle key={n.id} cx={pos.x} cy={pos.y} r={3}
              fill={MINIMAP_SPEAKER_COLORS[effectiveSpeaker(n)] ?? 'var(--text-muted)'}
              opacity={0.8} />
          );
        })}
      </svg>
      <div className="ant-legend">
        {layout.speakers.map(s => (
          <span key={s} className="ant-legend-item">
            {/* eslint-disable-next-line local/no-inline-style -- background is data-driven per speaker */}
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: MINIMAP_SPEAKER_COLORS[s] ?? 'var(--text-muted)' }} />
            {speakerLabel(s)}
          </span>
        ))}
        <span className="ant-legend-item">
          <span className="ant-legend-attack" /> attack
        </span>
        <span className="ant-legend-item">
          <span className="ant-legend-support" /> support
        </span>
        <TheoryLink docPath="docs/aif-debate-tool-analysis.md" size={12} />
      </div>
    </div>
  );
}

interface ConfidenceImpact { nodeId: string; label: string; pov: string; entry: WeightHistoryEntry }

/** Collect matching history entries from one history array into the shared impacts list. */
function collectHistoryImpacts(
  history: WeightHistoryEntry[] | undefined,
  n: { id: string; label: string },
  pov: string,
  debateId: string,
  impacts: ConfidenceImpact[],
) {
  if (!history) return;
  for (const h of history) {
    if (h.reason?.includes(debateId)) {
      impacts.push({ nodeId: n.id, label: n.label, pov, entry: h });
    }
  }
}

/** Gather confidence/priority/operationality history impacts for a debate from the taxonomy store. */
export function collectConfidenceImpacts(debateId: string): ConfidenceImpact[] {
  const taxState = useTaxonomyStore.getState();
  const impacts: ConfidenceImpact[] = [];
  for (const pov of ['accelerationist', 'safetyist', 'skeptic'] as const) {
    // t/4361: the full set (selectable + superseded) — a node superseded since this debate ran must
    // still surface the confidence-history impacts it recorded then (t/4355 holds it out of .nodes).
    for (const n of allPovNodes(taxState, pov)) {
      collectHistoryImpacts(n.confidence_history, n, pov, debateId, impacts);
      collectHistoryImpacts(n.priority_history, n, pov, debateId, impacts);
      collectHistoryImpacts(n.operationality_history, n, pov, debateId, impacts);
    }
  }
  return impacts;
}

/** Props-only sub-component: renders a single confidence-impact row. */
function ConfidenceImpactRow({ imp }: { imp: ConfidenceImpact }) {
  const deltaColor = imp.entry.delta > 0 ? 'var(--success)' : imp.entry.delta < 0 ? 'var(--danger)' : 'var(--text-muted)';
  return (
    <div className="ant-impact-row">
      <code className="ant-impact-code">{imp.nodeId}</code>
      <span className="ant-muted">{imp.label.length > 40 ? imp.label.slice(0, 40) + '…' : imp.label}</span>
      <span className="ant-value">{imp.entry.value.toFixed(2)}</span>
      {/* eslint-disable-next-line local/no-inline-style -- color is data-driven from delta sign */}
      <span style={{ color: deltaColor, fontWeight: 600 }}>
        {imp.entry.delta > 0 ? '+' : ''}{imp.entry.delta.toFixed(2)}
      </span>
      {imp.entry.attack_claim && (
        <span className="ant-attack-claim" title={imp.entry.attack_claim}>
          ← {imp.entry.attack_claim.length > 50 ? imp.entry.attack_claim.slice(0, 50) + '…' : imp.entry.attack_claim}
        </span>
      )}
      {imp.entry.robustness != null && imp.entry.robustness >= 2 && (
        <span className="ant-robust-chip">
          {imp.entry.robustness}× confirmed
        </span>
      )}
    </div>
  );
}

/** Inline sub-component: confidence impact trace from taxonomy store. */
function ConfidenceImpactTrace({ debateId }: { debateId: string }) {
  const impacts = collectConfidenceImpacts(debateId);
  if (impacts.length === 0) return null;
  return (
    <div className="ant-impact">
      <div className="ant-impact-title">
        Confidence Impact ({impacts.length})
      </div>
      {impacts.map((imp, i) => (
        <ConfidenceImpactRow key={i} imp={imp} />
      ))}
    </div>
  );
}
