// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { POV_META } from '@lib/electron-shared/povMeta';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { Pov, PovNode, Category, TabId } from '../../types/taxonomy';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import type { AggregatedCrux } from '../../hooks/useTaxonomyStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useAuthStatus } from '../../hooks/useAuthStatus';
import { countDanglingReferences, formatDanglingWarning } from '../../utils/danglingReferences';
import { useLongPressContextMenu } from '../../hooks/useLongPressContextMenu';
import { DeleteConfirmDialog } from '../shared/DeleteConfirmDialog';
import { DescriptionSection, type DescriptionMention } from './NodeDescriptionSection';
import { TypeaheadSelect } from '../shared/TypeaheadSelect';
import { FieldHelp } from '../shared/FieldHelp';
import { TheoryLink } from '../shared/TheoryLink';
import { LinkedChip } from '../shared/LinkedChip';
import { GraphAttributesPanel } from './GraphAttributesPanel';
import { RelatedEdgesPanel } from '../edge-browser/RelatedEdgesPanel';
import { EdgeDetailPanel } from '../edge-browser/EdgeDetailPanel';
import { getLineageInfo } from '../../data/lineageLookup';
import { researchPrompt } from '../../prompts/research';
import { SourcesPanel } from '../policy/SourcesPanel';
import { PhrasesPanel } from '../policy/PhrasesPanel';
import { FactsPanel, getFactCount, preloadFactsIndex } from '../analysis/FactsPanel';
import type { SourceFact } from '../analysis/FactsPanel';
import type { SourceDocumentResolution } from '../../bridge/types';
import { ConflictsPanel, conflictsForNode } from '../conflict';
import { NodeEditHistory } from './NodeEditHistory';
import { PovTagEditor } from './PovTagEditor';
import { useCanEditPovTags } from '../../hooks/useCanEditPovTags';
import { useIsAdmin } from '../../hooks/useIsAdmin';
import { PovMoveTagNotice } from './PovMoveTagNotice';
import { nodeTypeFromId, nodePovFromId } from '@lib/debate/nodeIdUtils';
import { POV_KEYS } from '@lib/debate/types';
import { api } from '@bridge';
import { useContainerMentionKit } from '../shared/MentionField';
import { reconstructNodeContainer } from '../shared/mentionText';
import { EditConflictBadge, type NodeConflict } from '../conflict/edit-conflicts';
import { useDescriptionMode, resolveDescription } from '../shared/DescriptionToggle';
import { usePreferencesStore } from '../../store/preferencesStore';
import { EmptyState } from '../shared/EmptyState';
import { OverflowMenu, type OverflowMenuEntry } from '../shared/OverflowMenu';
import { InlineEditTitle } from '../shared/InlineEditTitle';
import { DebateTestedChip } from './DebateTestedChip';
import { DebateTestedDrilldown } from './DebateTestedDrilldown';
import { CollapsibleSection } from './CollapsibleSection';
import './NodeDetail.css';

interface MoveTarget {
  label: string;
  action: () => void;
  isTransfer?: boolean;
}

function buildOverflowEntries(moveTargets: MoveTarget[], onDelete: () => void, onAIAnalysis: () => void, onPin?: () => void): OverflowMenuEntry[] {
  const entries: OverflowMenuEntry[] = [
    { type: 'item', key: 'ai', label: 'AI Analysis', onClick: onAIAnalysis },
  ];
  if (onPin) entries.push({ type: 'item', key: 'pin', label: 'Pin for Comparison', onClick: onPin });

  const categoryMoves = moveTargets.filter(t => !t.isTransfer);
  const transfers = moveTargets.filter(t => t.isTransfer);

  entries.push({ type: 'divider' });
  for (const t of categoryMoves) {
    entries.push({ type: 'item', key: `move-${t.label}`, label: `Move to ${t.label}`, onClick: t.action });
  }
  if (transfers.length > 0) {
    entries.push({ type: 'divider' });
    entries.push({ type: 'label', text: 'Transfer to' });
    for (const t of transfers) {
      entries.push({ type: 'item', key: `xfer-${t.label}`, label: t.label, onClick: t.action, className: 'overflow-menu-transfer' });
    }
  }
  entries.push({ type: 'divider' });
  entries.push({ type: 'item', key: 'delete', label: 'Delete', onClick: onDelete, danger: true });
  return entries;
}

interface NodeDetailProps {
  pov: Pov;
  node: PovNode;
  readOnly?: boolean;
  onPin?: () => void;
  onSimilarSearch?: () => void;
  onRelated?: () => void;
  /** Opens the camp Soul Document dialog (t/2827) — rendered in the header icon row, Advanced-view only.
   *  Gets the node's pov_tags, so the dialog opens on that tag's soul (t/4200). */
  onOpenSoulDoc?: (nodeTags?: readonly string[]) => void;
  chipDepth?: number;
  conflict?: NodeConflict;
  resolveUrl?: string | null;
}

const ALL_CATEGORIES: Category[] = ['Desires', 'Beliefs', 'Intentions'];
const ALL_POVS: Pov[] = [...POV_KEYS];

/** BDI layer guidance for each category */
const BDI_GUIDANCE: Record<Category, string> = {
  'Beliefs': 'Beliefs — empirical claims that could be verified or falsified with evidence.',
  'Desires': 'Desires — normative commitments about what should happen or what matters.',
  'Intentions': 'Intentions — reasoning strategies and argumentative approaches for how to think about something.',
};

/** Singular form with article for genus-differentia descriptions */
const POV_LABELS: Record<Pov, string> = {
  accelerationist: POV_META.accelerationist.label,
  safetyist: POV_META.safetyist.label,
  skeptic: POV_META.skeptic.label,
};

type NodeDetailTabId = 'content' | 'related' | 'attributes' | 'conflicts' | 'phrases' | 'sources' | 'facts' | 'cruxes' | 'research' | 'history';

/** Edit-history entry count for the History tab badge (extracted so the optional-chain access doesn't add to NodeDetail's own complexity count). */
function getEditHistoryLength(node: PovNode): number | undefined {
  return node._edit_history?.length;
}

// ── Simple-view last-edited line (t/3022, TL Option-3 ruling) ─────────────────
// Surfaces the who/when accountability datum in Simple view, where the full
// History tab is Advanced-only (t/3021 locks that gating). Prefers the canonical
// _edit_meta last-edited fields, falling back to the most-recent _edit_history
// entry. Formatting mirrors NodeEditHistory but is kept local here to avoid a new
// cross-module export (trivial-change scope).
function NodeLastEditedLine({ node, nodeDetailMode }: { node: PovNode; nodeDetailMode: 'simple' | 'advanced' }) {
  if (nodeDetailMode !== 'simple') return null; // Advanced view has the full History tab.
  const latest = node._edit_history?.[node._edit_history.length - 1];
  const user = node._edit_meta?.last_edited_by ?? latest?.user;
  const when = node._edit_meta?.last_edited_at ?? latest?.timestamp;
  if (!user || !when) return null;
  const name = user === '_local' ? 'Local (Electron)' : user.includes('@') ? user.slice(0, user.indexOf('@')) : user;
  const parsed = new Date(when);
  const date = Number.isNaN(parsed.getTime()) ? when : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <div className="nd-last-edited">
      Last edited by <span className="nd-last-edited-user">{name}</span>
      <span className="nd-last-edited-time"> · {date}</span>
    </div>
  );
}

