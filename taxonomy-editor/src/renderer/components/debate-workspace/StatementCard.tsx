// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useCallback, useMemo, useEffect, useRef, useLayoutEffect, type ReactNode } from 'react';
import { useDebateStore } from '../../hooks/useDebateStore';
import { escapeMarkdownEmphasis } from '../../hooks/useDebateStore/shared/factCheckFormat';
import { useShallow } from 'zustand/react/shallow';
import { useFlag } from '../../hooks/useFeatureFlags';
import { POVER_INFO } from '../../types/debate';
import type { SpeakerId, TranscriptEntry, TaxonomyRef } from '../../types/debate';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkColorizePov } from '../../utils/colorizePovPlugin';
import { lineageMarkdownComponents, extractLineageNames } from '../../utils/lineageMatcher';
import { getDebateMarkdownComponents, type VocabResolution } from '../../utils/vocabularyAnnotations';
import {
  speakerLabel, speakerColor, pctFmt, focusMainWindowNode,
  fixMarkdownLinks, stripLeadingHeadings,
  META_TIERS, WHY_TIERS, TIER_LABELS, modeOfTier, shownTier, lengthTier, kindLabel, splitTagline, countOccurrences,
} from './utils';
import type { AnchorHTMLAttributes, HTMLAttributes } from 'react';
import { parseEntityRef } from '@lib/entities/types';
import type { FactVerdict, FactDiscrepancy } from '@lib/debate/types';
import { remarkLinkifyRefs, REF_LINK_CLASS } from '../shared/refLinkifyPlugin';
import { ClaimsView } from './ClaimsView';
import { CampGlyph, povToCamp } from '../shared/CampGlyph';
import { TheoryLink } from '../shared/TheoryLink';
import './StatementCard.css';

