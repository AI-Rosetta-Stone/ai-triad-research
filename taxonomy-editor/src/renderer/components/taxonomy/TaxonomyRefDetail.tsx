import { useState, useMemo, useCallback } from 'react';
import { POV_META, povKeyFromNodeId, type PovMetaKey } from '@lib/electron-shared/povMeta';
import { POV_KEYS } from '@lib/debate/types';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useDescriptionMode, resolveDescription } from '../shared/DescriptionToggle';
import './TaxonomyRefDetail.css';

/** Raw node shape as loaded from POV JSON files, used read-only in Diagnostics. */
export interface TaxRefNode {
  id?: string;
  label?: string;
  category?: string;
  description?: string;
  plain_description?: string | null;
  pov?: string;
  parent_id?: string | null;
  parent_relationship?: string | null;
  parent_rationale?: string | null;
  children?: string[];
  situation_refs?: string[];
  conflict_ids?: string[];
  debate_refs?: string[];
  interpretations?: { accelerationist?: unknown; safetyist?: unknown; skeptic?: unknown };
  /** Mean pairwise cosine distance across POV interpretation embeddings (0-1). */
  interpretation_divergence?: number;
  graph_attributes?: {
    epistemic_type?: string;
    rhetorical_strategy?: string;
    assumes?: string[];
    falsifiability?: string;
    audience?: string;
    emotional_register?: string;
    intellectual_lineage?: string[];
    policy_actions?: { policy_id?: string; action?: string; framing?: string }[];
    steelman_vulnerability?: string | { from_accelerationist?: string; from_safetyist?: string; from_skeptic?: string };
    possible_fallacies?: { fallacy?: string; confidence?: string; explanation?: string }[];
    node_scope?: string;
  };
}

export interface TaxRefEdge {
  source: string;
  target: string;
  type: string;
  bidirectional: boolean;
  confidence: number;
  weight?: number;
  rationale: string;
  status: string;
  strength?: string;
  notes?: string;
}

/** t/3401: pol-* ids live in policy_actions.json, not the Perspective files — a policy is not a
 *  POV/situation node, so it gets a dedicated (simpler) view rather than reusing the tab machinery. */
export interface TaxRefPolicy {
  id: string;
  action: string;
  description?: string;
  source_povs: string[];
  member_count: number;
}

export interface TaxRefPolicyReferencingNode {
  id: string;
  label: string;
  pov: string;
  /** How THIS node's own graph_attributes.policy_actions entry frames the policy — per-node, not on the registry. */
  action?: string;
  framing?: string;
}

type TabId = 'content' | 'related' | 'attributes' | 'pov-acc' | 'pov-saf' | 'pov-skp';

interface Props {
  nodeId: string;
  node: TaxRefNode | undefined;
  pov: string;
  onClose: () => void;
  edges?: TaxRefEdge[];
  policy?: TaxRefPolicy;
  policyReferencingNodes?: TaxRefPolicyReferencingNode[];
}

/* ── Pure helpers ─────────────────────────────────────── */

function computeHasRelated(node: TaxRefNode, edges?: TaxRefEdge[]): boolean {
  return !!(
    node.children?.length ||
    node.situation_refs?.length ||
    node.conflict_ids?.length ||
    node.debate_refs?.length ||
    node.interpretations ||
    edges?.length
  );
}

function computeHasAttributes(ga: TaxRefNode['graph_attributes']): boolean {
  return !!(
    ga?.epistemic_type || ga?.rhetorical_strategy || ga?.falsifiability ||
    ga?.audience || ga?.emotional_register || ga?.node_scope ||
    ga?.assumes?.length || ga?.policy_actions?.length || ga?.possible_fallacies?.length
  );
}

function computeHasGraphKV(ga: TaxRefNode['graph_attributes']): boolean {
  return !!(
    ga?.epistemic_type || ga?.rhetorical_strategy || ga?.falsifiability ||
    ga?.audience || ga?.emotional_register || ga?.node_scope
  );
}

function povColorForId(id: string): string {
  if (id.startsWith('acc-')) return '#f97316';
  if (id.startsWith('saf-')) return '#3b82f6';
  if (id.startsWith('skp-')) return '#a855f7';
  return 'var(--text-primary)';
}

/* ── Tab bar sub-components ───────────────────────────── */