export function NodeDetail({ pov, node, readOnly, onPin, onSimilarSearch, onRelated, onOpenSoulDoc, chipDepth = 0, conflict, resolveUrl }: NodeDetailProps) {
  const { updatePovNode, deletePovNode, movePovNodeCategory, movePovNode, validationErrors, getAllNodeIds, getAllConflictIds, runAttributeFilter, showAttributeInfo, navigateToLineage, setToolbarPanel, selectedEdge, relatedNodeId, loadEdges, edgesFile, setSelectedNodeId, getLabelForId, aggregatedCruxes, showCruxDetail, conflicts, accelerationist, safetyist, skeptic, situations } = useTaxonomyStore();
  const authInfo = useAuthStatus();
  const isAdmin = useIsAdmin();
  const getNodeDetailMode = usePreferencesStore(state => state.getNodeDetailMode);
  const setNodeDetailMode = usePreferencesStore(state => state.setNodeDetailMode);
  const nodeDetailMode = getNodeDetailMode(node.id);
  const [descMode, setDescMode] = useDescriptionMode();
  const [showDelete, setShowDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<NodeDetailTabId>('content');
  const [expandedLineage, setExpandedLineage] = useState<string | null>(null);
  // t/4532: both collapsed by default, and reset to collapsed whenever a different node opens
  // (effect below, alongside the existing per-node setSelectedFact(null) reset).
  const [steelmanExpanded, setSteelmanExpanded] = useState(false);
  const [lineageExpanded, setLineageExpanded] = useState(false);

  // Reset to Analysis when switching to Simple (which hides most tabs, but Analysis is always visible).
  // t/4574: Simple mode can only access Analysis and Related tabs; all others are Advanced-only.
  // If switching to Simple while on an Advanced-only tab, drop to Analysis.
  // If switching back to Advanced, stay on the current tab.
  useEffect(() => {
    if (nodeDetailMode === 'simple' && activeTab !== 'content' && activeTab !== 'related') {
      setActiveTab('content');
    }
  }, [nodeDetailMode, activeTab]);
  const [showDtDrilldown, setShowDtDrilldown] = useState(false);
  const [relatedSplitPct, setRelatedSplitPct] = useState(40);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  // Stored entity-name mentions for this node's reading-flow text (t/1898 §4.2). Fetched
  // only in the read-only (reading) context — the editable editor uses inputs, not link
  // spans. `reconstructNodeContainer` rebuilds the FULL container so every field's offset
  // basis is correct. `label` + `plain_description` linkify via `renderMentionField`; the
  // `description` field (rendered through `HighlightedTextarea`) interleaves its mention
  // segments with search/bold ranges via `descriptionMention` (t/1908).
  const mentionContainer = useMemo(
    () => reconstructNodeContainer(node),
    [node.label, node.description, node.plain_description],
  );
  const mentionKit = useContainerMentionKit(readOnly ? `node:${node.id}` : null, mentionContainer);
  const renderMentionField = mentionKit.renderField;
  const labelContent: ReactNode = readOnly ? renderMentionField('label', node.label) : node.label;
  // Only engage the segment path when there is a real link to render, so the common
  // no-mention read-only description keeps its exact existing formatting.
  const descSegments = readOnly ? mentionKit.segmentsFor('description') : [];
  const descriptionMention: DescriptionMention | undefined = descSegments.some(s => s.ref)
    ? { segments: descSegments, onSelectRef: mentionKit.onSelectRef }
    : undefined;
  // t/2811: plain-description read-only view also needs search highlight; build its mention
  // segments so it can render through the same HighlightedTextarea readOnly path.
  const plainSegments = readOnly ? mentionKit.segmentsFor('plain_description') : [];
  const plainDescriptionMention: DescriptionMention | undefined = plainSegments.length > 0
    ? { segments: plainSegments, onSelectRef: mentionKit.onSelectRef }
    : undefined;

  // Eagerly load facts index so count badge is available
  const [factCount, setFactCount] = useState(() => getFactCount(node.id));
  useEffect(() => {
    preloadFactsIndex();
    const t = setTimeout(() => setFactCount(getFactCount(node.id)), 500);
    return () => clearTimeout(t);
  }, [node.id]);

  const cruxCount = useMemo(
    () => aggregatedCruxes?.filter(c => c.linked_node_ids.includes(node.id)).length ?? 0,
    [aggregatedCruxes, node.id],
  );

  const conflictCount = useMemo(
    () => conflictsForNode(conflicts, node.id).length,
    [conflicts, node.id],
  );

  // Source document viewer state (Facts tab)
  const [selectedFact, setSelectedFact] = useState<SourceFact | null>(null);
  const [sourceDoc, setSourceDoc] = useState<SourceDocumentResolution | null>(null);
  const [sourceDocLoading, setSourceDocLoading] = useState(false);
  const [factSplitPct, setFactSplitPct] = useState(40);
  const factSplitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedFact) { setSourceDoc(null); return; }
    let cancelled = false;
    setSourceDocLoading(true);
    api.resolveSourceDocument(selectedFact.doc_id)
      .then(res => { if (!cancelled) setSourceDoc(res); })
      .catch(err => {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'node-detail', level: 'error',
          message: 'Failed to resolve source document',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        if (!cancelled) setSourceDoc({ available: false, type: null });
      })
      .finally(() => { if (!cancelled) setSourceDocLoading(false); });
    return () => { cancelled = true; };
  }, [selectedFact]);

  // Clear fact selection on node change
  useEffect(() => { setSelectedFact(null); }, [node.id]);
  useEffect(() => { setSteelmanExpanded(false); setLineageExpanded(false); }, [node.id]); // t/4532

  const handleFactSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = factSplitRef.current;
    if (!container) return;
    const startY = e.clientY;
    const startPct = factSplitPct;
    const containerHeight = container.offsetHeight;
    const onMouseMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      setFactSplitPct(Math.min(70, Math.max(20, startPct + (dy / containerHeight) * 100)));
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [factSplitPct]);

  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const startX = e.clientX;
    const startPct = relatedSplitPct;
    const containerWidth = container.offsetWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const newPct = Math.min(70, Math.max(20, startPct + (dx / containerWidth) * 100));
      setRelatedSplitPct(newPct);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [relatedSplitPct]);

  // Research prompt state
  const [researchText, setResearchText] = useState('');
  const [researchCopied, setResearchCopied] = useState(false);
  const researchTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Aphorism editing state (manual authoring only; AI generation removed t/3004)
  const [aphorismEditing, setAphorismEditing] = useState(false);
  const [aphorismDraft, setAphorismDraft] = useState('');

  useEffect(() => {
    setAphorismEditing(false);
  }, [node.id]);

  // Generate research prompt when tab is selected or node changes
  useEffect(() => {
    if (activeTab === 'research') {
      setResearchText(researchPrompt(node.label, node.description));
      setResearchCopied(false);
    }
  }, [activeTab, node.id, node.label, node.description]);

  const handleResearchCopy = async () => {
    try {
      await api.clipboardWriteText(researchText);
      setResearchCopied(true);
      setTimeout(() => setResearchCopied(false), 2000);
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'node-detail', level: 'warn', message: 'clipboard write failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
  };

  // When switching to Related tab, set relatedNodeId and load edges without switching toolbar
  useEffect(() => {
    if (activeTab === 'related') {
      if (relatedNodeId !== node.id) {
        useTaxonomyStore.setState({ relatedNodeId: node.id, selectedEdge: null });
      }
      if (!edgesFile) {
        void loadEdges();
      }
    }
  }, [activeTab, node.id, relatedNodeId, edgesFile, loadEdges]);

  // Same-POV category moves
  const categoryMoveTargets: MoveTarget[] = ALL_CATEGORIES
    .filter(c => c !== node.category)
    .map(c => ({ label: c, action: () => movePovNodeCategory(pov, node.id, c) }));

  // Cross-POV transfers (every other POV × every category)
  const transferTargets: MoveTarget[] = ALL_POVS
    .filter(p => p !== pov)
    .flatMap(p => ALL_CATEGORIES.map(c => ({
      label: `${POV_LABELS[p]} / ${c}`,
      action: () => movePovNode(pov, node.id, p, c),
      isTransfer: true,
    })));

  const moveTargets = [...categoryMoveTargets, ...transferTargets];

  const allCcIds = getAllNodeIds().filter(id => nodeTypeFromId(id) === 'situation');
  const allConflictIds = getAllConflictIds();

  const err = (field: string) => validationErrors[`nodes.${node.id}.${field}`];
  const hasErrors = Object.keys(validationErrors).some(k => k.startsWith(`nodes.${node.id}.`));

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

  const update = (updates: Partial<PovNode>) => {
    if (readOnly) return;
    updatePovNode(pov, node.id, updates);
  };

  const addRef = (id: string) => {
    if (id && !node.situation_refs.includes(id)) {
      update({ situation_refs: [...node.situation_refs, id] });
    }
  };

  const removeRef = (ref: string) => {
    update({ situation_refs: node.situation_refs.filter(r => r !== ref) });
  };

  const addConflict = (id: string) => {
    if (id && !(node.conflict_ids || []).includes(id)) {
      update({ conflict_ids: [...(node.conflict_ids || []), id] });
    }
  };

  const removeConflict = (id: string) => {
    update({ conflict_ids: (node.conflict_ids || []).filter(c => c !== id) });
  };

  const hasGraphAttrs = !!node.graph_attributes;

  return (
    <div ref={formRef} className="node-detail-tabbed">
      <PovMoveTagNotice nodeId={node.id} />
      <div className="nd-header">
        <NodeDetailHeaderTop
          pov={pov}
          node={node}
          readOnly={readOnly}
          err={err}
          update={update}
          onPin={nodeDetailMode === 'advanced' ? onPin : undefined}
          moveTargets={moveTargets}
          setShowDelete={setShowDelete}
          labelContent={labelContent}
        />
        <div className="nd-header-meta">
          <span className="nd-header-cat" data-cat={node.category}>
            {node.category.toUpperCase()}
            <FieldHelp text={BDI_GUIDANCE[node.category]} />
          </span>
          <span className="nd-header-id">{node.id}</span>
          {/* Advanced-view header icons (t/4574): ontology, soul analysis, soul doc */}
          {nodeDetailMode === 'advanced' && (
            <>
              <TheoryLink
                docPath="docs/taxonomy-ontology-guide.md"
                label="Help: taxonomy ontology guide"
                size={16}
              />
              <TheoryLink
                docPath="research/comp-linguist/docs/soul-documents-analysis.md"
                label="Soul documents analysis"
                tooltip="Open Soul Documents Analysis in GitHub"
                size={15}
              />
              {onOpenSoulDoc && (
                <button className="nd-header-btn" onClick={() => onOpenSoulDoc(node.pov_tags)} title="Soul document" aria-label="Soul document">&#x1f4dc;</button>
              )}
            </>
          )}
          <EditConflictBadge conflict={conflict} resolveUrl={resolveUrl} />
          {/* Simple/Advanced toggle (t/4574) — top right */}
          <div className="nd-header-controls">
            <div className="nd-header-toggle">
              <button
                className={`nd-toggle-btn ${nodeDetailMode === 'simple' ? 'active' : ''}`}
                onClick={() => void setNodeDetailMode(node.id, 'simple')}
                aria-pressed={nodeDetailMode === 'simple'}
              >
                Simple
              </button>
              <button
                className={`nd-toggle-btn ${nodeDetailMode === 'advanced' ? 'active' : ''}`}
                onClick={() => void setNodeDetailMode(node.id, 'advanced')}
                aria-pressed={nodeDetailMode === 'advanced'}
              >
                Advanced
              </button>
            </div>
            {/* Admin-gated overflow menu (t/4574) */}
            {isAdmin && (
              <OverflowMenu
                entries={[
                  { type: 'item', key: 'search', label: 'Search Taxonomy', onClick: onSimilarSearch ?? (() => {}) },
                  { type: 'item', key: 'bdi', label: 'BDI Grounding', onClick: onOpenSoulDoc ? () => onOpenSoulDoc(node.pov_tags) : () => {} },
                  { type: 'item', key: 'copy', label: 'Copy Link', onClick: () => navigator.clipboard.writeText(node.id) },
                  { type: 'item', key: 'similar', label: 'Find Similar', onClick: onSimilarSearch ?? (() => {}) },
                ]}
              />
            )}
          </div>
        </div>

        <NodeDetailAphorismSection
          node={node}
          readOnly={readOnly}
          update={update}
          aphorismEditing={aphorismEditing}
          setAphorismEditing={setAphorismEditing}
          aphorismDraft={aphorismDraft}
          setAphorismDraft={setAphorismDraft}
        />
        <NodeLastEditedLine node={node} nodeDetailMode={nodeDetailMode} />
      </div>

      {hasErrors && (
        <div className="validation-banner">
          <span className="validation-banner-icon">!</span>
          Please fix the highlighted fields before saving.
        </div>
      )}

      {/* Description above tabs (t/4574) — shows in both Simple and Advanced views */}
      <DescriptionSection
        pov={pov}
        node={node}
        readOnly={readOnly}
        err={err}
        descMode={descMode}
        setDescMode={setDescMode}
        update={update}
        updatePovNode={updatePovNode}
        descriptionMention={descriptionMention}
        plainDescriptionMention={plainDescriptionMention}
      />

      <NodeDetailTabBar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        conflictCount={conflictCount}
        cruxCount={cruxCount}
        factCount={factCount}
        editHistoryLength={getEditHistoryLength(node)}
        viewMode={nodeDetailMode}
      />

      {/* Tab content */}
      <div className="node-detail-tab-content">
        {activeTab === 'content' && (
          <NodeDetailContentTab
            pov={pov}
            node={node}
            readOnly={readOnly}
            err={err}
            descMode={descMode}
            setDescMode={setDescMode}
            update={update}
            updatePovNode={updatePovNode}
            showDtDrilldown={showDtDrilldown}
            setShowDtDrilldown={setShowDtDrilldown}
            expandedLineage={expandedLineage}
            setExpandedLineage={setExpandedLineage}
            showAttributeInfo={showAttributeInfo}
            hasGraphAttrs={hasGraphAttrs}
            descriptionMention={descriptionMention}
            plainDescriptionMention={plainDescriptionMention}
            steelmanExpanded={steelmanExpanded}
            setSteelmanExpanded={setSteelmanExpanded}
            lineageExpanded={lineageExpanded}
            setLineageExpanded={setLineageExpanded}
          />
        )}

        {activeTab === 'related' && (
          <NodeDetailRelatedTab
            selectedEdge={selectedEdge}
            relatedSplitPct={relatedSplitPct}
            handleSplitMouseDown={handleSplitMouseDown}
            splitContainerRef={splitContainerRef}
          />
        )}

        {activeTab === 'conflicts' && (
          <ConflictsPanel nodeId={node.id} />
        )}

        {activeTab === 'cruxes' && (
          <RelatedCruxes nodeId={node.id} mode="full" />
        )}

        {activeTab === 'attributes' && (
          <NodeDetailAttributesTab
            node={node}
            readOnly={readOnly}
            pov={pov}
            updatePovNode={updatePovNode}
            update={update}
            runAttributeFilter={runAttributeFilter}
            showAttributeInfo={showAttributeInfo}
          />
        )}

        {activeTab === 'phrases' && (
          <PhrasesPanel nodeId={node.id} />
        )}

        {activeTab === 'sources' && (
          <SourcesPanel nodeId={node.id} />
        )}

        {activeTab === 'facts' && (
          <NodeDetailFactsTab
            node={node}
            selectedFact={selectedFact}
            setSelectedFact={setSelectedFact}
            sourceDoc={sourceDoc}
            sourceDocLoading={sourceDocLoading}
            factSplitPct={factSplitPct}
            handleFactSplitMouseDown={handleFactSplitMouseDown}
            factSplitRef={factSplitRef}
          />
        )}

        {activeTab === 'research' && (
          <NodeDetailResearchTab
            node={node}
            researchText={researchText}
            setResearchText={setResearchText}
            researchCopied={researchCopied}
            handleResearchCopy={handleResearchCopy}
            researchTextareaRef={researchTextareaRef}
          />
        )}

        {activeTab === 'history' && (
          <NodeEditHistory
            editMeta={node._edit_meta}
            editHistory={node._edit_history}
            descriptionHistory={node.description_history}
            labelHistory={node.label_history}
          />
        )}
      </div>

      {showDelete && !readOnly && (() => {
        // t/3852: exhaustive, not sampled — computed fresh at dialog-open time so a stale
        // closure can't under-report after the user has been editing edges/situations.
        const danglingCounts = countDanglingReferences(node.id, [accelerationist, safetyist, skeptic], situations, edgesFile);
        return (
        <DeleteConfirmDialog
          itemLabel={node.label}
          danglingWarning={formatDanglingWarning(danglingCounts)}
          onConfirm={() => {
            deletePovNode(pov, node.id);
            void api.logNodeDeletion({
              nodeId: node.id,
              pov,
              label: node.label,
              user: authInfo?.user || '_anonymous', // AuthInfo is web-only; Electron falls back to '_anonymous' here (t/3859's writer can supplement with the OS username)
              danglingEdges: danglingCounts.edges,
              danglingSituationRefs: danglingCounts.situationRefs,
              danglingChildren: danglingCounts.children,
            });
            setShowDelete(false);
          }}
          onCancel={() => setShowDelete(false)}
        />
        );
      })()}
    </div>
  );
}