const SafeLink = ({ node: _, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => (
  <a {...props} target="_blank" rel="noopener noreferrer" />
);
import { LineageTermsView, VocabTermsView } from './VocabularyPanel';
import { WhyTabs } from './WhyTabs';
import { CommentOverlay, useEntryCommentCount } from '../chat/CommentHighlights';
import { useCommentStore } from '../../hooks/useCommentStore';
import type { DetailTier } from '@lib/debate/comments';
import { TaxonomyRefsSection, BdiGroundingView } from './TaxonomyRefs';
import { StatementHowLayout } from './StatementHowLayout';
import { StatementTierPills, type SetEntryDisplayTier } from './StatementTierPills';
import { StructuredBrief, ReadMoreLink, HeaderTurnSymbols, structuredBriefOf, structuredBriefText, collapsedClaimOf } from './StatementBrief';
import { useTurnCollapsed } from './turnCollapse';
import { findingOf, pointsOf, limitOf, collapsedFindingOf } from './factCheckView';
import {
  FactCheckPill, FactCheckTargetLink, FactCheckChecked, FactCheckFinding, FactCheckPoints,
  FactCheckDiscrepancyPair, FactCheckSourcesRow, FactCheckDetailsToggle, type FactCheckTarget,
} from './FactCheckParts';
import { StatementSteelmans } from '../shared/Steelman';
import { useDiagnoseEntry } from './useDiagnoseEntry';
import { api } from '@bridge';
import { ConcludingSections } from './SynthesisSections';

/** Remark pipeline for debate transcript text: GFM + POV colorization + ID-token ref links (t/1776). */
const DEBATE_REMARK_PLUGINS = [remarkGfm, remarkColorizePov, remarkLinkifyRefs];

/** Taxonomy Vocabulary System spec — linked from the TERMS meta-view header (t/2471). */
const VOCAB_SPEC_URL = 'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/docs/taxonomy-vocabulary-system-spec.md';

const DISCREPANCY_DIMENSION_LABEL: Record<FactDiscrepancy['dimension'], string> = {
  magnitude: 'Magnitude', temporal: 'Timing', attribution: 'Attribution', scope: 'Scope', existence: 'Existence',
};

/**
 * `span` md-component: renders a `scanRefs`-detected ID token (marked `ref-link` by
 * the remark plugin) as a selectable button that opens the shared DetailPane; every
 * other span (e.g. pov-name colorization) passes through unchanged. For node/sit/pol
 * the displayed token IS the id, so parseEntityRef(children) recovers the ref without
 * a data round-trip; a non-parsing token falls through to a plain span. (t/1776)
 */
function RefLinkSpan({ node: _node, className, children, ...props }: HTMLAttributes<HTMLSpanElement> & { node?: unknown }) {
  if ((className ?? '').split(/\s+/).includes(REF_LINK_CLASS) && typeof children === 'string') {
    const ref = parseEntityRef(children);
    if (ref) {
      return (
        <button
          type="button"
          className={REF_LINK_CLASS}
          title={`Show details for ${children}`}
          onClick={(e) => { e.stopPropagation(); useDebateStore.getState().setSelectedRef(ref); }}
        >
          {children}
        </button>
      );
    }
  }
  return <span className={className} {...props}>{children}</span>;
}

// ── Small helper components ─────────────────────────────

export function PhaseTransitionCard({ type }: {
  type: 'TRANSITION_SUMMARY' | 'REGRESSION_NOTICE' | 'FINAL_COMMIT';
  content?: string;
}) {
  const label = type === 'TRANSITION_SUMMARY' ? 'Entering Synthesis'
    : type === 'REGRESSION_NOTICE' ? 'Returning to Exploration'
    : 'Final Positions';

  return (
    <div className="phase-hairline">
      <span className="phase-hairline-label">{label}</span>
    </div>
  );
}

export function PhaseHairline({ label }: { label: string }) {
  return (
    <div className="phase-hairline">
      <span className="phase-hairline-label">{label}</span>
    </div>
  );
}

export function HighlightedText({ text, query, matchOffset, currentIndex }: {
  text: string; query: string; matchOffset: number; currentIndex: number;
}) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let pos = 0, n = 0;
  while (pos <= text.length) {
    const idx = lower.indexOf(q, pos);
    if (idx === -1) { if (pos < text.length) parts.push(text.slice(pos)); break; }
    if (idx > pos) parts.push(text.slice(pos, idx));
    const gi = matchOffset + n;
    parts.push(
      <mark
        key={gi}
        className={`debate-find-match${gi === currentIndex ? ' debate-find-match-current' : ''}`}
        data-find-index={gi}
      >
        {text.slice(idx, idx + query.length)}
      </mark>
    );
    n++; pos = idx + query.length;
  }
  return <>{parts}</>;
}

export function EntryDeleteControls({ entry, totalEntries, entryIndex }: {
  entry: TranscriptEntry; totalEntries: number; entryIndex: number;
}) {
  const { deleteTranscriptEntries, activeDebate } = useDebateStore(
    useShallow(s => ({ deleteTranscriptEntries: s.deleteTranscriptEntries, activeDebate: s.activeDebate }))
  );
  const [confirmMode, setConfirmMode] = useState<'single' | 'after' | null>(null);

  const handleDeleteSingle = async () => {
    await deleteTranscriptEntries([entry.id]);
    setConfirmMode(null);
  };

  const handleDeleteThisAndAfter = async () => {
    if (!activeDebate) return;
    const idx = activeDebate.transcript.findIndex(e => e.id === entry.id);
    if (idx < 0) return;
    const idsToRemove = activeDebate.transcript.slice(idx).map(e => e.id);
    await deleteTranscriptEntries(idsToRemove);
    setConfirmMode(null);
  };

  if (confirmMode) {
    return (
      <div className="debate-entry-delete-confirm">
        <span>{confirmMode === 'single' ? 'Delete this entry?' : `Delete this and ${totalEntries - entryIndex - 1} entries after it?`}</span>
        <button className="btn btn-sm btn-danger" onClick={confirmMode === 'single' ? handleDeleteSingle : handleDeleteThisAndAfter}>Yes</button>
        <button className="btn btn-sm" onClick={() => setConfirmMode(null)}>No</button>
      </div>
    );
  }

  return (
    <div className="debate-entry-delete-actions">
      <button
        className="debate-entry-delete-btn"
        onClick={() => setConfirmMode('single')}
        title="Delete this entry"
      >
        &times;
      </button>
      {entryIndex < totalEntries - 1 && (
        <button
          className="debate-entry-delete-btn debate-entry-delete-after"
          onClick={() => setConfirmMode('after')}
          title="Delete this and all entries after it"
        >
          &times;&darr;
        </button>
      )}
    </div>
  );
}

export function EntryCommentBadge({ entryId }: { entryId: string }) {
  const count = useEntryCommentCount(entryId);
  const toggleSidebar = useCommentStore(s => s.toggleSidebar);
  if (count === 0) return null;
  return (
    <button
      className="entry-comment-badge"
      onClick={(e) => { e.stopPropagation(); toggleSidebar(); }}
      title={`${count} comment(s) — click to open sidebar`}
    >
      {count}
    </button>
  );
}

// ── Collapsible sections for concluding statements — extracted to
//    SynthesisSections.tsx (t/4914, line-count ceiling).

// ── Tier display content resolution ─────────────────────

const SUBSTANTIVE_TYPES = new Set(['opening', 'statement', 'fact-check', 'cross_respond']);

type StructuredBriefParts = { claim: string; points: string[] };

/** The first two sentences: the Brief of a statement that was never summarized. */
function leadSentences(content: string): { text: string; shorter: boolean } {
  const sentences = content.split(/(?<=[.!?])\s+/);
  return { text: sentences.slice(0, 2).join(' '), shorter: sentences.length > 2 };
}

/** t/701 §3: whether the card has a Brief that is shorter than the statement itself. Only then
 *  is there a "Read full statement" / "Show brief" choice to offer. */
function hasShorterBrief(entry: TranscriptEntry): boolean {
  return structuredBriefOf(entry) != null || !!entry.summaries?.brief || leadSentences(entry.content).shorter;
}

/** What the Statement tab shows for a tier. Brief (t/701 §1): the structured claim + points when
 *  the entry has them, else the `brief` string, else the lead sentences. §7 (Design, t/701#4):
 *  `Tagline:` only ever appears in a stored `brief` string, so that fallback drops the tagline
 *  line; a Brief has no sign-off. Anything else: the statement itself, unchanged. */
function resolveDisplayContent(entry: TranscriptEntry, activeTier: string, isSubstantive: boolean): { displayContent: string; structured: StructuredBriefParts | null } {
  if (activeTier === 'brief' && isSubstantive) {
    const structured = structuredBriefOf(entry);
    if (structured) return { displayContent: structuredBriefText(structured), structured };
    if (entry.summaries?.brief) return { displayContent: stripLeadingHeadings(splitTagline(entry.summaries.brief).body), structured: null };
    return { displayContent: stripLeadingHeadings(leadSentences(entry.content).text), structured: null };
  }
  return { displayContent: stripLeadingHeadings(entry.content), structured: null };
}

/** t/4625: the Why tiers render structured views too, same as META_TIERS, but aren't members. */
function isMetaViewTier(tier: string): boolean { return META_TIERS.has(tier) || WHY_TIERS.has(tier); }

// ── Shared ref helpers (t/1911: keep TaxonomyRefsSection call-sites flat) ──
type ActiveDebateT = ReturnType<typeof useDebateStore.getState>['activeDebate'];
type StageDiagnostics = { stage: string; raw_response: string; work_product: Record<string, unknown> }[] | undefined;

function stageDiagnosticsFor(activeDebate: ActiveDebateT, entryId: string): StageDiagnostics {
  return activeDebate?.diagnostics?.entries[entryId]?.stage_diagnostics as StageDiagnostics;
}
function metaPolicyRefsOf(entry: TranscriptEntry): string[] | undefined {
  return (entry.metadata as Record<string, unknown>)?.policy_refs as string[] | undefined;
}
function findAnNodeId(activeDebate: ActiveDebateT, entryId: string): string | null {
  return activeDebate?.argument_network?.nodes?.find(n => n.source_entry_id === entryId)?.id ?? null;
}

// ── StatementCard sub-parts (t/1911 ADR-007 line-slice) ─────────────────
function StatementModelBadge({ entry, activeDebate }: { entry: TranscriptEntry; activeDebate: ActiveDebateT }) {
  const modelId = entry.model ?? activeDebate?.speaker_models?.[entry.speaker];
  if (!modelId) return null;
  const short = modelId.replace(/^(gemini-|claude-|groq-|openai-|deepseek-|ollama-)/, '');
  return (
    <span className="debate-model-badge" title={modelId}>
      {short}
    </span>
  );
}

function StatementDeleteActions({ entryIndex, totalEntries, deleteConfirm, setDeleteConfirm }: {
  entryIndex?: number;
  totalEntries?: number;
  deleteConfirm: 'single' | 'after' | null;
  setDeleteConfirm: (v: 'single' | 'after' | null) => void;
}) {
  if (!(entryIndex != null && totalEntries != null && !deleteConfirm)) return null;
  return (
    <span className="debate-entry-delete-actions">
      <button
        className="debate-entry-delete-btn"
        onClick={(e) => { e.stopPropagation(); setDeleteConfirm('single'); }}
        title="Delete this entry"
        aria-label="Delete this entry"
      >&times;</button>
      {entryIndex < totalEntries - 1 && (
        <button
          className="debate-entry-delete-btn"
          onClick={(e) => { e.stopPropagation(); setDeleteConfirm('after'); }}
          title="Delete this and all entries after it"
          aria-label="Delete this and all entries after it"
        >&times;&darr;</button>
      )}
    </span>
  );
}

/**
 * Collapse caret (t/701 §8; first added as t/2241). Older turns start collapsed to their
 * claim so the debate reads like an outline. A native <button> keeps Enter/Space working
 * without key handlers; a collapsed row is also clickable anywhere (see StatementCardHeader).
 */
function StatementCollapseToggle({ collapsed, onToggle, entryId }: {
  collapsed: boolean;
  onToggle: () => void;
  entryId: string;
}) {
  return (
    <button
      type="button"
      className="debate-statement-collapse-btn"
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-expanded={!collapsed}
      aria-controls={`debate-statement-body-${entryId}`}
      aria-label={collapsed ? 'Expand this turn' : 'Collapse this turn'}
      title={collapsed ? 'Expand this turn' : 'Collapse this turn'}
    >
      {collapsed ? '▸' : '▾'}
    </button>
  );
}

function StatementCardHeader({
  entry, statementId, camp, color, activeDebate, anNodeId,
  showTierPills, activeTier, setEntryDisplayTier, vocabResolutions, hasLineageRefs,
  qbafEnabled, netDelta, isPover, diagnose,
  entryIndex, totalEntries, deleteConfirm, setDeleteConfirm,
  collapsible, collapsed, onToggleCollapse, collapsedClaim, turnSymbols, whySourceCount,
}: {
  entry: TranscriptEntry;
  statementId?: string;
  camp: ReturnType<typeof povToCamp> | undefined;
  color: string | undefined;
  activeDebate: ActiveDebateT;
  anNodeId: string | null;
  showTierPills: boolean;
  activeTier: string;
  setEntryDisplayTier: SetEntryDisplayTier;
  vocabResolutions: VocabResolution[] | undefined;
  hasLineageRefs: boolean;
  qbafEnabled: boolean;
  netDelta: number | undefined;
  isPover: boolean;
  diagnose: (entryId: string) => void;
  entryIndex?: number;
  totalEntries?: number;
  deleteConfirm: 'single' | 'after' | null;
  setDeleteConfirm: (v: 'single' | 'after' | null) => void;
  collapsible: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  collapsedClaim: string;
  turnSymbols: { symbol: string; tooltip: string }[] | undefined;
  whySourceCount: number;
}) {
  // t/4914 spec §2: the concluding (Synthesis) card's header drops the speaker/id/type
  // row for a plain "SYNTHESIS" eyebrow. The statement id anchor is preserved (still
  // used by cross-references and diagnostics) by moving it onto the eyebrow itself.
  const isConcluding = entry.type === 'concluding';
  const identity = (isConcluding ? (
        <span className="concluding-eyebrow" id={statementId ? `stmt-${statementId}` : undefined}>
          Synthesis
        </span>
      ) : (
        <>
          {camp && <CampGlyph camp={camp} size={16} />}
          <span className="debate-statement-speaker" style={color ? { color } : undefined}>
            {speakerLabel(entry.speaker)}
          </span>
          {/* t/701 §5: "{Speaker} · {Kind}". The statement and argument-node ids are internal:
              they sit in the kind's title, and the stmt- anchor that cross-references and
              diagnostics scroll to stays on it. */}
          <span
            className="debate-statement-kind"
            id={statementId ? `stmt-${statementId}` : undefined}
            data-statement-id={statementId}
            data-an-id={anNodeId ?? undefined}
            title={[statementId && `Statement ${statementId}`, anNodeId && `argument node ${anNodeId}`].filter(Boolean).join(' · ') || undefined}
          >
            <span aria-hidden="true">· </span>{kindLabel(entry.type)}
          </span>
        </>
      ));
  return (
    // A collapsed row opens on a click anywhere in it. Keyboard users have the caret button.
    <div className="debate-statement-header" onClick={collapsed ? (e) => { e.stopPropagation(); onToggleCollapse(); } : undefined}>
      {collapsible && (
        <StatementCollapseToggle collapsed={collapsed} onToggle={onToggleCollapse} entryId={entry.id} />
      )}
      {collapsed ? (
        <div className="debate-statement-collapsed-body">
          <div className="debate-statement-collapsed-line">{identity}</div>
          <span className={`debate-statement-collapsed-claim${camp && !isConcluding ? ' has-glyph' : ''}`}>{collapsedClaim}</span>
        </div>
      ) : (
        <>
          {identity}
          <StatementCardHeaderDetail
          entry={entry}
          activeDebate={activeDebate}
          anNodeId={anNodeId}
          showTierPills={showTierPills}
          activeTier={activeTier}
          setEntryDisplayTier={setEntryDisplayTier}
          vocabResolutions={vocabResolutions}
          hasLineageRefs={hasLineageRefs}
          qbafEnabled={qbafEnabled}
          netDelta={netDelta}
          isPover={isPover}
          diagnose={diagnose}
          entryIndex={entryIndex}
          totalEntries={totalEntries}
          deleteConfirm={deleteConfirm}
          setDeleteConfirm={setDeleteConfirm}
          turnSymbols={turnSymbols}
          whySourceCount={whySourceCount}
          />
        </>
      )}
    </div>
  );
}

/**
 * Everything in the card header past the speaker identity. Split out so a
 * collapsed card (t/2241) can render identity-only without duplicating the row,
 * and so the header stays under the complexity ceiling. Rendered output is
 * unchanged from before the split.
 */
function StatementCardHeaderDetail({
  entry, activeDebate, anNodeId, showTierPills, activeTier, setEntryDisplayTier,
  vocabResolutions, hasLineageRefs, qbafEnabled, netDelta, isPover,
  diagnose,
  entryIndex, totalEntries, deleteConfirm, setDeleteConfirm, turnSymbols, whySourceCount,
}: {
  entry: TranscriptEntry;
  activeDebate: ActiveDebateT;
  anNodeId: string | null;
  showTierPills: boolean;
  activeTier: string;
  setEntryDisplayTier: SetEntryDisplayTier;
  vocabResolutions: VocabResolution[] | undefined;
  hasLineageRefs: boolean;
  qbafEnabled: boolean;
  netDelta: number | undefined;
  isPover: boolean;
  diagnose: (entryId: string) => void;
  entryIndex?: number;
  totalEntries?: number;
  deleteConfirm: 'single' | 'after' | null;
  setDeleteConfirm: (v: 'single' | 'after' | null) => void;
  turnSymbols: { symbol: string; tooltip: string }[] | undefined;
  whySourceCount: number;
}) {
  return (
    <>
      <HeaderTurnSymbols turnSymbols={turnSymbols} />
      <StatementModelBadge entry={entry} activeDebate={activeDebate} />
      {showTierPills && (
        <StatementTierPills
          entry={entry}
          activeTier={activeTier}
          setEntryDisplayTier={setEntryDisplayTier}
          hasLineageRefs={hasLineageRefs}
          whySourceCount={whySourceCount}
        />
      )}
      {qbafEnabled && netDelta != null && Math.abs(netDelta) > 0.01 && (
        <span
          className={`qbaf-net-delta ${netDelta > 0 ? 'qbaf-delta-up' : 'qbaf-delta-down'}`}
          title={`Net QBAF strength change this turn: ${netDelta > 0 ? '+' : ''}${netDelta.toFixed(2)}`}
        >
          {netDelta > 0 ? '▲' : '▼'} {netDelta > 0 ? '+' : ''}{netDelta.toFixed(2)} net
        </span>
      )}
      {isPover && (
        <button
          className="debate-diagnose-btn"
          onClick={(e) => {
            e.stopPropagation();
            diagnose(entry.id);
          }}
          title="Open diagnostics for this turn"
        >
          Diagnose
        </button>
      )}
      <StatementDeleteActions entryIndex={entryIndex} totalEntries={totalEntries} deleteConfirm={deleteConfirm} setDeleteConfirm={setDeleteConfirm} />
    </>
  );
}

function StatementDeleteConfirm({ entry, activeDebate, deleteConfirm, setDeleteConfirm, deleteTranscriptEntries, entryIndex, totalEntries }: {
  entry: TranscriptEntry;
  activeDebate: ActiveDebateT;
  deleteConfirm: 'single' | 'after' | null;
  setDeleteConfirm: (v: 'single' | 'after' | null) => void;
  deleteTranscriptEntries: ReturnType<typeof useDebateStore.getState>['deleteTranscriptEntries'];
  entryIndex?: number;
  totalEntries?: number;
}) {
  if (!deleteConfirm) return null;
  return (
    <div className="debate-entry-delete-confirm">
      <span>{deleteConfirm === 'single' ? 'Delete this entry?' : `Delete this and ${totalEntries! - entryIndex! - 1} entries after it?`}</span>
      <button className="btn btn-sm btn-danger" onClick={async (e) => {
        e.stopPropagation();
        if (deleteConfirm === 'single') {
          await deleteTranscriptEntries([entry.id]);
        } else if (activeDebate) {
          const idx = activeDebate.transcript.findIndex(e => e.id === entry.id);
          if (idx >= 0) await deleteTranscriptEntries(activeDebate.transcript.slice(idx).map(e => e.id));
        }
        setDeleteConfirm(null);
      }}>Yes</button>
      <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setDeleteConfirm(null); }}>No</button>
    </div>
  );
}

