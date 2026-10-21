// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { TOAST_DURATION_FEEDBACK } from '../../constants';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { ConflictFile, ConflictInstance, ConflictQbaf, ConflictStance, DialecticTrace, DialecticTraceStep, TabId } from '../../types/taxonomy';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useFeatureFlagStore } from '../../hooks/useFeatureFlags';
import { usePreferencesStore } from '../../store/preferencesStore';
import { DeleteConfirmDialog } from '../shared/DeleteConfirmDialog';
import { OverflowMenu } from '../shared/OverflowMenu';
import { newEmptyInstance } from './ConflictInstanceForm';
import { ConflictNoteForm, newEmptyNote } from './ConflictNoteForm';
import { TypeaheadSelect } from '../shared/TypeaheadSelect';
import { LinkedItemPreview, toggleLinkedSelection, type SelectedLinkedItem } from './linkedItemPreview';
import { generateConflictResearchPrompt } from '../../utils/researchPrompt';
import { useDebateStore } from '../../hooks/useDebateStore';
import { api } from '@bridge';
import { summarizeStances } from './stanceSummary';
import { EditableField } from './EditableField';
import { InlineConfirm } from './InlineConfirm';
import { earliestInstanceDate, campColorVarForNodeId } from './conflictMeta';
import { allNodesById, isSuperseded } from '../../hooks/useTaxonomyStore/superseded';
import './ConflictDetail.css';

interface ConflictDetailProps {
  conflict: ConflictFile;
  readOnly?: boolean;
  onPin?: () => void;
  chipDepth?: number;
}

const STATUS_COLORS: Record<string, string> = {
  open: '#ef4444',
  resolved: '#16a34a',
  'wont-fix': '#d97706',
};

const STATUS_OPTIONS: { value: ConflictFile['status']; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'wont-fix', label: "Won't Fix" },
];
const STATUS_LABELS: Record<string, string> = { open: 'Open', resolved: 'Resolved', 'wont-fix': "Won't Fix" };
const STANCE_CHIP: Record<ConflictStance, { label: string; cls: string }> = {
  supports: { label: 'Supports', cls: 'cd-stance-supports' },
  disputes: { label: 'Disputes', cls: 'cd-stance-disputes' },
  neutral: { label: 'Neutral', cls: 'cd-stance-neutral' },
  qualifies: { label: 'Qualifies', cls: 'cd-stance-neutral' },
};

const POLICY_COLLAPSE_THRESHOLD = 8;

/** Map a taxonomy node id to the tab that lists it, for row click-to-navigate (§3.4). */
function tabForNodeId(id: string): TabId {
  switch (id.split('-', 1)[0]) {
    case 'acc': return 'accelerationist';
    case 'saf': return 'safetyist';
    case 'skp': return 'skeptic';
    default: return 'situations'; // sit-*, cc-*
  }
}