// ── Node header: title + actions (extracted from NodeDetail for complexity) ──

interface NodeDetailHeaderTopProps {
  pov: Pov;
  node: PovNode;
  readOnly?: boolean;
  err: (field: string) => string | undefined;
  update: (updates: Partial<PovNode>) => void;
  onPin?: () => void;
  moveTargets: MoveTarget[];
  setShowDelete: (v: boolean) => void;
  /** Read-only label content (may carry linkified entity mentions, t/1898); falls back to node.label. */
  labelContent?: ReactNode;
}

function NodeDetailHeaderTop({ pov, node, readOnly, err, update, onPin, moveTargets, setShowDelete, labelContent }: NodeDetailHeaderTopProps) {
  // t/4559 (PI direction): the "..." menu (and the read-only Pin fallback) is admin-only —
  // desktop counts as admin, web requires profile.isAdmin, hidden while loading/on error.
  const isAdmin = useIsAdmin();
  return (
    <div className="nd-header-top">
      <div className="nd-header-title">
        {readOnly ? (
          <span className="nd-header-label" title={node.label}>{labelContent ?? node.label}</span>
        ) : (
          <InlineEditTitle
            value={node.label}
            onChange={(v) => update({ label: v })}
            hasError={!!err('label')}
            placeholder="Label"
            ariaLabel="Label"
          />
        )}
      </div>
      <div className="nd-header-actions">
        {/* t/4559 (PI direction): the search, BDI grounding, copy-link and find-similar icons
            that used to live here are removed. The BDI Grounding panel (t/3470) had no other
            mount point and is now unreachable from the UI — flagged to the PI, no replacement
            entry point added per the ticket. Search is still reachable via the toolbar/bottom
            nav; copy-link and find-similar have no other entry point either. */}
        {isAdmin && !readOnly && (
          <OverflowMenu entries={buildOverflowEntries(
            moveTargets,
            () => setShowDelete(true),
            () => void useTaxonomyStore.getState().runNodeCritique(pov, node),
            onPin,
          )} />
        )}
        {isAdmin && readOnly && onPin && (
          <button className="nd-header-btn" onClick={onPin} title="Pin for comparison">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Aphorism display / editing / regeneration proposal (extracted from NodeDetail for complexity) ──

interface NodeDetailAphorismSectionProps {
  node: PovNode;
  readOnly?: boolean;
  update: (updates: Partial<PovNode>) => void;
  aphorismEditing: boolean;
  setAphorismEditing: (v: boolean) => void;
  aphorismDraft: string;
  setAphorismDraft: (v: string) => void;
}

function NodeDetailAphorismSection({ node, readOnly, update, aphorismEditing, setAphorismEditing, aphorismDraft, setAphorismDraft }: NodeDetailAphorismSectionProps) {
  return (
    <>
      {/* Aphorism display */}
      {aphorismEditing && !readOnly ? (
        <>
          <input
            className="nd-aphorism-input"
            value={aphorismDraft}
            onChange={(e) => setAphorismDraft(e.target.value)}
            placeholder="Enter aphorism…"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                update({ graph_attributes: { ...node.graph_attributes!, aphorism: aphorismDraft || undefined } });
                setAphorismEditing(false);
              } else if (e.key === 'Escape') {
                setAphorismEditing(false);
              }
            }}
          />
          <div className="nd-aphorism-actions">
            <button onClick={() => {
              update({ graph_attributes: { ...node.graph_attributes!, aphorism: aphorismDraft || undefined } });
              setAphorismEditing(false);
            }}>Save</button>
            <button onClick={() => setAphorismEditing(false)}>Cancel</button>
          </div>
        </>
      ) : node.graph_attributes?.aphorism ? (
        <div className="nd-aphorism">
          <span className="nd-aphorism-text">&ldquo;{node.graph_attributes.aphorism}&rdquo;</span>
          {!readOnly && (
            <button
              className="nd-aphorism-edit-btn"
              onClick={() => { setAphorismDraft(node.graph_attributes?.aphorism ?? ''); setAphorismEditing(true); }}
              title="Edit aphorism"
            >&#9998;</button>
          )}
        </div>
      ) : null}
    </>
  );
}

// ── Tab bar (extracted from NodeDetail for complexity) ──

interface NodeDetailTabBarProps {
  activeTab: NodeDetailTabId;
  setActiveTab: (tab: NodeDetailTabId) => void;
  conflictCount: number;
  cruxCount: number;
  factCount: number;
  editHistoryLength: number | undefined;
  viewMode: 'simple' | 'advanced';
}

function NodeDetailTabBar({ activeTab, setActiveTab, conflictCount, cruxCount, factCount, editHistoryLength, viewMode }: NodeDetailTabBarProps) {
  // Content + Related always show; the rest, including Attributes, are Advanced-only
  // (t/2120, t/3003 originally kept Attributes always-on; reversed at the PI's direction, t/4559).
  const tabs: { id: NodeDetailTabId; label: string; advanced?: boolean }[] = [
    { id: 'content', label: 'Analysis' },
    { id: 'related', label: 'Related' },
    { id: 'attributes', label: 'Attributes', advanced: true },
    { id: 'conflicts', label: `Conflicts${conflictCount > 0 ? ` (${conflictCount})` : ''}`, advanced: true },
    { id: 'cruxes', label: `Cruxes${cruxCount > 0 ? ` (${cruxCount})` : ''}`, advanced: true },
    { id: 'phrases', label: 'Phrases', advanced: true },
    { id: 'sources', label: 'Sources', advanced: true },
    { id: 'facts', label: `Facts${factCount > 0 ? ` (${factCount})` : ''}`, advanced: true },
    { id: 'research', label: 'Research', advanced: true },
    { id: 'history', label: `History${editHistoryLength ? ` (${editHistoryLength})` : ''}`, advanced: true },
  ];
  return (
    <div className="node-detail-tabs">
      {tabs
        .filter(tab => !tab.advanced || viewMode === 'advanced')
        .map(tab => (
          <button
            key={tab.id}
            className={`node-detail-tab ${activeTab === tab.id ? 'node-detail-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
    </div>
  );
}

// ── Content tab: node metrics row (extracted from NodeDetail for complexity) ──
// t/3393: Debate Tested must show on every BDI category, not only Beliefs — the underlying
// debate_tested record is populated on Desires/Intentions nodes too (confirmed against live
// data), so this row itself is no longer Beliefs-exclusive. Confidence stays Beliefs-gated: it's
// a genuinely Beliefs-specific metric (empirical-claim confidence) that's only sparsely populated
// elsewhere (legacy/cross-cutting data), and the ticket didn't ask to change its visibility.

interface NodeMetricsRowProps {
  node: PovNode;
  showDtDrilldown: boolean;
  setShowDtDrilldown: React.Dispatch<React.SetStateAction<boolean>>;
}

function NodeMetricsRow({ node, showDtDrilldown, setShowDtDrilldown }: NodeMetricsRowProps) {
  return (
    <>
      <div className="nd-metrics-row">
        {node.category === 'Beliefs' && node.confidence != null && (
          <span className="nd-metric" title="Confidence score">
            Confidence: <strong>{node.confidence.toFixed(2)}</strong>
          </span>
        )}
        <DebateTestedChip
          record={node.graph_attributes?.debate_tested}
          description={node.description}
          onClick={() => node.graph_attributes?.debate_tested && setShowDtDrilldown(v => !v)}
        />
      </div>
      {showDtDrilldown && node.graph_attributes?.debate_tested && (
        <DebateTestedDrilldown
          record={node.graph_attributes.debate_tested}
          description={node.description}
          onClose={() => setShowDtDrilldown(false)}
        />
      )}
    </>
  );
}

// DescriptionSection extracted to ./NodeDescriptionSection (ADR-007 file-size ceiling; t/2811/t/2812).

// ── Content tab: Steelman Vulnerability section (extracted from NodeDetail for complexity) ──

interface SteelmanVulnerabilitySectionProps {
  node: PovNode;
  readOnly?: boolean;
  update: (updates: Partial<PovNode>) => void;
  expanded: boolean;
  onToggle: () => void;
}

function SteelmanVulnerabilitySection({ node, readOnly, update, expanded, onToggle }: SteelmanVulnerabilitySectionProps) {
  return (
    <CollapsibleSection title="Steelman Vulnerability" sectionId="steelman-vulnerability" expanded={expanded} onToggle={onToggle}>
      {typeof node.graph_attributes!.steelman_vulnerability === 'string' ? (
        readOnly ? (
          <div className="ga-promoted-text">{node.graph_attributes!.steelman_vulnerability}</div>
        ) : (
          <textarea
            className="nd-vulnerability-input"
            value={node.graph_attributes!.steelman_vulnerability}
            rows={3}
            onChange={(e) => {
              update({ graph_attributes: { ...node.graph_attributes!, steelman_vulnerability: e.target.value } });
            }}
          />
        )
      ) : typeof node.graph_attributes!.steelman_vulnerability === 'object' && node.graph_attributes!.steelman_vulnerability ? (
        <div className="ga-promoted-text">
          {(['from_accelerationist', 'from_safetyist', 'from_skeptic'] as const).map(key => {
            const vuln = node.graph_attributes!.steelman_vulnerability as Record<string, string | undefined>;
            const povKey = key.replace('from_', '') as 'accelerationist' | 'safetyist' | 'skeptic';
            const meta = POV_META[povKey];
            // Hide a POV with no vulnerability text in BOTH modes — an empty POV rendered a
            // blank textarea in edit mode (noise). These are AI-populated (POV-node regen), not
            // manually seeded, so hiding an empty one loses nothing; regen repopulates it.
            if (!vuln[key]) return null;
            return (
              <div key={key} className="vulnerability-subsection">
                {/* eslint-disable-next-line local/no-inline-style -- color is per-POV, computed from meta.cssVar */}
                <strong style={{ color: `var(${meta.cssVar})` }}>{meta.label}:</strong>
                {readOnly ? (
                  <span> {vuln[key]}</span>
                ) : (
                  <textarea
                    className="nd-vulnerability-input"
                    value={vuln[key] ?? ''}
                    rows={2}
                    onChange={(e) => {
                      update({ graph_attributes: { ...node.graph_attributes!, steelman_vulnerability: { ...vuln, [key]: e.target.value } } });
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : !readOnly ? (
        <button
          className="btn btn-sm nd-add-btn"
          onClick={() => {
            update({ graph_attributes: { ...node.graph_attributes!, steelman_vulnerability: '' } });
          }}
        >+ Add Vulnerability</button>
      ) : (
        <div className="ga-empty">&mdash;</div>
      )}
    </CollapsibleSection>
  );
}

// ── Content tab: Intellectual Lineage section (extracted from NodeDetail for complexity) ──

interface IntellectualLineageSectionProps {
  node: PovNode;
  expandedLineage: string | null;
  setExpandedLineage: (v: string | null) => void;
  showAttributeInfo: (field: string, value: string) => void;
  expanded: boolean;
  onToggle: () => void;
}

// t/3382: touch devices never fire `contextmenu` on a long-press — extracted so
// useLongPressContextMenu can be called once per chip instance (can't call a hook inside .map()).
function LineageChip({ label, selected, onSelect, onShowInfo }: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  onShowInfo: () => void;
}) {
  const longPress = useLongPressContextMenu(useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    onShowInfo();
  }, [onShowInfo]));
  return (
    <span
      className={`ga-promoted-chip ga-promoted-chip-interactive${selected ? ' ga-promoted-chip-selected' : ''}`}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onContextMenu={longPress.onContextMenu}
      onTouchStart={longPress.onTouchStart}
      onTouchMove={longPress.onTouchMove}
      onTouchEnd={longPress.onTouchEnd}
      onTouchCancel={longPress.onTouchCancel}
      title={`Click to view lineage info: "${label}"`}
    >
      {label}
    </span>
  );
}

function IntellectualLineageSection({ node, expandedLineage, setExpandedLineage, showAttributeInfo, expanded, onToggle }: IntellectualLineageSectionProps) {
  return (
    <CollapsibleSection title="Intellectual Lineage" sectionId="intellectual-lineage" expanded={expanded} onToggle={onToggle}>
      <div className="ga-promoted-list">
        {[...node.graph_attributes!.intellectual_lineage!].map(v => typeof v === 'string' ? v : (v as { name?: string })?.name).filter((v): v is string => typeof v === 'string' && v.length > 0).sort((a, b) => a.localeCompare(b)).map((l, i) => (
          <LineageChip
            key={i}
            label={l}
            selected={expandedLineage === l}
            onSelect={() => setExpandedLineage(expandedLineage === l ? null : l)}
            onShowInfo={() => showAttributeInfo('intellectual_lineage', l)}
          />
        ))}
      </div>
      {expandedLineage && (() => {
        const info = getLineageInfo(expandedLineage);
        if (!info) return (
          <div className="lineage-inline-detail">
            <div className="lineage-inline-header">
              <span className="lineage-inline-label">{expandedLineage}</span>
              <button className="lineage-inline-close" onClick={() => setExpandedLineage(null)} title="Close">×</button>
            </div>
            <div className="lineage-inline-empty">No detailed information available for this lineage.</div>
          </div>
        );
        return (
          <div className="lineage-inline-detail">
            <div className="lineage-inline-header">
              <span className="lineage-inline-label">{info.label}</span>
              <button className="lineage-inline-close" onClick={() => setExpandedLineage(null)} title="Close">×</button>
            </div>
            <div className="lineage-inline-summary">{info.summary}</div>
            {info.example && (
              <div className="lineage-inline-example">
                <span className="lineage-inline-example-label">Example:</span> {info.example}
              </div>
            )}
            {info.links && info.links.length > 0 && (
              <div className="lineage-inline-links">
                {info.links.map((link, li) => (
                  <a
                    key={li}
                    className="lineage-inline-link"
                    href="#"
                    onClick={(e) => { e.preventDefault(); void api.openExternal(link.url); }}
                    title={link.url}
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </CollapsibleSection>
  );
}

// ── Content tab composition (extracted from NodeDetail for complexity) ──

interface NodeDetailContentTabProps {
  pov: Pov;
  node: PovNode;
  readOnly?: boolean;
  err: (field: string) => string | undefined;
  descMode: 'formal' | 'plain';
  setDescMode: (mode: 'formal' | 'plain') => void;
  update: (updates: Partial<PovNode>) => void;
  updatePovNode: (pov: Pov, id: string, updates: Partial<PovNode>) => void;
  showDtDrilldown: boolean;
  setShowDtDrilldown: React.Dispatch<React.SetStateAction<boolean>>;
  expandedLineage: string | null;
  setExpandedLineage: (v: string | null) => void;
  showAttributeInfo: (field: string, value: string) => void;
  hasGraphAttrs: boolean;
  /** Mention segments for the formal `description` HighlightedTextarea (t/1908). */
  descriptionMention?: DescriptionMention;
  /** t/2811: mention segments for the plain_description read-only highlight path. */
  plainDescriptionMention?: DescriptionMention;
  /** t/4532: Steelman Vulnerability / Intellectual Lineage collapse state, lifted to NodeDetail
   *  so it resets to collapsed on every node switch (same lifting pattern as expandedLineage). */
  steelmanExpanded: boolean;
  setSteelmanExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  lineageExpanded: boolean;
  setLineageExpanded: React.Dispatch<React.SetStateAction<boolean>>;
}

function NodeDetailContentTab({ pov, node, readOnly, err, descMode, setDescMode, update, updatePovNode, showDtDrilldown, setShowDtDrilldown, expandedLineage, setExpandedLineage, showAttributeInfo, hasGraphAttrs, descriptionMention, plainDescriptionMention, steelmanExpanded, setSteelmanExpanded, lineageExpanded, setLineageExpanded }: NodeDetailContentTabProps) {
  const canEditPovTags = useCanEditPovTags();
  return (
    <>
      {/* t/3393: Debate Tested must show on every BDI category, not only Beliefs. */}
      <NodeMetricsRow node={node} showDtDrilldown={showDtDrilldown} setShowDtDrilldown={setShowDtDrilldown} />

      {!readOnly && err('label') && (
        <div className="error-text">{err('label')}</div>
      )}

      {/* t/3961: POV tags (registry tags only; hidden when the POV has none and the node carries none). */}
      {/* t/4167: tags are admin-only; the rest of the node stays editable. */}
      <PovTagEditor pov={pov} tags={node.pov_tags} readOnly={!!readOnly || !canEditPovTags} error={err('pov_tags')} onChange={(next) => update({ pov_tags: next })} />

      {/* Description moved above tabs (t/4574) */}

      {hasGraphAttrs && (
        <SteelmanVulnerabilitySection
          node={node}
          readOnly={readOnly}
          update={update}
          expanded={steelmanExpanded}
          onToggle={() => setSteelmanExpanded(v => !v)}
        />
      )}

      {node.graph_attributes?.intellectual_lineage && node.graph_attributes.intellectual_lineage.length > 0 && (
        <IntellectualLineageSection
          node={node}
          expandedLineage={expandedLineage}
          setExpandedLineage={setExpandedLineage}
          showAttributeInfo={showAttributeInfo}
          expanded={lineageExpanded}
          onToggle={() => setLineageExpanded(v => !v)}
        />
      )}
    </>
  );
}

// ── Related tab (extracted from NodeDetail for complexity) ──

interface NodeDetailRelatedTabProps {
  selectedEdge: unknown;
  relatedSplitPct: number;
  handleSplitMouseDown: (e: React.MouseEvent) => void;
  splitContainerRef: React.RefObject<HTMLDivElement | null>;
}

function NodeDetailRelatedTab({ selectedEdge, relatedSplitPct, handleSplitMouseDown, splitContainerRef }: NodeDetailRelatedTabProps) {
  return (
    <div className="node-detail-related-split" ref={splitContainerRef}>
      <div
        className="node-detail-related-list nd-split-width"
        /* eslint-disable-next-line local/no-inline-style -- width is a user-dragged split percentage, passed as a CSS custom property */
        style={{ '--nd-split-width': `${relatedSplitPct}%` } as React.CSSProperties}
      >
        <RelatedEdgesPanel />
      </div>
      <div className="resize-handle" onMouseDown={handleSplitMouseDown} />
      <div
        className="node-detail-related-detail nd-split-width"
        /* eslint-disable-next-line local/no-inline-style -- width is a user-dragged split percentage, passed as a CSS custom property */
        style={{ '--nd-split-width': `${100 - relatedSplitPct}%` } as React.CSSProperties}
      >
        {selectedEdge ? (
          <EdgeDetailPanel width={0} />
        ) : (
          <EmptyState headline="No edge selected" direction="Select an edge to view details" />
        )}
      </div>
    </div>
  );
}

// ── Attributes tab (extracted from NodeDetail for complexity) ──

interface NodeDetailAttributesTabProps {
  node: PovNode;
  readOnly?: boolean;
  pov: Pov;
  updatePovNode: (pov: Pov, id: string, updates: Partial<PovNode>) => void;
  update: (updates: Partial<PovNode>) => void;
  runAttributeFilter: (field: string, value: string) => void;
  showAttributeInfo: (field: string, value: string) => void;
}

function NodeDetailAttributesTab({ node, readOnly, pov, updatePovNode, update, runAttributeFilter, showAttributeInfo }: NodeDetailAttributesTabProps) {
  if (!node.graph_attributes) return null;
  return (
    <GraphAttributesPanel
      attrs={node.graph_attributes}
      onBadgeClick={runAttributeFilter}
      onShowAttributeInfo={showAttributeInfo}
      onUpdatePolicyActions={readOnly ? undefined : (actions) => updatePovNode(pov, node.id, { graph_attributes: { ...node.graph_attributes!, policy_actions: actions } })}
      onUpdateAssumptions={readOnly ? undefined : (assumes) => updatePovNode(pov, node.id, { graph_attributes: { ...node.graph_attributes!, assumes } })}
      readOnly={readOnly}
      defaultOpen
      nodeCategory={node.category}
      confidence={node.confidence}
      priority={node.priority}
      operationality={node.operationality}
      doctrinallyAnchored={node.doctrinally_anchored}
      evidentialConfidence={node.evidential_confidence}
      confidenceHistory={node.confidence_history}
      priorityHistory={node.priority_history}
      operationalityHistory={node.operationality_history}
      onUpdateWeightedBdi={readOnly ? undefined : (updates) => update(updates)}
    />
  );
}

// ── Facts tab (extracted from NodeDetail for complexity) ──

interface NodeDetailFactsTabProps {
  node: PovNode;
  selectedFact: SourceFact | null;
  setSelectedFact: (f: SourceFact | null) => void;
  sourceDoc: SourceDocumentResolution | null;
  sourceDocLoading: boolean;
  factSplitPct: number;
  handleFactSplitMouseDown: (e: React.MouseEvent) => void;
  factSplitRef: React.RefObject<HTMLDivElement | null>;
}

function NodeDetailFactsTab({ node, selectedFact, setSelectedFact, sourceDoc, sourceDocLoading, factSplitPct, handleFactSplitMouseDown, factSplitRef }: NodeDetailFactsTabProps) {
  // Co-mount WRITE side (t/1987 AC#2): supply the global ref setter so FactsPanel's
  // stored-mention ref-links linkify and open the app-level DetailPane host. Without
  // it FactsPanel gates to plain text per the t/1977 co-mount rule. The store setter
  // is global, so this reads it directly rather than threading a prop from the parent.
  const setSelectedRef = useDebateStore((s) => s.setSelectedRef);
  return (
    <div className="facts-split-container" ref={factSplitRef}>
      <div
        className="facts-split-list nd-split-height"
        /* eslint-disable-next-line local/no-inline-style -- height is a user-dragged split percentage, passed as a CSS custom property */
        style={sourceDoc?.available ? { '--nd-split-height': `${factSplitPct}%` } as React.CSSProperties : undefined}
      >
        <FactsPanel nodeId={node.id} onSelectFact={setSelectedFact} onSelectRef={setSelectedRef} />
      </div>
      {sourceDocLoading && (
        <div className="facts-doc-loading">
          <span className="facts-doc-spinner" />
          Resolving source document...
        </div>
      )}
      {sourceDoc?.available && (
        <>
          <div className="resize-handle resize-handle-horizontal" onMouseDown={handleFactSplitMouseDown} />
          <div
            className="facts-doc-pane nd-split-height"
            /* eslint-disable-next-line local/no-inline-style -- height is a user-dragged split percentage, passed as a CSS custom property */
            style={{ '--nd-split-height': `${100 - factSplitPct}%` } as React.CSSProperties}
          >
            <div className="facts-doc-header">
              <span className="facts-doc-title">{selectedFact?.doc_id}</span>
              <span className="facts-doc-type">{sourceDoc.type?.toUpperCase()}</span>
              <button className="facts-doc-close" onClick={() => setSelectedFact(null)} title="Close document viewer">&times;</button>
            </div>
            <SourceDocumentViewer doc={sourceDoc} claimText={selectedFact?.claim} />
          </div>
        </>
      )}
      {sourceDoc && !sourceDoc.available && !sourceDocLoading && (
        <div className="facts-doc-unavailable">Source document not available for this fact.</div>
      )}
    </div>
  );
}

// ── Research tab (extracted from NodeDetail for complexity) ──

interface NodeDetailResearchTabProps {
  node: PovNode;
  researchText: string;
  setResearchText: (v: string) => void;
  researchCopied: boolean;
  handleResearchCopy: () => void;
  researchTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

function NodeDetailResearchTab({ node, researchText, setResearchText, researchCopied, handleResearchCopy, researchTextareaRef }: NodeDetailResearchTabProps) {
  return (
    <div className="node-detail-research">
      <EvidenceGraphSection nodeId={node.id} />
      <RelatedCruxes nodeId={node.id} mode="compact" />
      <div className="node-detail-research-header">
        <span className="node-detail-research-desc">Research prompt for this position. Edit as needed, then copy to clipboard.</span>
        <button
          className={`btn btn-sm${researchCopied ? '' : ' btn-ghost'}`}
          onClick={handleResearchCopy}
        >
          {researchCopied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <textarea
        ref={researchTextareaRef}
        className="node-detail-research-textarea"
        value={researchText}
        onChange={(e) => setResearchText(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

// ── Related Cruxes (shown in Research tab) ──

const CRUX_TYPE_COLORS: Record<string, string> = {
  empirical: 'var(--color-acc, #3b82f6)',
  values: 'var(--color-saf, #ef4444)',
  definitional: 'var(--color-skp, #f59e0b)',
};

function RelatedCruxes({ nodeId, mode = 'compact' }: { nodeId: string; mode?: 'compact' | 'full' }) {
  const { aggregatedCruxes, showCruxDetail, activeTab } = useTaxonomyStore();
  const related = useMemo(() => {
    const filtered = aggregatedCruxes?.filter(c => c.linked_node_ids.includes(nodeId)) ?? [];
    return mode === 'full' ? [...filtered].sort((a, b) => b.frequency - a.frequency) : filtered;
  }, [aggregatedCruxes, nodeId, mode]);
  const [expanded, setExpanded] = useState(mode === 'full' || related.length <= 5);

  if (mode === 'compact' && (!aggregatedCruxes || related.length === 0)) return null;

  const handleCruxClick = (cruxId: string) => {
    const isPovTab = (POV_KEYS as readonly string[]).includes(activeTab);
    if (isPovTab) {
      showCruxDetail(cruxId);
    } else {
      const pov = nodePovFromId(nodeId);
      if (pov && (POV_KEYS as readonly string[]).includes(pov)) {
        const store = useTaxonomyStore.getState();
        store.navigateToNode(pov as TabId, nodeId);
        useTaxonomyStore.setState({ toolbarPanel: null });
        setTimeout(() => useTaxonomyStore.getState().showCruxDetail(cruxId), 0);
      } else {
        showCruxDetail(cruxId);
      }
    }
  };

  if (mode === 'full') {
    if (related.length === 0) {
      return <div className="related-cruxes-empty">No cruxes pivot on this node yet.</div>;
    }
    return (
      <div className="related-cruxes related-cruxes-full">
        {related.map(crux => (
          <CruxChip key={crux.id} crux={crux} onClick={() => handleCruxClick(crux.id)} showDetail />
        ))}
      </div>
    );
  }

  return (
    <div className="related-cruxes">
      <div
        className="related-cruxes-header"
        onClick={() => setExpanded(!expanded)}
        title={expanded ? 'Collapse' : 'Expand'}
      >
        <span className="related-cruxes-chevron">{expanded ? '▾' : '▸'}</span>
        Related Cruxes ({related.length})
      </div>
      {expanded && (
        <div className="related-cruxes-list">
          {related.map(crux => (
            <CruxChip key={crux.id} crux={crux} onClick={() => handleCruxClick(crux.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function CruxChip({ crux, onClick, showDetail }: { crux: AggregatedCrux; onClick: () => void; showDetail?: boolean }) {
  const rs = crux.resolution_summary;
  const dominant = rs.resolved > 0 && rs.active === 0 ? 'resolved' : rs.irreducible > 0 && rs.active === 0 ? 'irreducible' : 'active';

  return (
    <button
      className={`btn btn-sm btn-ghost crux-chip${showDetail ? ' crux-chip-detail' : ''}`}
      onClick={onClick}
      title={`${crux.statement}\n\nType: ${crux.type} | Status: ${dominant}`}
    >
      <span
        className="crux-chip-dot"
        /* eslint-disable-next-line local/no-inline-style -- dot color is per crux-type, computed from CRUX_TYPE_COLORS */
        style={{ backgroundColor: CRUX_TYPE_COLORS[crux.type] ?? 'var(--text-muted)' }}
      />
      <span className="crux-chip-label">
        {showDetail ? (crux.question_form ?? crux.statement) : crux.statement}
      </span>
      <span className={`crux-chip-status crux-chip-status-${dominant}`}>
        {dominant}
      </span>
      {showDetail && (
        <span className="crux-chip-meta">
          {crux.type} · {crux.frequency}×
        </span>
      )}
    </button>
  );
}

// ── Source Document Viewer (shown in Facts tab bottom pane) ──

function highlightClaim(markdown: string, claim: string | undefined): string {
  if (!claim || !claim.trim()) return markdown;
  const escaped = claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return markdown.replace(new RegExp(`(${escaped})`, 'gi'), '**==$1==**');
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'source-doc-viewer', level: 'warn',
      message: 'Claim highlight regex failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err) },
    });
    return markdown;
  }
}

function SourceDocumentViewer({ doc, claimText }: { doc: SourceDocumentResolution; claimText?: string }) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      const mark = contentRef.current.querySelector('.claim-highlight');
      mark?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [doc, claimText]);

  if (doc.type === 'pdf' && doc.path) {
    return (
      <iframe
        className="facts-doc-iframe"
        src={doc.path}
        title="Source document (PDF)"
        onError={() => {
          getGlobalRecorder()?.record({
            type: 'embed.load-failure',
            component: 'source-doc-viewer',
            level: 'warn',
            message: 'PDF iframe failed to load',
            data: { src: doc.path },
          });
        }}
      />
    );
  }

  if (doc.type === 'markdown' && doc.content) {
    const highlighted = highlightClaim(doc.content, claimText);
    const parts = highlighted.split(/\*\*==(.*?)==\*\*/g);
    return (
      <div className="facts-doc-markdown" ref={contentRef}>
        {parts.map((part, i) =>
          i % 2 === 1
            ? <mark key={i} className="claim-highlight">{part}</mark>
            : <span key={i}>{part}</span>
        )}
      </div>
    );
  }

  return <div className="facts-doc-empty">Unable to render this document type.</div>;
}

// ── Evidence QBAF Graph (shown in Research tab) ──

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

function EvidenceGraphSection({ nodeId }: { nodeId: string }) {
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