/** Meta-view header. Why shows BDI | Vocabulary tabs when the statement has resolved terms;
 *  without them it's BDI alone, so a stale 'terms' override is labelled as BDI too. */
function MetaModeLabel({ entryId, displayedTier, hasVocab, setEntryDisplayTier }: {
  entryId: string;
  displayedTier: string;
  hasVocab: boolean;
  setEntryDisplayTier: SetEntryDisplayTier;
}) {
  const showWhyTabs = WHY_TIERS.has(displayedTier) && hasVocab;
  return (
    <div className="debate-meta-mode-label">
      {showWhyTabs
        ? <WhyTabs activeTier={displayedTier === 'terms' ? 'terms' : 'why'} onSelect={(t) => setEntryDisplayTier(entryId, t)} controlsId={`debate-statement-body-${entryId}`} />
        : TIER_LABELS[displayedTier === 'terms' ? 'why' : displayedTier]?.toUpperCase()}
      {displayedTier === 'terms' && showWhyTabs && (
        <a href="#" className="debate-meta-mode-spec-link" title="Open the Taxonomy Vocabulary System spec"
          onClick={(e) => { e.preventDefault(); void api.openExternal(VOCAB_SPEC_URL); }}>🔖 spec</a>
      )}
    </div>
  );
}

function StatementBody({
  entry, activeDebate, displayedTier, isMetaView, flipKey, flipping, handleFlipEnd,
  bodyRef, innerRef, contentRef, vocabResolutions, meta, renderedStatementBody, readMore, setEntryDisplayTier,
}: {
  entry: TranscriptEntry;
  activeDebate: ActiveDebateT;
  displayedTier: string;
  isMetaView: boolean;
  flipKey: number;
  flipping: boolean;
  handleFlipEnd: () => void;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  innerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  vocabResolutions: VocabResolution[] | undefined;
  meta: Record<string, unknown> | undefined;
  renderedStatementBody: ReactNode;
  /** t/701 §3: the Read full statement / Show brief link, or null when the card has no shorter Brief. */
  readMore: ReactNode;
  setEntryDisplayTier: SetEntryDisplayTier;
}) {
  const hasVocab = !!vocabResolutions && vocabResolutions.length > 0;
  return (
    <div className={`debate-statement-body${isMetaView ? ' meta-view' : ''}`} ref={bodyRef} id={`debate-statement-body-${entry.id}`}>
      <div key={flipKey} ref={innerRef} className={`debate-flip-inner${flipping ? ' flipping' : ''}`} onAnimationEnd={handleFlipEnd}>
      {isMetaView && (
        <MetaModeLabel entryId={entry.id} displayedTier={displayedTier} hasVocab={hasVocab} setEntryDisplayTier={setEntryDisplayTier} />
      )}
      {displayedTier === 'terms' && hasVocab ? (
        <div className="debate-statement-content">
          <VocabTermsView resolutions={vocabResolutions} ambiguities={meta?.vocabulary_ambiguities as { colloquial: string; offset?: number }[] | undefined} statementText={entry.content} speakerPov={povToCamp(entry.speaker) ? entry.speaker : undefined} />
        </div>
      ) : displayedTier === 'lineage' ? (
        <div className="debate-statement-content">
          <LineageTermsView content={entry.content} />
        </div>
      ) : displayedTier === 'claims' ? (
        <div className="debate-statement-content">
          <ClaimsView entryId={entry.id} debate={activeDebate!} />
        </div>
      ) : displayedTier === 'reasoning' ? (
        // t/469 Layout A: the statement's own claims, focus, moves, assumptions and responses.
        <StatementHowLayout entry={entry} debate={activeDebate} vocabResolutions={vocabResolutions} meta={meta} />
      ) : WHY_TIERS.has(displayedTier) ? (
        <div className="debate-statement-content">
          <BdiGroundingView
            refs={entry.taxonomy_refs}
            policyRefs={entry.policy_refs}
            metaPolicyRefs={metaPolicyRefsOf(entry)}
          />
        </div>
      ) : (
        <>
          {/* Always render the markdown — never suppress it when a comment exists
              (the t/1694 root cause). CommentOverlay decorates this same container
              in-place with highlight spans; it degrades gracefully (full markdown
              stays intact) when a comment's selectedText can't be resolved. */}
          <div className="debate-statement-content markdown-body prose" ref={contentRef}>
            {renderedStatementBody}
          </div>
          {readMore}
          <CommentOverlay containerRef={contentRef} entryId={entry.id} activeTier={displayedTier as DetailTier} />
        </>
      )}
      </div>
    </div>
  );
}

