// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Evidence QBAF graph (shown in NodeDetail's Research tab). Extracted from NodeDetail.tsx
// so the host file stays under its complexity/line-count baseline (t/4574).

import { useMemo } from 'react';
import { useDebateStore } from '../../hooks/useDebateStore';

interface EvidenceItem {
  id: string;
  source_doc_id: string;
  text: string;
  relation: 'support' | 'contradict';
  similarity: number;
}

interface EvidenceGraphData {
  evidence_items: EvidenceItem[];
  computed_strength: number;
  qbaf_iterations: number;
}

export function EvidenceGraphSection({ nodeId }: { nodeId: string }) {
  const activeDebate = useDebateStore(s => s.activeDebate);

  const evidenceNodes = useMemo(() => {
    const an = activeDebate?.argument_network;
    if (!an) return [];
    return an.nodes.filter(
      n => n.taxonomy_refs?.includes(nodeId) && n.evidence_graph
    );
  }, [activeDebate, nodeId]);

  if (evidenceNodes.length === 0) return null;

  return (
    <div className="evidence-graph">
      <div className="evidence-graph-title">
        Evidence Graph ({evidenceNodes.length} claim{evidenceNodes.length !== 1 ? 's' : ''})
      </div>
      {evidenceNodes.map(node => {
        const eg = node.evidence_graph as EvidenceGraphData;
        const sorted = [...eg.evidence_items].sort((a, b) => {
          if (a.relation !== b.relation) return a.relation === 'contradict' ? -1 : 1;
          return b.similarity - a.similarity;
        });
        const supports = sorted.filter(e => e.relation === 'support');
        const contradicts = sorted.filter(e => e.relation === 'contradict');
        const barPct = Math.round(eg.computed_strength * 100);
        const barColor = eg.computed_strength >= 0.7 ? '#22c55e' : eg.computed_strength >= 0.4 ? '#f59e0b' : '#ef4444';
        return (
          <div key={node.id} className="evidence-claim-card">
            <div className="evidence-claim-text">
              {node.text}
              {node.attribution_text_genus && <div className="claim-attribution-text"><span className="claim-attribution-label">Attribution:</span>{node.attribution_text_genus}</div>}
            </div>
            <div className="evidence-strength-row">
              <div className="evidence-strength-track">
                {/* eslint-disable-next-line local/no-inline-style -- width/background computed from this claim's evidence strength */}
                <div className="evidence-strength-fill" style={{ width: `${barPct}%`, background: barColor }} />
              </div>
              {/* eslint-disable-next-line local/no-inline-style -- color computed from this claim's evidence strength */}
              <span className="evidence-strength-value" style={{ color: barColor }}>
                {(eg.computed_strength ?? 0).toFixed(2)}
              </span>
              <span className="evidence-strength-iter">
                {eg.qbaf_iterations} iter
              </span>
            </div>
            {sorted.map(item => (
              <div key={item.id} className={`evidence-item ${item.relation === 'support' ? 'evidence-item-support' : 'evidence-item-contradict'}`}>
                <div className="evidence-item-header">
                  <span className={`evidence-item-badge ${item.relation === 'support' ? 'evidence-item-badge-support' : 'evidence-item-badge-contradict'}`}>
                    {item.relation === 'support' ? 'SUPPORTS' : 'CONTRADICTS'}
                  </span>
                  <span className="evidence-item-sim">
                    {(item.similarity * 100).toFixed(0)}% sim
                  </span>
                  <span className="evidence-item-source">
                    {item.source_doc_id}
                  </span>
                </div>
                <div className="evidence-item-text">
                  {item.text}
                </div>
              </div>
            ))}
            <div className="evidence-summary">
              {supports.length} supporting, {contradicts.length} contradicting
            </div>
          </div>
        );
      })}
    </div>
  );
}
