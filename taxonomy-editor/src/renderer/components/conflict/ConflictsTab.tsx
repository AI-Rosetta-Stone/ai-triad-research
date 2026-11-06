// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useKeyboardNav } from '../../hooks/useKeyboardNav';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { ConflictDetail } from './ConflictDetail';
import { PinnedPanel } from '../shared/PinnedPanel';
import { DocLink } from '../shared/TheoryLink';
import { SearchPreview } from '../edge-browser/SearchPreview';
import { FallacyDetailPanel } from '../analysis/FallacyPanel';
import { useFocusTrap } from '../shared/useDialog'; // t/4909
import { PromptDetailPanel } from '../chat/PromptsPanel';
import { ToolbarPaneRenderer, isFullWidthPanel, PhoneToolClose } from '../shared/ToolbarPaneRenderer';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { getLineageInfo } from '../../data/lineageLookup';
import { getCategoryLabel } from '../../data/lineageCategories';
import { POV_KEYS } from '@lib/debate/types';
import { api } from '@bridge';
import type { PromptCatalogEntry } from '../../data/promptCatalog';
import { PROMPT_CATALOG } from '../../data/promptCatalog';

const COLLAPSE_STORAGE_KEY = 'taxonomy-editor-conflict-collapsed';
const COLLAPSE_VERSION_KEY = 'taxonomy-editor-conflict-collapsed-version';
const COLLAPSE_VERSION = 2; // bump to reset all users to collapsed-by-default

function loadCollapsedClusters(): Set<string> {
  try {
    const version = Number(localStorage.getItem(COLLAPSE_VERSION_KEY) || '0');
    if (version >= COLLAPSE_VERSION) {
      const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
      if (raw) return new Set(JSON.parse(raw));
    }
    localStorage.setItem(COLLAPSE_VERSION_KEY, String(COLLAPSE_VERSION));
    localStorage.removeItem(COLLAPSE_STORAGE_KEY);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'conflicts-tab',
      level: 'warn',
      message: 'failed to load collapsed clusters from localStorage',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
  return new Set(); // empty = will be initialized from cluster labels on first render
}

function saveCollapsedClusters(collapsed: Set<string>) {
  localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...collapsed]));
}