function StatementExploreSuggestion({ entry, debateGenerating, askQuestion }: {
  entry: TranscriptEntry;
  debateGenerating: ReturnType<typeof useDebateStore.getState>['debateGenerating'];
  askQuestion: ReturnType<typeof useDebateStore.getState>['askQuestion'];
}) {
  if (!(entry.speaker === 'system' && entry.type === 'system' && entry.content.includes('Consider exploring:'))) return null;
  const match = entry.content.match(/Consider exploring:\s*(.+)/s);
  const topic = match?.[1]?.trim();
  if (!topic) return null;
  return (
    <div className="debate-explore-suggestion">
      <span className="debate-explore-suggestion-text">
        Redirect the debate to explore this topic?
      </span>
      <button
        className="debate-explore-btn"
        disabled={!!debateGenerating}
        onClick={(e) => { e.stopPropagation(); void askQuestion(`Explore this: ${topic}`); }}
        title={`Ask debaters to explore: ${topic}`}
      >
        Explore This
      </button>
    </div>
  );
}

function StatementFooter({ entry, activeDebate, activeTier, debateGenerating, askQuestion }: {
  entry: TranscriptEntry;
  activeDebate: ActiveDebateT;
  activeTier: string;
  debateGenerating: ReturnType<typeof useDebateStore.getState>['debateGenerating'];
  askQuestion: ReturnType<typeof useDebateStore.getState>['askQuestion'];
}) {
  if (activeTier === 'reasoning') return null;
  return (
    <>
      <EntryCommentBadge entryId={entry.id} />
      <StatementExploreSuggestion entry={entry} debateGenerating={debateGenerating} askQuestion={askQuestion} />
      <TaxonomyRefsSection
        refs={entry.taxonomy_refs}
        policyRefs={entry.policy_refs}
        metaPolicyRefs={metaPolicyRefsOf(entry)}
        entry={entry}
        stageDiagnostics={stageDiagnosticsFor(activeDebate, entry.id)}
        forceExpanded={false}
      />
    </>
  );
}

