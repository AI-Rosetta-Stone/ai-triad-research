// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState } from 'react';
import type { ArgumentNetworkNode, ArgumentNetworkEdge, TranscriptEntry } from '../../types/debate';
import { computeQbafStrengths } from '@lib/debate/qbaf';
import type { QbafNode, QbafEdge } from '@lib/debate/qbaf';
import { speakerLabel, STRENGTH_BAND, getNodeLabel } from './utils';
import { bandColor as computeBandColor, CONFIDENCE_BANDS } from '../../lib/bandColor';
// Direct import, not via the '../shared' barrel — the barrel crashes at test module-eval (t/2420).
import { TheoryLink } from '../shared/TheoryLink';
import './ClaimsView.css';

const ATTACK_TYPE_WEIGHTS: Record<string, number> = { rebut: 1.0, undercut: 1.05, undermine: 1.1 };

type ClaimAttribution = NonNullable<ArgumentNetworkNode['claim_taxonomy_attribution']>;

function bdiLabelFor(node: ArgumentNetworkNode): string {
  return node.bdi_category === 'belief' ? 'Belief' : node.bdi_category === 'desire' ? 'Desire' : node.bdi_category === 'intention' ? 'Intention' : '';
}

function idColTitle(
  node: ArgumentNetworkNode,
  bdiLabel: string,
  computed: number,
  base: number,
  delta: number,
  attacks: ArgumentNetworkEdge[],
  supports: ArgumentNetworkEdge[],
  truncText: string,
): string {
  return `Argument Network node ${node.id}\nSpeaker: ${speakerLabel(node.speaker)}\n${bdiLabel ? `Category: ${bdiLabel}` : ''}${node.bdi_confidence != null ? ` (confidence: ${node.bdi_confidence.toFixed(2)})` : ''}\nStrength: ${computed.toFixed(2)} (base: ${base.toFixed(2)}, delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)})\n${attacks.length} attack${attacks.length !== 1 ? 's' : ''}, ${supports.length} support${supports.length !== 1 ? 's' : ''}\n\n${truncText}`;
}

function bdiColTitle(bdiLabel: string, node: ArgumentNetworkNode): string | undefined {
  return bdiLabel && node.bdi_confidence != null ? `${bdiLabel} (confidence: ${node.bdi_confidence.toFixed(2)})` : bdiLabel || undefined;
}

function strengthColTitle(computed: number, base: number, delta: number): string {
  return `Strength: ${computed.toFixed(2)} (base: ${base.toFixed(2)}, delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`;
}

function edgeColTitle(hasEdges: boolean, attacks: ArgumentNetworkEdge[], supports: ArgumentNetworkEdge[]): string | undefined {
  return hasEdges ? `${attacks.length} attack${attacks.length !== 1 ? 's' : ''} and ${supports.length} support${supports.length !== 1 ? 's' : ''} connected to this claim` : undefined;
}

function UnattributedBadge({ reason }: { reason: string }) {
  const reasonLabel = reason === 'novel_argument' ? 'novel' : 'no embedding';
  const reasonTip = reason === 'novel_argument'
    ? 'Unattributed: claim is a novel argument not closely matching any taxonomy node (best similarity < 0.35)'
    : 'Unattributed: missing embedding — cannot compute similarity';
  return <span className="claims-badge" title={reasonTip}><span className="claims-dot claims-dot-red">●</span>{reasonLabel}</span>;
}

