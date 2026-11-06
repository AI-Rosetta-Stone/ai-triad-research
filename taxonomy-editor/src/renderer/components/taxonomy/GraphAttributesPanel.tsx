// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useLongPressContextMenu } from '../../hooks/useLongPressContextMenu';
import type { GraphAttributes, PossibleFallacy } from '../../types/taxonomy';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import type { PolicyRegistryEntry } from '../../hooks/useTaxonomyStore';
import { FALLACY_CATALOG } from '../../data/fallacyInfo';
import { api } from '@bridge';
import { TheoryLink } from '../shared/TheoryLink';
import './GraphAttributesPanel.css';

// Doc-link to the BDI scales reference (t/2448), rendered beside each scale label
// (Priority / Operationality / Confidence — one doc documents all three). Kept inside
// the scale cell so the fixed attribute grid columns don't shift.
function BdiScaleDocLink() {
  return <TheoryLink docPath="docs/bdi-scales.md" size={12} tooltip="How the BDI scales work" />;
}

interface GraphAttributesPanelProps {
  attrs: GraphAttributes;
  /** Node id — used only to default/reset the first policy action's expand state per node (t/4919). */
  nodeId?: string;
  onBadgeClick?: (field: string, value: string) => void;
  onShowAttributeInfo?: (field: string, value: string) => void;
  onUpdatePolicyActions?: (actions: GraphAttributes['policy_actions']) => void;
  onUpdateAssumptions?: (assumes: string[]) => void;
  readOnly?: boolean;
  defaultOpen?: boolean;
  /** Node category (Beliefs/Desires/Intentions) for confidence/priority display */
  nodeCategory?: string;
  /** Current confidence value (Beliefs only) */
  confidence?: number | null;
  /** Current priority value (Desires only) */
  priority?: number | null;
  /** Current operationality value (Intentions only) */
  operationality?: number | null;
  /** Whether the node is doctrinally anchored */
  doctrinallyAnchored?: boolean;
  /** Pre-floor evidential confidence — present when doctrinal floor was applied */
  evidentialConfidence?: number | null;
  /** Confidence history entries */
  confidenceHistory?: Array<{ reason: string }>;
  /** Priority history entries */
  priorityHistory?: Array<{ reason: string }>;
  /** Operationality history entries */
  operationalityHistory?: Array<{ reason: string }>;
  /** Callback to update confidence/priority/operationality */
  onUpdateWeightedBdi?: (updates: { confidence?: number; priority?: number; operationality?: number }) => void;
}

const LABEL_MAP: Record<string, string> = {
  epistemic_type: 'Epistemic Type',
  node_scope: 'Node Scope',
  rhetorical_strategy: 'Rhetorical Strategy',
  assumes: 'Assumptions',
  falsifiability: 'Falsifiability',
  audience: 'Audience',
  emotional_register: 'Emotional Register',
  policy_actions: 'Policy Actions',
  intellectual_lineage: 'Intellectual Lineage',
  steelman_vulnerability: 'Steelman Vulnerability',
};

const BADGE_COLORS: Record<string, string> = {
  // epistemic_type
  normative_prescription: '#7c3aed',
  empirical_claim: '#2563eb',
  definitional: '#0891b2',
  strategic_recommendation: '#059669',
  predictive: '#d97706',
  interpretive_lens: '#be185d',
  // node_scope
  claim: '#16a34a',
  scheme: '#2563eb',
  bridging: '#d97706',
  // emotional_register
  urgent: '#dc2626',
  measured: '#2563eb',
  optimistic: '#16a34a',
  cautionary: '#d97706',
  defiant: '#be185d',
  pragmatic: '#475569',
  alarmed: '#ef4444',
  dismissive: '#64748b',
  aspirational: '#7c3aed',
};

/** Fields that support "About..." right-click info */
const INFO_FIELDS = new Set([
  'rhetorical_strategy',
  'epistemic_type',
  'emotional_register',
  'intellectual_lineage',
]);