// ── Elapsed timer for S1 (shown while opening statements load) ──────────

function ElapsedTimer({ since, active }: { since: string; active: boolean }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000)));
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [since, active]);
  if (!active) return null;
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return (
    <div className="debate-s1-timer">
      <span className="debate-s1-timer-spinner" aria-hidden="true" />
      Generating opening statements… {m > 0 ? `${m}m ` : ''}{s}s
    </div>
  );
}

// ── t/701 per-card pieces (kept out of StatementCard for its complexity budget) ──

/** §8: whether this turn shows as its one-line claim. A turn holding a find-in-debate match is
 *  shown open, or the match being stepped to would be invisible. */
function useCollapsedTurn(entry: TranscriptEntry, activeDebate: ActiveDebateT, findQuery: string) {
  const { collapsed, toggle } = useTurnCollapsed(activeDebate?.id, activeDebate?.transcript, entry.id);
  const collapsedClaim = useMemo(() => collapsedClaimOf(entry), [entry]);
  const hasFindMatch = !!findQuery && countOccurrences(entry.content, findQuery) > 0;
  // No debate id (a card rendered on its own): there is nothing to key the state by, so no caret.
  return { collapsible: !!activeDebate?.id, isCollapsed: collapsed && !hasFindMatch, toggleCollapsed: toggle, collapsedClaim };
}

/** §3: the card's own length link, or null when the card has no shorter Brief or is not on the
 *  Statement tab. Choosing the debate-wide length clears the card's override rather than
 *  pinning the card to it. */
function useReadMore(
  entry: TranscriptEntry, displayedTier: string, defaultTier: string, isSubstantive: boolean,
  setEntryDisplayTier: SetEntryDisplayTier,
): ReactNode {
  const globalTier = lengthTier(shownTier(defaultTier));
  const showingFull = displayedTier === 'detailed';
  const toggleLength = useCallback(() => {
    const next = showingFull ? 'brief' : 'detailed';
    setEntryDisplayTier(entry.id, next === globalTier ? undefined : next);
  }, [showingFull, globalTier, entry.id, setEntryDisplayTier]);
  if (!(isSubstantive && modeOfTier(displayedTier) === 'text' && hasShorterBrief(entry))) return null;
  return <ReadMoreLink showingFull={showingFull} content={entry.content} controlsId={`debate-statement-body-${entry.id}`} onToggle={toggleLength} />;
}

/** §4: how many refs the Why tab lists: the taxonomy refs plus the policy refs BdiGroundingView shows. */
function whySourceCountOf(entry: TranscriptEntry): number {
  return entry.taxonomy_refs.length + (metaPolicyRefsOf(entry) || entry.policy_refs || []).length;
}

// ── Main cards ──────────────────────────────────────────