function SituationPovButtons({ tab, setTab, hasAccInterp, hasSafInterp, hasSkpInterp }: {
  tab: TabId;
  setTab: (t: TabId) => void;
  hasAccInterp: boolean;
  hasSafInterp: boolean;
  hasSkpInterp: boolean;
}) {
  return (
    <>
      {hasAccInterp && (
        <button
          className={`node-detail-tab taxref-tab-acc ${tab === 'pov-acc' ? 'node-detail-tab-active' : ''}`}
          onClick={() => setTab('pov-acc')}
        >Accelerationist</button>
      )}
      {hasSafInterp && (
        <button
          className={`node-detail-tab taxref-tab-saf ${tab === 'pov-saf' ? 'node-detail-tab-active' : ''}`}
          onClick={() => setTab('pov-saf')}
        >Safetyist</button>
      )}
      {hasSkpInterp && (
        <button
          className={`node-detail-tab taxref-tab-skp ${tab === 'pov-skp' ? 'node-detail-tab-active' : ''}`}
          onClick={() => setTab('pov-skp')}
        >Skeptic</button>
      )}
    </>
  );
}

function NodeTabBar({ tab, setTab, hasRelated, hasAttributes, isSituation, hasAccInterp, hasSafInterp, hasSkpInterp }: {
  tab: TabId;
  setTab: (t: TabId) => void;
  hasRelated: boolean;
  hasAttributes: boolean;
  isSituation: boolean;
  hasAccInterp: boolean;
  hasSafInterp: boolean;
  hasSkpInterp: boolean;
}) {
  return (
    <div className="node-detail-tabs">
      <button
        className={`node-detail-tab ${tab === 'content' ? 'node-detail-tab-active' : ''}`}
        onClick={() => setTab('content')}
      >Content</button>
      <button
        className={`node-detail-tab ${tab === 'related' ? 'node-detail-tab-active' : ''}${hasRelated ? '' : ' taxref-tab-disabled'}`}
        onClick={() => setTab('related')}
        disabled={!hasRelated}
      >Related</button>
      <button
        className={`node-detail-tab ${tab === 'attributes' ? 'node-detail-tab-active' : ''}${hasAttributes ? '' : ' taxref-tab-disabled'}`}
        onClick={() => setTab('attributes')}
        disabled={!hasAttributes}
      >Attributes</button>
      {isSituation && (
        <SituationPovButtons
          tab={tab}
          setTab={setTab}
          hasAccInterp={hasAccInterp}
          hasSafInterp={hasSafInterp}
          hasSkpInterp={hasSkpInterp}
        />
      )}
    </div>
  );
}

function NodeTabContent({ tab, node, nodeId, edges, interps }: {
  tab: TabId;
  node: TaxRefNode;
  nodeId: string;
  edges?: TaxRefEdge[];
  interps?: TaxRefNode['interpretations'];
}) {
  return (
    <div className="taxref-tab-content">
      {tab === 'content' && <ContentTab node={node} isSituation={nodeId.startsWith('sit-')} />}
      {tab === 'related' && <RelatedTab node={node} nodeId={nodeId} edges={edges} />}
      {tab === 'attributes' && <AttributesTab node={node} />}
      {tab === 'pov-acc' && <PovInterpretationTab interp={interps?.accelerationist} povLabel="Accelerationist" povColor="var(--color-acc, #f59e0b)" />}
      {tab === 'pov-saf' && <PovInterpretationTab interp={interps?.safetyist} povLabel="Safetyist" povColor="var(--color-saf, #3b82f6)" />}
      {tab === 'pov-skp' && <PovInterpretationTab interp={interps?.skeptic} povLabel="Skeptic" povColor="var(--color-skp, #a855f7)" />}
    </div>
  );
}

/* ── Main component ───────────────────────────────────── */

