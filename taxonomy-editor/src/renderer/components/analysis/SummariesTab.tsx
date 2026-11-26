// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useFlag } from '../../hooks/useFeatureFlags';
import type { Pov, Category } from '../../types/taxonomy';
import { SearchWithHistory } from '../shared/SearchWithHistory';
import { SourceSignInPrompt } from '../shared/SourceSignInPrompt'; // t/678
import './SummariesTab.css';

// ── Types ──

interface SourceInfo {
  id: string;
  title: string;
  url: string | null;
  sourceType: string;
  datePublished: string;
  dateIngested: string;
  hasSummary: boolean;
  tags: string[];
  authors: string[];
}

interface KeyPoint {
  stance: string;
  taxonomy_node_id: string | null;
  category: string;
  point: string;
  verbatim?: string;
  excerpt_context?: string;
}

interface PovSummary {
  stance?: string;
  key_points: KeyPoint[];
}

interface FactualClaim {
  claim: string;
  doc_position?: string;
  potential_conflict_id?: string | null;
}

interface UnmappedConcept {
  concept: string;
  suggested_label?: string;
  suggested_description?: string;
  suggested_pov?: string;
  suggested_category?: string;
  reason?: string;
  resolved_node_id?: string;
}

interface Summary {
  doc_id: string;
  taxonomy_version?: string;
  generated_at?: string;
  model_info?: { model?: string; chunk_count?: number };
  pov_summaries: Record<string, PovSummary>;
  factual_claims?: FactualClaim[];
  unmapped_concepts?: UnmappedConcept[];
}

// ── Helpers ──

const POV_COLORS: Record<string, string> = {
  accelerationist: 'var(--color-acc, #22c55e)',
  safetyist: 'var(--color-saf, #ef4444)',
  skeptic: 'var(--color-skp, #f59e0b)',
};

const STANCE_EMOJI: Record<string, string> = {
  strongly_aligned: '++',
  aligned: '+',
  neutral: '~',
  opposed: '-',
  strongly_opposed: '--',
};

function stanceClass(stance: string): string {
  if (stance.includes('strongly_aligned')) return 'stance-strongly-aligned';
  if (stance.includes('aligned')) return 'stance-aligned';
  if (stance.includes('opposed') && stance.includes('strongly')) return 'stance-strongly-opposed';
  if (stance.includes('opposed')) return 'stance-opposed';
  return 'stance-neutral';
}

// ── Component ──

type ViewMode = 'key-points' | 'claims' | 'unmapped' | 'document';
type SortField = 'title' | 'dateIngested' | 'datePublished';

const POV_MAP: Record<string, Pov> = {
  accelerationist: 'accelerationist',
  safetyist: 'safetyist',
  skeptic: 'skeptic',
};

const CATEGORY_MAP: Record<string, Category> = {
  Desires: 'Desires',
  Beliefs: 'Beliefs',
  Intentions: 'Intentions',
};

// ── Sub-components (props-only; extracted to keep SummariesTab under the complexity ceiling) ──

type GetLabelForId = ReturnType<typeof useTaxonomyStore.getState>['getLabelForId'];

interface SourceListBodyProps {
  sourcesLoading: boolean;
  filteredSources: SourceInfo[];
  selectedSourceId: string | null;
  sortField: SortField;
  onSelectSource: (id: string) => void;
}