export function StatementCard({ entry, statementId, findQuery = '', matchOffset = 0, findCurrentIndex = -1, entryIndex, totalEntries }: {
  entry: TranscriptEntry; statementId?: string; findQuery?: string; matchOffset?: number; findCurrentIndex?: number; entryIndex?: number; totalEntries?: number;
}) {
  const color = speakerColor(entry.speaker);
  const isPover = entry.speaker !== 'system' && entry.speaker !== 'user';
  const camp = isPover ? povToCamp(entry.speaker) : undefined;
  const activeDebate = useDebateStore(s => s.activeDebate);
  // Display-tier fallback is the (unpersisted) defaultDisplayTier, NOT responseLength
  // (t/2269 Option 2 / t/2282): responseLength governs generation verbosity only, so a
  // fresh debate renders at Medium by default without shortening what the model writes.
  // Per-entry entry.display_tier still wins below.
  const defaultTier = useDebateStore(s => s.defaultDisplayTier);
  const setEntryDisplayTier = useDebateStore(s => s.setEntryDisplayTier);
  const askQuestion = useDebateStore(s => s.askQuestion);
  const debateGenerating = useDebateStore(s => s.debateGenerating);
  const { diagnose, notice: diagnoseNotice } = useDiagnoseEntry();
  const deleteTranscriptEntries = useDebateStore(s => s.deleteTranscriptEntries);
  const qbafEnabled = useFlag('release-qbaf-analysis');
  // The scoping hook for redesign-only styling (t/2240 prose measure) — CSS can't read a
  // flag, so it becomes `.debate-redesign` on the card root.
  const chatRedesign = useFlag('DEBATE_CHAT_REDESIGN');
  // Per-turn collapse (t/701 §8): older turns start collapsed to their claim. Session-only,
  // never saved with the debate (see turnCollapse.ts).
  const { collapsible, isCollapsed, toggleCollapsed, collapsedClaim } = useCollapsedTurn(entry, activeDebate, findQuery);
  const [deleteConfirm, setDeleteConfirm] = useState<'single' | 'after' | null>(null);
  const anNodeId = findAnNodeId(activeDebate, entry.id);
  const meta = entry.metadata as Record<string, unknown> | undefined;
  const netDelta = meta?.qbaf_net_delta as number | undefined;
  const turnSymbols = meta?.turn_symbols as { symbol: string; tooltip: string }[] | undefined;
  const vocabResolutions = meta?.vocabulary_resolutions as VocabResolution[] | undefined;
  const showTerms = useCallback(() => { setEntryDisplayTier(entry.id, 'terms'); }, [entry.id, setEntryDisplayTier]);
  const showLineage = useCallback(() => { setEntryDisplayTier(entry.id, 'lineage'); }, [entry.id, setEntryDisplayTier]);
  const hasLineageRefs = useMemo(() => extractLineageNames(entry.content).length > 0, [entry.content]);
  const mdComponents = useMemo(
    () => ({ ...getDebateMarkdownComponents(vocabResolutions, vocabResolutions?.length ? showTerms : undefined, showLineage), a: SafeLink, span: RefLinkSpan }),
    [vocabResolutions, showTerms, showLineage],
  );

  const isSubstantive = SUBSTANTIVE_TYPES.has(entry.type);
  // t/697: the Convergence view is gone; a saved 'convergence' tier (entry or global) opens on Reasoning.
  // t/701 §2: Medium is no longer offered; a saved or default 'medium' shows as Brief.
  const activeTier = isSubstantive ? lengthTier(shownTier(entry.display_tier ?? defaultTier)) : 'detailed';
  const showTierPills = isSubstantive;

  // Flip animation: displayedTier lags activeTier — content swaps at the midpoint of the rotateY flip
  const [displayedTier, setDisplayedTier] = useState(activeTier);
  const [flipKey, setFlipKey] = useState(0);
  const [flipping, setFlipping] = useState(false);
  const prevTierRef = useRef(activeTier);
  const midpointTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prevTierRef.current === activeTier) return;
    const prevTier = prevTierRef.current;
    prevTierRef.current = activeTier;

    clearTimeout(midpointTimerRef.current);

    // t/4625: mode-based, so Text<->Why and Why<->How still flip; only a same-mode sub-tier
    // change (e.g. Brief->Detailed) skips the animation.
    const prevMode = modeOfTier(prevTier);
    const curMode = modeOfTier(activeTier);
    const isTextToText = prevMode === 'text' && curMode === 'text';
    const isAnalysisToAnalysis = prevMode === 'analysis' && curMode === 'analysis';
    if (isTextToText || isAnalysisToAnalysis || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplayedTier(activeTier);
      return;
    }

    if (bodyRef.current) {
      bodyRef.current.style.height = `${bodyRef.current.offsetHeight}px`;
    }

    setFlipping(true);
    setFlipKey(k => k + 1);

    midpointTimerRef.current = setTimeout(() => {
      setDisplayedTier(activeTier);
    }, 175);

    return () => clearTimeout(midpointTimerRef.current);
  }, [activeTier]);

  useLayoutEffect(() => {
    if (!flipping || !bodyRef.current || !innerRef.current) return;
    const naturalHeight = innerRef.current.scrollHeight;
    bodyRef.current.style.height = `${naturalHeight}px`;
  }, [displayedTier, flipping]);

  const handleFlipEnd = useCallback(() => {
    setFlipping(false);
    if (bodyRef.current) bodyRef.current.style.height = '';
  }, []);

  const isMetaView = isMetaViewTier(displayedTier);
  const { displayContent, structured } = resolveDisplayContent(entry, displayedTier, isSubstantive);
  const readMore = useReadMore(entry, displayedTier, defaultTier, isSubstantive, setEntryDisplayTier);
  const whySourceCount = whySourceCountOf(entry);

  // Memoize the rendered statement body into a reconciliation-stable subtree so
  // CommentOverlay's imperatively-injected [data-comment-highlight] spans survive
  // comment-only re-renders (HLD t/1683#1, Decision 2 — t/1694). A stable element
  // ref makes React bail on re-diffing this subtree, so the injected spans aren't
  // clobbered. Deps cover everything that changes the rendered TEXT (content,
  // tier, find-highlight state, md components); comment state is deliberately
  // EXCLUDED — registering a comment must not re-diff (and wipe) the wrapped nodes.
  // CommentOverlay's sweep/normalize is only safe because of this memoization.
  const renderedStatementBody = useMemo(() => {
    if (findQuery) {
      return <HighlightedText text={displayContent} query={findQuery} matchOffset={matchOffset} currentIndex={findCurrentIndex} />;
    }
    if (entry.type === 'concluding') {
      return <ConcludingSections content={displayContent} mdComponents={mdComponents} />;
    }
    if (structured) return <StructuredBrief claim={structured.claim} points={structured.points} />;
    return <Markdown remarkPlugins={DEBATE_REMARK_PLUGINS} components={mdComponents}>{fixMarkdownLinks(displayContent)}</Markdown>;
  }, [findQuery, matchOffset, findCurrentIndex, entry.type, displayContent, displayedTier, mdComponents, structured?.claim]);

  return (
    <div
      className={`debate-statement debate-speaker-${entry.speaker} debate-type-${entry.type}${chatRedesign ? ' debate-redesign' : ''}${isCollapsed ? ' debate-statement-collapsed' : ''}`}
      data-entry-id={entry.id}
      data-is-pover={isPover ? 'true' : 'false'}
    >
      <StatementCardHeader
        entry={entry}
        statementId={statementId}
        camp={camp}
        color={color}
        activeDebate={activeDebate}
        anNodeId={anNodeId}
        showTierPills={showTierPills}
        activeTier={activeTier}
        setEntryDisplayTier={setEntryDisplayTier}
        vocabResolutions={vocabResolutions}
        hasLineageRefs={hasLineageRefs}
        qbafEnabled={qbafEnabled}
        netDelta={netDelta}
        isPover={isPover}
        diagnose={diagnose}
        entryIndex={entryIndex}
        totalEntries={totalEntries}
        deleteConfirm={deleteConfirm}
        setDeleteConfirm={setDeleteConfirm}
        collapsible={collapsible}
        collapsed={isCollapsed}
        onToggleCollapse={toggleCollapsed}
        collapsedClaim={collapsedClaim}
        turnSymbols={turnSymbols}
        whySourceCount={whySourceCount}
      />
      {diagnoseNotice}
      {!isCollapsed && (
        <>
          <StatementDeleteConfirm
            entry={entry}
            activeDebate={activeDebate}
            deleteConfirm={deleteConfirm}
            setDeleteConfirm={setDeleteConfirm}
            deleteTranscriptEntries={deleteTranscriptEntries}
            entryIndex={entryIndex}
            totalEntries={totalEntries}
          />
          <StatementBody
            entry={entry}
            activeDebate={activeDebate}
            displayedTier={displayedTier}
            isMetaView={isMetaView}
            flipKey={flipKey}
            flipping={flipping}
            handleFlipEnd={handleFlipEnd}
            bodyRef={bodyRef}
            innerRef={innerRef}
            contentRef={contentRef}
            vocabResolutions={vocabResolutions}
            meta={meta}
            renderedStatementBody={renderedStatementBody}
            readMore={readMore}
            setEntryDisplayTier={setEntryDisplayTier}
          />
          <ElapsedTimer since={entry.timestamp} active={statementId === 'S1' && !!debateGenerating} />
          <StatementSteelmans entryId={entry.id} debate={activeDebate} />
          <StatementFooter entry={entry} activeDebate={activeDebate} activeTier={activeTier} debateGenerating={debateGenerating} askQuestion={askQuestion} />
        </>
      )}
    </div>
  );
}

