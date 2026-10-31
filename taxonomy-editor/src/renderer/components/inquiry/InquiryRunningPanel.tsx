// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useRef, useState } from 'react';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { STAGE_ORDER, STAGE_META, stageStatus } from './inquiryDisplay';
import './InquiryTab.css';

// t/4714: throttles the aria-live announcement (and the visible line, same value) to roughly
// once per 10s so a 3s poll cadence doesn't spam a screen reader with every intermediate detail.
const DETAIL_ANNOUNCE_THROTTLE_MS = 10_000;

export function InquiryRunningPanel() {
  const { question, jobId, status, progressPct, stageDetail, pollError, openList } = useInquiryStore();

  const [announcedDetail, setAnnouncedDetail] = useState<string | null>(null);
  const lastAnnouncedAt = useRef(0);
  useEffect(() => {
    if (!stageDetail || stageDetail === announcedDetail) return;
    const now = performance.now();
    if (now - lastAnnouncedAt.current < DETAIL_ANNOUNCE_THROTTLE_MS) return;
    lastAnnouncedAt.current = now;
    setAnnouncedDetail(stageDetail);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only re-runs on a new stageDetail value, not on announcedDetail's own change
  }, [stageDetail]);

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
                {s === 'live' && announcedDetail && (
                  <div className="inquiry-stage-detail" aria-live="polite">{announcedDetail}</div>
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