export function ConflictsTab() {
  const {
    conflicts, selectedNodeId, setSelectedNodeId, createConflict, pinnedStack, pinAtDepth, toolbarPanel,
    conflictClusters, conflictClusterLoading, conflictClusterError,
    runClusterConflicts, clearConflictClusters,
  } = useTaxonomyStore();
  const [showNew, setShowNew] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [listCollapsed, setListCollapsed] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [lineagePreviewValue, setLineagePreviewValue] = useState<string | null>(null);
  const [selectedFallacyKey, setSelectedFallacyKey] = useState<string | null>(null);
  const [searchPreviewId, setSearchPreviewId] = useState<string | null>(null);
  const [selectedPromptEntry, setSelectedPromptEntry] = useState<PromptCatalogEntry | null>(PROMPT_CATALOG[0]);
  const [promptInspectorActive, setPromptInspectorActive] = useState(false);
  const { width, onMouseDown } = useResizablePanel();
  const breakpoint = useBreakpoint();
  const isPhone = breakpoint === 'phone' || breakpoint === 'phone-lg';
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(() => loadCollapsedClusters());
  const initialCollapseApplied = useRef(false);

  // Alpha-bucket grouping (zero-dependency, always available)
  const alphaClusters = useMemo(() => {
    if (conflicts.length === 0) return [];
    const sorted = [...conflicts].sort((a, b) => (a.claim_label ?? '').localeCompare(b.claim_label ?? ''));
    const buckets = new Map<string, string[]>();
    for (const c of sorted) {
      const first = ((c.claim_label ?? '')[0] || '#').toUpperCase();
      const key = /[A-Z]/.test(first) ? first : '#';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(c.claim_id);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([letter, ids]) => ({ label: letter, nodeIds: ids }));
  }, [conflicts]);

  // Use semantic clusters if available, else alpha buckets
  const displayClusters = conflictClusters || alphaClusters;

  // Default all clusters to collapsed on first load
  useEffect(() => {
    if (displayClusters.length > 0 && !initialCollapseApplied.current) {
      initialCollapseApplied.current = true;
      // Only set defaults if user hasn't saved preferences yet
      if (collapsedClusters.size === 0) {
        const allKeys = new Set(displayClusters.map(c => c.label));
        setCollapsedClusters(allKeys);
        saveCollapsedClusters(allKeys);
      }
    }
  }, [displayClusters]);

  const toggleCluster = useCallback((key: string) => {
    setCollapsedClusters(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      saveCollapsedClusters(next);
      return next;
    });
  }, []);

  // Build ordered IDs from display clusters
  const orderedIds = useMemo(() => {
    return displayClusters.flatMap(c => c.nodeIds);
  }, [displayClusters]);

  useKeyboardNav(orderedIds, selectedNodeId, setSelectedNodeId);

  // Auto-select first conflict when tab loads
  useEffect(() => {
    if (!selectedNodeId && orderedIds.length > 0) {
      setSelectedNodeId(orderedIds[0]);
    }
  }, []);

  const selectedConflict = conflicts.find(c => c.claim_id === selectedNodeId) || null;

  const handleCreate = () => {
    if (newLabel.trim()) {
      createConflict(newLabel.trim());
      setNewLabel('');
      setShowNew(false);
    }
  };

  const handlePin = () => {
    if (selectedConflict) {
      pinAtDepth(0, {
        type: 'conflict',
        conflict: structuredClone(selectedConflict),
      });
    }
  };

  const fullWidth = isFullWidthPanel(toolbarPanel, promptInspectorActive);

  const renderLineagePreview = () => {
    if (!lineagePreviewValue) return <div className="detail-panel-empty">Select a lineage value to view details</div>;
    const info = getLineageInfo(lineagePreviewValue);

    // Compute Referenced By — POV nodes whose intellectual_lineage includes this value
    const normalizedValue = lineagePreviewValue.toLowerCase();
    const referencingNodes: { id: string; label: string; pov: string; category?: string }[] = [];
    const storeState = useTaxonomyStore.getState();
    for (const p of POV_KEYS) {
      const povFile = storeState[p];
      if (!povFile) continue;
      for (const node of povFile.nodes) {
        if (node.graph_attributes?.intellectual_lineage?.some(v => { const s = typeof v === 'string' ? v : (v as { name?: string })?.name; return s?.toLowerCase() === normalizedValue; })) {
          referencingNodes.push({ id: node.id, label: node.label, pov: p, category: node.category });
        }
      }
    }

    const renderReferencedBy = () => referencingNodes.length > 0 && (
      <div className="lineage-detail-section">
        <div className="lineage-detail-label">Referenced By ({referencingNodes.length})</div>
        <div className="lineage-detail-links">
          {referencingNodes.map(ref => (
            <button
              key={ref.id}
              className="btn btn-sm btn-ghost lineage-ref-item"
              onClick={() => useTaxonomyStore.getState().navigateToNode(ref.pov as any, ref.id)}
              title={`Open ${ref.id} in ${ref.pov} tree`}
            >
              <span className={`pov-badge pov-badge-${ref.pov.slice(0, 3)}`}>{ref.pov.slice(0, 3).toUpperCase()}</span>
              <span className="lineage-ref-label">{ref.label}</span>
            </button>
          ))}
        </div>
      </div>
    );

    if (!info) return (
      <div className="lineage-detail">
        <h2 className="lineage-detail-title">{lineagePreviewValue}</h2>
        <div className="lineage-category-badge">{getCategoryLabel(lineagePreviewValue)}</div>
        <div className="lineage-detail-section">
          <p className="lineage-detail-text" style={{ color: 'var(--text-muted)' }}>No detailed information available for this lineage value.</p>
        </div>
        {renderReferencedBy()}
      </div>
    );
    return (
      <div className="lineage-detail">
        <h2 className="lineage-detail-title">{info.label}</h2>
        <div className="lineage-category-badge">{getCategoryLabel(lineagePreviewValue)}</div>
        <div className="lineage-detail-section">
          <div className="lineage-detail-label">Summary</div>
          <p className="lineage-detail-text">{info.summary}</p>
        </div>
        <div className="lineage-detail-section">
          <div className="lineage-detail-label">Example</div>
          <p className="lineage-detail-text">{info.example}</p>
        </div>
        <div className="lineage-detail-section">
          <div className="lineage-detail-label">Frequency</div>
          <p className="lineage-detail-text">{info.frequency}</p>
        </div>
        {info.links && info.links.length > 0 && (
          <div className="lineage-detail-section">
            <div className="lineage-detail-label">Learn More</div>
            <ul className="strategy-info-links">
              {info.links.map((link, i) => (
                <li key={i}>
                  <button
                    className="strategy-info-link"
                    onClick={() => void api.openExternal(link.url)}
                    title={link.url}
                  >
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {renderReferencedBy()}
      </div>
    );
  };

  return (
    <div className={`two-column${isPhone ? ' phone-mode' : ''}${isPhone && selectedNodeId && !toolbarPanel ? ' has-selection' : ''}`}>
      <ConflictListColumn
        fullWidth={fullWidth}
        isPhone={isPhone}
        toolbarPanel={toolbarPanel}
        width={width}
        listCollapsed={listCollapsed}
        setListCollapsed={setListCollapsed}
        setShowNew={setShowNew}
        setSearchPreviewId={setSearchPreviewId}
        setLineagePreviewValue={setLineagePreviewValue}
        setSelectedFallacyKey={setSelectedFallacyKey}
        setSelectedPromptEntry={setSelectedPromptEntry}
        setPromptInspectorActive={setPromptInspectorActive}
        displayClusters={displayClusters}
        collapsedClusters={collapsedClusters}
        toggleCluster={toggleCluster}
        conflicts={conflicts}
        selectedNodeId={selectedNodeId}
        setSelectedNodeId={setSelectedNodeId}
      />
      {!fullWidth && (
        <div className="resize-handle" onMouseDown={onMouseDown} />
      )}
      <ConflictDetailColumn
        fullWidth={fullWidth}
        toolbarPanel={toolbarPanel}
        promptInspectorActive={promptInspectorActive}
        searchPreviewId={searchPreviewId}
        setSearchPreviewId={setSearchPreviewId}
        selectedPromptEntry={selectedPromptEntry}
        renderLineagePreview={renderLineagePreview}
        selectedFallacyKey={selectedFallacyKey}
        detailCollapsed={detailCollapsed}
        setDetailCollapsed={setDetailCollapsed}
        isPhone={isPhone}
        selectedNodeId={selectedNodeId}
        setSelectedNodeId={setSelectedNodeId}
        selectedConflict={selectedConflict}
        onPin={handlePin}
      />
      {pinnedStack.length > 0 && <PinnedPanel />}

      <NewConflictDialog
        show={showNew}
        newLabel={newLabel}
        setNewLabel={setNewLabel}
        onCreate={handleCreate}
        onClose={() => setShowNew(false)}
      />
    </div>
  );
}

function ConflictListItem({ claimId, label, status, isSelected, onSelect }: {
  claimId: string;
  label: string;
  status: string;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  return (
    <div
      ref={ref}
      className={`node-item ${isSelected ? 'selected' : ''}`}
      onClick={() => onSelect(claimId)}
    >
      <div
        style={{
          color: 'var(--text-primary)',
          borderLeft: `3px solid ${status === 'open' ? 'var(--color-skp)' : status === 'resolved' ? 'var(--color-acc)' : 'var(--text-muted)'}`,
          paddingLeft: 8,
        }}
      >
        {label || '(untitled)'}
      </div>
      <div className="node-item-id">
        {claimId}
        <span style={{ marginLeft: 8, color: status === 'open' ? 'var(--color-skp)' : 'var(--text-muted)' }}>
          [{status}]
        </span>
      </div>
    </div>
  );
}

type StoreState = ReturnType<typeof useTaxonomyStore.getState>;
type DisplayCluster = { label: string; nodeIds: string[] };

interface ConflictListColumnProps {
  fullWidth: boolean;
  isPhone: boolean;
  toolbarPanel: StoreState['toolbarPanel'];
  width: ReturnType<typeof useResizablePanel>['width'];
  listCollapsed: boolean;
  setListCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setShowNew: React.Dispatch<React.SetStateAction<boolean>>;
  setSearchPreviewId: React.Dispatch<React.SetStateAction<string | null>>;
  setLineagePreviewValue: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedFallacyKey: React.Dispatch<React.SetStateAction<string | null>>;
  setSelectedPromptEntry: React.Dispatch<React.SetStateAction<PromptCatalogEntry | null>>;
  setPromptInspectorActive: React.Dispatch<React.SetStateAction<boolean>>;
  displayClusters: DisplayCluster[];
  collapsedClusters: Set<string>;
  toggleCluster: (key: string) => void;
  conflicts: StoreState['conflicts'];
  selectedNodeId: StoreState['selectedNodeId'];
  setSelectedNodeId: StoreState['setSelectedNodeId'];
}

/** Left column — toolbar panes / collapsed rail / the clustered conflict list. */
function ConflictListColumn({
  fullWidth,
  isPhone,
  toolbarPanel,
  width,
  listCollapsed,
  setListCollapsed,
  setShowNew,
  setSearchPreviewId,
  setLineagePreviewValue,
  setSelectedFallacyKey,
  setSelectedPromptEntry,
  setPromptInspectorActive,
  displayClusters,
  collapsedClusters,
  toggleCluster,
  conflicts,
  selectedNodeId,
  setSelectedNodeId,
}: ConflictListColumnProps) {
  if (fullWidth) {
    return (
      <div className="list-panel list-panel-full">
        {isPhone && <PhoneToolClose />}
        <ToolbarPaneRenderer
          panel={toolbarPanel}
          onSelectResult={setSearchPreviewId}
          onSelectLineageValue={setLineagePreviewValue}
          onSelectFallacy={setSelectedFallacyKey}
          onSelectPrompt={setSelectedPromptEntry}
          onInspectorToggle={setPromptInspectorActive}
        />
      </div>
    );
  }
  if (toolbarPanel) {
    return (
      <div className="list-panel" style={{ width }}>
        {isPhone && <PhoneToolClose />}
        <ToolbarPaneRenderer
          panel={toolbarPanel}
          onSelectResult={setSearchPreviewId}
          onSelectLineageValue={setLineagePreviewValue}
          onSelectFallacy={setSelectedFallacyKey}
          onSelectPrompt={setSelectedPromptEntry}
          onInspectorToggle={setPromptInspectorActive}
        />
      </div>
    );
  }
  if (listCollapsed) {
    return (
      <div className="pane-collapsed pane-collapsed-list" onClick={() => setListCollapsed(false)} title="Expand list">
        <span className="pane-collapsed-label">Conflicts</span>
      </div>
    );
  }
  return (
    <div className="list-panel" style={{ width }}>
      <div className="list-panel-header">
        <h2>Conflicts</h2>
        <DocLink docPath="research/comp-linguist/docs/theory-of-success/theory-of-success-conflicts.md" label="Theory of success: Conflicts" tooltip="Open the Conflicts theory-of-success doc in GitHub" />
        <div className="list-panel-header-actions">
          <button className="btn btn-sm" onClick={() => setShowNew(true)}>
            + New
          </button>
          <button className="pane-collapse-btn" onClick={() => setListCollapsed(true)} title="Collapse" aria-label="Collapse panel">&lsaquo;</button>
        </div>
      </div>
      <div className="list-panel-items">
        {displayClusters.map((cluster) => {
          const isCollapsed = collapsedClusters.has(cluster.label);
          return (
            <div key={cluster.label} className="category-group cluster-group">
              <div
                className="category-label cluster-label"
                onClick={() => toggleCluster(cluster.label)}
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                <span className={`category-toggle ${isCollapsed ? 'collapsed' : ''}`}>&#9660;</span>
                {cluster.label} <span className="category-count">({cluster.nodeIds.length})</span>
              </div>
              {!isCollapsed && cluster.nodeIds.map((id) => {
                const conflict = conflicts.find(c => c.claim_id === id);
                if (!conflict) return null;
                return (
                  <ConflictListItem
                    key={conflict.claim_id}
                    claimId={conflict.claim_id}
                    label={conflict.claim_label}
                    status={conflict.status}
                    isSelected={selectedNodeId === conflict.claim_id}
                    onSelect={setSelectedNodeId}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ConflictDetailColumnProps {
  fullWidth: boolean;
  toolbarPanel: StoreState['toolbarPanel'];
  promptInspectorActive: boolean;
  searchPreviewId: string | null;
  setSearchPreviewId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedPromptEntry: PromptCatalogEntry | null;
  renderLineagePreview: () => React.ReactNode;
  selectedFallacyKey: string | null;
  detailCollapsed: boolean;
  setDetailCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  isPhone: boolean;
  selectedNodeId: StoreState['selectedNodeId'];
  setSelectedNodeId: StoreState['setSelectedNodeId'];
  selectedConflict: StoreState['conflicts'][number] | null;
  onPin: () => void;
}

/** Right column — toolbar-pane detail / collapsed rail / the selected conflict editor. */
function ConflictDetailColumn({
  fullWidth,
  toolbarPanel,
  promptInspectorActive,
  searchPreviewId,
  setSearchPreviewId,
  selectedPromptEntry,
  renderLineagePreview,
  selectedFallacyKey,
  detailCollapsed,
  setDetailCollapsed,
  isPhone,
  selectedNodeId,
  setSelectedNodeId,
  selectedConflict,
  onPin,
}: ConflictDetailColumnProps) {
  if (fullWidth) return null;
  if (toolbarPanel === 'search') {
    return (
      <div className="detail-panel">
        <SearchPreview searchPreviewId={searchPreviewId} onClear={() => setSearchPreviewId(null)} />
      </div>
    );
  }
  if (toolbarPanel === 'prompts' && !promptInspectorActive) {
    return (
      <div className="detail-panel">
        <PromptDetailPanel entry={selectedPromptEntry} />
      </div>
    );
  }
  if (toolbarPanel === 'lineage') {
    return (
      <div className="detail-panel">
        {renderLineagePreview()}
      </div>
    );
  }
  if (toolbarPanel === 'fallacy') {
    return (
      <div className="detail-panel">
        <FallacyDetailPanel fallacyKey={selectedFallacyKey} />
      </div>
    );
  }
  if (detailCollapsed) {
    return (
      <div className="pane-collapsed pane-collapsed-detail" onClick={() => setDetailCollapsed(false)} title="Expand detail">
        <span className="pane-collapsed-label">Detail</span>
      </div>
    );
  }
  return (
    <div className="detail-panel">
      {isPhone && selectedNodeId ? (
        <div className="phone-detail-header">
          <button className="phone-detail-back" onClick={() => setSelectedNodeId('')}>
            &larr; Conflicts
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button className="pane-collapse-btn" onClick={() => setDetailCollapsed(true)} title="Collapse" aria-label="Collapse panel">&lsaquo;</button>
        </div>
      )}
      {selectedConflict ? (
        <ConflictDetail conflict={selectedConflict} onPin={onPin} />
      ) : (
        <div className="detail-panel-empty">Select a conflict to edit</div>
      )}
    </div>
  );
}

interface NewConflictDialogProps {
  show: boolean;
  newLabel: string;
  setNewLabel: React.Dispatch<React.SetStateAction<string>>;
  onCreate: () => void;
  onClose: () => void;
}

/** Modal for creating a new conflict from a claim label. */
function NewConflictDialog({ show, newLabel, setNewLabel, onCreate, onClose }: NewConflictDialogProps) {
  // t/4909: mounted once by ConflictsTab (`show` toggles as a prop, not a conditional render) —
  // doesn't fit useDialog's mount-bookended focus management, so only the shared Tab trap plus
  // a matching open-keyed Esc + restore-focus effect (mirrors GeminiOnboardingModal, same shape).
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, show);
  useEffect(() => {
    if (!show) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [show, onClose]);

  if (!show) return null;
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal aria-labelledby="new-conflict-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="new-conflict-title">New Conflict</h3>
        <div className="form-group">
          <label>Claim Label</label>
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g., AGI Timeline Estimates"
            autoFocus
          />
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={onCreate}
            disabled={!newLabel.trim()}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