export function TaxonomyRefDetail({ nodeId, node, pov, onClose, edges, policy, policyReferencingNodes }: Props) {
  const [tab, setTab] = useState<TabId>('content');
  const ga = node?.graph_attributes;

  const catUpper = node?.category?.toUpperCase();
  const hasRelated = node ? computeHasRelated(node, edges) : false;
  const hasAttributes = computeHasAttributes(ga);

  const isSituation = nodeId.startsWith('sit-');
  const interps = node?.interpretations;
  const hasAccInterp = !!(interps?.accelerationist);
  const hasSafInterp = !!(interps?.safetyist);
  const hasSkpInterp = !!(interps?.skeptic);

  return (
    <div className="taxref-detail">
      {/* Header: big serif title + category pill + pov pill + close */}
      <div className="nd-header taxref-header-pad">
        <div className="nd-header-title">
          <span className="nd-header-label taxref-title">
            {policy ? policy.action : (node?.label || nodeId)}
          </span>
          {policy ? (
            <span className="taxref-pov-pill">policy</span>
          ) : pov && (
            <span className="taxref-pov-pill">{pov}</span>
          )}
          <span className="taxref-node-id">
            {nodeId}
          </span>
        </div>
        {catUpper && (
          <span className="nd-header-cat" data-cat={catUpper}>{catUpper}</span>
        )}
        <button
          onClick={onClose}
          className="taxref-close-btn"
          title="Close detail panel"
        >Close</button>
      </div>

      {policy ? (
        <PolicyView policy={policy} referencingNodes={policyReferencingNodes ?? []} />
      ) : !node ? (
        <div className="taxref-not-found">
          Node not found in loaded Perspective files. (Taxonomy may not be loaded yet, or this id belongs to a non-Perspective registry.)
        </div>
      ) : (
        <>
          <NodeTabBar
            tab={tab}
            setTab={setTab}
            hasRelated={hasRelated}
            hasAttributes={hasAttributes}
            isSituation={isSituation}
            hasAccInterp={hasAccInterp}
            hasSafInterp={hasSafInterp}
            hasSkpInterp={hasSkpInterp}
          />
          <NodeTabContent
            tab={tab}
            node={node}
            nodeId={nodeId}
            edges={edges}
            interps={interps}
          />
        </>
      )}
    </div>
  );
}

/* ── Policy view (t/3401) ─────────────────────────────── */

function PolicyView({ policy, referencingNodes }: { policy: TaxRefPolicy; referencingNodes: TaxRefPolicyReferencingNode[] }) {
  return (
    <div className="taxref-tab-content">
      {policy.description && (
        <div>
          <div className="taxref-section-header taxref-section-header-mt0">Description</div>
          <div className="taxref-desc-box">{policy.description}</div>
        </div>
      )}

      <div className="taxref-section-header taxref-section-header-mt0">Action</div>
      <div className="taxref-desc-box">{policy.action}</div>

      {policy.source_povs.length > 0 && (
        <>
          <div className="taxref-section-header">Source Perspectives</div>
          <div>
            {policy.source_povs.map(p => <span key={p} className="taxref-chip">{p}</span>)}
          </div>
        </>
      )}

      <div className="taxref-section-header taxref-section-header-flex">
        Referenced By
        <span className="taxref-related-count-badge">{referencingNodes.length}</span>
      </div>
      {referencingNodes.length === 0 ? (
        <div className="taxref-empty-msg">No loaded node currently references this policy.</div>
      ) : (
        referencingNodes.map(n => (
          <div key={n.id} className="taxref-attr-block">
            <span className="taxref-chip taxref-chip-strong">{n.label}</span>
            <span className="taxref-node-id">{n.id} · {n.pov}</span>
            {n.action && <div><strong className="taxref-attr-label">Action:</strong> {n.action}</div>}
            {n.framing && <div><strong className="taxref-attr-label">Framing:</strong> {n.framing}</div>}
          </div>
        ))
      )}
    </div>
  );
}

/* ── ContentTab section sub-components ───────────────── */

function DescriptionSection({ descText }: { descText: string }) {
  return (
    <div>
      <div className="taxref-section-header taxref-section-header-mt0">Description</div>
      <div className="taxref-desc-box">{descText}</div>
    </div>
  );
}

function DivergenceSection({ div }: { div: number }) {
  const divColor = div > 0.40 ? '#22c55e' : div >= 0.20 ? '#f59e0b' : '#ef4444';
  const divLabel = div > 0.40 ? 'high' : div >= 0.20 ? 'moderate' : 'low';
  const note = div > 0.40
    ? ' High divergence indicates strong disagreement between perspectives.'
    : div >= 0.20
    ? ' Moderate divergence — perspectives partially overlap.'
    : ' Low divergence suggests near-consensus across perspectives.';
  return (
    <div>
      <div className="taxref-section-header">Interpretation Divergence</div>
      <div className="taxref-info-box">
        <div className="taxref-divergence-row">
          {/* eslint-disable-next-line local/no-inline-style -- dynamic: color computed from divergence value */}
          <span className="taxref-divergence-value" style={{ color: divColor }}>{div.toFixed(2)}</span>
          {/* eslint-disable-next-line local/no-inline-style -- dynamic: color + background computed from divergence value */}
          <span className="taxref-divergence-badge" style={{ color: divColor, background: `${divColor}18` }}>{divLabel}</span>
          <div className="taxref-divergence-track">
            {/* eslint-disable-next-line local/no-inline-style -- dynamic: width + background computed from divergence value */}
            <div className="taxref-divergence-fill" style={{ width: `${Math.round(div * 100)}%`, background: divColor }} />
          </div>
        </div>
        <div className="taxref-divergence-note">
          Mean pairwise cosine distance across the three POV interpretation embeddings.{note}
        </div>
      </div>
    </div>
  );
}

