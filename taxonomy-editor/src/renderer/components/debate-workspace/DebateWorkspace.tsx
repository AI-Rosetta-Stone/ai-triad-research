// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useRef, useEffect, useCallback, useMemo, Fragment } from 'react';
import { api } from '@bridge';
import { useDebateStore } from '../../hooks/useDebateStore';
import { isRunLeaseHeldLocally, getRemoteRunLeaseHolder } from '../../hooks/useDebateStore/shared/debateRunLease';
import { isCompressionDue } from '../../hooks/useDebateStore/shared/compressionTrigger';
import { useLongPressSelectionMenu } from '../../hooks/useLongPressSelectionMenu';
import { useShallow } from 'zustand/react/shallow';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import type { SpeakerId } from '../../types/debate';
import { NeutralEvaluationPanel } from '../analysis/NeutralEvaluationPanel';
import { ParameterHistoryPanel } from '../analysis/ParameterHistoryPanel';
import { computeCoverageMap, computeStrengthWeightedCoverage } from '@lib/debate/coverageTracker';
import type { CoverageMap, StrengthWeightedCoverage } from '@lib/debate/coverageTracker';
import {
  speakerLabel, speakerColor, nodeIdToTab, focusMainWindowNode, countOccurrences, renderedOffsetOf,
  META_TIERS, TIER_LABELS, copyPromptForGemini,
} from './utils';
import type { AdaptivePhase } from './utils';
import { CommentCreationPopover } from '../chat/CommentCreationPopover';
import type { CommentPopoverState } from '../chat/CommentCreationPopover';
import { CommentSidebar } from '../chat/CommentSidebar';
import { DetailPane } from '../shared/DetailPane';
import { useCommentStore } from '../../hooks/useCommentStore';
import type { DetailTier } from '@lib/debate/comments';
import { UsernamePromptDialog } from '../shared/UsernamePromptDialog';
import { DiagnosticsChatSidebar } from '../debate-diagnostics/chat';
import type { NavigateCommand } from '../debate-diagnostics/chat';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { initDebatePopoutCloseHandler, isDebatePopoutWindow } from '../../hooks/useDebateStore/shared/guards';
import { RemoteDriverOverlay } from './RemoteDriverOverlay';
import { requestExplainForSelection } from './explainRequestBus';
import { useCommunityStore } from '../../hooks/useCommunityStore';
import { useUserProfile } from '../../hooks/useAuthStatus';
import { CommunityShareBanner } from '../shared/CommunityShareBanner';
import { DebateHeader } from './DebateHeader';
import { DebateSetupDialog } from './DebateSetupDialog';
import { StatementCard, ProbingCard, FactCheckCard, EntryDeleteControls, HighlightedText, PhaseHairline } from './StatementCard';
import { DebaterToggles, DebateActions } from './DebateActionBar';
import { DebatePhaseIndicators } from './DebatePhaseIndicators';
import { StatementProgressIndicator } from './StatementProgressIndicator';
import { ClarificationActions, ClaimsEditor, RefinedTopicEditor, TopicScoreComparison } from './ClarificationPanel';
import { OpeningActions } from './OpeningPanel';
import { ExplorationSummaryCard } from './ExplorationSummaryCard';
import { EmptyState } from '../shared/EmptyState';
import { TranscriptOutline } from './TranscriptOutline';
import { useFlag } from '../../hooks/useFeatureFlags';
import './DebateWorkspace.css';

// ── Phase 7: Context menu state ──────────────────────────
interface ContextMenuState {
  x: number;
  y: number;
  selectedText: string;
  entryId: string;
  isPoverStatement: boolean;
  tier: DetailTier;
  startOffset: number;
  endOffset: number;
}

const PHASE_TITLES: Record<string, string> = {
  setup: 'Setting up...',
  clarification: 'Topic Refinement',
  opening: 'Opening Statements',
  debate: 'Debate',
  closed: 'Debate Closed',
};

const EXPORT_FORMATS_INLINE = [
  { id: 'json', label: 'JSON' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'text', label: 'Plain Text' },
  { id: 'pdf', label: 'PDF' },
  { id: 'package', label: 'Package (ZIP)' },
];

