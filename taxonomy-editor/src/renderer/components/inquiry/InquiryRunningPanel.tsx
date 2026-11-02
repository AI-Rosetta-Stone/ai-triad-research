// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useRef, useState } from 'react';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { STAGE_ORDER, STAGE_META, stageStatus } from './inquiryDisplay';
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

export function InquiryRunningPanel() {
  const { question, jobId, status, progressPct, stageDetail, pollError, openList } = useInquiryStore();
  const announcedDetail = useThrottledAnnouncement(stageDetail);

  return (
    <div className="inquiry-run">
      <div className="inquiry-rawrow">
        {/* t/4562: the persistent Ask/My/Community strip is gone (replaced by the library page
         *  on the list screen) — this is the running screen's own way back while the poll
         *  continues in the background (the poll is keyed on jobId, not on which screen is shown). */}
        <button className="inquiry-ghost" onClick={openList}>My Questions</button>
      </div>
      <div className="inquiry-runhead">
        <p className="inquiry-runq">{question}</p>
        {jobId && <span className="inquiry-jobid mono">{jobId}</span>}
      </div>

      <div className="inquiry-stages">
        {STAGE_ORDER.map((stage, i) => {
          const s = stageStatus(status, stage);
          return (
            <div className="inquiry-sg" data-s={s} key={stage}>
              <span className="inquiry-n">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <h5>{STAGE_META[stage].title}</h5>
                <div className="inquiry-sub">{STAGE_META[stage].sub}</div>
                {s === 'live' && stageDetail && (
                  <div className="inquiry-stage-detail" aria-hidden="true">{stageDetail}</div>
                )}
                {s === 'live' && (
                  <span className="inquiry-sr-only" aria-live="polite">{announcedDetail ?? ''}</span>
                )}
              </div>
              <span className="inquiry-stat">{s === 'done' ? 'done' : s === 'live' ? 'running' : 'waiting'}</span>
            </div>
          );
        })}
      </div>

      <div className="inquiry-budget">
        <div className="inquiry-budget-top"><span>Progress</span><span><b>{progressPct}</b>%</span></div>
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