function AttributedBadge({ attr }: { attr: ClaimAttribution }) {
  const conf = attr.attribution_confidence;
  const confColor = computeBandColor(conf, [
    { threshold: 0.7, color: '#22c55e' },
    { threshold: 0.5, color: '#3b82f6' },
    { threshold: 0,   color: '#f59e0b' },
  ]);
  const secCount = attr.secondary_refs?.length ?? 0;
  // t/4676: attr.grounding_statement (t/4692) is the claim's best-matching synthetic
  // statement for this node — NOT the node's canonical description (getNodeLabel above is
  // the label, not the description, but the disclosure still applies since both are shown
  // together). Absent on claims attributed before t/4692 landed; the tooltip falls back to
  // the label alone, unchanged from before this ticket.
  const groundingLine = attr.grounding_statement
    ? `\n\nBest-matching statement: "${attr.grounding_statement}"`
    : '';
  const attrTip = `Attributed to ${attr.primary_ref} (confidence: ${conf.toFixed(2)})\n${getNodeLabel(attr.primary_ref)}${groundingLine}${secCount > 0 ? `\n\n${secCount} secondary ref${secCount !== 1 ? 's' : ''}: ${attr.secondary_refs!.map((s: { node_id: string; similarity: number }) => `${s.node_id} (${s.similarity.toFixed(2)})`).join(', ')}` : ''}`;
  return (
    <span className="claims-badge" title={attrTip}>
      {/* eslint-disable-next-line local/no-inline-style -- dynamic confidence color */}
      <span className="claims-dot" style={{ color: confColor }}>●</span>{attr.primary_ref} {conf.toFixed(2)}
    </span>
  );
}

function AttributionCell({ attr }: { attr: ClaimAttribution }) {
  if (attr.unattributed_reason) {
    return <UnattributedBadge reason={attr.unattributed_reason} />;
  }
  return <AttributedBadge attr={attr} />;
}

function SalienceBadge({ salience }: { salience: string }) {
  return (
    <span className="claims-salience-badge">
      <span className="claims-salience-icon">
        {salience === 'high' ? '🔴' : salience === 'medium' ? '🟡' : '⚪'}
      </span>
      {salience}
    </span>
  );
}

function ClaimGrid({ node, computed, base, delta, band, bandColor, bdiLabel, attacks, supports, hasEdges }: {
  node: ArgumentNetworkNode;
  computed: number;
  base: number;
  delta: number;
  band: { label: string };
  bandColor: string;
  bdiLabel: string;
  attacks: ArgumentNetworkEdge[];
  supports: ArgumentNetworkEdge[];
  hasEdges: boolean;
}) {
  const truncText = node.text.length > 80 ? node.text.slice(0, 80) + '…' : node.text;
  const attr = node.claim_taxonomy_attribution;
  return (
    <div className={node.political_salience ? 'claims-grid claims-grid-salience' : 'claims-grid claims-grid-default'}>
      {/* Col 1: AN ID */}
      <strong
        className="claims-id"
        title={idColTitle(node, bdiLabel, computed, base, delta, attacks, supports, truncText)}
      >{node.id}</strong>
      {/* Col 2: BDI category */}
      <span title={bdiColTitle(bdiLabel, node)}>{bdiLabel}</span>
      {/* Col 3: Attribution */}
      <span>
        {attr && <AttributionCell attr={attr} />}
      </span>
      {/* Col 4: Strength */}
      <span className="claims-badge claims-badge-nowrap" title={strengthColTitle(computed, base, delta)}>
        {/* eslint-disable-next-line local/no-inline-style -- dynamic strength band color */}
        <span className="claims-dot" style={{ color: bandColor }}>●</span>{band.label} {computed.toFixed(2)}
        {Math.abs(delta) > 0.01 && <span className="claims-delta">{delta > 0 ? '+' : ''}{delta.toFixed(2)}</span>}
        <TheoryLink
          docPath="research/comp-linguist/docs/debate-claim-scoring.md"
          size={12}
          tooltip="How claim strength is scored"
          className="claims-strength-doclink"
        />
      </span>
      {/* Col 5: Edge count */}
      <span className="claims-edge-count" title={edgeColTitle(hasEdges, attacks, supports)}>
        {hasEdges ? `${attacks.length + supports.length} edge${attacks.length + supports.length !== 1 ? 's' : ''}` : ''}
      </span>
      {/* Col 6: Political salience (policymaker debates only) */}
      {node.political_salience && <SalienceBadge salience={node.political_salience} />}
    </div>
  );
}