/** Map low/medium/high to a 1-5 scale position */
const HARDNESS_LEVELS: Record<string, { score: number; label: string }> = {
  low:    { score: 1, label: 'Low' },
  medium: { score: 3, label: 'Med' },
  high:   { score: 5, label: 'High' },
};

function formatValue(val: string): string {
  return val.replace(/_/g, ' ');
}

/** 5-point hardness meter for falsifiability */
function HardnessMeter({ field, value, onClick }: {
  field: string;
  value: string;
  onClick?: (field: string, value: string) => void;
}) {
  const level = HARDNESS_LEVELS[value] || { score: 0, label: value };
  const segments = 5;
  return (
    <div
      className={`ga-meter${onClick ? ' ga-meter-clickable' : ''}`}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(field, value); } : undefined}
      title={onClick ? `Find all nodes with ${formatValue(field)} = ${value}` : `${formatValue(field)}: ${value}`}
    >
      <div className="ga-meter-track">
        {Array.from({ length: segments }, (_, i) => (
          <div
            key={i}
            className={`ga-meter-seg${i < level.score ? ' ga-meter-filled' : ''}`}
            data-level={value}
          />
        ))}
      </div>
      <span className="ga-meter-label">{level.label}</span>
    </div>
  );
}

function Badge({ field, value, onClick, onContextMenu }: {
  field: string;
  value: string;
  onClick?: (field: string, value: string) => void;
  onContextMenu?: (e: React.MouseEvent, field: string, value: string) => void;
}) {
  const color = BADGE_COLORS[value] || '#475569';
  // t/3382: touch devices never fire `contextmenu` on a long-press — the long-press handlers below
  // invoke the same onContextMenu callback so the affordance works on iPad/phone too.
  const longPress = useLongPressContextMenu(useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(e as React.MouseEvent, field, value);
  }, [onContextMenu, field, value]));
  return (
    <span
      className={`ga-badge ${onClick ? 'ga-badge-clickable' : ''}`}
      // eslint-disable-next-line local/no-inline-style -- border/text color comes from the badge's value-specific color lookup
      style={{ borderColor: color, color }}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(field, value); } : undefined}
      onContextMenu={onContextMenu ? longPress.onContextMenu : undefined}
      onTouchStart={onContextMenu ? longPress.onTouchStart : undefined}
      onTouchMove={onContextMenu ? longPress.onTouchMove : undefined}
      onTouchEnd={onContextMenu ? longPress.onTouchEnd : undefined}
      onTouchCancel={onContextMenu ? longPress.onTouchCancel : undefined}
      title={onClick ? `Find all nodes with ${formatValue(field)} = ${formatValue(value)}` : undefined}
    >
      {formatValue(value)}
    </span>
  );
}

// ── Extracted sub-components for complexity reduction ──────────

function confidenceColor(val: number): string {
  if (val >= 0.7) return 'var(--success, #22c55e)';
  if (val >= 0.4) return 'var(--info, #3b82f6)';
  return 'var(--warning, #f59e0b)';
}