export function ConflictDetail({ conflict, readOnly, onPin, chipDepth = 0 }: ConflictDetailProps) {
  // Bookmark (Pin-for-comparison) controls are Advanced-view only (t/2826).
  const viewMode = usePreferencesStore(s => s.viewMode);
  const {
    updateConflict,
    deleteConflict,
    addConflictInstance,
    removeConflictInstance,
    updateConflictInstance,
    addConflictNote,
    removeConflictNote,
    updateConflictNote,
    getAllNodeIds,
    validationErrors,
  } = useTaxonomyStore();
  const { setActiveTab } = useTaxonomyStore();
  const getLabelForId = useTaxonomyStore(s => s.getLabelForId);
  const navigateToNode = useTaxonomyStore(s => s.navigateToNode);
  const createConflictDebate = useDebateStore(s => s.createConflictDebate);
  const [showDelete, setShowDelete] = useState(false);
  const [clipboardState, setClipboardState] = useState<'idle' | 'copied'>('idle');
  const [debateCreating, setDebateCreating] = useState(false);
  const [selectedItem, setSelectedItem] = useState<SelectedLinkedItem | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [showAllPolicies, setShowAllPolicies] = useState(false);
  const [showLinkSearch, setShowLinkSearch] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  // Close the status popover on click-outside / Escape (mirrors OverflowMenu;
  // the shared component's trigger is a fixed "…", so the status chip needs its
  // own trigger — reusing the .overflow-menu-* dropdown recipe. See t/1559#1).
  useEffect(() => {
    if (!statusOpen) return;
    const onDown = (e: MouseEvent) => { if (statusRef.current && !statusRef.current.contains(e.target as Node)) setStatusOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setStatusOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [statusOpen]);

  const handleResearchPrompt = useCallback(async () => {
    const instances = (conflict.instances || []).map((i) => ({
      doc_id: i.doc_id,
      assertion: i.assertion,
      stance: i.stance,
    }));
    const prompt = generateConflictResearchPrompt(
      conflict.claim_label,
      conflict.description,
      instances,
    );
    await api.clipboardWriteText(prompt);
    setClipboardState('copied');
    setTimeout(() => setClipboardState('idle'), TOAST_DURATION_FEEDBACK);
  }, [conflict.claim_label, conflict.description, conflict.instances]);

  const handleDebate = useCallback(async () => {
    if (debateCreating) return;
    setDebateCreating(true);
    try {
      await createConflictDebate(conflict.claim_id);
      setActiveTab('debate');
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'conflict-detail',
        level: 'error',
        message: 'failed to create debate from conflict',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    } finally {
      setDebateCreating(false);
    }
  }, [conflict.claim_id, createConflictDebate, setActiveTab, debateCreating]);

  const allNodeIds = getAllNodeIds();

  const prefix = conflict.claim_id;
  const err = (field: string) => validationErrors[`${prefix}.${field}`];
  const hasErrors = Object.keys(validationErrors).some(k => k.startsWith(`${prefix}.`));

  useEffect(() => {
    if (hasErrors && formRef.current) {
      const firstError = formRef.current.querySelector('.has-error');
      if (firstError) {
        firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const input = firstError.querySelector<HTMLElement>('input, textarea');
        input?.focus();
      }
    }
  }, [hasErrors]);

  const update = (updates: Partial<ConflictFile>) => {
    if (readOnly) return;
    updateConflict(conflict.claim_id, updates);
  };

  const raw = conflict.linked_taxonomy_nodes;
  const linkedNodes = Array.isArray(raw) ? raw : raw ? [raw] : [];

  // Computed evidentiary balance from instance stances (t/1558) — surfaces
  // whether this claim is actually contested, so the static "CONFLICT"
  // record-type chip isn't misread as "the sides disagree".
  const stanceSummary = useMemo(() => summarizeStances(conflict.instances ?? []), [conflict.instances]);
  const firstFlagged = useMemo(() => earliestInstanceDate(conflict.instances ?? []), [conflict.instances]);

  // Derive related policies from linked taxonomy nodes
  const { policyRegistry } = useTaxonomyStore();
  const relatedPolicies = useMemo(
    () => computeRelatedPolicies(linkedNodes, policyRegistry),
    [linkedNodes, policyRegistry],
  );

  // Mark (don't hide) a linked node that's been superseded (TL ruling, t/4355/t/4360).
  const supersededLinkedIds = useMemo(
    () => computeSupersededLinkedIds(linkedNodes, useTaxonomyStore.getState()),
    [linkedNodes],
  );

  const addLinked = (id: string) => {
    if (id && !linkedNodes.includes(id)) {
      update({ linked_taxonomy_nodes: [...linkedNodes, id] });
    }
  };

  const removeLinked = (id: string) => {
    update({ linked_taxonomy_nodes: linkedNodes.filter(n => n !== id) });
  };

  const noopUpdate = () => {};
  const noopRemove = () => {};

  return (
    <div ref={formRef} className="conflict-detail">
      <ConflictToolbar
        clipboardState={clipboardState}
        onResearch={handleResearchPrompt}
        onDebate={handleDebate}
        debateCreating={debateCreating}
        onPin={viewMode === 'advanced' ? onPin : undefined}
        readOnly={readOnly}
        onDelete={() => setShowDelete(true)}
      />

      {hasErrors && (
        <div className="validation-banner">
          <span className="validation-banner-icon">!</span>
          Please fix the highlighted fields before saving.
        </div>
      )}

      {/* Header — eyebrow (record type + status chip) + serif title + meta line (§3.1) */}
      <ConflictHeaderSection
        conflict={conflict}
        readOnly={readOnly}
        statusRef={statusRef}
        statusOpen={statusOpen}
        setStatusOpen={setStatusOpen}
        onSelectStatus={(v) => update({ status: v })}
        onTitleCommit={(v) => update({ claim_label: v })}
        claimLabelError={err('claim_label')}
        stanceSummary={stanceSummary}
        firstFlagged={firstFlagged}
      />

      {/* Body */}
      <div className="conflict-detail-body">
        {/* Description — prose read mode; click-to-edit textarea (§3.3) */}
        <div className={`cd-description-group ${err('description') ? 'has-error' : ''}`}>
          <EditableField
            type="textarea"
            value={conflict.description}
            onCommit={(v) => update({ description: v })}
            readOnly={readOnly}
            ariaLabel="Edit description"
            placeholder="No description"
            className="cd-description"
            rows={4}
            renderRead={(v) => v
              ? <p className="cd-prose">{v}</p>
              : <p className="cd-prose cd-empty">No description</p>}
          />
          {err('description') && <div className="error-text">{err('description')}</div>}
        </div>

        {/* Linked taxonomy nodes — label-first rows, camp tick, hover controls (§3.4) */}
        <LinkedNodesSection
          linkedNodes={linkedNodes}
          readOnly={readOnly}
          selectedItem={selectedItem}
          setSelectedItem={setSelectedItem}
          getLabelForId={getLabelForId}
          supersededLinkedIds={supersededLinkedIds}
          removeLinked={removeLinked}
          addLinked={addLinked}
          allNodeIds={allNodeIds}
          showLinkSearch={showLinkSearch}
          setShowLinkSearch={setShowLinkSearch}
        />

        {/* Related Policies (derived from linked nodes) — two-column label-first (§3.5) */}
        <RelatedPoliciesSection
          relatedPolicies={relatedPolicies}
          showAllPolicies={showAllPolicies}
          setShowAllPolicies={setShowAllPolicies}
          selectedItem={selectedItem}
          setSelectedItem={setSelectedItem}
        />

        {/* Instances — evidence cards (§3.6) */}
        <InstancesSection
          claimId={conflict.claim_id}
          instances={conflict.instances}
          readOnly={readOnly}
          updateConflictInstance={updateConflictInstance}
          removeConflictInstance={removeConflictInstance}
          addConflictInstance={addConflictInstance}
        />

        {/* Human Notes */}
        <div className="form-group">
          <label>Human Notes</label>
          {conflict.human_notes.map((note, i) => (
            <ConflictNoteForm
              key={i}
              note={note}
              index={i}
              onUpdate={readOnly ? noopUpdate : (idx, updates) => updateConflictNote(conflict.claim_id, idx, updates)}
              onRemove={readOnly ? noopRemove : (idx) => removeConflictNote(conflict.claim_id, idx)}
              readOnly={readOnly}
              errorPrefix={`${prefix}.human_notes.${i}`}
            />
          ))}
          {!readOnly && (
            <button
              className="btn btn-sm conflict-add-btn"
              onClick={() => addConflictNote(conflict.claim_id, newEmptyNote())}
            >
              + Add Note
            </button>
          )}
        </div>

        {/* Selected linked-item preview — single shared bottom region (t/1568) */}
        {selectedItem && (
          <LinkedItemPreview
            item={selectedItem}
            onClose={() => setSelectedItem(null)}
            onOpenInTab={selectedItem.kind === 'node'
              ? () => navigateToNode(tabForNodeId(selectedItem.id), selectedItem.id)
              : undefined}
          />
        )}
      </div>

      {/* QBAF Analysis (Q-15a) + Dialectic Trace — feature-gated analysis panels */}
      <ConflictAnalysisPanels qbaf={conflict.qbaf} trace={conflict.verdict?.dialectic_trace} />

      {showDelete && !readOnly && (
        <DeleteConfirmDialog
          itemLabel={conflict.claim_label}
          onConfirm={() => {
            deleteConflict(conflict.claim_id);
            setShowDelete(false);
          }}
          onCancel={() => setShowDelete(false)}
        />
      )}
    </div>
  );
}

type RelatedPolicy = { id: string; action: string };
type StoreState = ReturnType<typeof useTaxonomyStore.getState>;

/**
 * Collect the policy_action ids referenced by the conflict's linked taxonomy nodes.
 * Resolves each linked id directly — via `allNodesById` for POV nodes (t/4355: the
 * exact node, superseded included, since a superseded node's own file no longer
 * carries it) and a situations lookup otherwise — rather than scanning every file.
 * Split out of computeRelatedPolicies so each stays under the complexity gate (t/1919).
 */
function collectLinkedPolicyIds(linkedNodes: string[]): Set<string> {
  const state = useTaxonomyStore.getState();
  const byId = allNodesById(state);
  const policyIdSet = new Set<string>();

  for (const id of linkedNodes) {
    const node = byId.get(id) ?? state.situations?.nodes.find(n => n.id === id);
    if (!node) continue;
    const ga = (node as { graph_attributes?: { policy_actions?: { policy_id?: string }[] } }).graph_attributes;
    if (ga?.policy_actions) {
      for (const action of ga.policy_actions) {
        if (action.policy_id) policyIdSet.add(action.policy_id);
      }
    }
  }

  return policyIdSet;
}

/** Linked ids (POV only) that are superseded — for marking, not hiding (TL ruling, t/4360). */
function computeSupersededLinkedIds(linkedNodes: string[], state: ReturnType<typeof useTaxonomyStore.getState>): Set<string> {
  const ids = new Set<string>();
  for (const id of linkedNodes) if (isSuperseded(state, id)) ids.add(id);
  return ids;
}

/**
 * Collect the policy actions referenced by the conflict's linked taxonomy nodes.
 * Extracted verbatim from the `relatedPolicies` useMemo to keep the callback under
 * the complexity gate (t/1919) — behavior is unchanged.
 */
function computeRelatedPolicies(linkedNodes: string[], policyRegistry: StoreState['policyRegistry']): RelatedPolicy[] {
  if (linkedNodes.length === 0) return [];
  const policyIdSet = collectLinkedPolicyIds(linkedNodes);

  const policies: RelatedPolicy[] = [];
  for (const id of policyIdSet) {
    const pol = policyRegistry?.find(p => p.id === id);
    policies.push({ id, action: pol?.action ?? id });
  }
  return policies.sort((a, b) => a.id.localeCompare(b.id));
}

interface ConflictToolbarProps {
  clipboardState: 'idle' | 'copied';
  onResearch: () => void;
  onDebate: () => void;
  debateCreating: boolean;
  onPin?: () => void;
  readOnly?: boolean;
  onDelete: () => void;
}

/** Pill toolbar — Research / Debate / Pin actions + overflow menu (matches POV/CC detail style). */
function ConflictToolbar({ clipboardState, onResearch, onDebate, debateCreating, onPin, readOnly, onDelete }: ConflictToolbarProps) {
  return (
    <div className="node-detail-toolbar">
      <button
        className={`node-detail-pill${clipboardState === 'copied' ? ' node-detail-pill-active' : ''}`}
        onClick={onResearch}
        title="Generate a research prompt and copy to clipboard"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        {clipboardState === 'copied' ? 'Copied!' : 'Research'}
      </button>
      <button
        className="node-detail-pill"
        onClick={onDebate}
        disabled={debateCreating}
        title="Start a multi-agent debate on this conflict"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        {debateCreating ? 'Creating...' : 'Debate'}
      </button>
      {onPin && (
        <button className="node-detail-pill" onClick={onPin} title="Pin for comparison">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
          Pin
        </button>
      )}
      <div style={{ flex: 1 }} />
      {!readOnly && (
        <OverflowMenu
          triggerClassName="node-detail-pill cd-overflow-trigger"
          entries={[{ type: 'item', key: 'delete', label: 'Delete conflict', danger: true, onClick: onDelete }]}
        />
      )}
    </div>
  );
}

interface ConflictHeaderSectionProps {
  conflict: ConflictFile;
  readOnly?: boolean;
  statusRef: React.RefObject<HTMLDivElement | null>;
  statusOpen: boolean;
  setStatusOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSelectStatus: (value: ConflictFile['status']) => void;
  onTitleCommit: (value: string) => void;
  claimLabelError?: string;
  stanceSummary: ReturnType<typeof summarizeStances>;
  firstFlagged: ReturnType<typeof earliestInstanceDate>;
}

/** Header — eyebrow (record type + status chip/popover) + serif title + meta line (§3.1). */
function ConflictHeaderSection({
  conflict,
  readOnly,
  statusRef,
  statusOpen,
  setStatusOpen,
  onSelectStatus,
  onTitleCommit,
  claimLabelError,
  stanceSummary,
  firstFlagged,
}: ConflictHeaderSectionProps) {
  return (
    <div className="cd-header">
      <div className="cd-eyebrow">
        <span className="cd-eyebrow-cat">CONFLICT</span>
        <span className="cd-eyebrow-sep">·</span>
        {readOnly ? (
          <span className="cd-status-chip" data-status={conflict.status}>
            <span className="cd-status-dot" style={{ background: STATUS_COLORS[conflict.status] || '#888' }} />
            {STATUS_LABELS[conflict.status] ?? conflict.status}
          </span>
        ) : (
          <div className="cd-status-wrap" ref={statusRef}>
            <button
              type="button"
              className="cd-status-chip cd-status-chip-btn"
              data-status={conflict.status}
              onClick={() => setStatusOpen(o => !o)}
              aria-haspopup="true"
              aria-expanded={statusOpen}
              title="Change status"
            >
              <span className="cd-status-dot" style={{ background: STATUS_COLORS[conflict.status] || '#888' }} />
              {STATUS_LABELS[conflict.status] ?? conflict.status}
              <span className="cd-status-caret" aria-hidden="true">▾</span>
            </button>
            {statusOpen && (
              <div className="overflow-menu-dropdown cd-status-menu" role="menu">
                {STATUS_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    className="overflow-menu-item"
                    role="menuitem"
                    onClick={() => { onSelectStatus(opt.value); setStatusOpen(false); }}
                  >
                    <span className="cd-status-dot" style={{ background: STATUS_COLORS[opt.value] }} />
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <EditableField
        value={conflict.claim_label}
        onCommit={onTitleCommit}
        readOnly={readOnly}
        ariaLabel="Edit claim label"
        placeholder="Untitled Conflict"
        className={`cd-title${claimLabelError ? ' has-error' : ''}`}
        renderRead={(v) => <h2 className="cd-title-text">{v || 'Untitled Conflict'}</h2>}
      />
      {claimLabelError && <div className="error-text">{claimLabelError}</div>}

      <div className="cd-meta">
        {firstFlagged && <>First flagged {firstFlagged} · </>}
        {conflict.instances.length} instance{conflict.instances.length === 1 ? '' : 's'}
        {stanceSummary.total > 0 && (
          <>
            {' · '}
            <span
              className="cd-meta-stance"
              style={{ color: stanceSummary.kind === 'contested' ? 'var(--warning, #d97706)' : 'var(--text-muted)' }}
              title={`${stanceSummary.supports} support / ${stanceSummary.disputes} dispute / ${stanceSummary.neutral} neutral / ${stanceSummary.qualifies} qualify — derived from instance stance, not a claim that the sides disagree`}
            >
              {stanceSummary.label} ({stanceSummary.detail})
            </span>
          </>
        )}
      </div>
    </div>
  );
}

interface LinkedNodesSectionProps {
  linkedNodes: string[];
  readOnly?: boolean;
  selectedItem: SelectedLinkedItem | null;
  setSelectedItem: React.Dispatch<React.SetStateAction<SelectedLinkedItem | null>>;
  getLabelForId: StoreState['getLabelForId'];
  supersededLinkedIds: Set<string>;
  removeLinked: (id: string) => void;
  addLinked: (id: string) => void;
  allNodeIds: string[];
  showLinkSearch: boolean;
  setShowLinkSearch: React.Dispatch<React.SetStateAction<boolean>>;
}

/** Linked taxonomy nodes — label-first rows, camp tick, hover controls (§3.4). */
function LinkedNodesSection({
  linkedNodes,
  readOnly,
  selectedItem,
  setSelectedItem,
  getLabelForId,
  supersededLinkedIds,
  removeLinked,
  addLinked,
  allNodeIds,
  showLinkSearch,
  setShowLinkSearch,
}: LinkedNodesSectionProps) {
  return (
    <section className="cd-section">
      <div className="cd-section-head">LINKED TAXONOMY NODES</div>
      <div className="cd-node-rows">
        {linkedNodes.map((id) => {
          const label = getLabelForId(id);
          const isSelected = selectedItem?.kind === 'node' && selectedItem.id === id;
          const superseded = supersededLinkedIds.has(id);
          return (
            <div key={id} className={`cd-node-row${isSelected ? ' cd-row-selected' : ''}`}>
              <span className="cd-node-tick" style={{ background: campColorVarForNodeId(id) }} aria-hidden="true" />
              <button
                type="button"
                className="cd-node-main"
                onClick={() => setSelectedItem(s => toggleLinkedSelection(s, { kind: 'node', id }))}
                aria-pressed={isSelected}
                title={`Preview ${label || id}`}
              >
                <span className={`cd-node-label${label ? '' : ' cd-node-unlabeled'}`}>{label || '(unlabeled node)'}</span>
                {superseded && <span className="cd-node-superseded-badge" title="This node has been superseded">Superseded</span>}
                <span className="cd-node-id">{id}</span>
              </button>
              {!readOnly && (
                <div className="cd-node-controls">
                  <InlineConfirm onConfirm={() => removeLinked(id)} label="Unlink?" confirmLabel="Unlink">
                    {(start) => (
                      <button type="button" className="cd-node-ctrl cd-node-unlink" onClick={start} title="Unlink node" aria-label="Unlink node">✕</button>
                    )}
                  </InlineConfirm>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!readOnly && (
        showLinkSearch ? (
          <TypeaheadSelect
            options={allNodeIds.filter(id => !linkedNodes.includes(id))}
            onSelect={(id) => { addLinked(id); setShowLinkSearch(false); }}
            placeholder="Search nodes..."
          />
        ) : (
          <button type="button" className="cd-add-row" onClick={() => setShowLinkSearch(true)}>＋ Link node</button>
        )
      )}
    </section>
  );
}

interface RelatedPoliciesSectionProps {
  relatedPolicies: RelatedPolicy[];
  showAllPolicies: boolean;
  setShowAllPolicies: React.Dispatch<React.SetStateAction<boolean>>;
  selectedItem: SelectedLinkedItem | null;
  setSelectedItem: React.Dispatch<React.SetStateAction<SelectedLinkedItem | null>>;
}

/** Related Policies (derived from linked nodes) — two-column label-first (§3.5). */
function RelatedPoliciesSection({ relatedPolicies, showAllPolicies, setShowAllPolicies, selectedItem, setSelectedItem }: RelatedPoliciesSectionProps) {
  if (relatedPolicies.length === 0) return null;
  return (
    <section className="cd-section">
      <div className="cd-section-head">RELATED POLICIES ({relatedPolicies.length})</div>
      <div className="cd-policy-grid">
        {(showAllPolicies ? relatedPolicies : relatedPolicies.slice(0, POLICY_COLLAPSE_THRESHOLD)).map((pol) => {
          const isSelected = selectedItem?.kind === 'policy' && selectedItem.id === pol.id;
          return (
            <button
              key={pol.id}
              type="button"
              className={`cd-policy-row${isSelected ? ' cd-row-selected' : ''}`}
              title={pol.action}
              aria-pressed={isSelected}
              onClick={() => setSelectedItem(s => toggleLinkedSelection(s, { kind: 'policy', id: pol.id, action: pol.action }))}
            >
              <span className="cd-policy-label">{pol.action}</span>
              <span className="cd-policy-id">{pol.id}</span>
            </button>
          );
        })}
      </div>
      {relatedPolicies.length > POLICY_COLLAPSE_THRESHOLD && (
        <button type="button" className="cd-show-all" onClick={() => setShowAllPolicies(v => !v)}>
          {showAllPolicies ? 'Show fewer' : `Show all (${relatedPolicies.length})`}
        </button>
      )}
    </section>
  );
}

interface InstancesSectionProps {
  claimId: string;
  instances: ConflictInstance[];
  readOnly?: boolean;
  updateConflictInstance: StoreState['updateConflictInstance'];
  removeConflictInstance: StoreState['removeConflictInstance'];
  addConflictInstance: StoreState['addConflictInstance'];
}

/** Instances — evidence cards with per-field click-to-edit (§3.6). */
function InstancesSection({ claimId, instances, readOnly, updateConflictInstance, removeConflictInstance, addConflictInstance }: InstancesSectionProps) {
  return (
    <section className="cd-section">
      <div className="cd-section-head">INSTANCES ({instances.length})</div>
      {instances.map((inst, i) => {
        const commit = (patch: Partial<ConflictInstance>) => updateConflictInstance(claimId, i, patch);
        return (
          <div key={i} className="cd-evidence-card">
            <div className="cd-evidence-meta">
              <EditableField
                value={inst.stance}
                onCommit={(v) => commit({ stance: v as ConflictStance })}
                type="select"
                readOnly={readOnly}
                ariaLabel="Stance"
                options={[
                  { value: 'supports', label: 'Supports' },
                  { value: 'disputes', label: 'Disputes' },
                  { value: 'neutral', label: 'Neutral' },
                  { value: 'qualifies', label: 'Qualifies' },
                ]}
                renderRead={(v) => {
                  const c = STANCE_CHIP[v as ConflictStance] ?? STANCE_CHIP.neutral;
                  return <span className={`cd-stance-chip ${c.cls}`}>{c.label}</span>;
                }}
              />
              <span className="cd-evidence-sep" aria-hidden="true">·</span>
              <EditableField
                value={inst.doc_id}
                onCommit={(v) => commit({ doc_id: v })}
                readOnly={readOnly}
                ariaLabel="Document ID"
                placeholder="(no document id)"
                className="cd-evidence-docid"
                renderRead={(v) => <span className="cd-evidence-docid-text">{v || '(no document id)'}</span>}
              />
              <span className="cd-evidence-sep" aria-hidden="true">·</span>
              <EditableField
                value={inst.date_flagged}
                onCommit={(v) => commit({ date_flagged: v })}
                type="date"
                readOnly={readOnly}
                ariaLabel="Date flagged"
                className="cd-evidence-date"
                renderRead={(v) => <span className="cd-evidence-date-text">{v || '—'}</span>}
              />
              {!readOnly && (
                <span className="cd-evidence-del">
                  <InlineConfirm onConfirm={() => removeConflictInstance(claimId, i)} label="Delete instance?" confirmLabel="Delete">
                    {(start) => (
                      <button type="button" className="cd-node-ctrl" onClick={start} title="Delete instance" aria-label="Delete instance">🗑</button>
                    )}
                  </InlineConfirm>
                </span>
              )}
            </div>
            <EditableField
              type="textarea"
              value={inst.assertion}
              onCommit={(v) => commit({ assertion: v })}
              readOnly={readOnly}
              ariaLabel="Assertion"
              placeholder="(no assertion)"
              className="cd-evidence-assertion"
              rows={3}
              renderRead={(v) => <blockquote className="cd-evidence-quote">{v || <span className="cd-empty">(no assertion)</span>}</blockquote>}
            />
          </div>
        );
      })}
      {!readOnly && (
        <button type="button" className="cd-add-row" onClick={() => addConflictInstance(claimId, newEmptyInstance())}>
          ＋ Add instance
        </button>
      )}
    </section>
  );
}

/** Feature-gated analysis panels — QBAF argument map (flag-gated) + dialectic trace. */
function ConflictAnalysisPanels({ qbaf, trace }: { qbaf?: ConflictQbaf; trace?: DialecticTrace }) {
  const qbafEnabled = useFeatureFlagStore.getState().flags['release-qbaf-analysis'] ?? false;
  return (
    <>
      {qbaf && qbafEnabled && <QbafConflictPanel qbaf={qbaf} />}
      {trace && <DialecticTracePanel trace={trace} />}
    </>
  );
}

/** Mini QBAF argument map + resolution card for conflict detail */
function QbafConflictPanel({ qbaf }: { qbaf: ConflictQbaf }) {
  const { graph, resolution } = qbaf;

  function strengthBand(score: number): { label: string; cls: string } {
    if (score >= 0.8) return { label: 'Strong', cls: 'qbaf-strong' };
    if (score >= 0.5) return { label: 'Moderate', cls: 'qbaf-moderate' };
    if (score >= 0.3) return { label: 'Weak', cls: 'qbaf-weak' };
    return { label: 'Very Weak', cls: 'qbaf-very-weak' };
  }

  return (
    <div className="conflict-qbaf-panel">
      <div className="conflict-qbaf-header">QBAF Analysis</div>

      {/* Mini argument map — claims with strength badges */}
      <div className="conflict-qbaf-claims">
        {graph.nodes.map(node => {
          const band = strengthBand(node.computed_strength);
          const delta = (node.computed_strength ?? 0) - (node.base_strength ?? 0);
          const isPrevailing = resolution?.prevailing_claim === node.id;
          return (
            <div key={node.id} className={`conflict-qbaf-claim ${isPrevailing ? 'conflict-qbaf-prevailing' : ''}`}>
              <span className="conflict-qbaf-pov">{node.source_pov.slice(0, 3).toUpperCase()}</span>
              {node.bdi_category && <span className="conflict-qbaf-bdi">{node.bdi_category[0].toUpperCase()}</span>}
              <span className="conflict-qbaf-text" title={node.attribution_text_genus || undefined}>{node.text.slice(0, 100)}{node.text.length > 100 ? '...' : ''}</span>
              <span className={`qbaf-badge ${band.cls}`} style={{ opacity: 0.3 + node.computed_strength * 0.7 }}>
                {band.label}
                {Math.abs(delta) > 0.1 && (
                  <span className={`qbaf-delta ${delta > 0 ? 'qbaf-delta-up' : 'qbaf-delta-down'}`}>
                    {delta > 0 ? '+' : ''}{(delta ?? 0).toFixed(2)}
                  </span>
                )}
              </span>
              {node.bdi_sub_scores && (
                <span className="conflict-qbaf-subscores" title={Object.entries(node.bdi_sub_scores).filter(([,v]) => v != null).map(([k,v]) => `${k}: ${v}`).join(', ')}>
                  [{Object.values(node.bdi_sub_scores).filter(v => v != null).map(v => ((v as number) ?? 0).toFixed(1)).join('/')}]
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Edges */}
      {graph.edges.length > 0 && (
        <div className="conflict-qbaf-edges">
          {graph.edges.map((edge, i) => (
            <div key={i} className="conflict-qbaf-edge">
              <span className={`conflict-qbaf-edge-type ${edge.type === 'attacks' ? 'conflict-qbaf-attack' : 'conflict-qbaf-support'}`}>
                {edge.type === 'attacks' ? '\u2694' : '\u2764'} {edge.attack_type ?? edge.type}
              </span>
              <span className="conflict-qbaf-edge-weight">weight: {(edge.weight ?? 1.0).toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Resolution card */}
      {resolution && (
        <div className="conflict-qbaf-resolution">
          <div className="conflict-qbaf-resolution-header">Resolution Analysis</div>
          <div className="conflict-qbaf-resolution-body">
            {resolution.verdict === 'undecided' ? (
              <span><em>Undecided — sides not meaningfully separated (margin &lt; 0.05)</em></span>
            ) : (
              <>
                <span>Prevailing: <strong>{graph.nodes.find(n => n.id === resolution.prevailing_claim)?.text.slice(0, 60) ?? resolution.prevailing_claim}</strong></span>
                <span>Strength: {(resolution.prevailing_strength ?? 0).toFixed(2)} (margin: {(resolution.margin ?? 0).toFixed(2)})</span>
              </>
            )}
            <span>Criterion: {resolution.criterion.replace(/_/g, ' ')}</span>
          </div>
        </div>
      )}

      <div className="conflict-qbaf-meta">
        {qbaf.algorithm} &middot; {qbaf.iterations} iterations &middot; {new Date(qbaf.computed_at).toLocaleDateString()}
      </div>
    </div>
  );
}

/** Dialectic trace panel — shows the argument chain explaining why a position prevailed */
function DialecticTracePanel({ trace }: { trace: DialecticTrace }) {
  const ACTION_ICONS: Record<DialecticTraceStep['action'], string> = {
    asserted: '\u25B6',   // ▶
    attacked: '\u2694',   // ⚔
    supported: '\u2764',  // ❤
    conceded: '\u2714',   // ✔
    unaddressed: '\u2026', // …
  };

  const ACTION_COLORS: Record<DialecticTraceStep['action'], string> = {
    asserted: 'var(--text-secondary)',
    attacked: '#dc2626',
    supported: '#16a34a',
    conceded: '#d97706',
    unaddressed: 'var(--text-muted)',
  };

  return (
    <div className="conflict-trace-panel">
      <div className="conflict-trace-header">Dialectic Trace</div>
      <div className="conflict-trace-verdict">
        <span>Prevailing: <strong>{trace.prevailing}</strong></span>
        <span className="conflict-trace-criterion">{trace.criterion.replace(/_/g, ' ')}</span>
      </div>

      <div className="conflict-trace-steps">
        {trace.steps.map((step, i) => (
          <div key={i} className="conflict-trace-step">
            <div className="conflict-trace-step-gutter">
              <span className="conflict-trace-step-num">{step.step}</span>
              <span className="conflict-trace-connector" />
            </div>
            <div className="conflict-trace-step-body">
              <div className="conflict-trace-step-header">
                <span
                  className="conflict-trace-action"
                  style={{ color: ACTION_COLORS[step.action] }}
                >
                  {ACTION_ICONS[step.action]} {step.action}
                </span>
                <span className="conflict-trace-speaker">{step.speaker}</span>
                {step.scheme && (
                  <span className="conflict-trace-scheme">{step.scheme}</span>
                )}
                {step.attack_type && (
                  <span className="conflict-trace-attack-type">{step.attack_type}</span>
                )}
                {step.strength != null && (
                  <span className="conflict-trace-strength">{(step.strength ?? 0).toFixed(2)}</span>
                )}
              </div>
              <div className="conflict-trace-claim">{step.claim}</div>
              {step.responds_to && (
                <div className="conflict-trace-responds-to">responds to {step.responds_to}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="conflict-trace-meta">
        debate {trace.debate_id.slice(0, 12)} &middot; {new Date(trace.generated_at).toLocaleDateString()}
      </div>
    </div>
  );
}
