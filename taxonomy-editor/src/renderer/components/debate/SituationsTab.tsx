// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { PovNode, SituationNode } from '../../types/taxonomy';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById, isSupersededNode } from '../../hooks/useTaxonomyStore/superseded';
import { SupersededBanner } from '../taxonomy/SupersededBanner';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useKeyboardNav } from '../../hooks/useKeyboardNav';
import { useResizablePanel, useResizableRightPanel } from '../../hooks/useResizablePanel';
import { SituationDetail } from './SituationDetail';
import { FallacyDetailPanel } from '../analysis/FallacyPanel';
import { PinnedPanel } from '../shared/PinnedPanel';
import { DocLink } from '../shared/TheoryLink';
import { ExternalEmbed } from '../shared/ExternalEmbed';
import { SearchPreview } from '../edge-browser/SearchPreview';
import { EdgeDetailPanel } from '../edge-browser/EdgeDetailPanel';
import { ToolbarPaneRenderer, isFullWidthPanel, PhoneToolClose } from '../shared/ToolbarPaneRenderer';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { getLineageInfo } from '../../data/lineageLookup';
import { getCategoryLabel } from '../../data/lineageCategories';
import { POV_KEYS } from '@lib/debate/types';
import { PromptDetailPanel } from '../chat/PromptsPanel';
import type { PromptCatalogEntry } from '../../data/promptCatalog';
import { PROMPT_CATALOG } from '../../data/promptCatalog';
import { api } from '@bridge';
import { sortSituationNodes, type SitSortMode } from './situationSort';
import { SituationListItem } from './SituationListItem';
import { subscribeToSituationDebateStart } from './waitForSituationDebateStart';
import './SituationsTab.css';

// --- Presentational sub-components (props in → JSX out, NO hooks) ---------
// Extracted from SituationsTab's render to keep each function's cyclomatic
// complexity within bounds (ADR-007). Behavior-preserving: JSX is verbatim.

interface SituationsListPaneProps {
  toolbarPanel: string | null;
  promptInspectorActive: boolean;
  isPhone: boolean;
  width: number;
  hasToolbarPane: boolean;
  listCollapsed: boolean;
  setListCollapsed: (v: boolean) => void;
  setSearchPreviewId: (id: string | null) => void;
  setLineagePreviewValue: (value: string | null) => void;
  setSelectedFallacyKey: (key: string | null) => void;
  setSelectedPromptEntry: (entry: PromptCatalogEntry | null) => void;
  setPromptInspectorActive: (active: boolean) => void;
  sitSortMode: SitSortMode;
  setSitSortMode: (mode: SitSortMode) => void;
  hierarchyView: boolean;
  toggleHierarchy: () => void;
  createSituationNode: () => string;
  roots: SituationNode[];
  childMap: Map<string, SituationNode[]>;
  standalones: SituationNode[];
  sortedFlatNodes: SituationNode[];
  collapsedGroups: Set<string>;
  toggleGroup: (key: string) => void;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
}