function ClaimEdges({ attacks, supports, allNodes, strengthMap }: {
  attacks: ArgumentNetworkEdge[];
  supports: ArgumentNetworkEdge[];
  allNodes: ArgumentNetworkNode[];
  strengthMap: Map<string, number>;
}) {
  return (
    <div className="claims-edges">
      {attacks.map(e => {
        const src = allNodes.find(n => n.id === e.source);
        const srcStr = strengthMap.get(e.source);
        const atkMult = ATTACK_TYPE_WEIGHTS[e.attack_type ?? 'rebut'] ?? 1.0;
        const edgeWeight = e.weight ?? 0.5;
        const hasWeight = e.weight != null;
        const contribution = srcStr != null ? srcStr * edgeWeight * atkMult : undefined;
        return (
          <div key={`a-${e.source}`} className="claims-attack">
            ← <strong title={src ? `${src.id} by ${speakerLabel(src.speaker)}\n${src.text}` : e.source}>{e.source}</strong>{' '}
            <span title={`Attack type: ${e.attack_type ?? 'rebut'} (multiplier: ${atkMult.toFixed(1)})\nEdge weight: ${edgeWeight.toFixed(2)}${hasWeight ? '' : ' (default — no AI weight)'}${contribution != null ? `\nContribution: −${contribution.toFixed(2)} (${(srcStr ?? 0).toFixed(2)} × ${edgeWeight.toFixed(1)} × ${atkMult.toFixed(1)})` : ''}`}>
              {e.attack_type ?? 'rebut'}
            </span>{' '}
            ({speakerLabel(src?.speaker ?? 'system')}): {src?.text}
          </div>
        );
      })}
      {supports.map(e => {
        const src = allNodes.find(n => n.id === e.source);
        const srcStr = strengthMap.get(e.source);
        const edgeWeight = e.weight ?? 0.5;
        const hasWeight = e.weight != null;
        const contribution = srcStr != null ? srcStr * edgeWeight : undefined;
        return (
          <div key={`s-${e.source}`} className="claims-support">
            ← <strong title={src ? `${src.id} by ${speakerLabel(src.speaker)}\n${src.text}` : e.source}>{e.source}</strong>{' '}
            <span title={`Support\nEdge weight: ${edgeWeight.toFixed(2)}${hasWeight ? '' : ' (default — no AI weight)'}${contribution != null ? `\nContribution: +${contribution.toFixed(2)} (${(srcStr ?? 0).toFixed(2)} × ${edgeWeight.toFixed(1)})` : ''}`}>
              support
            </span>{' '}
            ({speakerLabel(src?.speaker ?? 'system')}): {src?.text}
          </div>
        );
      })}
    </div>
  );
}

export function ClaimNodeRow({ node, attacks, supports, allNodes, strengthMap, showFormal }: {
  node: ArgumentNetworkNode;
  attacks: ArgumentNetworkEdge[];
  supports: ArgumentNetworkEdge[];
  allNodes: ArgumentNetworkNode[];
  strengthMap: Map<string, number>;
  showFormal?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasEdges = attacks.length > 0 || supports.length > 0;
  const base = node.base_strength ?? 0.5;
  const computed = strengthMap.get(node.id) ?? node.computed_strength ?? base;
  const delta = computed - base;
  const band = STRENGTH_BAND(computed);
  const bandColor = computeBandColor(computed, CONFIDENCE_BANDS);
  const bdiLabel = bdiLabelFor(node);

  return (
    <div className="claims-node-row">
      <div className="claims-node-header">
        {hasEdges ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="claims-toggle-btn"
          >{expanded ? '▼' : '▶'}</button>
        ) : <span className="claims-toggle-spacer" />}
        <ClaimGrid
          node={node}
          computed={computed}
          base={base}
          delta={delta}
          band={band}
          bandColor={bandColor}
          bdiLabel={bdiLabel}
          attacks={attacks}
          supports={supports}
          hasEdges={hasEdges}
        />
      </div>
      <div className="claims-node-text">{showFormal && node.attribution_text_genus ? node.attribution_text_genus : node.text}</div>
      {expanded && <ClaimEdges attacks={attacks} supports={supports} allNodes={allNodes} strengthMap={strengthMap} />}
    </div>
  );
}