function SourceListBody({ sourcesLoading, filteredSources, selectedSourceId, sortField, onSelectSource }: SourceListBodyProps) {
  return (
    <div className="panel-body sumt-list-body">
      {sourcesLoading ? (
        <div className="panel-empty">Loading sources...</div>
      ) : filteredSources.length === 0 ? (
        <div className="panel-empty">No sources with summaries found.</div>
      ) : (
        <ul className="node-list sumt-node-list">
          {filteredSources.map(s => (
            <li
              key={s.id}
              className={`node-item sumt-node-item${s.id === selectedSourceId ? ' node-item-selected' : ''}`}
              onClick={() => onSelectSource(s.id)}
            >
              <div className="sumt-node-title">{s.title}</div>
              <div className="sumt-date-meta">
                {s.tags.map(t => (
                  <span
                    key={t}
                    className="sumt-tag"
                    /* eslint-disable-next-line local/no-inline-style -- dynamic: tag color keyed on tag value */
                    style={{
                    backgroundColor: t === 'accelerationist' ? 'rgba(34,197,94,0.15)' :
                      t === 'safetyist' ? 'rgba(239,68,68,0.15)' :
                      t === 'skeptic' ? 'rgba(245,158,11,0.15)' :
                      'rgba(148,163,184,0.15)',
                    color: t === 'accelerationist' ? 'var(--color-acc, #22c55e)' :
                      t === 'safetyist' ? 'var(--color-saf, #ef4444)' :
                      t === 'skeptic' ? 'var(--color-skp, #f59e0b)' :
                      'var(--text-muted)',
                  }}>{t.slice(0, 3)}</span>
                ))}
                {sortField === 'dateIngested' && s.dateIngested
                  ? <span className="sumt-ml4">{s.dateIngested.slice(0, 10)}</span>
                  : s.datePublished && <span className="sumt-ml4">{s.datePublished.slice(0, 10)}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DetailMeta({ summary }: { summary: Summary }) {
  return (
    <div className="sumt-date-meta">
      {summary.model_info?.model && <span>Model: {summary.model_info.model}</span>}
      {summary.generated_at && <span className="sumt-ml8">Generated: {summary.generated_at.slice(0, 10)}</span>}
      {summary.model_info?.chunk_count && <span className="sumt-ml8">Chunks: {summary.model_info.chunk_count}</span>}
    </div>
  );
}

interface ViewModeTabsProps {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  keyPointsCount: number;
  summary: Summary;
  povFilter: string | null;
  setPovFilter: (pov: string | null) => void;
}

function ViewModeTabs({ viewMode, setViewMode, keyPointsCount, summary, povFilter, setPovFilter }: ViewModeTabsProps) {
  return (
    <div className="sumt-tab-bar">
      {(['key-points', 'claims', 'unmapped', 'document'] as ViewMode[]).map(mode => (
        <button
          key={mode}
          className="sumt-viewmode-btn"
          onClick={() => setViewMode(mode)}
          /* eslint-disable-next-line local/no-inline-style -- dynamic: active-tab underline/color/weight */
          style={{
            borderBottom: viewMode === mode ? '2px solid var(--focus-ring, #3b82f6)' : '2px solid transparent',
            color: viewMode === mode ? 'var(--text-primary)' : 'var(--text-muted)',
            fontWeight: viewMode === mode ? 600 : 400,
          }}
        >
          {mode === 'key-points' ? `Key Points (${keyPointsCount})` :
           mode === 'claims' ? `Claims (${summary.factual_claims?.length ?? 0})` :
           mode === 'unmapped' ? `Unmapped (${summary.unmapped_concepts?.length ?? 0})` :
           'Document'}
        </button>
      ))}

      {/* POV filter */}
      {viewMode === 'key-points' && (
        <div className="sumt-pov-filter">
          <button
            className="sumt-pov-btn"
            onClick={() => setPovFilter(null)}
            /* eslint-disable-next-line local/no-inline-style -- dynamic: active-filter background/color */
            style={{
              background: !povFilter ? 'var(--focus-ring, #3b82f6)' : 'var(--bg-secondary)',
              color: !povFilter ? '#fff' : 'var(--text-muted)',
            }}
          >All</button>
          {Object.keys(summary.pov_summaries).map(pov => (
            <button
              key={pov}
              className="sumt-pov-btn"
              onClick={() => setPovFilter(pov)}
              /* eslint-disable-next-line local/no-inline-style -- dynamic: active-filter POV color */
              style={{
                background: povFilter === pov ? (POV_COLORS[pov] || '#666') : 'var(--bg-secondary)',
                color: povFilter === pov ? '#fff' : 'var(--text-muted)',
              }}
            >{pov.slice(0, 3)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

interface SummaryContentViewProps {
  viewMode: ViewMode;
  keyPoints: (KeyPoint & { pov: string })[];
  summary: Summary;
  summariesFlag: boolean;
  snapshot: string | null;
  snapshotLoading: boolean;
  snapshotSignIn: boolean;
  getLabelForId: GetLabelForId;
  handleNodeClick: (nodeId: string) => void;
  addUnmappedToTaxonomy: (uc: UnmappedConcept) => void;
}

export function SummaryContentView({ viewMode, keyPoints, summary, summariesFlag, snapshot, snapshotLoading, snapshotSignIn, getLabelForId, handleNodeClick, addUnmappedToTaxonomy }: SummaryContentViewProps) {
  return (
    <div className="sumt-content">
      {viewMode === 'key-points' && (
        <div>
          {keyPoints.length === 0 ? (
            <div className="panel-empty">No key points found.</div>
          ) : keyPoints.map((kp, i) => (
            <div key={i} className="sumt-card">
              <div className="sumt-kp-header">
                <span
                  className="sumt-pov-badge"
                  /* eslint-disable-next-line local/no-inline-style -- dynamic: POV-keyed badge color */
                  style={{
                  backgroundColor: POV_COLORS[kp.pov] ? `${POV_COLORS[kp.pov]}22` : 'var(--bg-tertiary)',
                  color: POV_COLORS[kp.pov] || 'var(--text-muted)',
                }}>{kp.pov.slice(0, 3)}</span>
                <span className="sumt-category">{kp.category}</span>
                <span className={`sumt-stance ${stanceClass(kp.stance)}`}>
                  {STANCE_EMOJI[kp.stance] || '~'} {kp.stance.replace(/_/g, ' ')}
                </span>
                {kp.taxonomy_node_id && (
                  <button
                    className="sumt-node-btn"
                    onClick={() => handleNodeClick(kp.taxonomy_node_id!)}
                    title={kp.taxonomy_node_id}
                  >
                    {getLabelForId(kp.taxonomy_node_id) || kp.taxonomy_node_id}
                  </button>
                )}
              </div>
              <div className="sumt-kp-point">{kp.point}</div>
              {kp.verbatim && (
                <div className="sumt-verbatim">
                  "{kp.verbatim}"
                </div>
              )}
              {kp.excerpt_context && (
                <div className="sumt-date-meta">
                  {kp.excerpt_context}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {viewMode === 'claims' && (
        <div>
          {!summary.factual_claims?.length ? (
            <div className="panel-empty">No factual claims extracted.</div>
          ) : summary.factual_claims.map((claim, i) => (
            <div key={i} className="sumt-claim-card">
              <div className="sumt-claim-text">{claim.claim}</div>
              <div className="sumt-claim-meta">
                {claim.doc_position && <span>{claim.doc_position}</span>}
                {claim.potential_conflict_id && (
                  <button
                    className="sumt-conflict-btn"
                    onClick={() => handleNodeClick(claim.potential_conflict_id!)}
                  >
                    {claim.potential_conflict_id}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {viewMode === 'unmapped' && (
        <div>
          {!summary.unmapped_concepts?.length ? (
            <div className="panel-empty">No unmapped concepts.</div>
          ) : summary.unmapped_concepts.map((uc, i) => (
            <div key={i} className="sumt-card">
              <div className="sumt-uc-header">
                <span className="sumt-uc-label">{uc.suggested_label || uc.concept}</span>
                {uc.resolved_node_id && (
                  <span className="sumt-mapped-badge">mapped</span>
                )}
              </div>
              {uc.suggested_description && (
                <div className="sumt-uc-desc">{uc.suggested_description}</div>
              )}
              <div className="sumt-uc-meta">
                {uc.suggested_pov && <span>Perspective: {uc.suggested_pov}</span>}
                {uc.suggested_category && <span>Category: {uc.suggested_category}</span>}
              </div>
              {uc.reason && (
                <div className="sumt-uc-reason">
                  {uc.reason}
                </div>
              )}
              <div className="sumt-uc-actions">
                {uc.resolved_node_id && (
                  <button
                    className="sumt-goto-btn"
                    onClick={() => handleNodeClick(uc.resolved_node_id!)}
                  >
                    Go to {getLabelForId(uc.resolved_node_id) || uc.resolved_node_id}
                  </button>
                )}
                {!uc.resolved_node_id && uc.suggested_pov && POV_MAP[uc.suggested_pov] && uc.suggested_category && CATEGORY_MAP[uc.suggested_category] && (
                  <button
                    className="sumt-add-btn"
                    onClick={() => addUnmappedToTaxonomy(uc)}
                    title={`Add as ${uc.suggested_pov} ${uc.suggested_category} node`}
                  >
                    + Add to Taxonomy
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {viewMode === 'document' && (
        <div>
          {snapshotLoading ? (
            <div className="panel-empty">Loading document...</div>
          ) : snapshotSignIn ? (
            <SourceSignInPrompt />
          ) : !snapshot ? (
            !summariesFlag ? (
              <div className="panel-empty sumt-doc-fallback">
                <strong>Document snapshots are available in the desktop app.</strong>
                <p className="sumt-doc-fallback-p">
                  Key points and claims from this source are shown in the other tabs.
                </p>
              </div>
            ) : (
              <div className="panel-empty">No document snapshot available.</div>
            )
          ) : (
            <pre className="sumt-doc-pre">{snapshot}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function SummariesTab() {
  const { getLabelForId, navigateToNode, setActiveTab, createPovNode, updatePovNode } = useTaxonomyStore();
  const summariesFlag = useFlag('env-electron-summaries');
  const { width: listWidth, onMouseDown } = useResizablePanel();
  const breakpoint = useBreakpoint();
  const isPhone = breakpoint === 'phone' || breakpoint === 'phone-lg';

  // Sources
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [filter, setFilter] = useState('');

  // Selected source
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Document
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotSignIn, setSnapshotSignIn] = useState(false); // t/678

  // View
  const [viewMode, setViewMode] = useState<ViewMode>('key-points');
  const [povFilter, setPovFilter] = useState<string | null>(null);

  // Sort
  const [sortField, setSortField] = useState<SortField>('dateIngested');
  const [sortDesc, setSortDesc] = useState(true);

  // Load sources on mount
  useEffect(() => {
    setSourcesLoading(true);
    api.discoverSources()
      .then((data) => setSources((data as SourceInfo[]).filter(s => s.hasSummary)))
      .catch(err => {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'summaries-tab',
          level: 'error',
          message: 'Failed to load sources',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      })
      .finally(() => setSourcesLoading(false));
  }, []);

  // Load summary when source selected
  useEffect(() => {
    if (!selectedSourceId) { setSummary(null); setSnapshot(null); return; }
    setSummaryLoading(true);
    api.loadSummary(selectedSourceId)
      .then(data => setSummary(data as Summary | null))
      .catch(err => {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'summaries-tab',
          level: 'warn',
          message: 'Summary unavailable for source — falling back to none',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setSummary(null);
      })
      .finally(() => setSummaryLoading(false));
  }, [selectedSourceId]);

  // Load snapshot lazily when document view is shown
  useEffect(() => {
    if (viewMode !== 'document' || !selectedSourceId || snapshot || snapshotSignIn) return;
    setSnapshotLoading(true);
    api.loadSnapshot(selectedSourceId)
      .then(data => { setSnapshotSignIn(data?.signInRequired === true); setSnapshot(data?.signInRequired ? null : data?.content ?? null); })
      .catch(err => {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'summaries-tab',
          level: 'warn',
          message: 'Snapshot unavailable for source — falling back to none',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setSnapshot(null);
      })
      .finally(() => setSnapshotLoading(false));
  }, [viewMode, selectedSourceId, snapshot, snapshotSignIn]);

  // Reset snapshot when source changes
  useEffect(() => { setSnapshot(null); setSnapshotSignIn(false); }, [selectedSourceId]);

  // Filtered and sorted sources
  const filteredSources = useMemo(() => {
    let result = sources;
    if (filter) {
      const q = filter.toLowerCase();
      result = result.filter(s =>
        (s.title ?? '').toLowerCase().includes(q) ||
        (s.id ?? '').toLowerCase().includes(q) ||
        s.authors.some(a => a.toLowerCase().includes(q)) ||
        s.tags.some(t => t.toLowerCase().includes(q))
      );
    }
    const sorted = [...result].sort((a, b) => {
      let cmp: number;
      if (sortField === 'title') {
        cmp = (a.title ?? '').localeCompare(b.title ?? '');
      } else {
        const av = a[sortField] || '';
        const bv = b[sortField] || '';
        cmp = av.localeCompare(bv);
      }
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [sources, filter, sortField, sortDesc]);

  // Aggregated key points
  const keyPoints = useMemo(() => {
    if (!summary) return [];
    const points: (KeyPoint & { pov: string })[] = [];
    for (const [pov, data] of Object.entries(summary.pov_summaries)) {
      for (const kp of data.key_points || []) {
        if (povFilter && pov !== povFilter) continue;
        points.push({ ...kp, pov });
      }
    }
    return points;
  }, [summary, povFilter]);

  const selectedSource = sources.find(s => s.id === selectedSourceId);

  const addUnmappedToTaxonomy = useCallback((uc: UnmappedConcept) => {
    const pov = POV_MAP[uc.suggested_pov || ''];
    const category = CATEGORY_MAP[uc.suggested_category || ''];
    if (!pov || !category) return;
    const newId = createPovNode(pov, category);
    if (!newId) return;
    updatePovNode(pov, newId, {
      label: uc.suggested_label || uc.concept,
      description: uc.suggested_description || uc.concept,
    });
    setActiveTab(pov);
    navigateToNode(pov, newId);
  }, [createPovNode, updatePovNode, setActiveTab, navigateToNode]);

  const handleNodeClick = useCallback((nodeId: string) => {
    // Navigate to the node in the appropriate tab
    if (nodeId.startsWith('acc-')) { setActiveTab('accelerationist'); navigateToNode('accelerationist', nodeId); }
    else if (nodeId.startsWith('saf-')) { setActiveTab('safetyist'); navigateToNode('safetyist', nodeId); }
    else if (nodeId.startsWith('skp-')) { setActiveTab('skeptic'); navigateToNode('skeptic', nodeId); }
    else if (nodeId.startsWith('sit-')) { setActiveTab('situations'); navigateToNode('situations', nodeId); }
    else if (nodeId.startsWith('conflict-')) { setActiveTab('conflicts'); navigateToNode('conflicts', nodeId); }
  }, [setActiveTab, navigateToNode]);

  return (
    <div className={`two-column${isPhone ? ' phone-mode' : ''}${isPhone && selectedSourceId ? ' has-selection' : ''}`}>
      {/* ── Pane 1: Source List ── */}
      <div
        className="list-panel sumt-min-w"
        /* eslint-disable-next-line local/no-inline-style -- dynamic: width from resizable panel */
        style={{ width: listWidth }}
      >
        <div className="panel-header">
          <h3>Sources ({filteredSources.length})</h3>
        </div>
        <div className="sumt-filter-bar">
          <SearchWithHistory
            area="summaries"
            className="search-input"
            placeholder="Filter sources..."
            value={filter}
            onChange={setFilter}
          />
          <div className="sumt-sort-row">
            <span className="sumt-muted">Sort:</span>
            {([['dateIngested', 'Imported'], ['datePublished', 'Published'], ['title', 'Title']] as const).map(([field, label]) => (
              <button
                key={field}
                className="sumt-sort-btn"
                onClick={() => {
                  if (sortField === field) setSortDesc(d => !d);
                  else { setSortField(field); setSortDesc(field !== 'title'); }
                }}
                /* eslint-disable-next-line local/no-inline-style -- dynamic: active-tab background/color */
                style={{
                  background: sortField === field ? 'var(--focus-ring, #3b82f6)' : 'var(--bg-secondary)',
                  color: sortField === field ? '#fff' : 'var(--text-muted)',
                }}
              >{label}{sortField === field ? (sortDesc ? ' \u25BC' : ' \u25B2') : ''}</button>
            ))}
          </div>
        </div>
        <SourceListBody
          sourcesLoading={sourcesLoading}
          filteredSources={filteredSources}
          selectedSourceId={selectedSourceId}
          sortField={sortField}
          onSelectSource={setSelectedSourceId}
        />
      </div>

      {/* ── Resize Handle ── */}
      <div className="resize-handle" onMouseDown={onMouseDown} />

      {/* ── Pane 2: Summary Detail ── */}
      <div className="detail-panel sumt-detail-panel">
        {isPhone && selectedSourceId && (
          <div className="phone-detail-header">
            <button className="phone-detail-back" onClick={() => setSelectedSourceId(null)}>
              &larr; Sources
            </button>
          </div>
        )}
        {!selectedSourceId ? (
          <div className="panel-empty sumt-empty-pad">Select a source document to view its summary.</div>
        ) : summaryLoading ? (
          <div className="panel-empty sumt-empty-pad">Loading summary...</div>
        ) : !summary ? (
          <div className="panel-empty sumt-empty-pad">No summary found for this source.</div>
        ) : (
          <>
            {/* Header */}
            <div className="panel-header sumt-flex-shrink0">
              <h3 className="sumt-detail-title">{selectedSource?.title}</h3>
              <DetailMeta summary={summary} />
            </div>

            {/* View mode tabs */}
            <ViewModeTabs
              viewMode={viewMode}
              setViewMode={setViewMode}
              keyPointsCount={keyPoints.length}
              summary={summary}
              povFilter={povFilter}
              setPovFilter={setPovFilter}
            />

            {/* Content */}
            <SummaryContentView
              viewMode={viewMode}
              keyPoints={keyPoints}
              summary={summary}
              summariesFlag={summariesFlag}
              snapshot={snapshot}
              snapshotSignIn={snapshotSignIn}
              snapshotLoading={snapshotLoading}
              getLabelForId={getLabelForId}
              handleNodeClick={handleNodeClick}
              addUnmappedToTaxonomy={addUnmappedToTaxonomy}
            />
          </>
        )}
      </div>
    </div>
  );
}