// Pane 1: node list OR promoted toolbar panel.
function SituationsListPane({
  toolbarPanel, promptInspectorActive, isPhone, width, hasToolbarPane,
  listCollapsed, setListCollapsed,
  setSearchPreviewId, setLineagePreviewValue, setSelectedFallacyKey,
  setSelectedPromptEntry, setPromptInspectorActive,
  sitSortMode, setSitSortMode, hierarchyView, toggleHierarchy, createSituationNode,
  roots, childMap, standalones, sortedFlatNodes, collapsedGroups, toggleGroup,
  selectedNodeId, setSelectedNodeId,
}: SituationsListPaneProps) {
  return (
    isFullWidthPanel(toolbarPanel, promptInspectorActive) ? (
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
    ) : hasToolbarPane ? (
      <div
        className="list-panel"
        // eslint-disable-next-line local/no-inline-style -- dynamic: resizable panel width from useResizablePanel
        style={{ width }}
      >
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
    ) : listCollapsed ? (
      <div className="pane-collapsed pane-collapsed-list" onClick={() => setListCollapsed(false)} title="Expand list">
        <span className="pane-collapsed-label">Situations</span>
      </div>
    ) : (
      <div
        className="list-panel"
        // eslint-disable-next-line local/no-inline-style -- dynamic: resizable panel width from useResizablePanel
        style={{ width }}
      >
        <div className="list-panel-header">
          <h2>Situations</h2>
          <DocLink docPath="research/comp-linguist/docs/theory-of-success/theory-of-success-situations.md" label="Theory of success: Situations" tooltip="Open the Situations theory-of-success doc in GitHub" />
          <div className="list-panel-header-actions">
            <select
              className="sort-select"
              value={sitSortMode}
              onChange={(e) => setSitSortMode(e.target.value as SitSortMode)}
              title="Sort situations"
            >
              <option value="label">Sort: Name</option>
              <option value="id">Sort: ID</option>
              <option value="divergence">Sort: Divergence</option>
            </select>
            <button
              className={`btn btn-sm${hierarchyView ? '' : ' btn-ghost'}`}
              onClick={toggleHierarchy}
              title={hierarchyView ? 'Switch to flat list' : 'Switch to hierarchy view'}
            >
              {hierarchyView ? 'Tree' : 'Flat'}
            </button>
            <button className="btn btn-sm" onClick={createSituationNode}>
              + New
            </button>
            <button className="pane-collapse-btn" onClick={() => setListCollapsed(true)} title="Collapse" aria-label="Collapse panel">&lsaquo;</button>
          </div>
        </div>
        <div className="list-panel-items">
          {hierarchyView ? (
            <>
              {roots.map((root) => {
                const children = childMap.get(root.id) || [];
                const isGroupCollapsed = collapsedGroups.has(root.id);
                return (
                  <div key={root.id} className="node-tree-parent-group">
                    <div
                      className={`node-tree-parent-header ${selectedNodeId === root.id ? 'selected' : ''}`}
                      onClick={() => setSelectedNodeId(root.id)}
                    >
                      <span
                        className={`category-toggle ${isGroupCollapsed ? 'collapsed' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleGroup(root.id); }}
                      >&#9660;</span>
                      <span className="node-tree-parent-label">{root.label || '(untitled)'}</span>
                      <span className="node-tree-parent-count">{children.length}</span>
                    </div>
                    {!isGroupCollapsed && children.map((child) => (
                      <SituationListItem
                        key={child.id}
                        id={child.id}
                        label={child.label}
                        isSelected={selectedNodeId === child.id}
                        onSelect={setSelectedNodeId}
                        indent
                        relationship={child.parent_relationship}
                        divergence={sitSortMode === 'divergence' && typeof child.interpretation_divergence === 'number' ? child.interpretation_divergence : undefined}
                      />
                    ))}
                  </div>
                );
              })}
              {standalones.length > 0 && roots.length > 0 && (
                <div className="situations-standalone-divider" />
              )}
              {standalones.map((node) => (
                <SituationListItem
                  key={node.id}
                  id={node.id}
                  label={node.label}
                  isSelected={selectedNodeId === node.id}
                  onSelect={setSelectedNodeId}
                  divergence={sitSortMode === 'divergence' && typeof node.interpretation_divergence === 'number' ? node.interpretation_divergence : undefined}
                />
              ))}
            </>
          ) : (
            sortedFlatNodes.map((node) => (
              <SituationListItem
                key={node.id}
                id={node.id}
                label={node.label}
                isSelected={selectedNodeId === node.id}
                onSelect={setSelectedNodeId}
                divergence={sitSortMode === 'divergence' ? node.interpretation_divergence : undefined}
              />
            ))
          )}
        </div>
      </div>
    )
  );
}

interface SituationsNormalDetailProps {
  detailCollapsed: boolean;
  setDetailCollapsed: (v: boolean) => void;
  isPhone: boolean;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  selectedNode: SituationNode | null;
  /** t/4363 (t/4355 child): selectedNodeId resolved to a held-aside POV node rather than a
   *  situations node. Shown read-only with the "Superseded by" banner, never through
   *  SituationDetail (its `interpretations` field is required and POV nodes don't have one). */
  supersededPovNode: PovNode | null;
  handlePin: () => void;
  handleRelated: () => void;
  handleDebate: () => void;
  pinnedStack: readonly unknown[];
  hasToolbarPane: boolean;
}

// Pane 2, final branch: the normal detail panel (+ pinned stack).
function SituationsNormalDetail({
  detailCollapsed, setDetailCollapsed, isPhone, selectedNodeId, setSelectedNodeId,
  selectedNode, supersededPovNode, handlePin, handleRelated, handleDebate, pinnedStack, hasToolbarPane,
}: SituationsNormalDetailProps) {
  return (
    <>
      {detailCollapsed ? (
        <div className="pane-collapsed pane-collapsed-detail" onClick={() => setDetailCollapsed(false)} title="Expand detail">
          <span className="pane-collapsed-label">Detail</span>
        </div>
      ) : (
        <div className="detail-panel">
          {isPhone && selectedNodeId ? (
            <div className="phone-detail-header">
              <button className="phone-detail-back" onClick={() => setSelectedNodeId('')}>
                &larr; Situations
              </button>
            </div>
          ) : (
            <div className="situations-detail-collapse-row">
              <button className="pane-collapse-btn" onClick={() => setDetailCollapsed(true)} title="Collapse" aria-label="Collapse panel">&lsaquo;</button>
            </div>
          )}
          {selectedNode ? (
            <SituationDetail node={selectedNode} onPin={handlePin} onRelated={handleRelated} onDebate={handleDebate} />
          ) : supersededPovNode ? (
            <>
              <SupersededBanner node={supersededPovNode} />
              <div className="detail-panel-superseded-readonly">
                <h3>{supersededPovNode.label}</h3>
                <p>{supersededPovNode.description}</p>
              </div>
            </>
          ) : (
            <div className="detail-panel-empty">Select a situation node to edit</div>
          )}
        </div>
      )}
      {pinnedStack.length > 0 && !hasToolbarPane && <PinnedPanel />}
    </>
  );
}

interface SituationsDetailPaneProps {
  toolbarPanel: string | null;
  promptInspectorActive: boolean;
  searchPreviewId: string | null;
  setSearchPreviewId: (id: string | null) => void;
  showEdgeDetail: boolean;
  selectedPromptEntry: PromptCatalogEntry | null;
  selectedFallacyKey: string | null;
  handleFallacyNodeSelect: (nodeId: string, pov: string) => void;
  renderLineagePreview: () => ReactNode;
  lineageLinkUrl: string | null;
  setLineageLinkUrl: (url: string | null) => void;
  normalDetail: ReactNode;
}

// Pane 2: detail region (search preview, related edges, prompts, fallacy,
// lineage preview, or normal detail).
function SituationsDetailPane({
  toolbarPanel, promptInspectorActive, searchPreviewId, setSearchPreviewId,
  showEdgeDetail, selectedPromptEntry, selectedFallacyKey, handleFallacyNodeSelect,
  renderLineagePreview, lineageLinkUrl, setLineageLinkUrl, normalDetail,
}: SituationsDetailPaneProps) {
  return (
    toolbarPanel === 'search' ? (
      <div className="detail-panel">
        <SearchPreview searchPreviewId={searchPreviewId} onClear={() => setSearchPreviewId(null)} />
      </div>
    ) : toolbarPanel === 'related' ? (
      <div className="detail-panel">
        {showEdgeDetail ? (
          <EdgeDetailPanel />
        ) : (
          <div className="detail-panel-empty">Select an edge to view details</div>
        )}
      </div>
    ) : isFullWidthPanel(toolbarPanel, promptInspectorActive) ? null
    : (toolbarPanel === 'prompts' && !promptInspectorActive) ? (
      <div className="detail-panel">
        <PromptDetailPanel entry={selectedPromptEntry} />
      </div>
    ) : toolbarPanel === 'fallacy' ? (
      <div className="detail-panel">
        <FallacyDetailPanel fallacyKey={selectedFallacyKey} onSelectNode={handleFallacyNodeSelect} />
      </div>
    ) : toolbarPanel === 'lineage' ? (
      <>
        <div className="detail-panel">
          {renderLineagePreview()}
        </div>
        {lineageLinkUrl && (
          <>
            <div className="resize-handle" />
            <div className="webview-pane">
              <div className="webview-pane-header">
                <span className="webview-pane-url">{lineageLinkUrl}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setLineageLinkUrl(null)} aria-label="Close">&times;</button>
              </div>
              <ExternalEmbed src={lineageLinkUrl} title="Lineage source" />
            </div>
          </>
        )}
      </>
    ) : (
      normalDetail
    )
  );
}

/**
 * t/4363 (t/4355 child): `selectedNodeId` is normally a situations-node id, resolved above via
 * `situations.nodes.find`. `allNodesById` only indexes POV nodes (acc/saf/skp) — the situations/cc
 * file is a separate slice, never held aside — so this fallback only fires if `selectedNodeId` ever
 * resolves to a POV id while this tab is mounted, and only surfaces it when that node is superseded
 * (a live POV node isn't this tab's business to show). Exported for direct unit testing. TL p/696#8:
 * reads the caller's already-subscribed store state, so the component stays reactive.
 */
export function resolveSupersededFallback(
  selectedSituationNode: SituationNode | null,
  selectedNodeId: string | null,
  taxonomyState: Parameters<typeof allNodesById>[0],
): PovNode | null {
  if (selectedSituationNode || !selectedNodeId) return null;
  const node = allNodesById(taxonomyState).get(selectedNodeId);
  return node && isSupersededNode(node) ? node : null;
}

export function SituationsTab() {
  const taxonomyState = useTaxonomyStore();
  const {
    situations, selectedNodeId, setSelectedNodeId, createSituationNode,
    pinnedStack, pinAtDepth,
    attributeFilter, attributeInfo,
    relatedNodeId, showRelatedEdges, selectedEdge,
    toolbarPanel, setActiveTab,
  } = taxonomyState;
  const [listCollapsed, setListCollapsed] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [sitSortMode, setSitSortMode] = useState<SitSortMode>('label');
  const [hierarchyView, setHierarchyView] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem('taxonomy-editor-sit-hierarchy');
      return v === null ? true : v === 'true';
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'situations-tab',
        level: 'warn',
        message: 'Failed to load hierarchy view preference from localStorage',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return true;
    }
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const version = Number(localStorage.getItem('taxonomy-editor-sit-collapsed-version') || '0');
      if (version >= 3) {
        const raw = localStorage.getItem('taxonomy-editor-sit-collapsed');
        if (raw) return new Set(JSON.parse(raw));
      }
      localStorage.setItem('taxonomy-editor-sit-collapsed-version', '3');
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'situations-tab',
        level: 'warn',
        message: 'Failed to load collapsed groups from localStorage',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    return new Set(['__default_collapsed__']); // sentinel: collapse all on first load
  });
  const [searchPreviewId, setSearchPreviewId] = useState<string | null>(null);
  const [lineagePreviewValue, setLineagePreviewValue] = useState<string | null>(null);
  const [lineageLinkUrl, setLineageLinkUrl] = useState<string | null>(null);
  const [selectedFallacyKey, setSelectedFallacyKey] = useState<string | null>(null);
  const [selectedPromptEntry, setSelectedPromptEntry] = useState<PromptCatalogEntry | null>(PROMPT_CATALOG[0]);
  const [promptInspectorActive, setPromptInspectorActive] = useState(false);
  const [debateLaunching, setDebateLaunching] = useState(false);
  const { width, onMouseDown } = useResizablePanel();
  const breakpoint = useBreakpoint();
  const isPhone = breakpoint === 'phone' || breakpoint === 'phone-lg';
  const { width: edgeDetailWidth, onMouseDown: onEdgeDetailResize } = useResizableRightPanel({
    storageKey: 'taxonomy-editor-edge-detail-width',
    defaultWidth: 480,
    minWidth: 320,
    maxWidth: 700,
  });

  const showRelatedPanel = relatedNodeId !== null;
  const showEdgeDetail = selectedEdge !== null && showRelatedPanel;
  const hasToolbarPane = toolbarPanel !== null;

  // Grow/shrink window when Edge Detail panel opens/closes
  const prevShowEdgeDetail = useRef(false);
  useEffect(() => {
    const wasShowing = prevShowEdgeDetail.current;
    prevShowEdgeDetail.current = showEdgeDetail;
    if (showEdgeDetail === wasShowing) return;
    const delta = edgeDetailWidth + 4;
    void api.isMaximized().then((max) => {
      if (max) return;
      if (showEdgeDetail) void api.growWindow(delta);
      else void api.shrinkWindow(delta);
    });
  }, [showEdgeDetail]);

  // Auto-collapse pane 2 when edge detail opens; auto-expand when closed
  const prevEdgeDetailForCollapse = useRef(false);
  useEffect(() => {
    const was = prevEdgeDetailForCollapse.current;
    prevEdgeDetailForCollapse.current = showEdgeDetail;
    if (showEdgeDetail && !was) setDetailCollapsed(true);
    if (!showEdgeDetail && was) setDetailCollapsed(false);
  }, [showEdgeDetail]);

  // Auto-refresh related edges when selection changes while panel is open
  useEffect(() => {
    /* eslint-disable @typescript-eslint/no-use-before-define -- selectedNode defined after early return guard */
    if (showRelatedPanel && selectedNode) {
      showRelatedEdges(selectedNode.id);
    }
    /* eslint-enable @typescript-eslint/no-use-before-define */
  }, [selectedNodeId]);

  const toggleHierarchy = useCallback(() => {
    setHierarchyView(prev => {
      const next = !prev;
      localStorage.setItem('taxonomy-editor-sit-hierarchy', String(next));
      return next;
    });
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem('taxonomy-editor-sit-collapsed', JSON.stringify([...next]));
      return next;
    });
  }, []);

  // Build hierarchy structures for tree view
  const { roots, childMap, standalones } = useMemo(() => {
    if (!situations) return { roots: [] as SituationNode[], childMap: new Map<string, SituationNode[]>(), standalones: [] as SituationNode[] };
    const cMap = new Map<string, SituationNode[]>();
    const allNodes = situations.nodes;
    for (const n of allNodes) {
      if (n.parent_id) {
        const list = cMap.get(n.parent_id) || [];
        list.push(n);
        cMap.set(n.parent_id, list);
      }
    }
    const r = sortSituationNodes(allNodes.filter(n => !n.parent_id && cMap.has(n.id)), sitSortMode);
    const s = sortSituationNodes(allNodes.filter(n => !n.parent_id && !cMap.has(n.id)), sitSortMode);
    // Sort children within each group
    for (const [key, children] of cMap) {
      cMap.set(key, sortSituationNodes(children, sitSortMode));
    }
    return { roots: r, childMap: cMap, standalones: s };
  }, [situations, sitSortMode]);

  // Sorted flat list for flat view
  const sortedFlatNodes = useMemo(() => {
    if (!situations) return [];
    return sortSituationNodes([...situations.nodes], sitSortMode);
  }, [situations, sitSortMode]);

  // Ordered IDs for keyboard nav — hierarchy-aware when in tree view
  const orderedIds = useMemo(() => {
    if (!situations) return [];
    if (!hierarchyView) return sortedFlatNodes.map(n => n.id);
    const ids: string[] = [];
    for (const root of roots) {
      ids.push(root.id);
      if (!collapsedGroups.has(root.id)) {
        for (const child of childMap.get(root.id) || []) {
          ids.push(child.id);
        }
      }
    }
    for (const node of standalones) {
      ids.push(node.id);
    }
    return ids;
  }, [situations, hierarchyView, roots, childMap, standalones, collapsedGroups]);

  useKeyboardNav(orderedIds, selectedNodeId, setSelectedNodeId, toolbarPanel !== null);

  // Default-collapse all groups on first load (when sentinel is present)
  useEffect(() => {
    if (collapsedGroups.has('__default_collapsed__') && roots.length > 0) {
      const allIds = new Set(roots.map(r => r.id));
      setCollapsedGroups(allIds);
      localStorage.setItem('taxonomy-editor-sit-collapsed', JSON.stringify([...allIds]));
    }
  }, [roots]);

  // Auto-select first node when tab loads
  useEffect(() => {
    if (!selectedNodeId && orderedIds.length > 0) {
      setSelectedNodeId(orderedIds[0]);
    }
  }, []);

  const selectedNode = situations?.nodes.find(n => n.id === selectedNodeId) || null;
  const supersededPovNode = resolveSupersededFallback(selectedNode, selectedNodeId, taxonomyState);

  // Hooks must precede the `if (!situations)` early return (rules-of-hooks, t/2299).
  // selectedNode was already `... || null`, so hoisting it does not change its type.
  const handleFallacyNodeSelect = useCallback((nodeId: string, pov: string) => {
    // Map pov to tab and navigate
    const tabMap: Record<string, string> = {
      accelerationist: 'accelerationist',
      safetyist: 'safetyist',
      skeptic: 'skeptic',
      situations: 'situations',
    };
    const tab = tabMap[pov];
    if (tab) {
      setActiveTab(tab as any);
      // Delay to let the tab render before selecting
      setTimeout(() => setSelectedNodeId(nodeId), 50);
    }
  }, [setActiveTab, setSelectedNodeId]);

  const createSituationDebate = useDebateStore(s => s.createSituationDebate);
  const handleDebate = useCallback(() => {
    if (!selectedNode || debateLaunching) return;
    setDebateLaunching(true);
    const nodeId = selectedNode.id;

    // Mirrors SituationDebatePanel.handleLaunch's fix (t/3752): open the popout
    // (t/3749 — setActiveTab alone lands on the summary card, not the live debate)
    // as soon as the record exists, instead of blocking on createSituationDebate's
    // full watch-only opening round (enterClarificationOrBegin, t/3629 — don't touch).
    const unsubscribe = subscribeToSituationDebateStart(nodeId, (id) => {
      unsubscribe();
      void api.openDebateWindow(id).catch((openErr: Error) => {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'situations-tab', level: 'warn', debate_id: id, message: 'Failed to open debate popout window after situation debate launch', error: { name: openErr.name ?? 'Error', message: String(openErr), stack: openErr.stack } });
      });
      setActiveTab('debate');
      setDebateLaunching(false);
    });

    createSituationDebate(nodeId)
      .catch((err) => {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'situations-tab', level: 'error', message: 'Failed to create situation debate', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        setDebateLaunching(false);
      })
      .finally(() => {
        unsubscribe();
      });
  }, [selectedNode, debateLaunching, createSituationDebate, setActiveTab]);

  if (!situations) {
    return <div className="detail-panel-empty">No situations data loaded</div>;
  }

  const handlePin = () => {
    if (selectedNode) {
      pinAtDepth(0, {
        type: 'situations',
        node: structuredClone(selectedNode),
      });
    }
  };

  const handleRelated = () => {
    if (selectedNode) {
      showRelatedEdges(selectedNode.id);
    }
  };

  // Search preview rendered via shared SearchPreview component

  // Render lineage about info for Pane 2
  const renderLineagePreview = () => {
    if (!lineagePreviewValue) return <div className="detail-panel-empty">Select a lineage value to view details</div>;
    const info = getLineageInfo(lineagePreviewValue);

    // Compute Referenced By — POV nodes whose intellectual_lineage includes this value
    const normalizedValue = lineagePreviewValue.toLowerCase();
    const referencingNodes: { id: string; label: string; pov: string; category?: string }[] = [];
    const state = useTaxonomyStore.getState();
    for (const p of POV_KEYS) {
      const povFile = state[p];
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
          <p className="lineage-detail-text situations-lineage-empty-text">No detailed information available for this lineage value.</p>
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
            <div className="lineage-detail-label">Links</div>
            <div className="lineage-detail-links">
              {info.links.map((link, i) => (
                <button
                  key={i}
                  className={`btn btn-sm${lineageLinkUrl === link.url ? '' : ' btn-ghost'}`}
                  onClick={() => setLineageLinkUrl(link.url)}
                >
                  {link.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {renderReferencedBy()}
      </div>
    );
  };

  return (
    <div className={`two-column${isPhone ? ' phone-mode' : ''}${isPhone && selectedNodeId && !toolbarPanel ? ' has-selection' : ''}`}>
      {/* Pane 1: Node list OR promoted toolbar panel */}
      <SituationsListPane
        toolbarPanel={toolbarPanel}
        promptInspectorActive={promptInspectorActive}
        isPhone={isPhone}
        width={width}
        hasToolbarPane={hasToolbarPane}
        listCollapsed={listCollapsed}
        setListCollapsed={setListCollapsed}
        setSearchPreviewId={setSearchPreviewId}
        setLineagePreviewValue={setLineagePreviewValue}
        setSelectedFallacyKey={setSelectedFallacyKey}
        setSelectedPromptEntry={setSelectedPromptEntry}
        setPromptInspectorActive={setPromptInspectorActive}
        sitSortMode={sitSortMode}
        setSitSortMode={setSitSortMode}
        hierarchyView={hierarchyView}
        toggleHierarchy={toggleHierarchy}
        createSituationNode={createSituationNode}
        roots={roots}
        childMap={childMap}
        standalones={standalones}
        sortedFlatNodes={sortedFlatNodes}
        collapsedGroups={collapsedGroups}
        toggleGroup={toggleGroup}
        selectedNodeId={selectedNodeId}
        setSelectedNodeId={setSelectedNodeId}
      />
      {!isFullWidthPanel(toolbarPanel, promptInspectorActive) && (
        <div className="resize-handle" onMouseDown={onMouseDown} />
      )}
      {/* Pane 2: Detail (search preview, lineage preview, or normal detail) */}
      <SituationsDetailPane
        toolbarPanel={toolbarPanel}
        promptInspectorActive={promptInspectorActive}
        searchPreviewId={searchPreviewId}
        setSearchPreviewId={setSearchPreviewId}
        showEdgeDetail={showEdgeDetail}
        selectedPromptEntry={selectedPromptEntry}
        selectedFallacyKey={selectedFallacyKey}
        handleFallacyNodeSelect={handleFallacyNodeSelect}
        renderLineagePreview={renderLineagePreview}
        lineageLinkUrl={lineageLinkUrl}
        setLineageLinkUrl={setLineageLinkUrl}
        normalDetail={
          <SituationsNormalDetail
            detailCollapsed={detailCollapsed}
            setDetailCollapsed={setDetailCollapsed}
            isPhone={isPhone}
            selectedNodeId={selectedNodeId}
            setSelectedNodeId={setSelectedNodeId}
            selectedNode={selectedNode}
            supersededPovNode={supersededPovNode}
            handlePin={handlePin}
            handleRelated={handleRelated}
            handleDebate={handleDebate}
            pinnedStack={pinnedStack}
            hasToolbarPane={hasToolbarPane}
          />
        }
      />
    </div>
  );
}

/** @deprecated Use SituationsTab instead */
export const CrossCuttingTab = SituationsTab;