export function ConfidenceCell({ value, readOnly, doctrinallyAnchored, evidentialConfidence, history, onUpdate }: {
  value: number;
  readOnly?: boolean;
  doctrinallyAnchored?: boolean;
  evidentialConfidence?: number | null;
  history?: Array<{ reason: string }>;
  onUpdate?: (updates: { confidence: number }) => void;
}) {
  return (
    <div className="ga-cell">
      <div className="ga-label-row">
        <span className="ga-label">Confidence</span>
        <BdiScaleDocLink />
      </div>
      <div className="ga-confidence-row">
        <input
          type="range"
          min={0} max={1} step={0.05}
          value={value}
          disabled={readOnly || !onUpdate}
          onChange={(e) => onUpdate?.({ confidence: parseFloat(e.target.value) })}
          className="ga-confidence-slider"
        />
        {/* eslint-disable-next-line local/no-inline-style -- color reflects the current confidence value via confidenceColor() */}
        <span className="ga-confidence-value" style={{ color: confidenceColor(value) }}>
          {value.toFixed(2)}
        </span>
        {doctrinallyAnchored && (
          <span
            className="ga-doctrinal-anchor-badge"
            title="This Belief is cosine-similar to the POV's doctrinal boundaries — a confidence floor is applied to prevent it from dropping below the doctrinal minimum"
          >⚓ Doctrinally Anchored</span>
        )}
      </div>
      {doctrinallyAnchored && evidentialConfidence != null && (
        <div className="ga-evidential-confidence">
          Evidential confidence: <strong>{evidentialConfidence.toFixed(2)}</strong>
          <span className="ga-floor-applied-note">(floor applied: {value.toFixed(2)} ≥ doctrinal minimum)</span>
        </div>
      )}
      {history && history.length > 0 && (
        <div className="ga-history-note">
          {history.length} update(s) — latest: {history[history.length - 1].reason}
        </div>
      )}
    </div>
  );
}

export function RankedSelectCell({ label, value, options, badge, history, readOnly, onUpdate }: {
  label: string;
  value: number;
  options: Array<{ value: number; label: string }>;
  badge?: { show: boolean; text: string; color: string; bg: string; title: string };
  history?: Array<{ reason: string }>;
  readOnly?: boolean;
  onUpdate?: (val: number) => void;
}) {
  return (
    <div className="ga-cell">
      <div className="ga-label-row">
        <span className="ga-label">{label}</span>
        <BdiScaleDocLink />
      </div>
      <select
        value={value}
        disabled={readOnly || !onUpdate}
        onChange={(e) => onUpdate?.(parseInt(e.target.value, 10))}
        className="ga-ranked-select"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {badge?.show && (
        <span
          className="ga-ranked-badge"
          // eslint-disable-next-line local/no-inline-style -- background/color come from the caller-supplied badge config
          style={{ background: badge.bg, color: badge.color }}
          title={badge.title}
        >{badge.text}</span>
      )}
      {history && history.length > 0 && (
        <div className="ga-history-note">
          {history.length} update(s) — latest: {history[history.length - 1].reason}
        </div>
      )}
    </div>
  );
}

const PRIORITY_OPTIONS = [
  { value: 5, label: '5 — Core (non-negotiable)' },
  { value: 4, label: '4 — High' },
  { value: 3, label: '3 — Important' },
  { value: 2, label: '2 — Preferred' },
  { value: 1, label: '1 — Nice-to-have' },
];

const OPERATIONALITY_OPTIONS = [
  { value: 5, label: '5 — Fully operational (deployed/enacted)' },
  { value: 4, label: '4 — High (concrete plan, resources allocated)' },
  { value: 3, label: '3 — Moderate (specific but unresourced)' },
  { value: 2, label: '2 — Low (vague aspiration)' },
  { value: 1, label: '1 — Notional (pure rhetoric)' },
];

interface PolicyEdge { type: string; target: string; targetAction: string }

const EDGE_GROUPS: Array<{ key: string; type: string; className: string; label: string }> = [
  { key: 'contradicts', type: 'CONTRADICTS', className: 'ga-policy-edge-contradicts', label: 'Contradicts' },
  { key: 'complements', type: 'COMPLEMENTS', className: 'ga-policy-edge-complements', label: 'Complements' },
  { key: 'tensions', type: 'TENSION_WITH', className: 'ga-policy-edge-tension', label: 'Tension With' },
];