const CLAIMS_STYLE_KEY = 'debate-claims-style';

export function ClaimsView({ entryId, debate }: { entryId?: string; debate: { argument_network?: { nodes: ArgumentNetworkNode[]; edges: ArgumentNetworkEdge[] }; transcript: TranscriptEntry[] } }) {
  const [showFormal, setShowFormal] = useState(() => {
    try { return sessionStorage.getItem(CLAIMS_STYLE_KEY) === 'formal'; } catch { /* telemetry — silent by design */ return false; }
  });
  const toggleStyle = () => {
    const next = !showFormal;
    setShowFormal(next);
    try { sessionStorage.setItem(CLAIMS_STYLE_KEY, next ? 'formal' : 'plain'); } catch { /* telemetry — silent by design */ }
  };

  const an = debate.argument_network;
  if (!an || an.nodes.length === 0) return <div className="claims-empty">No argument network yet</div>;

  const entryNodes = entryId ? an.nodes.filter(n => n.source_entry_id === entryId) : an.nodes;
  if (entryNodes.length === 0) return <div className="claims-empty">No claims extracted for this statement</div>;
  const hasFormalText = entryNodes.some(n => !!n.attribution_text_genus);

  const qbafNodes: QbafNode[] = an.nodes.map(n => ({ id: n.id, base_strength: n.base_strength ?? 0.5 }));
  const qbafEdges: QbafEdge[] = an.edges.map(e => ({
    source: e.source, target: e.target,
    type: e.type as 'attacks' | 'supports',
    weight: e.weight ?? 0.5,
    attack_type: e.attack_type,
  }));
  const { strengths: strengthMap } = computeQbafStrengths(qbafNodes, qbafEdges);

  const caCount = an.edges.filter(e => entryNodes.some(n => n.id === e.target) && e.type === 'attacks').length;
  const raCount = an.edges.filter(e => entryNodes.some(n => n.id === e.target) && e.type === 'supports').length;

  // Political salience histogram (policymaker debates only)
  const salienceCounts = (() => {
    const high = entryNodes.filter(n => n.political_salience === 'high').length;
    const medium = entryNodes.filter(n => n.political_salience === 'medium').length;
    const low = entryNodes.filter(n => n.political_salience === 'low').length;
    return (high + medium + low > 0) ? { high, medium, low } : null;
  })();

  return (
    <div className="claims-view claims-view-root">
      <div className="claims-summary">
        <span>{entryNodes.length} claim{entryNodes.length !== 1 ? 's' : ''} · {caCount} attack{caCount !== 1 ? 's' : ''} · {raCount} support{raCount !== 1 ? 's' : ''}</span>
        {hasFormalText && (
          <button
            onClick={toggleStyle}
            className="claims-style-toggle"
            title={showFormal ? 'Show plain text' : 'Show formal/DOLCE text'}
          >{showFormal ? 'Formal' : 'Plain'}</button>
        )}
      </div>
      {salienceCounts && (
        <div className="claims-salience-row">
          <span className="claims-salience-label">Salience:</span>
          <span>🔴 {salienceCounts.high} high</span>
          <span>🟡 {salienceCounts.medium} med</span>
          <span>⚪ {salienceCounts.low} low</span>
        </div>
      )}
      {entryNodes.map(node => {
        const attacks = an.edges.filter(e => e.target === node.id && e.type === 'attacks');
        const supports = an.edges.filter(e => e.target === node.id && e.type === 'supports');
        return <ClaimNodeRow key={node.id} node={node} attacks={attacks} supports={supports} allNodes={an.nodes} strengthMap={strengthMap} showFormal={showFormal} />;
      })}
    </div>
  );
}
