// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useMemo, useCallback, useRef, useState, type MouseEvent } from 'react';
import { useValidationStore, filterClaims, claimUid } from '../../hooks/useValidationStore';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById } from '../../hooks/useTaxonomyStore/superseded';
import { useResizablePanel, useResizableRightPanel } from '../../hooks/useResizablePanel';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { GoldenClaim, Verdict, SpeakerFilter, VerdictFilter } from '../../types/validation';
import type { PovNode } from '../../types/taxonomy';
import { useDescriptionMode, resolveDescription } from '../shared/DescriptionToggle';
import './ValidationTab.css';

type SearchPovFilter = 'same' | 'all' | 'accelerationist' | 'safetyist' | 'skeptic';

const POV_ABBREV: Record<string, string> = {
  acc: 'ACC', saf: 'SAF', skp: 'SKE', cc: 'CC',
};

const SPEAKER_COLORS: Record<string, string> = {
  accelerationist: '#f97316',
  safetyist: '#3b82f6',
  skeptic: '#a855f7',
};

const VERDICT_LABELS: Record<Verdict, string> = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  uncertain: 'Uncertain',
  novel: 'Novel',
};

const VERDICT_KEYS: Record<string, Verdict> = {
  '1': 'correct',
  '2': 'incorrect',
  '3': 'uncertain',
  '4': 'novel',
};

function speakerColor(speaker: string): string {
  return SPEAKER_COLORS[speaker.toLowerCase()] ?? '#888';
}