function PolicyEdgeGroups({ edges }: { edges: PolicyEdge[] }) {
  return (
    <div className="ga-policy-edges">
      {EDGE_GROUPS.map(({ key, type, className, label }) => {
        const group = edges.filter(e => e.type === type);
        if (group.length === 0) return null;
        return (
          <div key={key} className="ga-policy-edge-group">
            <div className={`ga-policy-edge-type ${className}`}>{label}</div>
            {group.map((e, ei) => (
              <div key={ei} className="ga-policy-edge-item">
                <span className="ga-policy-edge-id">{e.target}</span> {e.targetAction}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function PolicyActionHeader({ policyId, reg, edgeCount, expanded, onToggleExpand }: {
  policyId: string;
  reg?: PolicyRegistryEntry;
  edgeCount: number;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  return (
    <div className="ga-policy-action-header">
      <span className="ga-policy-action-id">{policyId}</span>
      {reg && reg.member_count > 1 && (
        <span className="ga-policy-action-reuse" title={`Used by ${reg.member_count} nodes across ${reg.source_povs.join(', ')}`}>
          {reg.member_count} nodes &middot; {reg.source_povs.map(p => p.slice(0, 3)).join(', ')}
        </span>
      )}
      {edgeCount > 0 && (
        <button
          className="ga-policy-edges-toggle"
          onClick={onToggleExpand}
          title={`${edgeCount} policy relationships`}
          aria-expanded={expanded}
        >
          {expanded ? '▼' : '▶'} {edgeCount} edge{edgeCount !== 1 ? 's' : ''}
        </button>
      )}
    </div>
  );
}

function PolicyActionItem({ pa, index, reg, edges, readOnly, expanded, onToggleExpand, onUpdateFraming, onRemove }: {
  pa: { policy_id?: string; action: string; framing: string };
  index: number;
  reg?: PolicyRegistryEntry;
  edges?: PolicyEdge[];
  readOnly?: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdateFraming?: (index: number, framing: string) => void;
  onRemove?: (index: number) => void;
}) {
  const edgeCount = edges?.length || 0;
  return (
    <li className="ga-policy-action-item">
      {pa.policy_id && (
        <PolicyActionHeader policyId={pa.policy_id} reg={reg} edgeCount={edgeCount} expanded={expanded} onToggleExpand={onToggleExpand} />
      )}
      <div className="ga-policy-action-text">{pa.action}</div>
      {!readOnly && onUpdateFraming ? (
        <textarea
          className="ga-policy-action-framing-input"
          value={pa.framing}
          onChange={(e) => onUpdateFraming(index, e.target.value)}
          placeholder="POV-specific framing..."
          rows={2}
        />
      ) : (
        <div className="ga-policy-action-framing">{pa.framing}</div>
      )}
      {!readOnly && onRemove && (
        <button className="ga-policy-action-remove" onClick={() => onRemove(index)} title="Remove policy">&times;</button>
      )}
      {expanded && edges && edges.length > 0 && <PolicyEdgeGroups edges={edges} />}
    </li>
  );
}

function AssumptionsCell({ assumes, readOnly, editing, onToggleEdit, onUpdate, onBadgeClick }: {
  assumes?: string[];
  readOnly?: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onUpdate?: (assumes: string[]) => void;
  onBadgeClick?: (field: string, value: string) => void;
}) {
  const items = assumes ?? [];
  return (
    <div className="ga-cell">
      <div className="ga-label">
        {LABEL_MAP.assumes}
        {!readOnly && onUpdate && (
          <button
            className="btn btn-ghost btn-sm ga-edit-toggle-btn"
            onClick={onToggleEdit}
          >{editing ? 'Done' : 'Edit'}</button>
        )}
      </div>
      {editing && onUpdate ? (
        <>
          <ul className="ga-list">
            {items.map((a, i) => (
              <li key={i} className="nd-editable-list-item">
                <textarea
                  className="nd-assumption-input"
                  value={a}
                  rows={2}
                  onChange={(e) => {
                    const updated = [...items];
                    updated[i] = e.target.value;
                    onUpdate(updated);
                  }}
                />
                <button
                  className="nd-remove-btn"
                  title="Remove assumption"
                  onClick={() => onUpdate(items.filter((_, j) => j !== i))}
                >&times;</button>
              </li>
            ))}
          </ul>
          <button
            className="btn btn-sm nd-add-btn"
            onClick={() => onUpdate([...items, ''])}
          >+ Add Assumption</button>
        </>
      ) : items.length > 0 ? (
        <ul className="ga-list">
          {items.map((a, i) => <li key={i}>{a}</li>)}
        </ul>
      ) : <div className="ga-empty">&mdash;</div>}
    </div>
  );
}

function FallacyItem({ f }: { f: PossibleFallacy }) {
  const info = FALLACY_CATALOG[f.fallacy];
  const label = info ? info.label : f.fallacy.replace(/_/g, ' ');
  return (
    <li className="ga-fallacy-item">
      <div className="ga-fallacy-header">
        <span className={`ga-fallacy-badge ga-fallacy-${f.confidence}`}>
          {label}
        </span>
        {f.type ? (
          <span className="ga-fallacy-type" title={`Fallacy tier: ${f.type.replace(/_/g, ' ')}`}>
            {f.type.replace(/_/g, ' ')}
          </span>
        ) : (
          <span className="ga-fallacy-type ga-fallacy-type-missing" title="Missing fallacy tier — run attribute extraction to populate">
            no tier
          </span>
        )}
        <span className="ga-fallacy-confidence">{f.confidence}</span>
        {info && (
          <button
            className="ga-fallacy-about"
            onClick={() => api.openExternal(info.wikiUrl)}
            title={`Open Wikipedia article: ${label}`}
          >
            About
          </button>
        )}
      </div>
      <div className="ga-fallacy-explanation">{f.explanation}</div>
      {info && (
        <details className="ga-fallacy-details">
          <summary>What is this fallacy?</summary>
          <div className="ga-fallacy-description">{info.description}</div>
          {info.example && <div className="ga-fallacy-example"><strong>Example:</strong> {info.example}</div>}
        </details>
      )}
    </li>
  );
}

function EpistemicTypeCell({ attrs, onBadgeClick, contextMenuHandler }: {
  attrs: GraphAttributes;
  onBadgeClick?: (field: string, value: string) => void;
  contextMenuHandler?: (e: React.MouseEvent, field: string, value: string) => void;
}) {
  return (
    <div className="ga-cell">
      <div className="ga-label">{LABEL_MAP.epistemic_type}</div>
      {attrs.epistemic_type ? (
        <div className="ga-value">
          <Badge field="epistemic_type" value={attrs.epistemic_type} onClick={onBadgeClick} onContextMenu={contextMenuHandler} />
        </div>
      ) : <div className="ga-empty">&mdash;</div>}
      {attrs.falsifiability && (
        <div className="ga-cell-sub">
          <div className="ga-label">{LABEL_MAP.falsifiability}</div>
          <HardnessMeter field="falsifiability" value={attrs.falsifiability} onClick={onBadgeClick} />
        </div>
      )}
      {attrs.node_scope && (
        <div className="ga-cell-sub">
          <div className="ga-label">{LABEL_MAP.node_scope}</div>
          <div className="ga-value">
            <Badge field="node_scope" value={attrs.node_scope} onClick={onBadgeClick} />
          </div>
        </div>
      )}
    </div>
  );
}

function PolicyPicker({ policyRegistry, filteredPolicies, policySearchQuery, onSearch, onAdd, onClose }: {
  policyRegistry: PolicyRegistryEntry[];
  filteredPolicies: PolicyRegistryEntry[];
  policySearchQuery: string;
  onSearch: (q: string) => void;
  onAdd: (pol: PolicyRegistryEntry) => void;
  onClose: () => void;
}) {
  return (
    <div className="ga-policy-picker">
      <input
        className="ga-policy-picker-input"
        type="text"
        value={policySearchQuery}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search policies by ID or text..."
        autoFocus
      />
      {filteredPolicies.length > 0 && (
        <div className="ga-policy-picker-results">
          {filteredPolicies.map(pol => (
            <button
              key={pol.id}
              className="ga-policy-picker-item"
              onClick={() => onAdd(pol)}
            >
              <span className="ga-policy-picker-id">{pol.id}</span>
              <span className="ga-policy-picker-text">{pol.action}</span>
              {pol.member_count > 1 && (
                <span className="ga-policy-picker-reuse">{pol.member_count} nodes</span>
              )}
            </button>
          ))}
        </div>
      )}
      {policySearchQuery && filteredPolicies.length === 0 && (
        <div className="ga-policy-picker-empty">No matching policies</div>
      )}
      <button className="btn btn-ghost btn-sm" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────

export function GraphAttributesPanel({ attrs, nodeId, onBadgeClick, onShowAttributeInfo, onUpdatePolicyActions, onUpdateAssumptions, readOnly, defaultOpen, nodeCategory, confidence, priority, operationality, doctrinallyAnchored, evidentialConfidence, confidenceHistory, priorityHistory, operationalityHistory, onUpdateWeightedBdi }: GraphAttributesPanelProps) {
  const { policyRegistry, edgesFile } = useTaxonomyStore();
  const [open, setOpen] = useState(defaultOpen ?? false);
  // t/4919: default the first policy action open. Lazy-seeded so the initial render doesn't
  // flash collapsed before an effect opens it; the effect below re-applies the default when
  // the node changes (this panel doesn't remount per node) without re-forcing after a user toggle.
  const [expandedPolicyId, setExpandedPolicyId] = useState<string | null>(
    () => attrs.policy_actions?.[0]?.policy_id ?? null,
  );
  useEffect(() => {
    setExpandedPolicyId(attrs.policy_actions?.[0]?.policy_id ?? null);
  }, [nodeId]);
  const [policySearchQuery, setPolicySearchQuery] = useState('');
  const [showPolicyPicker, setShowPolicyPicker] = useState(false);
  const [editingAssumptions, setEditingAssumptions] = useState(false);

  // Filter registry for typeahead
  const filteredPolicies = useMemo(() => {
    if (!policyRegistry || !policySearchQuery.trim()) return [];
    const q = policySearchQuery.toLowerCase();
    const currentIds = new Set((attrs.policy_actions || []).map(pa => pa.policy_id).filter(Boolean));
    return policyRegistry
      .filter(p => !currentIds.has(p.id) && (p.id.toLowerCase().includes(q) || p.action.toLowerCase().includes(q)))
      .slice(0, 20);
  }, [policyRegistry, policySearchQuery, attrs.policy_actions]);

  const handleAddPolicy = (pol: PolicyRegistryEntry) => {
    if (!onUpdatePolicyActions) return;
    const existing = attrs.policy_actions || [];
    onUpdatePolicyActions([...existing, { policy_id: pol.id, action: pol.action, framing: '' }]);
    setPolicySearchQuery('');
    setShowPolicyPicker(false);
  };

  const handleRemovePolicy = (index: number) => {
    if (!onUpdatePolicyActions) return;
    const existing = attrs.policy_actions || [];
    onUpdatePolicyActions(existing.filter((_, i) => i !== index));
  };

  const handleUpdateFraming = (index: number, framing: string) => {
    if (!onUpdatePolicyActions) return;
    const existing = [...(attrs.policy_actions || [])];
    existing[index] = { ...existing[index], framing };
    onUpdatePolicyActions(existing);
  };

  // Build policy edge lookup
  const policyEdges = useMemo(() => {
    if (!edgesFile) return new Map<string, { type: string; target: string; targetAction: string }[]>();
    const map = new Map<string, { type: string; target: string; targetAction: string }[]>();
    for (const edge of edgesFile.edges) {
      if (!edge.source.startsWith('pol-') && !edge.target.startsWith('pol-')) continue;
      const addEdge = (polId: string, otherId: string, type: string) => {
        const list = map.get(polId) || [];
        const reg = policyRegistry?.find(p => p.id === otherId);
        list.push({ type, target: otherId, targetAction: reg?.action || otherId });
        map.set(polId, list);
      };
      if (edge.source.startsWith('pol-')) addEdge(edge.source, edge.target, edge.type);
      if (edge.target.startsWith('pol-')) addEdge(edge.target, edge.source, edge.type);
    }
    return map;
  }, [edgesFile, policyRegistry]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; field: string; value: string } | null>(null);

  // Close context menu on Escape or outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    const handleClick = () => setContextMenu(null);
    document.addEventListener('keydown', handleKey);
    document.addEventListener('click', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('click', handleClick);
    };
  }, [contextMenu]);

  const handleBadgeContextMenu = (e: React.MouseEvent, field: string, value: string) => {
    if (INFO_FIELDS.has(field)) {
      setContextMenu({ x: e.clientX, y: e.clientY, field, value });
    }
  };

  const contextMenuHandler = onShowAttributeInfo ? handleBadgeContextMenu : undefined;

  return (
    <div className="ga-panel">
      {!defaultOpen && (
        <button
          className="ga-toggle"
          onClick={() => setOpen(!open)}
          type="button"
        >
          <span className={`ga-chevron ${open ? 'ga-chevron-open' : ''}`}>&#9654;</span>
          Graph Attributes
        </button>
      )}
      {open && (
        <div className="ga-grid-3col">
          {/* Row 1: Assumptions | Epistemic Type + Falsifiability | Rhetorical Strategy */}
          <AssumptionsCell
            assumes={attrs.assumes}
            readOnly={readOnly}
            editing={editingAssumptions}
            onToggleEdit={() => setEditingAssumptions(!editingAssumptions)}
            onUpdate={onUpdateAssumptions}
          />

          <EpistemicTypeCell attrs={attrs} onBadgeClick={onBadgeClick} contextMenuHandler={contextMenuHandler} />

          <div className="ga-cell">
            <div className="ga-label">{LABEL_MAP.rhetorical_strategy}</div>
            {attrs.rhetorical_strategy ? (
              <div className="ga-value">
                {attrs.rhetorical_strategy.split(',').map((s) => (
                  <Badge
                    key={s.trim()}
                    field="rhetorical_strategy"
                    value={s.trim()}
                    onClick={onBadgeClick}
                    onContextMenu={contextMenuHandler}
                  />
                ))}
              </div>
            ) : <div className="ga-empty">&mdash;</div>}
          </div>

          {/* Weighted BDI: Confidence (Beliefs) / Priority (Desires) / Operationality (Intentions) */}
          {nodeCategory === 'Beliefs' && (
            <ConfidenceCell
              value={confidence ?? 0.5}
              readOnly={readOnly}
              doctrinallyAnchored={doctrinallyAnchored}
              evidentialConfidence={evidentialConfidence}
              history={confidenceHistory}
              onUpdate={onUpdateWeightedBdi}
            />
          )}
          {nodeCategory === 'Desires' && (
            <RankedSelectCell
              label="Priority"
              value={priority ?? 3}
              options={PRIORITY_OPTIONS}
              badge={{ show: priority === 5, text: 'Doctrinally Pinned', color: '#ef4444', bg: 'rgba(239,68,68,0.12)', title: 'Priority 5 = Core doctrinal boundary — non-negotiable commitment for this POV' }}
              history={priorityHistory}
              readOnly={readOnly}
              onUpdate={onUpdateWeightedBdi ? (val) => onUpdateWeightedBdi({ priority: val }) : undefined}
            />
          )}
          {nodeCategory === 'Intentions' && (
            <RankedSelectCell
              label="Operationality"
              value={operationality ?? 3}
              options={OPERATIONALITY_OPTIONS}
              history={operationalityHistory}
              readOnly={readOnly}
              onUpdate={onUpdateWeightedBdi ? (val) => onUpdateWeightedBdi({ operationality: val }) : undefined}
            />
          )}

          {/* Row 2: Audience | Emotional Register | Policy Actionability */}
          <div className="ga-cell">
            <div className="ga-label">{LABEL_MAP.audience}</div>
            {attrs.audience ? (
              <div className="ga-value">
                {attrs.audience.split(',').map(s => s.trim()).sort((a, b) => a.localeCompare(b)).map((s) => (
                  <Badge key={s} field="audience" value={s} onClick={onBadgeClick} />
                ))}
              </div>
            ) : <div className="ga-empty">&mdash;</div>}
          </div>

          <div className="ga-cell">
            <div className="ga-label">{LABEL_MAP.emotional_register}</div>
            {attrs.emotional_register ? (
              <div className="ga-value">
                <Badge field="emotional_register" value={attrs.emotional_register} onClick={onBadgeClick} onContextMenu={contextMenuHandler} />
              </div>
            ) : <div className="ga-empty">&mdash;</div>}
          </div>

          <div className="ga-cell">
            <div className="ga-label">Policy Actions</div>
            {attrs.policy_actions && attrs.policy_actions.length > 0 ? (
              <div className="ga-policy-actions-compact">
                {attrs.policy_actions.length} action{attrs.policy_actions.length !== 1 ? 's' : ''}
              </div>
            ) : <div className="ga-empty">&mdash;</div>}
          </div>

          {/* Policy Actions — full width */}
          {attrs.policy_actions && attrs.policy_actions.length > 0 && (
            <div className="ga-cell ga-cell-full">
              <div className="ga-label">Policy Actions</div>
              <ul className="ga-policy-actions-list">
                {attrs.policy_actions.map((pa, i) => (
                  <PolicyActionItem
                    key={i}
                    pa={pa}
                    index={i}
                    reg={policyRegistry?.find(p => p.id === pa.policy_id)}
                    edges={pa.policy_id ? policyEdges.get(pa.policy_id) : undefined}
                    readOnly={readOnly}
                    expanded={expandedPolicyId === pa.policy_id}
                    onToggleExpand={() => setExpandedPolicyId(expandedPolicyId === pa.policy_id ? null : pa.policy_id!)}
                    onUpdateFraming={onUpdatePolicyActions ? handleUpdateFraming : undefined}
                    onRemove={onUpdatePolicyActions ? handleRemovePolicy : undefined}
                  />
                ))}
              </ul>
            </div>
          )}

          {/* Policy Action Picker */}
          {!readOnly && onUpdatePolicyActions && policyRegistry && (
            <div className="ga-cell ga-cell-full">
              {!showPolicyPicker ? (
                <button className="btn btn-sm" onClick={() => setShowPolicyPicker(true)}>
                  + Add Policy Action
                </button>
              ) : (
                <PolicyPicker
                  policyRegistry={policyRegistry}
                  filteredPolicies={filteredPolicies}
                  policySearchQuery={policySearchQuery}
                  onSearch={setPolicySearchQuery}
                  onAdd={handleAddPolicy}
                  onClose={() => { setShowPolicyPicker(false); setPolicySearchQuery(''); }}
                />
              )}
            </div>
          )}

          {/* Possible Fallacies — full width */}
          {attrs.possible_fallacies && attrs.possible_fallacies.length > 0 && (
            <div className="ga-cell ga-cell-full">
              <div className="ga-label">Possible Fallacies</div>
              <ul className="ga-fallacy-list">
                {attrs.possible_fallacies.map((f: PossibleFallacy, i: number) => (
                  <FallacyItem key={i} f={f} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {contextMenu && (
        <div
          className="context-menu"
          // eslint-disable-next-line local/no-inline-style -- position tracks the click point that opened the menu
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              onShowAttributeInfo?.(contextMenu.field, contextMenu.value);
              setContextMenu(null);
            }}
          >
            About {formatValue(contextMenu.value)}
          </button>
          {onBadgeClick && (
            <button
              className="context-menu-item"
              onClick={() => {
                onBadgeClick(contextMenu.field, contextMenu.value);
                setContextMenu(null);
              }}
            >
              Find nodes with this {formatValue(contextMenu.field)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