function ExportButtonInline({ onExport }: { onExport: (format: string) => void }) {
  const [showMenu, setShowMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowMenu(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block', marginLeft: 'auto' }}>
      <button className="btn btn-sm" onClick={() => setShowMenu(!showMenu)} title="Export debate">
        Export &#9662;
      </button>
      {showMenu && (
        <div className="export-format-menu">
          {EXPORT_FORMATS_INLINE.map(f => (
            <button
              key={f.id}
              className="export-format-item"
              onClick={() => { onExport(f.id); setShowMenu(false); }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ShareToCommunityButton({ debate }: { debate: { id: string; topic: string; transcript: unknown[] } }) {
  const [shareState, setShareState] = useState<'idle' | 'sharing' | 'success' | 'error'>('idle');
  const [shareError, setShareError] = useState<string | null>(null);
  const submitItem = useCommunityStore(s => s.submitItem);
  const communityUrl = useTaxonomyStore(s => s.communityServerUrl);
  const profile = useUserProfile();

  const handleShare = async () => {
    setShareState('sharing');
    setShareError(null);
    try {
      const submissionId = await submitItem('debate', debate);
      setShareState('success');
      getGlobalRecorder()?.record({
        type: 'lifecycle',
        component: 'debate-workspace',
        level: 'info',
        message: 'community.submit.ok',
        data: { debateId: debate.id, submissionId },
      });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-workspace',
        level: 'error',
        message: 'Failed to submit debate to community',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      const raw = (err as Error).message;
      const reason = raw.replace(/^(Error:\s*)+/i, '').replace(/^Error invoking remote method '[^']+': /i, '');
      setShareError(reason || 'Unknown error');
      setShareState('error');
    }
  };

  const configured = !isElectronLike() || !!communityUrl;

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className="btn btn-sm"
        onClick={handleShare}
        disabled={shareState !== 'idle' || !configured}
        title={!configured ? 'Set Community Server URL in Settings first' : 'Submit this debate for community review'}
      >
        {shareState === 'sharing' ? 'Sharing...' : 'Share'}
      </button>
      {shareState === 'success' && (
        <CommunityShareBanner
          itemType="debate"
          onDismiss={() => setShareState('idle')}
        />
      )}
      {shareState === 'error' && shareError && (
        <span
          className="debate-toolbar-status"
          style={{ color: 'var(--danger, #ef4444)', marginLeft: 4, fontSize: '0.75rem' }}
          title={shareError}
        >
          {'Failed: ' + shareError}
          <button
            onClick={() => { setShareState('idle'); setShareError(null); }}
            style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, fontSize: 'inherit' }}
            aria-label="Dismiss error"
          >✕</button>
        </span>
      )}
    </span>
  );
}

function isElectronLike(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}

// ── Similar POVs panel ───────────────────────────────────

function DebateSimilarPovPanel({ query, onClose }: { query: string; onClose: () => void }) {
  const { semanticResults, getLabelForId } = useTaxonomyStore();
  const [searching, setSearching] = useState(true);
  const isFirstRender = useRef(true);

  // Don't mark done on the initial mount (semanticResults may be stale from a previous search);
  // only react to genuine updates that arrive after this component mounts.
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    setSearching(false);
  }, [semanticResults]);

  const rows = semanticResults.filter(r => r.score >= 0.4).slice(0, 20);
  const truncatedQuery = query.length > 70 ? query.slice(0, 67) + '…' : query;

  return (
    <div className="debate-similar-pov-panel">
      <div className="debate-similar-pov-header">
        <span className="debate-similar-pov-title">Similar Perspectives</span>
        <span className="debate-similar-pov-query" title={query}>&ldquo;{truncatedQuery}&rdquo;</span>
        <button className="debate-find-close" onClick={onClose} title="Close">×</button>
      </div>
      {searching ? (
        <div className="debate-similar-pov-status">Searching…</div>
      ) : rows.length === 0 ? (
        <div className="debate-similar-pov-status">No similar POVs found.</div>
      ) : (
        <div className="debate-similar-pov-rows">
          {rows.map(r => {
            const label = getLabelForId(r.id);
            const { colorVar } = nodeIdToTab(r.id);
            return (
              <button
                key={r.id}
                className="debate-similar-pov-row"
                onClick={() => focusMainWindowNode(r.id)}
                title={label}
              >
                <span className="debate-similar-pov-score">{Math.round(r.score * 100)}%</span>
                <span className="debate-similar-pov-id" style={{ color: colorVar }}>{r.id}</span>
                <span className="debate-similar-pov-label">{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Find bar ─────────────────────────────────────────────

function FindBar({ query, onQueryChange, current, total, onPrev, onNext, onClose }: {
  query: string; onQueryChange: (q: string) => void;
  current: number; total: number;
  onPrev: () => void; onNext: () => void; onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  return (
    <div className="debate-find-bar">
      <input
        ref={inputRef}
        className="debate-find-input"
        type="text"
        placeholder="Find in debate…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? onPrev() : onNext(); }
        }}
      />
      <span className="debate-find-count">
        {total === 0 ? (query ? 'No results' : '') : `${current + 1} / ${total}`}
      </span>
      <button className="debate-find-nav" onClick={onPrev} disabled={total === 0} title="Previous (Shift+Enter)">▲</button>
      <button className="debate-find-nav" onClick={onNext} disabled={total === 0} title="Next (Enter)">▼</button>
      <button className="debate-find-close" onClick={onClose} title="Close (Esc)">×</button>
    </div>
  );
}

// ── Context menu ─────────────────────────────────────────

/** Custom context menu for debate text selection */
function DebateContextMenu({
  menu,
  onClose,
  onSimilarPovSearch,
  onComment,
}: {
  menu: ContextMenuState;
  onClose: () => void;
  onSimilarPovSearch: (query: string) => void;
  onComment: () => void;
}) {
  const { factCheckSelection, debateGenerating } = useDebateStore(
    useShallow(s => ({ factCheckSelection: s.factCheckSelection, debateGenerating: s.debateGenerating }))
  );
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleCopy = () => {
    void api.clipboardWriteText(menu.selectedText);
    onClose();
  };

  const handleSearchGoogle = () => {
    const query = encodeURIComponent(menu.selectedText.slice(0, 200));
    void api.openExternal(`https://www.google.com/search?q=${query}`);
    onClose();
  };

  const handleSimilarPovs = () => {
    onSimilarPovSearch(menu.selectedText);
    onClose();
  };

  const handleFactCheck = async () => {
    onClose();
    await factCheckSelection(menu.selectedText, menu.entryId);
  };

  const truncatedText = menu.selectedText.length > 40
    ? menu.selectedText.slice(0, 37) + '...'
    : menu.selectedText;

  return (
    <div
      ref={menuRef}
      className="debate-context-menu"
      style={{ left: menu.x, top: menu.y }}
    >
      <button className="debate-context-menu-item" onClick={handleCopy}>
        Copy
      </button>
      <button className="debate-context-menu-item" onClick={handleSearchGoogle}>
        Search Google for &lsquo;{truncatedText}&rsquo;
      </button>
      <button className="debate-context-menu-item" onClick={handleSimilarPovs}>
        Similar Perspectives for &lsquo;{truncatedText}&rsquo;
      </button>
      <button className="debate-context-menu-item" onClick={() => {
        // t/4514: open the same inline in-app panel the card's "Explain" button uses, scoped to
        // this selection, via the entry's registered handler. No handler registered (panel not
        // mounted for this entry) falls back to the copy+open escape hatch — routed through
        // copyPromptForGemini (t/4645) so a failed clipboard write never opens Gemini. This
        // fallback has no persistent surface to show a confirmation on first, unlike
        // ExplainPanel's "Copy prompt & open Gemini" button — see t/4645 completion note.
        if (!requestExplainForSelection(menu.entryId, menu.selectedText)) {
          void copyPromptForGemini(`EXPLAIN: ${menu.selectedText}`).then((ok) => {
            if (ok) void api.openExternal('https://gemini.google.com/app');
          });
        }
        onClose();
      }}>
        Explain&hellip;
      </button>
      {menu.isPoverStatement && (
        <button
          className="debate-context-menu-item debate-context-menu-fact-check"
          onClick={handleFactCheck}
          disabled={!!debateGenerating}
        >
          Fact check
        </button>
      )}
      {menu.entryId && (
        <button className="debate-context-menu-item" onClick={onComment}>
          Add Comment
        </button>
      )}
    </div>
  );
}

// ── Extracted render regions (ADR-007 verbatim line-slice, t/1876) ───────
// The blocks below were lifted verbatim out of DebateWorkspace's render tree to
// drop its cyclomatic complexity; each guard is preserved exactly (moved inside
// the region where that removes a parent decision point). No behavioral change.

type DWStore = ReturnType<typeof useDebateStore.getState>;
type CommentStoreState = ReturnType<typeof useCommentStore.getState>;
type ActiveDebateSession = NonNullable<DWStore['activeDebate']>;
type ActiveTranscriptEntry = ActiveDebateSession['transcript'][number];

type GlobalTextTier = 'brief' | 'medium' | 'detailed';
type GlobalAnalysisTier = 'reasoning' | 'claims' | 'convergence';
const GLOBAL_TEXT_TIERS: GlobalTextTier[] = ['brief', 'medium', 'detailed'];
const GLOBAL_ANALYSIS_TIERS: GlobalAnalysisTier[] = ['reasoning', 'claims', 'convergence'];
const GLOBAL_TIER_TITLES: Record<string, string> = {
  brief: 'Set all turns to brief (2–3 sentences)', medium: 'Set all turns to medium (key points)',
  detailed: 'Set all turns to full content', reasoning: 'Show brief, plan & BDI (replaces text)',
  claims: 'Show argument network claims', convergence: 'Show convergence diagnostics',
};
const GLOBAL_MODE_IDS = [{ id: 'text', label: 'Text' }, { id: 'analysis', label: 'Analysis' }] as const;

function GlobalModeControl({ defaultTier, setDefaultTier }: {
  defaultTier: DWStore['defaultDisplayTier'];
  setDefaultTier: DWStore['setDefaultDisplayTier'];
}) {
  const activeMode = META_TIERS.has(defaultTier) ? 'analysis' : 'text';
  const [lastText, setLastText] = useState<GlobalTextTier>(
    activeMode === 'text' ? (defaultTier as GlobalTextTier) : 'detailed'
  );
  const [lastAnalysis, setLastAnalysis] = useState<GlobalAnalysisTier>(
    activeMode === 'analysis' ? (defaultTier as GlobalAnalysisTier) : 'reasoning'
  );

  useEffect(() => {
    if (META_TIERS.has(defaultTier)) setLastAnalysis(defaultTier as GlobalAnalysisTier);
    else setLastText(defaultTier as GlobalTextTier);
  }, [defaultTier]);

  const subTiers = activeMode === 'text' ? GLOBAL_TEXT_TIERS : GLOBAL_ANALYSIS_TIERS;
  const modeRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleModeSelect = useCallback((mode: 'text' | 'analysis') => {
    if (mode === activeMode) return;
    setDefaultTier(mode === 'text' ? lastText : lastAnalysis);
  }, [activeMode, lastText, lastAnalysis, setDefaultTier]);

  const handleSubSelect = useCallback((tier: string) => {
    setDefaultTier(tier as GlobalTextTier | GlobalAnalysisTier);
    if (activeMode === 'text') setLastText(tier as GlobalTextTier);
    else setLastAnalysis(tier as GlobalAnalysisTier);
  }, [activeMode, setDefaultTier]);

  const handleModeKey = useCallback((e: { key: string; preventDefault(): void }, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % 2;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + 2) % 2;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 1;
    else return;
    e.preventDefault();
    handleModeSelect(GLOBAL_MODE_IDS[next].id);
    requestAnimationFrame(() => modeRefs.current[next]?.focus());
  }, [handleModeSelect]);

  return (
    <span className="debate-tier-global" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span role="radiogroup" aria-label="View mode" className="debate-mode-group">
        {GLOBAL_MODE_IDS.map(({ id, label }, i) => (
          <button
            key={id}
            ref={el => { modeRefs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={activeMode === id}
            tabIndex={activeMode === id ? 0 : -1}
            className={`debate-mode-seg${activeMode === id ? ' debate-mode-seg-active' : ''}`}
            onClick={() => handleModeSelect(id)}
            onKeyDown={(e) => handleModeKey(e, i)}
          >
            {label}
          </button>
        ))}
      </span>
      {/* Value selector — native <select> dropdown (t/2274 §13). Global control has
          no per-statement override, so no dot / match-global item here. */}
      <select
        className="debate-detail-dropdown debate-value-dropdown"
        aria-label={activeMode === 'text' ? 'Text detail level' : 'Analysis view'}
        value={defaultTier}
        title={GLOBAL_TIER_TITLES[defaultTier]}
        onChange={(e) => handleSubSelect(e.target.value)}
      >
        {subTiers.map(tier => (
          <option key={tier} value={tier}>{TIER_LABELS[tier]}</option>
        ))}
      </select>
    </span>
  );
}

function DebateToolbar({
  activeDebate, isExploration, onShowSetup,
  commentSidebarOpen, toggleCommentSidebar, commentsFile,
  exportStatus, onExport, diagnosticsEnabled, toggleDiagnostics,
  defaultTier, setDefaultTier, headerVariant = false,
}: {
  activeDebate: ActiveDebateSession;
  isExploration: boolean;
  onShowSetup: () => void;
  commentSidebarOpen: boolean;
  toggleCommentSidebar: () => void;
  commentsFile: CommentStoreState['commentsFile'];
  exportStatus?: string | null;
  onExport?: (format: string) => void;
  diagnosticsEnabled: boolean;
  toggleDiagnostics: () => void;
  defaultTier: DWStore['defaultDisplayTier'];
  setDefaultTier: DWStore['setDefaultDisplayTier'];
  // When true, renders as the action cluster inside the redesigned header's Band 1
  // (t/2293): the standalone title span is dropped (the header h2 carries the topic)
  // and the frozen `.debate-toolbar` bar chrome is neutralized via `.debate-hdr-actions`.
  headerVariant?: boolean;
}) {
  return (
    <div className={`debate-toolbar${headerVariant ? ' debate-hdr-actions' : ''}`}>
      {!headerVariant && (
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', userSelect: 'all', marginRight: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 300 }} title={`${activeDebate.title} — ${activeDebate.id}`}>
          {activeDebate.title || activeDebate.id.slice(0, 12)}
        </span>
      )}
      {isExploration && (
        <span className="debate-exploration-badge" title="Exploration run — quick discovery with a cheap model">
          Exploration
        </span>
      )}
      <button
        className="btn btn-sm"
        onClick={onShowSetup}
        title="View full topic, source, and debate configuration"
      >
        Setup
      </button>
      <button
        className={`btn btn-sm${commentSidebarOpen ? ' active' : ''}`}
        onClick={toggleCommentSidebar}
        title={commentSidebarOpen ? 'Hide comments sidebar' : 'Show comments sidebar'}
      >
        Comments ({commentsFile?.comments?.length ?? 0})
      </button>
      {exportStatus && (
        <span className="debate-toolbar-status">{exportStatus}</span>
      )}
      {onExport && (
        <ExportButtonInline onExport={onExport} />
      )}
      <ShareToCommunityButton debate={activeDebate as unknown as { id: string; topic: string; transcript: unknown[] }} />
      <button
        className={`btn btn-sm debate-diag-btn${diagnosticsEnabled ? ' active' : ''}`}
        onClick={toggleDiagnostics}
        title={diagnosticsEnabled ? 'Disable diagnostics mode' : 'Enable diagnostics mode — click entries to inspect'}
      >
        {diagnosticsEnabled ? 'Diagnostics ON' : 'Diagnostics'}
      </button>
      <GlobalModeControl defaultTier={defaultTier} setDefaultTier={setDefaultTier} />
    </div>
  );
}

function DebatePhaseHeader({ activeDebate, isDebatePhase, isOpeningPhase }: {
  activeDebate: ActiveDebateSession;
  isDebatePhase: boolean;
  isOpeningPhase: boolean;
}) {
  return (
    <>
      <DebatePhaseIndicators activeDebate={activeDebate} isDebatePhase={isDebatePhase} />

      {/* Debater toggle pills */}
      {(isDebatePhase || isOpeningPhase) && (
        <DebaterToggles />
      )}

      {/* Refined topic editor + score comparison (hidden once debate has substantive entries) */}
      {activeDebate.topic.refined && (activeDebate.phase === 'setup' || activeDebate.phase === 'clarification' || activeDebate.phase === 'edit-claims') && !activeDebate.transcript.some(e => e.type === 'opening' || e.type === 'statement') && (
        <>
          <RefinedTopicEditor />
          <TopicScoreComparison />
        </>
      )}
    </>
  );
}

function isOpeningStart(type: string, prevType: string | null): boolean {
  return type === 'opening' && prevType !== 'opening';
}

function isDebateStart(type: string, prevType: string | null): boolean {
  return (type === 'statement' || type === 'cross_respond') && prevType !== 'statement' && prevType !== 'cross_respond' && prevType !== 'probing' && prevType !== 'fact-check' && prevType !== 'system' && prevType !== 'question';
}

function isSynthesisStart(type: string, prevType: string | null): boolean {
  return (type === 'synthesis' || type === 'concluding') && prevType !== 'synthesis' && prevType !== 'concluding';
}

/** Phase-transition hairline for a transcript position, or null. Extracted verbatim (t/1876). */
function computeTranscriptHairline(entry: ActiveTranscriptEntry, idx: number, transcript: ActiveTranscriptEntry[]): React.ReactNode {
  let prevVisibleIdx = -1;
  for (let i = idx - 1; i >= 0; i--) {
    if (transcript[i].type !== 'clarification') { prevVisibleIdx = i; break; }
  }
  const prevType: string | null = prevVisibleIdx >= 0 ? transcript[prevVisibleIdx].type : null;
  const type = entry.type as string;
  if (isOpeningStart(type, prevType)) {
    return <PhaseHairline key={`hairline-opening-${idx}`} label="Opening Statements" />;
  }
  if (isDebateStart(type, prevType)) {
    return <PhaseHairline key={`hairline-debate-${idx}`} label="Cross-Examination" />;
  }
  if (isSynthesisStart(type, prevType)) {
    return <PhaseHairline key={`hairline-synthesis-${idx}`} label="Synthesis" />;
  }
  return null;
}

function TranscriptEntryRow({
  entry, idx, activeDebate, findOffsets, findQuery, findCurrentIndex,
  diagnosticsEnabled, selectedDiagEntry, selectDiagEntry,
}: {
  entry: ActiveTranscriptEntry;
  idx: number;
  activeDebate: ActiveDebateSession;
  findOffsets: Map<string, number>;
  findQuery: string;
  findCurrentIndex: number;
  diagnosticsEnabled: boolean;
  selectedDiagEntry: DWStore['selectedDiagEntry'];
  selectDiagEntry: DWStore['selectDiagEntry'];
}) {
  const matchOffset = findOffsets.get(entry.id) ?? 0;
  // Statement ID — stable human-readable label for this transcript position.
  // Matches ClaimExtractionTrace.round (transcript index + 1) so cross-panel
  // references line up (e.g. Extraction Timeline "S12" == this card's "S12").
  const statementId = `S${idx + 1}`;
  // Skip the clarification transcript card — the interactive ClarificationActions panel
  // below the transcript already shows the questions as clickable pills.
  if (entry.type === 'clarification') return null;

  const hairline = computeTranscriptHairline(entry, idx, activeDebate.transcript);

  // Slot-first opening lifecycle (t/2907): a 'generating'/'retrying'/'error' opening
  // slot renders its state INLINE on the speaker's own card (content is empty until
  // 'done'), so one card cycles through the states instead of spawning new panels +
  // system retry toasts. 'done' and legacy openings (no status) fall through to the
  // normal StatementCard below.
  if (entry.type === 'opening' && entry.status && entry.status !== 'done') {
    const isError = entry.status === 'error';
    const typeLabel = entry.status === 'generating' ? 'thinking…' : entry.status === 'retrying' ? 'retrying…' : 'failed';
    return (
      <Fragment>
        {hairline}
        <div id={`debate-entry-${entry.id}`} className="debate-entry-wrapper">
          <div className={`debate-statement debate-generating${isError ? ' debate-slot-error' : ''}`}>
            <div className="debate-statement-header">
              <span className="debate-statement-speaker" style={{ color: speakerColor(entry.speaker) || undefined }}>
                {speakerLabel(entry.speaker)}
              </span>
              <span className="debate-statement-type">{typeLabel}</span>
            </div>
            {isError ? (
              <div className="debate-slot-error-message">
                {entry.errorMessage ?? 'Opening statement failed.'}
              </div>
            ) : (
              <>
                <StatementProgressIndicator />
                {entry.errorMessage && <div className="debate-slot-retry-note">{entry.errorMessage}</div>}
              </>
            )}
          </div>
        </div>
      </Fragment>
    );
  }

  const isStatement = entry.type !== 'probing' && entry.type !== 'fact-check';
  const card = entry.type === 'probing'
    ? <ProbingCard key={entry.id} entry={entry} statementId={statementId} />
    : entry.type === 'fact-check'
    ? <FactCheckCard key={entry.id} entry={entry} statementId={statementId} findQuery={findQuery} matchOffset={matchOffset} findCurrentIndex={findCurrentIndex} />
    : <StatementCard key={entry.id} entry={entry} statementId={statementId} findQuery={findQuery} matchOffset={matchOffset} findCurrentIndex={findCurrentIndex} entryIndex={idx} totalEntries={activeDebate.transcript.length} />;
  return (
    <Fragment>
      {hairline}
      <div
        id={`debate-entry-${entry.id}`}
        className={`debate-entry-wrapper${diagnosticsEnabled && selectedDiagEntry === entry.id ? ' diag-selected' : ''}`}
        onClick={diagnosticsEnabled ? () => selectDiagEntry(entry.id) : undefined}
      >
        {card}
        {!isStatement && <EntryDeleteControls entry={entry} totalEntries={activeDebate.transcript.length} entryIndex={idx} />}
      </div>
    </Fragment>
  );
}

function DebateTranscriptColumn({
  activeDebate, debateGenerating, findOffsets, findQuery, findCurrentIndex,
  diagnosticsEnabled, selectedDiagEntry, selectDiagEntry, transcriptEndRef,
}: {
  activeDebate: ActiveDebateSession;
  debateGenerating: DWStore['debateGenerating'];
  findOffsets: Map<string, number>;
  findQuery: string;
  findCurrentIndex: number;
  diagnosticsEnabled: boolean;
  selectedDiagEntry: DWStore['selectedDiagEntry'];
  selectDiagEntry: DWStore['selectDiagEntry'];
  transcriptEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      {/* Transcript */}
      <div className="debate-transcript-column">
      {activeDebate.transcript.length === 0 && !debateGenerating && (
        <EmptyState
          headline="The debate is ready to begin"
          direction="Clarification questions will appear here."
        />
      )}
      {activeDebate.transcript.map((entry, idx) => (
        <TranscriptEntryRow
          key={entry.id}
          entry={entry}
          idx={idx}
          activeDebate={activeDebate}
          findOffsets={findOffsets}
          findQuery={findQuery}
          findCurrentIndex={findCurrentIndex}
          diagnosticsEnabled={diagnosticsEnabled}
          selectedDiagEntry={selectedDiagEntry}
          selectDiagEntry={selectDiagEntry}
        />
      ))}
      </div>
      {/* Global "thinking" card for generation WITHOUT its own slot (clarification,
          synthesis, cross-respond statements). During opening generation the speaker
          has an active opening slot that renders its own inline spinner (t/2907), so
          suppress this one then — otherwise it double-cards. */}
      {debateGenerating && !activeDebate.transcript.some(
        e => e.type === 'opening' && e.speaker === debateGenerating && e.status && e.status !== 'done',
      ) && (
        <div className="debate-statement debate-generating">
          <div className="debate-statement-header">
            <span className="debate-statement-speaker" style={{ color: speakerColor(debateGenerating) || undefined }}>
              {speakerLabel(debateGenerating)}
            </span>
            <span className="debate-statement-type">thinking...</span>
          </div>
          <StatementProgressIndicator />
        </div>
      )}
      <div ref={transcriptEndRef} />
    </>
  );
}

function PhaseActionBar({
  showRemoteOverlay, activeDebate, isClarificationPhase, isEditClaimsPhase, isOpeningPhase, isDebatePhase, isExplorationClosed,
  showParamHistory, setShowParamHistory, showEvaluation, setShowEvaluation,
}: {
  showRemoteOverlay: boolean;
  activeDebate: ActiveDebateSession;
  isClarificationPhase: boolean;
  isEditClaimsPhase: boolean;
  isOpeningPhase: boolean;
  isDebatePhase: boolean;
  isExplorationClosed: boolean;
  showParamHistory: boolean;
  setShowParamHistory: React.Dispatch<React.SetStateAction<boolean>>;
  showEvaluation: boolean;
  setShowEvaluation: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  // Phase-aware action bar (fixed at bottom) — hidden when popout is driving
  if (showRemoteOverlay) return null;
  return (
    <>
      {isClarificationPhase && !activeDebate.transcript.some(e => e.type === 'opening' || e.type === 'statement') && <ClarificationActions />}
      {isEditClaimsPhase && <ClaimsEditor />}
      {isOpeningPhase && <OpeningActions />}
      {isDebatePhase && !isExplorationClosed && <DebateActions showParamHistory={showParamHistory} setShowParamHistory={setShowParamHistory} showEvaluation={showEvaluation} setShowEvaluation={setShowEvaluation} />}
    </>
  );
}

function NeutralEvalSlot({ showEvaluation, activeDebate, onClose }: { showEvaluation: boolean; activeDebate: ActiveDebateSession; onClose: () => void }) {
  if (!showEvaluation || !activeDebate.neutral_evaluations || activeDebate.neutral_evaluations.length === 0) return null;
  return (
    <NeutralEvaluationPanel
      evaluations={activeDebate.neutral_evaluations}
      speakerMapping={activeDebate.neutral_speaker_mapping}
      onClose={onClose}
    />
  );
}

// Evaluation + parameter-history panels live inside the transcript's scroll column
// (t/3843) — rendering them as siblings of .debate-scroll-content let their content
// outgrow the fixed-height .debate-workspace and clip against its overflow:hidden,
// while squeezing the transcript's own scroll area toward zero height.
function DebateScrollPanels({
  activeDebate, showEvaluation, setShowEvaluation, showParamHistory, setShowParamHistory,
}: {
  activeDebate: ActiveDebateSession;
  showEvaluation: boolean;
  setShowEvaluation: React.Dispatch<React.SetStateAction<boolean>>;
  showParamHistory: boolean;
  setShowParamHistory: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <>
      {/* Neutral evaluation panel — toggled via Evaluation button */}
      <NeutralEvalSlot
        showEvaluation={showEvaluation}
        activeDebate={activeDebate}
        onClose={() => setShowEvaluation(false)}
      />

      {/* Parameter calibration history */}
      {showParamHistory && (
        <ParameterHistoryPanel onClose={() => setShowParamHistory(false)} />
      )}
    </>
  );
}

function DebateActionRegion({
  activeDebate, isExplorationClosed, explorationSummary,
  showRemoteOverlay, isClarificationPhase, isEditClaimsPhase, isOpeningPhase, isDebatePhase,
  showParamHistory, setShowParamHistory, showEvaluation, setShowEvaluation,
}: {
  activeDebate: ActiveDebateSession;
  isExplorationClosed: boolean;
  explorationSummary: DWStore['explorationSummary'];
  showRemoteOverlay: boolean;
  isClarificationPhase: boolean;
  isEditClaimsPhase: boolean;
  isOpeningPhase: boolean;
  isDebatePhase: boolean;
  showParamHistory: boolean;
  setShowParamHistory: React.Dispatch<React.SetStateAction<boolean>>;
  showEvaluation: boolean;
  setShowEvaluation: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <>
      {/* Exploration summary card — shown when exploration debate closes */}
      {isExplorationClosed && explorationSummary && <ExplorationSummaryCard />}

      <PhaseActionBar
        showRemoteOverlay={showRemoteOverlay}
        activeDebate={activeDebate}
        isClarificationPhase={isClarificationPhase}
        isEditClaimsPhase={isEditClaimsPhase}
        isOpeningPhase={isOpeningPhase}
        isDebatePhase={isDebatePhase}
        isExplorationClosed={isExplorationClosed}
        showParamHistory={showParamHistory}
        setShowParamHistory={setShowParamHistory}
        showEvaluation={showEvaluation}
        setShowEvaluation={setShowEvaluation}
      />
    </>
  );
}

function DebateModals({
  contextMenu, setContextMenu, commentPopover, setCommentPopover,
  onSimilarPovSearch, commentSidebarOpen, commentsFile,
}: {
  contextMenu: ContextMenuState | null;
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
  commentPopover: CommentPopoverState | null;
  setCommentPopover: React.Dispatch<React.SetStateAction<CommentPopoverState | null>>;
  onSimilarPovSearch: (query: string) => void;
  commentSidebarOpen: boolean;
  commentsFile: CommentStoreState['commentsFile'];
}) {
  return (
    <>
      {/* Phase 7: Context menu */}
      {contextMenu && (
        <DebateContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onSimilarPovSearch={onSimilarPovSearch}
          onComment={() => {
            setCommentPopover({
              x: contextMenu.x,
              y: contextMenu.y,
              selectedText: contextMenu.selectedText,
              entryId: contextMenu.entryId,
              tier: contextMenu.tier,
              startOffset: contextMenu.startOffset,
              endOffset: contextMenu.endOffset,
            });
            setContextMenu(null);
          }}
        />
      )}

      {/* Comment creation popover */}
      {commentPopover && (
        <CommentCreationPopover
          popover={commentPopover}
          onClose={() => setCommentPopover(null)}
        />
      )}

      {/* Comment sidebar */}
      {commentSidebarOpen && commentsFile && (
        <CommentSidebar />
      )}

      {/* Username prompt dialog (mounted once for all comment flows) */}
      <UsernamePromptDialog />
    </>
  );
}

function DebateSideRail({
  debateChatOpen, setDebateChatOpen, activeDebate, onChatNavigate, selectedRef, setSelectedRef,
}: {
  debateChatOpen: boolean;
  setDebateChatOpen: React.Dispatch<React.SetStateAction<boolean>>;
  activeDebate: ActiveDebateSession;
  onChatNavigate: (cmd: NavigateCommand) => void;
  selectedRef: DWStore['selectedRef'];
  setSelectedRef: DWStore['setSelectedRef'];
}) {
  return (
    <>
      {/* Debate Chat FAB — bottom-right floating button */}
      <button
        className={`debate-chat-fab${debateChatOpen ? ' active' : ''}`}
        onClick={() => setDebateChatOpen(v => !v)}
        title={debateChatOpen ? 'Hide Debate Chat' : 'Open Debate Chat — ask questions about the debate'}
        aria-label="Debate Chat"
      >
        {debateChatOpen ? '✕' : '💬'}
      </button>
      {/* Debate Chat sidebar — outside workspace column, inside row */}
      {debateChatOpen && (
        <DiagnosticsChatSidebar
          debate={activeDebate}
          selectedEntry={null}
          currentTab="transcript"
          onNavigate={onChatNavigate}
          embedded
          onClose={() => setDebateChatOpen(false)}
        />
      )}
      {/* Reference detail pane — opens when a transcript ID-ref link is selected (t/1776) */}
      {selectedRef && (
        <DetailPane
          className="debate-detail-pane"
          selectedRef={selectedRef}
          onSelectRef={setSelectedRef}
          onClose={() => setSelectedRef(null)}
        />
      )}
    </>
  );
}

// ── Extracted effect / memo hooks (ADR-007, t/1876) ──────────────────────
// Side-effect and derived-state logic lifted verbatim out of DebateWorkspace.
// Purely a relocation — the effects, memos, and their dependency arrays are
// unchanged, which is what drops the parent's cyclomatic count (each `?.` in a
// dependency array is a decision point in whichever function owns it).

function useDebateWorkspaceEffects({
  activeDebate, setDiagPopoutOpen, extractExplorationSummary,
  loadDebateComments, unloadComments, saveDebate, debateGenerating, compressOldTranscript,
  communityReadOnly,
}: {
  activeDebate: DWStore['activeDebate'];
  setDiagPopoutOpen: DWStore['setDiagPopoutOpen'];
  extractExplorationSummary: DWStore['extractExplorationSummary'];
  loadDebateComments: CommentStoreState['loadComments'];
  unloadComments: CommentStoreState['unloadComments'];
  saveDebate: DWStore['saveDebate'];
  debateGenerating: DWStore['debateGenerating'];
  compressOldTranscript: DWStore['compressOldTranscript'];
  communityReadOnly: DWStore['communityReadOnly'];
}) {
  const explorationExtracted = useRef<string | null>(null);
  const hasTriggeredOpening = useRef(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compressionCooldownRef = useRef<number>(0);

  // Listen for diagnostics popout window closing
  useEffect(() => {
    const unsub = api.onDiagnosticsPopoutClosed(() => {
      setDiagPopoutOpen(false);
    });
    return unsub;
  }, [setDiagPopoutOpen]);

  // Listen for debate popout window closing — release driver lock and reload state
  useEffect(() => {
    return initDebatePopoutCloseHandler(api);
  }, []);

  // Listen for re-extract claims requests from popout (t/226)
  useEffect(() => {
    const unsub = api.onReExtractClaims((entryId: string) => {
      void useDebateStore.getState().reExtractClaims(entryId);
    });
    return unsub;
  }, []);

  // Auto-extract exploration summary when an exploration debate closes
  useEffect(() => {
    if (
      activeDebate?.protocol_id === 'exploration'
      && activeDebate.phase === 'closed'
      && explorationExtracted.current !== activeDebate.id
    ) {
      explorationExtracted.current = activeDebate.id;
      extractExplorationSummary();
    }
  }, [activeDebate?.id, activeDebate?.phase, activeDebate?.protocol_id, extractExplorationSummary]);

  // Load comments when debate changes. Skip for community/read-only debates —
  // they live in a shared namespace with no personal comments blob, so the load
  // 404s repeatedly with a misleading "may have been deleted" error (t/2433).
  useEffect(() => {
    if (activeDebate && !communityReadOnly) {
      void loadDebateComments(activeDebate.id);
    }
    return () => unloadComments();
  }, [activeDebate?.id, communityReadOnly, loadDebateComments, unloadComments]);

  // Phase 8: Auto-save debounced (2s after last change)
  useEffect(() => {
    if (!activeDebate) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      void saveDebate('DebateWorkspace:autoSave');
    }, 2000);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [activeDebate?.transcript.length, activeDebate?.updated_at, saveDebate]);

  // Phase 8: Auto-compress context when transcript grows large
  useEffect(() => {
    if (!activeDebate || debateGenerating) return;
    // t/3917: while an automatic run owns this debate (in this window or another), the run
    // compresses between rounds itself (clarificationSlice compressIfDue). Under Option A
    // the owner may not even mount this workspace. A viewer compressing would waste an AI
    // call whose save is skipped; the holder's UI compressing would race the run.
    if (useDebateStore.getState().driverIsRemote || isRunLeaseHeldLocally(activeDebate.id) || getRemoteRunLeaseHolder(activeDebate.id)) return;
    if (Date.now() < compressionCooldownRef.current) return;
    if (isCompressionDue(activeDebate)) {
      compressionCooldownRef.current = Date.now() + 60_000;
      void compressOldTranscript();
    }
  }, [activeDebate?.transcript.length, debateGenerating]);

  // Reset trigger flags when debate changes
  useEffect(() => {
    hasTriggeredOpening.current = false;
  }, [activeDebate?.id]);
}

function useDebateFind(activeDebate: DWStore['activeDebate']) {
  const [findVisible, setFindVisible] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCurrentIndex, setFindCurrentIndex] = useState(0);

  const { findTotal, findOffsets } = useMemo(() => {
    if (!findQuery || !activeDebate) return { findTotal: 0, findOffsets: new Map<string, number>() };
    const offsets = new Map<string, number>();
    let total = 0;
    for (const entry of activeDebate.transcript) {
      const count = countOccurrences(entry.content, findQuery);
      if (count > 0) { offsets.set(entry.id, total); total += count; }
    }
    return { findTotal: total, findOffsets: offsets };
  }, [findQuery, activeDebate?.transcript]);

  useEffect(() => { setFindCurrentIndex(0); }, [findQuery, findTotal]);

  useEffect(() => {
    if (!findVisible || findTotal === 0) return;
    document.querySelector(`[data-find-index="${findCurrentIndex}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [findCurrentIndex, findVisible, findQuery, findTotal]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setFindVisible(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const findNext = useCallback(() => {
    if (findTotal === 0) return;
    setFindCurrentIndex(i => (i + 1) % findTotal);
  }, [findTotal]);

  const findPrev = useCallback(() => {
    if (findTotal === 0) return;
    setFindCurrentIndex(i => (i - 1 + findTotal) % findTotal);
  }, [findTotal]);

  const closeFind = useCallback(() => {
    setFindVisible(false);
    setFindQuery('');
  }, []);

  return { findVisible, findQuery, setFindQuery, findCurrentIndex, findTotal, findOffsets, findNext, findPrev, closeFind };
}

function useDebateCoverage(activeDebate: DWStore['activeDebate']) {
  const coverageMap = useMemo<CoverageMap | null>(() => {
    if (!activeDebate?.document_analysis?.i_nodes?.length) return null;
    const anNodes = activeDebate.argument_network?.nodes ?? [];
    if (anNodes.length === 0) return null;
    const documentClaims = activeDebate.document_analysis.i_nodes.map(n => ({ id: n.id, text: n.text }));
    try {
      return computeCoverageMap(anNodes, documentClaims);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-workspace',
        level: 'warn',
        message: 'Coverage map computation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return null;
    }
  }, [activeDebate?.argument_network?.nodes, activeDebate?.document_analysis?.i_nodes]);

  const strengthWeighted = useMemo<StrengthWeightedCoverage | null>(() => {
    if (!coverageMap || !activeDebate?.argument_network) return null;
    const { nodes, edges } = activeDebate.argument_network;
    if (nodes.length === 0) return null;
    try {
      return computeStrengthWeightedCoverage(coverageMap, nodes, edges);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-workspace',
        level: 'warn',
        message: 'Strength-weighted coverage computation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return null;
    }
  }, [coverageMap, activeDebate?.argument_network]);

  return { coverageMap, strengthWeighted };
}

// Walk up from the selection's anchor to find the enclosing statement card.
function findSelectedEntry(anchorNode: Node | null | undefined, currentTarget: EventTarget | null): { entryId: string; isPoverStatement: boolean } {
  let node = anchorNode as HTMLElement | null;
  let entryId = '';
  let isPoverStatement = false;
  while (node && node !== currentTarget) {
    if (node.dataset?.entryId) {
      entryId = node.dataset.entryId;
      isPoverStatement = node.dataset.isPover === 'true';
      break;
    }
    node = node.parentElement;
  }
  return { entryId, isPoverStatement };
}

// Rendered-text offset + active tier for a selection within a statement card (t/1694).
function computeSelectionAnchor(
  selection: Selection,
  entry: ActiveTranscriptEntry,
  selectedText: string,
  defaultTier: DWStore['defaultDisplayTier'],
): { startOffset: number; endOffset: number; tier: DetailTier } {
  const isSub = ['opening', 'statement', 'fact-check', 'cross_respond'].includes(entry.type);
  const tier: DetailTier = isSub ? ((entry as any).display_tier ?? defaultTier ?? 'detailed') : 'detailed';
  let startOffset = 0;
  let endOffset = selectedText.length;
  const range = selection.getRangeAt(0);
  const anchorEl = range.startContainer instanceof Element
    ? range.startContainer
    : range.startContainer.parentElement;
  const container = anchorEl?.closest('.debate-statement-content') as HTMLElement | null;
  if (container) {
    // `selectedText` was trimmed; realign the offset to the trimmed start so
    // it points at the same text CommentOverlay will locate.
    const rawSelected = selection.toString();
    const leadingWs = rawSelected.length - rawSelected.trimStart().length;
    startOffset = renderedOffsetOf(container, range.startContainer, range.startOffset) + leadingWs;
    endOffset = startOffset + selectedText.length;
  }
  return { startOffset, endOffset, tier };
}

function useDebateSelectionMenu(activeDebate: DWStore['activeDebate'], defaultTier: DWStore['defaultDisplayTier']) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [commentPopover, setCommentPopover] = useState<CommentPopoverState | null>(null);

  const buildMenuState = useCallback((container: EventTarget | null, x: number, y: number): ContextMenuState | null => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || '';
    if (!selectedText) return null; // No selection → use default browser menu

    const { entryId, isPoverStatement } = findSelectedEntry(selection?.anchorNode, container);

    // Compute text offsets + active tier within the debate-statement-content element
    let startOffset = 0;
    let endOffset = selectedText.length;
    let tier: DetailTier = 'detailed';
    if (entryId && selection && selection.rangeCount > 0) {
      // Find the entry in the transcript to determine the active tier
      const entry = activeDebate?.transcript.find(e2 => e2.id === entryId);
      if (entry) {
        ({ startOffset, endOffset, tier } = computeSelectionAnchor(selection, entry, selectedText, defaultTier));
      }
    }

    return { x, y, selectedText, entryId, isPoverStatement, tier, startOffset, endOffset };
  }, [activeDebate?.transcript, defaultTier]);

  // Phase 7 (desktop right-click) + t/3382 (touch long-press-to-select, which never
  // fires `contextmenu` — iOS/Android intercept it with the native selection callout)
  // share one trigger model via the shared hook: show the menu once a selection is final.
  const { onContextMenu: handleContextMenu, onTouchEnd: handleTouchEnd } =
    useLongPressSelectionMenu(buildMenuState, setContextMenu);

  return { contextMenu, setContextMenu, commentPopover, setCommentPopover, handleContextMenu, handleTouchEnd };
}

// ── Main component ───────────────────────────────────────

export function DebateWorkspace({ onExport, exportStatus }: {
  onExport?: (format: string) => void;
  exportStatus?: string | null;
} = {}) {
  const {
    activeDebate, debateLoading, debateError, debateGenerating,
    runClarification, runOpeningStatements, saveDebate, compressOldTranscript,
    diagnosticsEnabled, toggleDiagnostics, selectedDiagEntry, selectDiagEntry,
    diagPopoutOpen, setDiagPopoutOpen, defaultTier, setDefaultTier,
    driverIsRemote,
    selectedRef, setSelectedRef,
    explorationSummary, extractExplorationSummary,
    communityReadOnly,
  } = useDebateStore(
    useShallow(s => ({
      activeDebate: s.activeDebate, debateLoading: s.debateLoading, debateError: s.debateError, debateGenerating: s.debateGenerating,
      runClarification: s.runClarification, runOpeningStatements: s.runOpeningStatements, saveDebate: s.saveDebate, compressOldTranscript: s.compressOldTranscript,
      diagnosticsEnabled: s.diagnosticsEnabled, toggleDiagnostics: s.toggleDiagnostics, selectedDiagEntry: s.selectedDiagEntry, selectDiagEntry: s.selectDiagEntry,
      diagPopoutOpen: s.diagPopoutOpen, setDiagPopoutOpen: s.setDiagPopoutOpen,
      // Header Text/Analysis control + statement display fallback bind to the
      // display tier (defaultDisplayTier, default Medium), NOT responseLength
      // (generation verbosity, default Detailed) — t/2318.
      defaultTier: s.defaultDisplayTier, setDefaultTier: s.setDefaultDisplayTier,
      driverIsRemote: s.driverIsRemote,
      selectedRef: s.selectedRef, setSelectedRef: s.setSelectedRef,
      explorationSummary: s.explorationSummary,
      extractExplorationSummary: s.extractExplorationSummary,
      communityReadOnly: s.communityReadOnly,
    }))
  );
  const { runSemanticSearch, setFindQuery: setStoreFindQuery, setFindMode: setStoreFindMode, setToolbarPanel } = useTaxonomyStore();
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showParamHistory, setShowParamHistory] = useState(false);
  const [showEvaluation, setShowEvaluation] = useState(false);
  const [debateChatOpen, setDebateChatOpen] = useState(false);
  const { commentsFile, loadComments: loadDebateComments, unloadComments, sidebarOpen: commentSidebarOpen, toggleSidebar: toggleCommentSidebar } = useCommentStore();

  useDebateWorkspaceEffects({
    activeDebate, setDiagPopoutOpen, extractExplorationSummary,
    loadDebateComments, unloadComments, saveDebate, debateGenerating, compressOldTranscript,
    communityReadOnly,
  });

  const handleSimilarPovSearch = useCallback((query: string) => {
    setStoreFindQuery(query);
    setStoreFindMode('semantic');
    setToolbarPanel('search');
    void runSemanticSearch(query, new Set(), new Set());
  }, [runSemanticSearch, setStoreFindQuery, setStoreFindMode, setToolbarPanel]);

  const handleChatNavigate = useCallback((cmd: NavigateCommand) => {
    if (cmd.entry) {
      const el = document.getElementById(`debate-entry-${cmd.entry}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, []);

  const { findVisible, findQuery, setFindQuery, findCurrentIndex, findTotal, findOffsets, findNext, findPrev, closeFind } = useDebateFind(activeDebate);
  const { coverageMap, strengthWeighted } = useDebateCoverage(activeDebate);
  const { contextMenu, setContextMenu, commentPopover, setCommentPopover, handleContextMenu, handleTouchEnd } = useDebateSelectionMenu(activeDebate, defaultTier);

  // useFlag is a hook — hoist above the early returns below (rules-of-hooks, t/2299).
  const chatRedesign = useFlag('DEBATE_CHAT_REDESIGN');

  if (debateLoading) {
    return <div className="debate-workspace-loading">Loading debate...</div>;
  }

  if (!activeDebate) {
    return <div className="debate-workspace-loading">No debate selected</div>;
  }

  const isClarificationPhase = activeDebate.phase === 'clarification' || activeDebate.phase === 'setup';
  const isEditClaimsPhase = activeDebate.phase === 'edit-claims';
  const isOpeningPhase = activeDebate.phase === 'opening';
  const isDebatePhase = activeDebate.phase === 'debate'
    || activeDebate.phase === 'closed'
    || activeDebate.adaptive_staging?.phase_state?.current_phase != null;
  const isExploration = activeDebate.protocol_id === 'exploration';
  const isExplorationClosed = isExploration && activeDebate.phase === 'closed';
  const showRemoteOverlay = driverIsRemote && !!activeDebate;

  return (
    <div className="debate-workspace-row" data-phase={isClarificationPhase ? 'setup' : undefined}>
    {chatRedesign && <TranscriptOutline transcript={activeDebate.transcript} />}
    <div className="debate-workspace">
      {showSetup && <DebateSetupDialog activeDebate={activeDebate} onClose={() => setShowSetup(false)} />}

      {/* Find bar */}
      {findVisible && (
        <FindBar
          query={findQuery}
          onQueryChange={setFindQuery}
          current={findCurrentIndex}
          total={findTotal}
          onPrev={findPrev}
          onNext={findNext}
          onClose={closeFind}
        />
      )}

      {/* Remote driver overlay — another window (the pop-out, or the main window when this is the pop-out) drives this debate */}
      <RemoteDriverOverlay show={showRemoteOverlay} inPopout={isDebatePopoutWindow()} />

      {/* Scrollable content: header (title+status+DEBATERS strip), debaters, transcript.
          The header scrolls with the transcript rather than staying pinned (user request):
          on a phone the fixed header consumed ~half the viewport. */}
      <div className="debate-scroll-content" onContextMenu={handleContextMenu} onTouchEnd={handleTouchEnd}>
        <DebateHeader
          activeDebate={activeDebate}
          coverageMap={coverageMap}
          strengthWeighted={strengthWeighted}
          phaseLabel={PHASE_TITLES[activeDebate.phase] || activeDebate.phase}
          onShowSetup={() => setShowSetup(true)}
          actions={
            <DebateToolbar
              activeDebate={activeDebate}
              headerVariant
              isExploration={isExploration}
              onShowSetup={() => setShowSetup(true)}
              commentSidebarOpen={commentSidebarOpen}
              toggleCommentSidebar={toggleCommentSidebar}
              commentsFile={commentsFile}
              exportStatus={exportStatus}
              onExport={onExport}
              diagnosticsEnabled={diagnosticsEnabled}
              toggleDiagnostics={toggleDiagnostics}
              defaultTier={defaultTier}
              setDefaultTier={setDefaultTier}
            />
          }
        />
        <DebatePhaseHeader activeDebate={activeDebate} isDebatePhase={isDebatePhase} isOpeningPhase={isOpeningPhase} />
        <DebateTranscriptColumn
          activeDebate={activeDebate}
          debateGenerating={debateGenerating}
          findOffsets={findOffsets}
          findQuery={findQuery}
          findCurrentIndex={findCurrentIndex}
          diagnosticsEnabled={diagnosticsEnabled}
          selectedDiagEntry={selectedDiagEntry}
          selectDiagEntry={selectDiagEntry}
          transcriptEndRef={transcriptEndRef}
        />
        <DebateScrollPanels
          activeDebate={activeDebate}
          showEvaluation={showEvaluation}
          setShowEvaluation={setShowEvaluation}
          showParamHistory={showParamHistory}
          setShowParamHistory={setShowParamHistory}
        />
      </div>

      <DebateActionRegion
        activeDebate={activeDebate}
        isExplorationClosed={isExplorationClosed}
        explorationSummary={explorationSummary}
        showRemoteOverlay={showRemoteOverlay}
        isClarificationPhase={isClarificationPhase}
        isEditClaimsPhase={isEditClaimsPhase}
        isOpeningPhase={isOpeningPhase}
        isDebatePhase={isDebatePhase}
        showParamHistory={showParamHistory}
        setShowParamHistory={setShowParamHistory}
        showEvaluation={showEvaluation}
        setShowEvaluation={setShowEvaluation}
      />

      {/* Diagnostics always uses popup window — no inline panel */}

      <DebateModals
        contextMenu={contextMenu}
        setContextMenu={setContextMenu}
        commentPopover={commentPopover}
        setCommentPopover={setCommentPopover}
        onSimilarPovSearch={handleSimilarPovSearch}
        commentSidebarOpen={commentSidebarOpen}
        commentsFile={commentsFile}
      />
    </div>
    <DebateSideRail
      debateChatOpen={debateChatOpen}
      setDebateChatOpen={setDebateChatOpen}
      activeDebate={activeDebate}
      onChatNavigate={handleChatNavigate}
      selectedRef={selectedRef}
      setSelectedRef={setSelectedRef}
    />
    </div>
  );
}
