// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import type { InquiryStageTiming } from '@lib/inquiry/jobStatus';
import { STAGE_ORDER, STAGE_META, stageStatus, formatStageElapsed, formatStageElapsedSpoken } from './inquiryDisplay';
import './InquiryTab.css';

// t/4714: the visible detail line always shows the latest stageDetail. Only the screen-reader
// announcement is throttled, to at most one per 10s, so a 3s poll cadence doesn't spam it. A
// throttled value is deferred (trailing), never dropped, so the latest detail is always announced.
const DETAIL_ANNOUNCE_THROTTLE_MS = 10_000;

function useThrottledAnnouncement(detail: string | null): string | null {
  const [announced, setAnnounced] = useState<string | null>(null);
  const lastAt = useRef<number | null>(null);
  useEffect(() => {
    if (!detail) return;
    const wait = lastAt.current === null ? 0 : lastAt.current + DETAIL_ANNOUNCE_THROTTLE_MS - Date.now();
    const announce = () => { lastAt.current = Date.now(); setAnnounced(detail); };
    if (wait <= 0) { announce(); return; }
    const timer = setTimeout(announce, wait);
    return () => clearTimeout(timer);
  }, [detail]);
  return announced;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const MAX_VISIBLE_STEPS = 10;

/** t/328: the stage's sub-steps as an append-only checklist. While the stage runs the last row is
 *  the current step (spinner) and earlier rows are done; once the stage is done every row is ✓ and
 *  the list collapses behind a disclosure. */
function StageSteps({ title, steps, running }: { title: string; steps: string[]; running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const stuckToBottom = useRef(true);
  const [faded, setFaded] = useState(false);
  const scrollable = steps.length > MAX_VISIBLE_STEPS;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stuckToBottom.current) el.scrollTop = el.scrollHeight;
    setFaded(el.scrollTop > 0);
  }, [steps.length, running, expanded]);

  if (steps.length === 0) return null;

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    setFaded(el.scrollTop > 0);
  };

  const list = (
    <ol
      ref={listRef}
      className="inquiry-steps"
      data-faded={faded ? 'true' : undefined}
      onScroll={onScroll}
      tabIndex={scrollable ? 0 : undefined}
      aria-label={scrollable ? `${title} steps` : undefined}
    >
      {steps.map((step, i) => {
        const current = running && i === steps.length - 1;
        return (
          <li className="inquiry-step" data-current={current ? 'true' : undefined} key={`${i}-${step}`}>
            <span className={current ? 'inquiry-step-spinner' : 'inquiry-step-check'} aria-hidden="true">{current ? '' : '✓'}</span>
            <span className="inquiry-sr-only">{current ? 'in progress' : 'done'}</span>
            <span className="inquiry-step-label">{step}</span>
          </li>
        );
      })}
    </ol>
  );

  if (running) return list;
  return (
    <div className="inquiry-steps-done">
      <button
        type="button"
        className="inquiry-steps-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(e => !e)}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {steps.length} {steps.length === 1 ? 'step' : 'steps'}
      </button>
      {expanded && list}
    </div>
  );
}

function stageElapsedMs(s: 'done' | 'live' | 'wait', t: InquiryStageTiming, now: number): number | null {
  if (t.startedAt === undefined) return null;
  if (s === 'live') return now - t.startedAt;
  if (s === 'done' && t.endedAt !== undefined) return t.endedAt - t.startedAt;
  return null;
}

interface StageRowProps {
  stage: (typeof STAGE_ORDER)[number];
  index: number;
  state: 'done' | 'live' | 'wait';
  timing: InquiryStageTiming;
  now: number;
  steps: string[];
  announced: string | null;
}

function StageRow({ stage, index, state, timing, now, steps, announced }: StageRowProps) {
  const elapsedMs = stageElapsedMs(state, timing, now);
  const timerText = state === 'wait' ? '' : elapsedMs === null ? '—' : formatStageElapsed(elapsedMs);
  const statLabel = state === 'done' ? 'done' : state === 'live' ? 'running' : 'waiting';
  const spoken = elapsedMs === null ? null
    : state === 'done' ? `, ${formatStageElapsedSpoken(elapsedMs)}` : `, ${formatStageElapsed(elapsedMs)} elapsed`;
  return (
    <div className="inquiry-sg" data-s={state}>
      <span className="inquiry-n">{String(index + 1).padStart(2, '0')}</span>
      <div>
        <h5>{STAGE_META[stage].title}</h5>
        <div className="inquiry-sub">{STAGE_META[stage].sub}</div>
        {state !== 'wait' && <StageSteps title={STAGE_META[stage].title} steps={steps} running={state === 'live'} />}
        {state === 'live' && <span className="inquiry-sr-only" aria-live="polite">{announced ?? ''}</span>}
      </div>
      <span className="inquiry-timer" aria-hidden="true">{timerText}</span>
      <span className="inquiry-stat">
        {statLabel}
        {spoken && <span className="inquiry-sr-only">{spoken}</span>}
      </span>
    </div>
  );
}

export function InquiryRunningPanel() {
  const { question, jobId, status, progressPct, stageDetail, stageDetailHistory, stageTimings, pollError } = useInquiryStore();
  const announcedDetail = useThrottledAnnouncement(stageDetail);
  const running = STAGE_ORDER.some(stage => stageStatus(status, stage) === 'live');
  const now = useNow(running);

  // t/346: total elapsed (PI-approved), from the first observed stage start. Not a live region.
  const firstStart = Math.min(...STAGE_ORDER.map(st => stageTimings[st].startedAt ?? Infinity));
  const totalElapsed = Number.isFinite(firstStart) ? formatStageElapsed(now - firstStart) : null;

  return (
    <div className="inquiry-run">
      <div className="inquiry-runhead">
        <p className="inquiry-runq">{question}</p>
        {jobId && <span className="inquiry-jobid mono">{jobId}</span>}
      </div>

      <div className="inquiry-stages">
        {STAGE_ORDER.map((stage, i) => {
          const state = stageStatus(status, stage);
          return (
            <StageRow
              key={stage}
              stage={stage}
              index={i}
              state={state}
              timing={stageTimings[stage]}
              now={now}
              steps={stageDetailHistory[stage] ?? (state === 'live' && stageDetail ? [stageDetail] : [])}
              announced={announcedDetail}
            />
          );
        })}
      </div>

      <div className="inquiry-budget">
        <div className="inquiry-budget-top">
          <span>Progress{totalElapsed && <> · <span className="inquiry-total-elapsed">{totalElapsed}</span> elapsed</>}</span>
          <span><b>{Math.round(progressPct)}</b>%</span>
        </div>
        <div className="inquiry-meter">
          {/* eslint-disable-next-line local/no-inline-style -- dynamic numeric percentage, no static token fits */}
          <i style={{ width: `${progressPct}%` }} />
        </div>
        <small>If this runs out before the debate reaches a decision point, the run is truncated and
          affected metrics are marked accordingly. You can leave this tab — the run continues.</small>
      </div>

      {pollError && (
        <p className="inquiry-poll-warning" role="status">
          Having trouble checking status ({pollError}) — still trying, the inquiry itself is unaffected.
        </p>
      )}
    </div>
  );
}