function scoreColor(score: number): string {
  if (score > 0.5) return 'var(--success, #22c55e)';
  if (score >= 0.35) return 'var(--warning, #eab308)';
  return 'var(--danger, #ef4444)';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

const POV_KEYS = ['accelerationist', 'safetyist', 'skeptic'] as const;
type PovKey = (typeof POV_KEYS)[number];

const PREFIX_TO_POV: Record<string, PovKey> = {
  acc: 'accelerationist',
  saf: 'safetyist',
  skp: 'skeptic',
};

function nodePovBadge(nodeId: string): string {
  const prefix = nodeId.split('-')[0];
  return POV_ABBREV[prefix] ?? prefix.toUpperCase();
}

/** t/4355: a claim's attributed node is history, so it resolves to the exact node, superseded included. */
function resolveNode(nodeId: string, store: ReturnType<typeof useTaxonomyStore>): PovNode | null {
  return allNodesById(store as Parameters<typeof allNodesById>[0]).get(nodeId) ?? null;
}

// ── Claim List Sidebar (Col 1) ──────────────────────────────────────────────

function ClaimListSidebar({ width, onResizeMouseDown }: {
  width: number;
  onResizeMouseDown: (e: MouseEvent) => void;
}) {
  const {
    claims: allClaims, results, currentClaimIndex, goToIndex,
    speakerFilter, setSpeakerFilter, verdictFilter, setVerdictFilter,
    scoreRange, setScoreRange,
  } = useValidationStore();

  const claims = useMemo(
    () => filterClaims(allClaims, results, speakerFilter, scoreRange, verdictFilter),
    [allClaims, results, speakerFilter, scoreRange, verdictFilter],
  );
  const meta = useMemo(() => {
    let correct = 0, incorrect = 0, uncertain = 0, novel = 0;
    for (const r of results.values()) {
      switch (r.verdict) {
        case 'correct': correct++; break;
        case 'incorrect': incorrect++; break;
        case 'uncertain': uncertain++; break;
        case 'novel': novel++; break;
      }
    }
    return { total: allClaims.length, reviewed: results.size, correct, incorrect, uncertain, novel };
  }, [allClaims, results]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[currentClaimIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [currentClaimIndex]);

  return (
    // eslint-disable-next-line local/no-inline-style -- width is a resizable-panel prop (runtime drag value)
    <div className="validation-sidebar" style={{ width, minWidth: width, maxWidth: width }}>
      <div className="validation-sidebar-header">
        <div className="validation-progress-bar">
          {/* eslint-disable-next-line local/no-inline-style -- computed progress percentage */}
          <div className="validation-progress-fill" style={{ width: `${meta.total ? (meta.reviewed / meta.total) * 100 : 0}%` }} />
          <span className="validation-progress-text">{meta.reviewed} of {meta.total} reviewed</span>
        </div>

        <div className="validation-filters">
          <select
            value={speakerFilter}
            onChange={e => setSpeakerFilter(e.target.value as SpeakerFilter)}
            className="validation-filter-select"
          >
            <option value="all">All speakers</option>
            <option value="accelerationist">Accelerationist</option>
            <option value="safetyist">Safetyist</option>
            <option value="skeptic">Skeptic</option>
          </select>

          <select
            value={verdictFilter}
            onChange={e => setVerdictFilter(e.target.value as VerdictFilter)}
            className="validation-filter-select"
          >
            <option value="all">All verdicts</option>
            <option value="unreviewed">Unreviewed</option>
            <option value="correct">Correct</option>
            <option value="incorrect">Incorrect</option>
            <option value="uncertain">Uncertain</option>
            <option value="novel">Novel</option>
          </select>

          <div className="validation-score-range">
            <label>Score: {scoreRange.min.toFixed(2)}&ndash;{scoreRange.max.toFixed(2)}</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={scoreRange.min}
              onChange={e => setScoreRange({ ...scoreRange, min: parseFloat(e.target.value) })}
            />
          </div>
        </div>
      </div>

      <div className="validation-claim-list" ref={listRef}>
        {claims.map((claim, i) => {
          const uid = claimUid(claim);
          const reviewed = results.has(uid);
          const verdict = results.get(uid)?.verdict;
          return (
            <button
              key={`${claim.debate_id}-${claim.claim_id}`}
              className={`validation-claim-item${i === currentClaimIndex ? ' selected' : ''}`}
              onClick={() => goToIndex(i)}
            >
              <span className="validation-claim-status" title={reviewed ? verdict : 'Unreviewed'}>
                {reviewed ? (
                  <span className={`validation-verdict-dot verdict-${verdict}`} />
                ) : (
                  <span className="validation-verdict-dot verdict-none" />
                )}
              </span>
              <span className="validation-claim-id">{claim.claim_id}</span>
              {/* eslint-disable-next-line local/no-inline-style -- speaker-derived color lookup */}
              <span className="validation-speaker-badge" style={{ backgroundColor: speakerColor(claim.speaker) }}>
                {claim.speaker.slice(0, 3)}
              </span>
              <span className="validation-claim-text">{truncate(claim.claim_text, 60)}</span>
            </button>
          );
        })}
        {claims.length === 0 && (
          <div className="validation-empty">No claims match current filters</div>
        )}
      </div>

      <div className="resize-handle" onMouseDown={onResizeMouseDown} />
    </div>
  );
}

// ── Claim Detail (Col 2) ────────────────────────────────────────────────────

function ClaimDetail({ claim }: { claim: GoldenClaim | null }) {
  const {
    results, setVerdict, clearVerdict, setReviewerNotes, nextUnreviewed,
  } = useValidationStore();

  if (!claim) {
    return <div className="validation-detail-empty">Select a claim to review</div>;
  }

  const uid = claimUid(claim);
  const result = results.get(uid);
  const activeVerdict = result?.verdict ?? null;

  const handleVerdict = (verdict: Verdict) => {
    if (activeVerdict === verdict) {
      clearVerdict(uid);
    } else {
      setVerdict(uid, verdict);
    }
  };

  const handleConfirmAdvance = () => {
    if (activeVerdict) {
      nextUnreviewed();
    }
  };

  return (
    <div className="validation-detail">
      <div className="validation-detail-header">
        {/* eslint-disable-next-line local/no-inline-style -- speaker-derived color lookup */}
        <span className="validation-speaker-badge large" style={{ backgroundColor: speakerColor(claim.speaker) }}>
          {claim.speaker}
        </span>
        <span className="validation-claim-id-large">{claim.claim_id}</span>
      </div>

      <div className="validation-claim-full-text">
        {claim.claim_text}
        <button
          className="validation-copy-btn"
          onClick={() => void navigator.clipboard.writeText(claim.claim_text)}
        >
          Copy
        </button>
      </div>

      <div className="validation-context-row">
        <span className="validation-context-label">Debate:</span>
        <span className="validation-context-value">{claim.debate_title}</span>
      </div>
      <div className="validation-context-row">
        <span className="validation-context-label">Turn:</span>
        <span className="validation-context-value">{claim.turn_number}</span>
      </div>
      <div className="validation-context-row">
        <span className="validation-context-label">Similarity:</span>
        {/* eslint-disable-next-line local/no-inline-style -- score-derived color band */}
        <span className="validation-score" style={{ color: scoreColor(claim.similarity_score) }}>
          {claim.similarity_score.toFixed(3)}
        </span>
      </div>
      {claim.computed_strength != null && (
        <div className="validation-context-row">
          <span className="validation-context-label">Strength:</span>
          <span className="validation-context-value">{claim.computed_strength}</span>
        </div>
      )}

      <div className="validation-verdict-toolbar">
        {(['correct', 'incorrect', 'uncertain', 'novel'] as Verdict[]).map((v, i) => (
          <button
            key={v}
            className={`validation-verdict-btn verdict-${v}${activeVerdict === v ? ' active' : ''}`}
            onClick={() => handleVerdict(v)}
            title={`${VERDICT_LABELS[v]} (${i + 1})`}
          >
            {VERDICT_LABELS[v]} <kbd>{i + 1}</kbd>
          </button>
        ))}
      </div>

      <textarea
        className="validation-notes"
        placeholder="Reviewer notes (optional)"
        value={result?.reviewer_notes ?? ''}
        onChange={e => {
          if (result) setReviewerNotes(uid, e.target.value);
        }}
        rows={2}
      />

      <button
        className="validation-confirm-btn"
        disabled={!activeVerdict}
        onClick={handleConfirmAdvance}
      >
        Confirm &amp; Next Unreviewed (Enter)
      </button>
    </div>
  );
}

// ── Attribution Panel (Col 3) ───────────────────────────────────────────────

function AttributionPanel({
  claim,
  width,
  onResizeMouseDown,
}: {
  claim: GoldenClaim | null;
  width: number;
  onResizeMouseDown: (e: MouseEvent) => void;
}) {
  const store = useTaxonomyStore();
  const { results, setVerdict, beliefsOnly, setBeliefsOnly } = useValidationStore();
  const [descMode] = useDescriptionMode();
  const [searchText, setSearchText] = useState('');
  const [searchPov, setSearchPov] = useState<SearchPovFilter>('same');
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const [expandedAltId, setExpandedAltId] = useState<string | null>(null);

  const claimPov = claim ? PREFIX_TO_POV[claim.attributed_node.split('-')[0]] : undefined;

  const searchPool = useMemo(() => {
    const collectNodes = (pov: PovKey): PovNode[] => {
      const file = (store as unknown as Record<string, { nodes?: PovNode[] }>)[pov];
      if (!file?.nodes) return [];
      return beliefsOnly ? file.nodes.filter((n: PovNode) => n.category === 'Beliefs') : file.nodes;
    };

    if (searchPov === 'same') {
      return claimPov ? collectNodes(claimPov) : [];
    }
    if (searchPov === 'all') {
      return POV_KEYS.flatMap(collectNodes);
    }
    return collectNodes(searchPov);
  }, [store, claimPov, searchPov, beliefsOnly]);

  const searchResults = useMemo(() => {
    if (!searchText.trim()) return [];
    const q = searchText.toLowerCase();
    return searchPool
      .filter((n: PovNode) => n.label.toLowerCase().includes(q) || n.description.toLowerCase().includes(q) || n.id.includes(q))
      .slice(0, 30);
  }, [searchPool, searchText]);

  if (!claim) {
    return (
      // eslint-disable-next-line local/no-inline-style -- width is a resizable-panel prop (runtime drag value)
      <div className="validation-attribution" style={{ width, minWidth: width, maxWidth: width }}>
        <div className="validation-detail-empty">No claim selected</div>
        <div className="resize-handle left" onMouseDown={onResizeMouseDown} />
      </div>
    );
  }

  const primaryNode = resolveNode(claim.attributed_node, store);
  const uid = claimUid(claim);
  const result = results.get(uid);
  const isIncorrect = result?.verdict === 'incorrect';

  const alternativeNodes = claim.secondary_refs
    .map(ref => ({ node: resolveNode(ref.node_id, store), similarity: ref.similarity, id: ref.node_id }))
    .filter((r): r is { node: PovNode; similarity: number; id: string } => r.node !== null);

  const handleSelectCorrection = (nodeId: string) => {
    const node = resolveNode(nodeId, store);
    const cat = node?.category !== 'Beliefs' ? node?.category : undefined;
    setVerdict(uid, 'incorrect', {
      corrected_node: nodeId,
      corrected_category: cat,
    });
  };

  return (
    // eslint-disable-next-line local/no-inline-style -- width is a resizable-panel prop (runtime drag value)
    <div className="validation-attribution" style={{ width, minWidth: width, maxWidth: width }}>
      <div className="resize-handle left" onMouseDown={onResizeMouseDown} />

      <h3 className="validation-section-title">Primary Attribution</h3>
      {primaryNode ? (
        <div className={`validation-node-card${isIncorrect ? ' incorrect' : ''}`}>
          <div className="validation-node-id">{claim.attributed_node}</div>
          <div className="validation-node-label">{primaryNode.label}</div>
          <div className="validation-node-desc">{resolveDescription(primaryNode, descMode).text}</div>
          <div className="validation-node-score">
            {/* eslint-disable-next-line local/no-inline-style -- score-derived color band */}
            Score: <span style={{ color: scoreColor(claim.similarity_score) }}>
              {claim.similarity_score.toFixed(3)}
            </span>
          </div>
        </div>
      ) : (
        <div className="validation-node-card missing">
          <div className="validation-node-id">{claim.attributed_node}</div>
          <div className="validation-node-desc">Node not found in taxonomy</div>
        </div>
      )}

      {result?.corrected_node && (
        <>
          <h3 className="validation-section-title">Corrected To</h3>
          <div className="validation-node-card corrected">
            <div className="validation-node-id">{result.corrected_node}</div>
            {(() => {
              const corrNode = resolveNode(result.corrected_node, store);
              return corrNode ? (
                <>
                  <div className="validation-node-label">{corrNode.label}</div>
                  <div className="validation-node-desc">{resolveDescription(corrNode, descMode).text}</div>
                </>
              ) : null;
            })()}
            {result.corrected_category && (
              <div className="validation-node-category">Category: {result.corrected_category}</div>
            )}
          </div>
        </>
      )}

      {alternativeNodes.length > 0 && (
        <>
          <h3 className="validation-section-title">Alternatives ({alternativeNodes.length})</h3>
          <div className="validation-alt-list">
            {alternativeNodes.map(({ node, similarity, id }) => {
              const isAltExpanded = expandedAltId === id;
              return (
                <div key={id} className={`validation-search-item${isAltExpanded ? ' expanded' : ''}`}>
                  <button
                    className="validation-alt-item"
                    onClick={() => setExpandedAltId(isAltExpanded ? null : id)}
                  >
                    <div className="validation-alt-header">
                      <span className={`validation-pov-badge pov-${id.split('-')[0]}`}>{nodePovBadge(id)}</span>
                      <span className="validation-node-id">{id}</span>
                      {/* eslint-disable-next-line local/no-inline-style -- score-derived color band */}
                      <span className="validation-alt-score" style={{ color: scoreColor(similarity) }}>
                        {similarity.toFixed(3)}
                      </span>
                    </div>
                    <div className="validation-node-label">{node.label}</div>
                    {!isAltExpanded && (
                      <div className="validation-node-desc-preview">{truncate(resolveDescription(node, descMode).text, 120)}</div>
                    )}
                  </button>
                  {isAltExpanded && (
                    <div className="validation-expanded-detail">
                      <div className="validation-node-desc">{resolveDescription(node, descMode).text}</div>
                      {node.confidence != null && (
                        <div className="validation-node-meta">Confidence: {node.confidence.toFixed(3)}</div>
                      )}
                      {isIncorrect && (
                        <button
                          className="validation-select-correction-btn"
                          onClick={() => handleSelectCorrection(id)}
                        >
                          Select as correction
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <h3 className="validation-section-title">Search Nodes</h3>
      <div className="validation-search-controls">
        <div className="validation-search-row">
          <input
            type="text"
            className="validation-search-input"
            placeholder="Search by label, ID, or description..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
          />
          <select
            className="validation-pov-select"
            value={searchPov}
            onChange={e => setSearchPov(e.target.value as SearchPovFilter)}
          >
            <option value="same">Same POV</option>
            <option value="all">All POVs</option>
            <option value="accelerationist">Accelerationist</option>
            <option value="safetyist">Safetyist</option>
            <option value="skeptic">Skeptic</option>
          </select>
        </div>
        <label className="validation-beliefs-toggle">
          <input
            type="checkbox"
            checked={!beliefsOnly}
            onChange={e => setBeliefsOnly(!e.target.checked)}
          />
          Expand to all categories
        </label>
      </div>
      {searchResults.length > 0 && (
        <div className="validation-search-results">
          {searchResults.map((n: PovNode) => {
            const isExpanded = expandedNodeId === n.id;
            return (
              <div key={n.id} className={`validation-search-item${isExpanded ? ' expanded' : ''}`}>
                <button
                  className="validation-alt-item"
                  onClick={() => setExpandedNodeId(isExpanded ? null : n.id)}
                >
                  <div className="validation-alt-header">
                    <span className={`validation-pov-badge pov-${n.id.split('-')[0]}`}>{nodePovBadge(n.id)}</span>
                    <span className="validation-node-id">{n.id}</span>
                    <span className="validation-node-category-tag">{n.category}</span>
                  </div>
                  <div className="validation-node-label">{n.label}</div>
                  {!isExpanded && (
                    <div className="validation-node-desc-preview">{truncate(resolveDescription(n, descMode).text, 120)}</div>
                  )}
                </button>
                {isExpanded && (
                  <div className="validation-expanded-detail">
                    <div className="validation-node-desc">{resolveDescription(n, descMode).text}</div>
                    {n.confidence != null && (
                      <div className="validation-node-meta">Confidence: {n.confidence.toFixed(3)}</div>
                    )}
                    {isIncorrect && (
                      <button
                        className="validation-select-correction-btn"
                        onClick={() => handleSelectCorrection(n.id)}
                      >
                        Select as correction
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main ValidationTab ──────────────────────────────────────────────────────

export function ValidationTab() {
  const {
    loaded, loading, loadGoldenSet, currentClaimIndex,
    claims: allClaims, results, speakerFilter, scoreRange, verdictFilter,
  } = useValidationStore();
  const { width: leftWidth, onMouseDown: onLeftResize } = useResizablePanel();
  const { width: rightWidth, onMouseDown: onRightResize } = useResizableRightPanel({
    storageKey: 'validation-right-panel-width',
    defaultWidth: 380,
    minWidth: 280,
    maxWidth: 600,
  });

  useEffect(() => {
    if (!loaded && !loading) {
      loadGoldenSet().catch((err: unknown) => {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'validation-tab',
          level: 'error',
          message: 'Failed to load golden set in tab',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      });
    }
  }, [loaded, loading, loadGoldenSet]);

  const claims = useMemo(
    () => filterClaims(allClaims, results, speakerFilter, scoreRange, verdictFilter),
    [allClaims, results, speakerFilter, scoreRange, verdictFilter],
  );
  const currentClaim = claims[currentClaimIndex] ?? null;

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const verdict = VERDICT_KEYS[e.key];
      if (verdict && currentClaim) {
        e.preventDefault();
        useValidationStore.getState().setVerdict(claimUid(currentClaim), verdict);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        useValidationStore.getState().prevClaim();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        useValidationStore.getState().nextClaim();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = currentClaim ? useValidationStore.getState().results.get(claimUid(currentClaim)) : undefined;
        if (r) useValidationStore.getState().nextUnreviewed();
      } else if (e.key === 'Escape') {
        if (currentClaim) {
          e.preventDefault();
          useValidationStore.getState().clearVerdict(claimUid(currentClaim));
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentClaim]);

  if (loading && !loaded) {
    return (
      <div className="validation-loading">
        Loading golden set...
      </div>
    );
  }

  return (
    <div className="validation-tab">
      <ClaimListSidebar width={leftWidth} onResizeMouseDown={onLeftResize} />
      <ClaimDetail claim={currentClaim} />
      <AttributionPanel claim={currentClaim} width={rightWidth} onResizeMouseDown={onRightResize} />
    </div>
  );
}