function HierarchySection({ node }: { node: TaxRefNode }) {
  return (
    <>
      <div className="taxref-section-header">Hierarchy</div>
      <div>
        {node.parent_id && (
          <span className="taxref-chip" title={node.parent_relationship || ''}>
            ▲ {node.parent_id}
          </span>
        )}
        {node.children && node.children.map(c => (
          <span key={c} className="taxref-chip">▼ {c}</span>
        ))}
      </div>
      {node.parent_rationale && (
        <div className="taxref-hierarchy-note">
          {node.parent_rationale}
        </div>
      )}
    </>
  );
}

function SteelmanSection({ steelman }: { steelman: NonNullable<NonNullable<TaxRefNode['graph_attributes']>['steelman_vulnerability']> }) {
  return (
    <>
      <div className="taxref-section-header">Steelman Vulnerability</div>
      {typeof steelman === 'string' ? (
        <div className="taxref-steelman-quote">{steelman}</div>
      ) : (
        <div className="taxref-steelman-block">
          {steelman.from_accelerationist && (
            <div className="taxref-steelman-item">
              <strong className="taxref-steelman-label">From Accelerationist:</strong>{' '}
              <span className="taxref-italic">{steelman.from_accelerationist}</span>
            </div>
          )}
          {steelman.from_safetyist && (
            <div className="taxref-steelman-item">
              <strong className="taxref-steelman-label">From Safetyist:</strong>{' '}
              <span className="taxref-italic">{steelman.from_safetyist}</span>
            </div>
          )}
          {steelman.from_skeptic && (
            <div>
              <strong className="taxref-steelman-label">From Skeptic:</strong>{' '}
              <span className="taxref-italic">{steelman.from_skeptic}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function LineageSection({ lineage }: { lineage: unknown[] }) {
  const labels = [...lineage]
    .map(v => typeof v === 'string' ? v : (v as { name?: string })?.name)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort((a, b) => a.localeCompare(b));
  return (
    <>
      <div className="taxref-section-header">Intellectual Lineage</div>
      <div>
        {labels.map((l, i) => (
          <span key={i} className="taxref-chip taxref-chip-strong">{l}</span>
        ))}
      </div>
    </>
  );
}

/* ── Tab Content ──────────────────────────────────────── */

function ContentTab({ node, isSituation }: { node: TaxRefNode; isSituation?: boolean }) {
  const [descMode] = useDescriptionMode();
  const descText = resolveDescription(node, descMode).text;
  const div = isSituation ? node.interpretation_divergence : undefined;
  return (
    <>
      {descText && <DescriptionSection descText={descText} />}
      {div != null && <DivergenceSection div={div} />}
      {(node.parent_id || node.children?.length) && <HierarchySection node={node} />}
      {node.graph_attributes?.steelman_vulnerability && (
        <SteelmanSection steelman={node.graph_attributes.steelman_vulnerability} />
      )}
      {node.graph_attributes?.intellectual_lineage?.length && (
        <LineageSection lineage={node.graph_attributes.intellectual_lineage} />
      )}
    </>
  );
}

function PovInterpretationTab({ interp, povLabel, povColor }: { interp: unknown; povLabel: string; povColor: string }) {
  if (!interp) return <div className="taxref-empty-msg">No {povLabel} interpretation available.</div>;

  if (typeof interp === 'string') {
    return <div className="taxref-info-box">{interp}</div>;
  }

  const bdi = interp as { belief?: string; desire?: string; intention?: string; summary?: string };
  const bdiItem = (label: string, text: string | undefined) => text ? (
    // eslint-disable-next-line local/no-inline-style -- dynamic: border-left color from povColor prop
    <div className="taxref-pov-item" style={{ borderLeft: `2px solid ${povColor}` }}>
      <div className="taxref-pov-item-label">{label}</div>
      <div className="taxref-pov-item-text">{text}</div>
    </div>
  ) : null;

  return (
    <>
      {bdi.summary && (
        // eslint-disable-next-line local/no-inline-style -- dynamic: border-left color from povColor prop
        <div className="taxref-pov-summary-box" style={{ borderLeft: `3px solid ${povColor}` }}>
          {bdi.summary}
        </div>
      )}
      {bdiItem('Belief', bdi.belief)}
      {bdiItem('Desire', bdi.desire)}
      {bdiItem('Intention', bdi.intention)}
    </>
  );
}

export const EDGE_TYPE_COLORS: Record<string, string> = {
  SUPPORTS: '#22c55e',
  CONTRADICTS: '#ef4444',
  ASSUMES: '#a78bfa',
  WEAKENS: '#f59e0b',
  RESPONDS_TO: '#3b82f6',
  TENSION_WITH: '#f97316',
  INTERPRETS: '#06b6d4',
  CONVERGES_WITH: '#10b981',
};

/* ── POV filter / edge grouping (mirrors RelatedEdgesPanel UX) ─── */


const EDGE_TYPE_PRIORITY = [
  'SUPPORTS', 'CONTRADICTS', 'ASSUMES', 'WEAKENS',
  'RESPONDS_TO', 'TENSION_WITH', 'INTERPRETS', 'CONVERGES_WITH',
];

function otherNodeId(edge: TaxRefEdge, nodeId: string) {
  return edge.source === nodeId ? edge.target : edge.source;
}

function otherPovKey(edge: TaxRefEdge, nodeId: string): PovMetaKey | undefined {
  return povKeyFromNodeId(otherNodeId(edge, nodeId));
}

function sortEdgeGroups(groups: Map<string, TaxRefEdge[]>): Map<string, TaxRefEdge[]> {
  for (const arr of groups.values()) arr.sort((a, b) => b.confidence - a.confidence);
  const sorted = new Map<string, TaxRefEdge[]>();
  for (const t of EDGE_TYPE_PRIORITY) {
    const a = groups.get(t);
    if (a) sorted.set(t, a);
  }
  for (const [t, a] of groups) {
    if (!sorted.has(t)) sorted.set(t, a);
  }
  return sorted;
}

function TaxRefEdgeGroup({
  edgeType, edges, nodeId, selectedKey, onSelect, nodeLabels,
}: {
  edgeType: string; edges: TaxRefEdge[]; nodeId: string;
  selectedKey: string | null; onSelect: (key: string | null) => void;
  nodeLabels: Map<string, string>;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const typeColor = EDGE_TYPE_COLORS[edgeType] || 'var(--text-secondary)';

  return (
    <div className="related-edge-group">
      <div className="related-edge-group-header" onClick={() => setCollapsed(!collapsed)}>
        <span className="related-edge-group-toggle">{collapsed ? '▶' : '▼'}</span>
        <span className="related-edge-type-name">{edgeType.replace(/_/g, ' ')}</span>
        <span className="related-edge-type-count">{edges.length}</span>
      </div>
      {!collapsed && edges.map((e, i) => {
        const other = otherNodeId(e, nodeId);
        const otherLabel = nodeLabels.get(other);
        const direction = e.bidirectional ? '↔' : e.source === nodeId ? '→' : '←';
        const key = `${e.source}|${e.target}|${e.type}`;
        const isSelected = selectedKey === key;
        return (
          <div key={i}
            onClick={() => onSelect(isSelected ? null : key)}
            className={`taxref-edge-row${isSelected ? ' taxref-edge-row-selected' : ''}`}>
            <div className="taxref-edge-row-main">
              <span className="taxref-edge-direction">{direction}</span>
              <span className="taxref-edge-other-label">{otherLabel || other}</span>
              {e.strength && (
                <span className="taxref-edge-strength">({e.strength})</span>
              )}
              <span className="taxref-edge-confidence">
                c{(e.confidence * 100).toFixed(0)}%
              </span>
            </div>
            {otherLabel && (
              <div className="taxref-edge-other-id">{other}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EdgeStatusBadge({ status }: { status: string }) {
  if (status === 'approved') return <span className="taxref-edge-status-approved">✓ Approved</span>;
  if (!status || status === 'approved') return null;
  return (
    <span className={status === 'rejected' ? 'taxref-edge-status-rejected' : 'taxref-edge-status-pending'}>
      {status === 'rejected' ? '✗' : '●'} {status}
    </span>
  );
}

function EdgeDetailPanel({ edge, typeColor, srcLabel, tgtLabel, pct, onClose }: {
  edge: TaxRefEdge; typeColor: string; srcLabel: string; tgtLabel: string; pct: number; onClose: () => void;
}) {
  const [rationaleExpanded, setRationaleExpanded] = useState(false);
  const RATIONALE_LIMIT = 200;
  const srcPovColor = povColorForId(edge.source);
  const tgtPovColor = povColorForId(edge.target);

  return (
    <div className="taxref-edge-panel">
      {/* Edge type banner */}
      <div className="taxref-edge-banner">
        {/* eslint-disable-next-line local/no-inline-style -- dynamic: edge-type color */}
        <div className="taxref-edge-banner-bar" style={{ background: typeColor }} />
        {/* eslint-disable-next-line local/no-inline-style -- dynamic: edge-type color */}
        <span className="taxref-edge-banner-type" style={{ color: typeColor }}>
          {edge.type.replace(/_/g, ' ')}
        </span>
        {/* eslint-disable-next-line local/no-inline-style -- dynamic: edge-type color */}
        <span className="taxref-edge-banner-arrow" style={{ color: typeColor }}>{edge.bidirectional ? '↔' : '→'}</span>
        <button onClick={onClose} className="taxref-edge-banner-close">✕</button>
      </div>

      {/* Source → Target */}
      <div className="taxref-edge-endpoints">
        <div className="taxref-edge-endpoint">
          <div className="taxref-edge-endpoint-label">Source</div>
          {/* eslint-disable-next-line local/no-inline-style -- dynamic: per-side POV color */}
          <div className="taxref-edge-endpoint-name" style={{ color: srcPovColor }}>{srcLabel}</div>
          <div className="taxref-edge-endpoint-id">{edge.source}</div>
        </div>
        {/* eslint-disable-next-line local/no-inline-style -- dynamic: edge-type color */}
        <div className="taxref-edge-arrow-mid" style={{ color: typeColor }}>
          {edge.bidirectional ? '↔' : '→'}
        </div>
        <div className="taxref-edge-endpoint">
          <div className="taxref-edge-endpoint-label">Target</div>
          {/* eslint-disable-next-line local/no-inline-style -- dynamic: per-side POV color */}
          <div className="taxref-edge-endpoint-name" style={{ color: tgtPovColor }}>{tgtLabel}</div>
          <div className="taxref-edge-endpoint-id">{edge.target}</div>
        </div>
      </div>

      {/* Rationale */}
      {edge.rationale && (
        <div className="taxref-edge-rationale-wrap">
          <div className="taxref-edge-rationale-label">Rationale</div>
          <div className="taxref-edge-rationale-text">
            {!rationaleExpanded && edge.rationale.length > RATIONALE_LIMIT
              ? edge.rationale.slice(0, RATIONALE_LIMIT) + '…'
              : edge.rationale}
          </div>
          {edge.rationale.length > RATIONALE_LIMIT && (
            <div onClick={() => setRationaleExpanded(!rationaleExpanded)} className="taxref-edge-rationale-toggle">
              {rationaleExpanded ? 'Show less' : 'Show more'}
            </div>
          )}
        </div>
      )}

      {/* Confidence & Strength */}
      <div className="taxref-edge-meta">
        <span>Confidence: <strong className="taxref-strong-primary">{pct}%</strong></span>
        {edge.strength && <span>Strength: <strong className="taxref-strong-primary">{edge.strength}</strong></span>}
        <EdgeStatusBadge status={edge.status} />
      </div>
    </div>
  );
}

/* ── Node relation chips (children / refs / conflicts) ── */

function NodeRelationChips({ node, hasEdges }: { node: TaxRefNode; hasEdges: boolean }) {
  return (
    <>
      {node.children && node.children.length > 0 && (
        <>
          <div className={`taxref-section-header${hasEdges ? '' : ' taxref-section-header-mt0'}`}>Children ({node.children.length})</div>
          <div>{node.children.map(c => <span key={c} className="taxref-chip">{c}</span>)}</div>
        </>
      )}
      {node.situation_refs && node.situation_refs.length > 0 && (
        <>
          <div className="taxref-section-header">Situation Refs ({node.situation_refs.length})</div>
          <div>{node.situation_refs.map(s => <span key={s} className="taxref-chip">{s}</span>)}</div>
        </>
      )}
      {node.conflict_ids && node.conflict_ids.length > 0 && (
        <>
          <div className="taxref-section-header">Conflicts ({node.conflict_ids.length})</div>
          <div>{node.conflict_ids.map(c => <span key={c} className="taxref-chip">{c}</span>)}</div>
        </>
      )}
      {node.debate_refs && node.debate_refs.length > 0 && (
        <>
          <div className="taxref-section-header">Debate Refs ({node.debate_refs.length})</div>
          <div>{node.debate_refs.map(d => <span key={d} className="taxref-chip">{d}</span>)}</div>
        </>
      )}
    </>
  );
}

function RelatedTab({ node, nodeId, edges }: { node: TaxRefNode; nodeId: string; edges?: TaxRefEdge[] }) {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.75);
  const [hiddenPovs, setHiddenPovs] = useState<Set<PovMetaKey>>(new Set());
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);

  const { accelerationist, safetyist, skeptic } = useTaxonomyStore();
  const nodeLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const pov of [accelerationist, safetyist, skeptic]) {
      if (!pov?.nodes) continue;
      for (const n of pov.nodes) map.set(n.id, n.label);
    }
    return map;
  }, [accelerationist, safetyist, skeptic]);

  const selectedEdge = useMemo(() => {
    if (!selectedEdgeKey || !edges) return null;
    const [src, tgt, typ] = selectedEdgeKey.split('|');
    return edges.find(e => e.source === src && e.target === tgt && e.type === typ) ?? null;
  }, [selectedEdgeKey, edges]);

  const togglePov = useCallback((prefix: PovMetaKey) => {
    setHiddenPovs(prev => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix); else next.add(prefix);
      return next;
    });
  }, []);

  // POV counts (after status/confidence filter, before POV filter)
  const povCounts = useMemo(() => {
    const counts: Record<PovMetaKey, number> = { accelerationist: 0, safetyist: 0, skeptic: 0, situations: 0 };
    if (!edges) return counts;
    for (const e of edges) {
      if (statusFilter && e.status !== statusFilter) continue;
      if (e.confidence < confidenceThreshold) continue;
      const k = otherPovKey(e, nodeId);
      if (k) counts[k]++;
    }
    return counts;
  }, [edges, nodeId, statusFilter, confidenceThreshold]);

  // Group edges by type with filters applied
  const { groupedEdges, totalEdges } = useMemo(() => {
    if (!edges) return { groupedEdges: new Map<string, TaxRefEdge[]>(), totalEdges: 0 };
    const groups = new Map<string, TaxRefEdge[]>();
    let total = 0;
    for (const e of edges) {
      if (statusFilter && e.status !== statusFilter) continue;
      if (e.confidence < confidenceThreshold) continue;
      const k = otherPovKey(e, nodeId);
      if (k && hiddenPovs.has(k)) continue;
      const arr = groups.get(e.type);
      if (arr) arr.push(e); else groups.set(e.type, [e]);
      total++;
    }
    return { groupedEdges: sortEdgeGroups(groups), totalEdges: total };
  }, [edges, nodeId, statusFilter, confidenceThreshold, hiddenPovs]);

  const displayPovs = (Object.keys(POV_META) as PovMetaKey[]).filter(k => povCounts[k] > 0);

  return (
    <>
      {edges && edges.length > 0 && (
        <>
          <div className="taxref-section-header taxref-section-header-mt0 taxref-section-header-flex">
            Related Edges
            <span className="taxref-related-count-badge">{totalEdges}</span>
          </div>

          {/* POV filter pills */}
          <div className="taxref-pov-filter-row">
            {displayPovs.map(k => (
              <button
                key={k}
                className={`related-edges-pov-btn${hiddenPovs.has(k) ? ' related-edges-pov-btn-hidden' : ''}`}
                // eslint-disable-next-line local/no-inline-style -- dynamic: per-POV CSS custom property
                style={{ '--pov-color': `var(${POV_META[k].cssVar})` } as React.CSSProperties}
                onClick={() => togglePov(k)}
                title={`${hiddenPovs.has(k) ? 'Show' : 'Hide'} ${POV_META[k].label}`}
              >
                {POV_META[k].label}
                <span className="related-edges-pov-btn-count">{povCounts[k]}</span>
              </button>
            ))}
          </div>

          {/* Status + confidence filters */}
          <div className="taxref-filter-row">
            <select
              className="related-edges-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              <option value="approved">Approved</option>
              <option value="proposed">Proposed</option>
              <option value="rejected">Rejected</option>
            </select>
            <label className="taxref-confidence-label">
              Confidence &ge; {Math.round(confidenceThreshold * 100)}%
              <input
                type="range" min="0" max="100"
                value={Math.round(confidenceThreshold * 100)}
                onChange={(e) => setConfidenceThreshold(Number(e.target.value) / 100)}
                className="related-edges-threshold-slider"
              />
            </label>
          </div>

          {/* Grouped edge list */}
          {Array.from(groupedEdges.entries()).map(([edgeType, edgeList]) => (
            <TaxRefEdgeGroup key={edgeType} edgeType={edgeType} edges={edgeList} nodeId={nodeId} selectedKey={selectedEdgeKey} onSelect={setSelectedEdgeKey} nodeLabels={nodeLabels} />
          ))}

          {totalEdges === 0 && (
            <div className="taxref-no-match-note">
              No edges match the current filters.
            </div>
          )}

          {/* Edge Detail Panel */}
          {selectedEdge && (
            <EdgeDetailPanel
              edge={selectedEdge}
              typeColor={EDGE_TYPE_COLORS[selectedEdge.type] || 'var(--text-secondary)'}
              srcLabel={nodeLabels.get(selectedEdge.source) ?? selectedEdge.source}
              tgtLabel={nodeLabels.get(selectedEdge.target) ?? selectedEdge.target}
              pct={Math.round(selectedEdge.confidence * 100)}
              onClose={() => setSelectedEdgeKey(null)}
            />
          )}
        </>
      )}

      <NodeRelationChips node={node} hasEdges={!!(edges && edges.length > 0)} />

      {node.interpretations && (
        <>
          <div className="taxref-section-header">Interpretations</div>
          {POV_KEYS.map(p => {
            const interp = node.interpretations?.[p];
            if (!interp) return null;
            if (typeof interp === 'string') {
              return (
                <div key={p} className="taxref-interp-item">
                  <strong className="taxref-interp-label">{p}:</strong>{' '}
                  <span>{interp}</span>
                </div>
              );
            }
            const bdi = interp as { belief?: string; desire?: string; intention?: string; summary?: string };
            return (
              <div key={p} className="taxref-interp-block">
                <div><strong className="taxref-interp-label">{p}</strong></div>
                {bdi.summary && <div className="taxref-interp-block-line">{bdi.summary}</div>}
                {bdi.belief && <div className="taxref-interp-block-line"><em>Belief:</em> {bdi.belief}</div>}
                {bdi.desire && <div className="taxref-interp-block-line"><em>Desire:</em> {bdi.desire}</div>}
                {bdi.intention && <div className="taxref-interp-block-line"><em>Intention:</em> {bdi.intention}</div>}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

function AttributesTab({ node }: { node: TaxRefNode }) {
  const ga = node.graph_attributes;
  if (!ga) return null;

  const kv = (label: string, val: string | undefined) => val ? (
    <div className="taxref-kv-row">
      <strong className="taxref-kv-label">{label}:</strong>{' '}
      {val}
    </div>
  ) : null;

  return (
    <>
      {computeHasGraphKV(ga) && (
        <>
          <div className="taxref-section-header taxref-section-header-mt0">Graph Attributes</div>
          {kv('Epistemic', ga.epistemic_type)}
          {kv('Rhetorical', ga.rhetorical_strategy)}
          {kv('Falsifiability', ga.falsifiability)}
          {kv('Audience', ga.audience)}
          {kv('Register', ga.emotional_register)}
          {kv('Scope', ga.node_scope)}
        </>
      )}

      {ga.assumes && ga.assumes.length > 0 && (
        <>
          <div className="taxref-section-header">Assumes ({ga.assumes.length})</div>
          <ul className="taxref-attr-list">
            {ga.assumes.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </>
      )}

      {ga.policy_actions && ga.policy_actions.length > 0 && (
        <>
          <div className="taxref-section-header">Policy Actions ({ga.policy_actions.length})</div>
          {ga.policy_actions.map((p, i) => (
            <div key={i} className="taxref-attr-block">
              {p.policy_id && <span className="taxref-chip">{p.policy_id}</span>}
              {p.action && <div><strong className="taxref-attr-label">Action:</strong> {p.action}</div>}
              {p.framing && <div><strong className="taxref-attr-label">Framing:</strong> {p.framing}</div>}
            </div>
          ))}
        </>
      )}

      {ga.possible_fallacies && ga.possible_fallacies.length > 0 && (
        <>
          <div className="taxref-section-header">Possible Fallacies ({ga.possible_fallacies.length})</div>
          {ga.possible_fallacies.map((f, i) => (
            <div key={i} className="taxref-attr-block">
              {f.fallacy && <div><strong>{f.fallacy}</strong>{f.confidence ? ` (${f.confidence})` : ''}</div>}
              {f.explanation && <div className="taxref-fallacy-explanation">{f.explanation}</div>}
            </div>
          ))}
        </>
      )}
    </>
  );
}