export function ProbingCard({ entry, statementId }: { entry: TranscriptEntry; statementId?: string }) {
  const { askQuestion, debateGenerating } = useDebateStore(
    useShallow(s => ({ askQuestion: s.askQuestion, debateGenerating: s.debateGenerating }))
  );
  const questions = (entry.metadata?.probing_questions as { text: string; targets: string[]; threatens?: string; type?: string }[]) || [];

  const handleAsk = async (q: { text: string; targets: string[] }) => {
    if (debateGenerating) return;
    const validTargets = (q.targets || []).filter(t => POVER_INFO[t as Exclude<SpeakerId, 'user'>]);
    if (validTargets.length > 0 && validTargets.length < 3) {
      const mentions = validTargets.map(t => `@${POVER_INFO[t as Exclude<SpeakerId, 'user'>]?.label}`).join(' ');
      await askQuestion(`${mentions} ${q.text}`);
      return;
    }
    await askQuestion(q.text);
  };

  return (
    <div className="debate-statement debate-type-probing debate-speaker-system">
      <div className="debate-statement-header">
        {statementId && (
          <span className="debate-statement-id" title={`Statement ${statementId}`} id={`stmt-${statementId}`}>
            {statementId}
          </span>
        )}
        <span className="debate-statement-speaker">Facilitator</span>
        <span className="debate-statement-type">probing questions</span>
      </div>
      <div className="debate-probing-questions">
        {questions.map((q, i) => {
          const validTargets = (q.targets || []).filter(t => POVER_INFO[t as Exclude<SpeakerId, 'user'>]);
          const hasTargets = validTargets.length > 0 && validTargets.length < 3;
          return (
            <button
              key={i}
              className="debate-probing-question-btn"
              onClick={() => void handleAsk(q)}
              disabled={!!debateGenerating}
              title={[
                q.targets?.length > 0 ? `Directed at: ${q.targets.map((t) => POVER_INFO[t as Exclude<SpeakerId, 'user'>]?.label || t).join(', ')}` : null,
                q.threatens ? `Threatens: ${q.threatens}` : null,
                q.type ? `Type: ${q.type}` : null,
              ].filter(Boolean).join('\n') || 'Ask this question to all debaters'}
            >
              {hasTargets && validTargets.map(t => {
                const info = POVER_INFO[t as Exclude<SpeakerId, 'user'>];
                return (
                  <span key={t} className="debate-probing-target" style={info?.color ? { color: info.color } : undefined}>
                    @{info?.label}
                  </span>
                );
              })}
              {q.text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── FactCheckCard (t/764: docs/ux/debate-fact-check-card.md) ─────────────
type FactCheckMeta = {
  verdict: FactVerdict;
  discrepancy?: FactDiscrepancy;
  explanation: string;
  checked_text: string;
  /** §5 (t/763): optional, written by the Debate Engine; an old entry has none. */
  finding?: string;
  finding_points?: string[];
  limit?: string;
  target_an_id?: string;
  web_search_used?: boolean;
  web_search_queries?: string[];
  web_search_evidence?: string;
  web_search_citations?: {
    uri: string;
    title: string;
    segments: { startIndex: number; endIndex: number; text?: string; confidence?: number }[];
  }[];
};
type FactCheckCitation = NonNullable<FactCheckMeta['web_search_citations']>[number];

function FactCheckReasoning({ reasoning, findQuery, matchOffset, findCurrentIndex }: {
  reasoning: string; findQuery: string; matchOffset: number; findCurrentIndex: number;
}) {
  if (!reasoning) return null;
  return (
    <>
      <h4 className="debate-fact-check-details-heading">Full reasoning</h4>
      <div className="debate-statement-content markdown-body">
        {findQuery
          ? <HighlightedText text={reasoning} query={findQuery} matchOffset={matchOffset} currentIndex={findCurrentIndex} />
          : <Markdown remarkPlugins={DEBATE_REMARK_PLUGINS} components={{ ...lineageMarkdownComponents, a: SafeLink, span: RefLinkSpan }}>{fixMarkdownLinks(reasoning)}</Markdown>}
      </div>
    </>
  );
}

function FactCheckCitationList({ citations }: { citations: FactCheckCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <ol className="debate-fact-check-sources">
      {citations.map((c, i) => (
        <li key={c.uri || i} id={`fact-check-source-${i + 1}`}>
          {c.uri ? <a href={c.uri} target="_blank" rel="noreferrer noopener">{c.title}</a> : <span>{c.title}</span>}
        </li>
      ))}
    </ol>
  );
}

/** §2: the queries, the grounding text and the numbered citations, or a note that no search ran. */
function FactCheckWebSearch({ factCheck, citations }: { factCheck: FactCheckMeta | undefined; citations: FactCheckCitation[] }) {
  const queries = factCheck?.web_search_queries ?? [];
  const evidence = factCheck?.web_search_evidence;
  if (queries.length === 0 && citations.length === 0 && !evidence) {
    return <p className="debate-fact-check-details-searched">Web search was not used for this fact check; the verdict rests on the taxonomy and conflict data.</p>;
  }
  return (
    <>
      <h4 className="debate-fact-check-details-heading">Web search</h4>
      {queries.length > 0 && <p className="debate-fact-check-details-searched">Searched: {queries.map(q => `“${q}”`).join(' · ')}</p>}
      {evidence && (
        <div className="debate-fact-check-web-evidence-body markdown-body">
          <Markdown remarkPlugins={DEBATE_REMARK_PLUGINS} components={{ a: SafeLink, span: RefLinkSpan }}>{fixMarkdownLinks(evidence)}</Markdown>
        </div>
      )}
      <FactCheckCitationList citations={citations} />
    </>
  );
}

/** §2: the details panel: full reasoning, the web search, the taxonomy sources. */
function FactCheckDetails({ id, entry, factCheck, citations, find, activeDebate }: {
  id: string;
  entry: TranscriptEntry;
  factCheck: FactCheckMeta | undefined;
  citations: FactCheckCitation[];
  find: { query: string; matchOffset: number; currentIndex: number };
  activeDebate: ActiveDebateT;
}) {
  return (
    <div className="debate-fact-check-details" id={id}>
      <FactCheckReasoning reasoning={factCheck?.explanation || ''} findQuery={find.query} matchOffset={find.matchOffset} findCurrentIndex={find.currentIndex} />
      <FactCheckWebSearch factCheck={factCheck} citations={citations} />
      <TaxonomyRefsSection
        refs={entry.taxonomy_refs}
        policyRefs={entry.policy_refs}
        metaPolicyRefs={metaPolicyRefsOf(entry)}
        entry={entry}
        stageDiagnostics={stageDiagnosticsFor(activeDebate, entry.id)}
      />
    </div>
  );
}

/** §1.1: the entry the fact check was raised on, from its argument-network node. Null when the
 *  fact check has no known target (a manual one): the `of …` part is then omitted. */
function factCheckTargetOf(activeDebate: ActiveDebateT, targetAnId: string | undefined): FactCheckTarget | null {
  if (!activeDebate || !targetAnId) return null;
  const node = activeDebate.argument_network?.nodes?.find(n => n.id === targetAnId);
  const target = node ? activeDebate.transcript.find(e => e.id === node.source_entry_id) : undefined;
  if (!target) return null;
  return { entryId: target.id, speaker: speakerLabel(target.speaker), kind: kindLabel(target.type) };
}

/** What the card shows, worked out once: the finding, points, target and the collapse state. */
function useFactCheckView(entry: TranscriptEntry, factCheck: FactCheckMeta | undefined, findQuery: string) {
  const activeDebate = useDebateStore(s => s.activeDebate);
  const { collapsed, toggle } = useTurnCollapsed(activeDebate?.id, activeDebate?.transcript, entry.id);
  const target = useMemo(() => factCheckTargetOf(activeDebate, factCheck?.target_an_id), [activeDebate, factCheck?.target_an_id]);
  // A find-in-debate match shows the card open, with the reasoning it matched in.
  const hasFindMatch = !!findQuery && countOccurrences(entry.content, findQuery) > 0;
  return {
    activeDebate, toggle, target, hasFindMatch,
    isCollapsed: collapsed && !hasFindMatch,
    caretShown: !!activeDebate?.id,
    finding: findingOf(factCheck), points: pointsOf(factCheck), limit: limitOf(factCheck),
  };
}

/** §4: two lines. Line 1: caret, label, pill, `of {Speaker} · {Kind}`. Line 2: the finding. */
function CollapsedFactCheck({ className, entry, factCheck, statementId, view, pill }: {
  className: string; entry: TranscriptEntry; factCheck: FactCheckMeta | undefined; statementId?: string;
  view: ReturnType<typeof useFactCheckView>; pill: ReactNode;
}) {
  return (
    <div className={className} data-entry-id={entry.id}>
      <div className="debate-statement-header" onClick={(e) => { e.stopPropagation(); view.toggle(); }}>
        {view.caretShown && <StatementCollapseToggle collapsed onToggle={view.toggle} entryId={entry.id} />}
        <div className="debate-statement-collapsed-body">
          <div className="debate-statement-collapsed-line">
            <span className="debate-fact-check-header-label">Fact check</span>
            {pill}
            <FactCheckTargetLink target={view.target} statementId={statementId} asLink={false} />
          </div>
          <span className="debate-statement-collapsed-claim">{collapsedFindingOf(factCheck)}</span>
        </div>
      </div>
    </div>
  );
}

/** §1: the open card: header, checked claim, finding, points or the discrepancy pair, sources, details. */
function OpenFactCheck({ className, entry, factCheck, statementId, view, pill, find }: {
  className: string; entry: TranscriptEntry; factCheck: FactCheckMeta | undefined; statementId?: string;
  view: ReturnType<typeof useFactCheckView>; pill: ReactNode;
  find: { query: string; matchOffset: number; currentIndex: number };
}) {
  const [showDetails, setShowDetails] = useState(false);
  const citations = factCheck?.web_search_citations ?? [];
  const detailsOpen = showDetails || view.hasFindMatch;
  const detailsId = `debate-fact-check-details-${entry.id}`;
  const pair = factCheck?.verdict === 'partially_accurate' ? factCheck.discrepancy : undefined;
  return (
    <div className={className} data-entry-id={entry.id}>
      <div className="debate-statement-header">
        {view.caretShown && <StatementCollapseToggle collapsed={false} onToggle={view.toggle} entryId={entry.id} />}
        <span className="debate-fact-check-header-label">Fact check</span>
        {pill}
        <TheoryLink docPath="docs/fact-check-process.md" anchor="what-the-card-shows-you" size={12} />
        <FactCheckTargetLink target={view.target} statementId={statementId} asLink />
      </div>
      <FactCheckChecked text={factCheck?.checked_text} />
      {view.finding ? <FactCheckFinding>{view.finding}</FactCheckFinding> : null}
      {pair ? <FactCheckDiscrepancyPair discrepancy={pair} /> : <FactCheckPoints points={view.points} limit={view.limit} />}
      <FactCheckSourcesRow citations={citations} />
      <FactCheckDetailsToggle open={detailsOpen} onToggle={() => setShowDetails(!showDetails)} panelId={detailsId} />
      {detailsOpen && (
        <FactCheckDetails id={detailsId} entry={entry} factCheck={factCheck} citations={citations} find={find} activeDebate={view.activeDebate} />
      )}
    </div>
  );
}

export function FactCheckCard({ entry, statementId, findQuery = '', matchOffset = 0, findCurrentIndex = -1 }: {
  entry: TranscriptEntry; statementId?: string; findQuery?: string; matchOffset?: number; findCurrentIndex?: number;
}) {
  const factCheck = entry.metadata?.fact_check as FactCheckMeta | undefined;
  // Same scoping hook as StatementCard — carries the 95ch prose measure (t/2240)
  // onto fact-check panels so both surfaces read as one system.
  const chatRedesign = useFlag('DEBATE_CHAT_REDESIGN');
  const view = useFactCheckView(entry, factCheck, findQuery);
  const verdictClass = factCheck?.verdict ? `debate-fact-check-${factCheck.verdict}` : '';
  const pill = <FactCheckPill verdict={factCheck?.verdict} verdictClass={verdictClass} />;
  const className = `debate-statement debate-type-fact-check debate-speaker-system ${verdictClass}${chatRedesign ? ' debate-redesign' : ''}${view.isCollapsed ? ' debate-statement-collapsed' : ''}`;
  if (view.isCollapsed) {
    return <CollapsedFactCheck className={className} entry={entry} factCheck={factCheck} statementId={statementId} view={view} pill={pill} />;
  }
  return (
    <OpenFactCheck
      className={className} entry={entry} factCheck={factCheck} statementId={statementId} view={view} pill={pill}
      find={{ query: findQuery, matchOffset, currentIndex: findCurrentIndex }}
    />
  );
}
