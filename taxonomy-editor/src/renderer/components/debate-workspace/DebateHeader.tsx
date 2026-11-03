// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { DEBATE_AUDIENCES, POVER_INFO } from '../../types/debate';
import { AI_POVERS, normalizeDebateOrigin } from '@lib/debate/types';
import type { CoverageMap, StrengthWeightedCoverage } from '@lib/debate/coverageTracker';
import { CoverageBadge } from './TaxonomyRefs';
import { TheoryLink } from '../shared/TheoryLink';
import { isDebatePopoutWindow } from '../../hooks/useDebateStore/shared/guards';
import './DebateHeader.css';

type DWStore = ReturnType<typeof useDebateStore.getState>;
type ActiveDebateSession = NonNullable<DWStore['activeDebate']>;

// Substantive transcript entry types counted as a speaker's "turns" in the DEBATERS
// strip — openings + statements + cross-responses, matching the set the transcript
// renders as that speaker's cards (t/2293 spec §Band 3).
const TURN_ENTRY_TYPES = new Set(['opening', 'statement', 'cross_respond']);

function poverTurnCount(activeDebate: ActiveDebateSession, pover: string): number {
  return activeDebate.transcript.filter(e => e.speaker === pover && TURN_ENTRY_TYPES.has(e.type)).length;
}

/** Humanize a URL for display: drop the scheme + leading `www.` and any trailing slash. */
export function humanizeUrl(s: string): string {
  return s.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');
}

/** Derive the header's display title + source subtitle (t/2293 review). Some debates
 *  have a raw-URL `topic.final` like "Discuss: https://www.…/foo" which would make the
 *  h2 and the source line show the same URL twice. Strip a leading "Discuss:", humanize
 *  a bare-URL topic, and suppress the source line when it would merely repeat the title. */
export function deriveHeaderTitle(topicFinal: string, sourceRef: string | null | undefined): {
  displayTitle: string; sourceDisplay: string | null;
} {
  const stripped = (topicFinal ?? '').replace(/^\s*discuss:\s*/i, '').trim();
  const titleIsUrl = /^https?:\/\//i.test(stripped);
  const displayTitle = (titleIsUrl ? humanizeUrl(stripped) : stripped) || (topicFinal ?? '');
  if (!sourceRef) return { displayTitle, sourceDisplay: null };
  const humanSource = humanizeUrl(sourceRef);
  return { displayTitle, sourceDisplay: humanSource === displayTitle ? null : humanSource };
}

// t/4678/t/4693: `inquiryJobId` is a legacy sibling of `origin`, not nested under it (persisted
// by the web host's old persistInquiryDebateSession as `{ ...session, origin: 'inquiry',
// inquiryJobId: jobId }`) — normalizeDebateOrigin (t/4679) needs both to recover `inquiry_id`
// from an old string-origin session. New sessions already carry the typed object.
function debateOrigin(activeDebate: ActiveDebateSession): ReturnType<typeof normalizeDebateOrigin> {
  return normalizeDebateOrigin(activeDebate.origin, (activeDebate as unknown as { inquiryJobId?: unknown }).inquiryJobId);
}

/**
 * t/4693: back-link to the originating question, split out of t/4683's `DebateTab.tsx` attempt
 * (Design review, t/4683#6) — `DebateWorkspace` is the only place a running/finished debate
 * actually renders, so the link belongs in its header, not `DebateDetailSummary`. The question
 * text IS the debate's topic (runInquiryPipeline passes the question straight into runDebate) —
 * no separate fetch by inquiry_id needed. In a pop-out window, `setActiveTab` runs in the
 * pop-out's own renderer (which only shows the debate), so the control would do nothing there —
 * render plain text instead of a dead button.
 *
 * t/4693 follow-up (Design review of the merged PR, t/4693#2): the question is already the
 * header title, so repeating it in full here added 4 extra lines at 1100px. Now a single short
 * line — "From a question · View the answer" (main window) or "From a question in Ask a
 * Question" (pop-out, plain text, no italic) — with the question named only in the button's
 * aria-label, not its visible text.
 */
function FromQuestionLink({ activeDebate }: { activeDebate: ActiveDebateSession }) {
  const origin = debateOrigin(activeDebate);
  const handleOpenQuestion = useCallback(() => {
    if (!origin?.inquiry_id) return;
    useTaxonomyStore.getState().setActiveTab('inquiry');
    void useInquiryStore.getState().openFromHistory(origin.inquiry_id);
  }, [origin?.inquiry_id]);

  if (origin?.mode !== 'inquiry' || !origin.inquiry_id) return null;

  if (isDebatePopoutWindow()) {
    return <p className="debate-hdr-from-question">From a question in Ask a Question</p>;
  }
  const topic = activeDebate.topic.final || activeDebate.topic.refined || activeDebate.topic.original;
  return (
    <p className="debate-hdr-from-question">
      From a question ·{' '}
      <button
        type="button"
        className="debate-hdr-from-question-link"
        onClick={handleOpenQuestion}
        aria-label={`View the answer to: ${topic}`}
      >
        View the answer
      </button>
    </p>
  );
}

/** Redesigned debate window header (t/2293) — three bands: title+source, status+
 *  metadata, and a per-POV DEBATERS strip. Rendered in the fixed header slot so the
 *  action controls stay always-visible (no scroll regression). The action cluster and
 *  resolved phase label are passed in to keep this component free of the toolbar/
 *  PHASE_TITLES dependency (no import cycle with DebateWorkspace.tsx). */
export function DebateHeader({
  activeDebate, coverageMap, strengthWeighted, phaseLabel, actions, onShowSetup,
}: {
  activeDebate: ActiveDebateSession;
  coverageMap: CoverageMap | null;
  strengthWeighted: StrengthWeightedCoverage | null;
  phaseLabel: string;
  actions: ReactNode;
  onShowSetup?: () => void;
}) {
  // POVs actually present, in canonical acc → saf → skp order; falls back to all three
  // if the session doesn't declare active_povers (spec §edge cases).
  const presentPovers = AI_POVERS.filter(p => (activeDebate.active_povers ?? AI_POVERS).includes(p));
  const { displayTitle, sourceDisplay } = deriveHeaderTitle(activeDebate.topic.final, activeDebate.source_ref);
  const created = new Date(activeDebate.created_at);
  const audienceLabel = activeDebate.audience
    ? (DEBATE_AUDIENCES.find(a => a.id === activeDebate.audience)?.label ?? activeDebate.audience)
    : null;

  return (
    <div className="debate-hdr">
      {/* Band 1 — title + source, action controls right */}
      <div className="debate-hdr-band debate-hdr-band1">
        <div className="debate-hdr-title-block">
          <div className="debate-hdr-title-row">
            {onShowSetup ? (
              <h2
                className="debate-hdr-title"
                title={activeDebate.topic.final}
                role="button"
                tabIndex={0}
                aria-label="Show full topic and setup"
                style={{ cursor: 'pointer' }}
                onClick={onShowSetup}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onShowSetup()}
              >
                {displayTitle}
              </h2>
            ) : (
              <h2 className="debate-hdr-title" title={activeDebate.topic.final}>{displayTitle}</h2>
            )}
            <TheoryLink
              docPath="docs/debate-system-overview.md"
              label="Help: debate system overview"
              className="debate-hdr-theory-link"
            />
          </div>
          {sourceDisplay && (
            <span className="debate-hdr-source" title={activeDebate.source_ref ?? undefined}>{sourceDisplay}</span>
          )}
          <FromQuestionLink activeDebate={activeDebate} />
        </div>
        {actions}
      </div>

      {/* Band 2 — status pills left, muted metadata right */}
      <div className="debate-hdr-band debate-hdr-band2">
        <div className="debate-hdr-status">
          <span className="debate-hdr-phase">
            <span className="debate-hdr-status-dot" aria-hidden="true" />
            {phaseLabel}
          </span>
          {coverageMap && <CoverageBadge coverageMap={coverageMap} strengthWeighted={strengthWeighted} />}
        </div>
        <div className="debate-hdr-meta">
          <span className="debate-timestamp" title={activeDebate.created_at}>
            {created.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            {' · '}
            {created.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
          {audienceLabel && <span className="debate-audience-badge">{audienceLabel}</span>}
          {activeDebate.debate_model && (
            <span className="debate-model-badge">{activeDebate.debate_model}</span>
          )}
          <code className="debate-hdr-id" title="Debate ID — click to select">{activeDebate.id}</code>
        </div>
      </div>

      {/* Band 3 — DEBATERS strip, one cell per POV with a per-POV colored accent bar */}
      <div className="debate-hdr-band debate-hdr-band3">
        <div className="debate-hdr-debaters-summary">
          <span className="debate-hdr-debaters-label">DEBATERS</span>
          <span className="debate-hdr-debaters-count">{presentPovers.length} position{presentPovers.length === 1 ? '' : 's'}</span>
        </div>
        {presentPovers.map(pover => {
          const info = POVER_INFO[pover];
          const turns = poverTurnCount(activeDebate, pover);
          return (
            <div className="debate-hdr-pov-cell" key={pover}>
              <span className="debate-hdr-pov-accent" aria-hidden="true" style={{ background: info.color }} />
              <span className="debate-hdr-pov-name">{info.label}</span>
              <span className="debate-hdr-pov-turns">{turns} turn{turns === 1 ? '' : 's'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
