// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { CAMP_LABELS, isZeroResult } from './inquiryDisplay';
import { InquiryExportDropdown } from './InquiryExportDropdown';
import { InquiryShareControl } from './InquiryShareControl';
import { GroundingSection } from './GroundingSection';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import './InquiryTab.css';

type ExportFormat = 'pdf' | 'json' | 'markdown';

/** Extracted from the component (ESLint complexity) — pure request/result, no component state. */
async function runExport(result: import('../../bridge/types').InquiryResult, format: ExportFormat): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await api.exportInquiryToFile(result, result.request.question, format);
    return { ok: true };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'InquiryAnswerPanel',
      level: 'error',
      message: 'Failed to export inquiry answer',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { ok: false, message: mapErrorToUserMessage(err) };
  }
}

/** Mirrors DebateTab.handleShare (t/3659) — the epic's req-3 submit-to-community action. */
async function runSubmitToCommunity(jobId: string): Promise<{ ok: true; submissionId: string } | { ok: false; message: string }> {
  try {
    const { submissionId } = await api.submitToCommunity('inquiry', { id: jobId });
    return { ok: true, submissionId };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'InquiryAnswerPanel',
      level: 'error',
      message: 'Failed to submit inquiry to community',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { ok: false, message: mapErrorToUserMessage(err) };
  }
}

/** "View raw run" not-found detection (t/4684): web and Electron signal a missing debate
 *  differently, so both shapes are checked.
 *  - Web: web-bridge's get() throws an ActionableError with .httpStatus = 404 (throwHttpError),
 *    the same pattern useInquiryStore.ts uses for inquiry-job 404s.
 *  - Electron: debateIO.loadDebateSession throws a plain Error('Debate session not found: <id>').
 *    ipcRenderer.invoke strips structured error types crossing the main/renderer boundary — only
 *    the message string survives as a generic Error — so detect it by message instead.
 */
function isDebateNotFoundError(err: unknown): boolean {
  const httpStatus = (err as { httpStatus?: number } | null)?.httpStatus;
  if (httpStatus === 404) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /not found/i.test(message);
}

/** Extracted from the component (ESLint complexity) — probes existence before "View raw run"
 *  switches to the Debate tab (t/4684): the shared loadDebate (sessionSlice.ts) swallows load
 *  failures into debateError rather than rethrowing, so a deleted debate would otherwise navigate
 *  away with no session and no clear notice here. Non-404 errors (network, etc.) are reported as
 *  'ok' so the caller falls through to loadDebate's own debateError handling, unchanged. */
async function probeRawRunDebate(debateId: string): Promise<'ok' | 'deleted'> {
  try {
    await api.loadDebateSession(debateId);
    return 'ok';
  } catch (err) {
    if (!isDebateNotFoundError(err)) return 'ok';
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'InquiryAnswerPanel',
      level: 'warn',
      message: 'View raw run: debate not found (likely deleted from My Debates)',
      error: { name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
    });
    return 'deleted';
  }
}

/** Extracted from the component (ESLint complexity) — the deleted-vs-open branch for "View raw
 *  run" (t/4684) lives outside InquiryAnswerPanel's own complexity count, same rationale as
 *  probeRawRunDebate above. */
async function runViewRawRun(debateId: string, loadDebate: (id: string) => Promise<void>, setActiveTab: (tab: 'debate') => void): Promise<{ deleted: boolean }> {
  const outcome = await probeRawRunDebate(debateId);
  if (outcome === 'deleted') return { deleted: true };
  await loadDebate(debateId);
  setActiveTab('debate');
  return { deleted: false };
}

/** Extracted so the two render sites (zero-result and main) don't each add a branch to
 *  InquiryAnswerPanel's own complexity count (t/4684) — same rationale as InquiryGrounding below. */
function RawRunDeletedNotice({ deleted }: { deleted: boolean }) {
  if (!deleted) return null;
  return <p className="inquiry-error" role="alert">The debate behind this answer was deleted.</p>;
}

/** Extracted for ESLint complexity (t/4591 TL triage) — old results predate `grounding`; hide
 *  rather than crash, and WARN so the gap is diagnosable rather than silently absent. */
function InquiryGrounding({ grounding }: { grounding: import('../../bridge/types').InquiryResult['grounding'] }) {
  if (!grounding) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'InquiryAnswerPanel',
      level: 'warn',
      message: 'Inquiry result has no grounding field — hiding Grounding section',
      error: { name: 'MissingField', message: 'result.grounding is undefined', stack: '' },
    });
    return null;
  }
  return <GroundingSection grounding={grounding} />;
}

export function InquiryAnswerPanel() {
  const { status, result, error, terminationReason, jobId, reset, openList } = useInquiryStore();
  const [exportError, setExportError] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  const [rawRunDeleted, setRawRunDeleted] = useState(false);
  const loadDebate = useDebateStore(s => s.loadDebate);
  const setActiveTab = useTaxonomyStore(s => s.setActiveTab);

  const handleViewRawRun = async (debateId: string) => {
    setRawRunDeleted(false);
    const { deleted } = await runViewRawRun(debateId, loadDebate, setActiveTab);
    setRawRunDeleted(deleted);
  };

  const handleExport = async (format: ExportFormat) => {
    if (!result) return;
    setExportError(null);
    const outcome = await runExport(result, format);
    if (!outcome.ok) setExportError(outcome.message);
  };

  const handleSubmitToCommunity = async () => {
    if (!jobId) {
      setShareStatus('Failed: Missing inquiry job ID');
      setTimeout(() => setShareStatus(null), 4000);
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'InquiryAnswerPanel',
        level: 'warn',
        message: 'submitToCommunity called without jobId',
        error: { name: 'ValidationError', message: 'jobId is required for share', stack: '' },
      });
      return;
    }
    setShareStatus('Submitting...');
    const outcome = await runSubmitToCommunity(jobId);
    setShareStatus(outcome.ok ? `Shared! (${outcome.submissionId.slice(0, 8)})` : `Failed: ${outcome.message}`);
    setTimeout(() => setShareStatus(null), 4000);
  };

  if (status === 'failed') {
    return (
      <div className="inquiry-answer">
        <span className="inquiry-eyebrow">Answer</span>
        <div className="inquiry-banner inquiry-banner-failed">
          <span className="inquiry-bi">FAILED</span>
          <p>{error ?? 'The inquiry failed before producing a result.'}</p>
        </div>
        <div className="inquiry-rawrow">
          <button className="inquiry-ghost" onClick={reset}>Ask another question</button>
          <button className="inquiry-ghost" onClick={openList}>My Questions</button>
        </div>
      </div>
    );
  }

  if (!result) return null; // shouldn't happen once terminal per useInquiryStore.screen()

  // ADR-001 graceful-empty: "found nothing" and "never looked" arrive identically — this needs
  // its own designed treatment, not a blank/near-blank answer page (TL t/3583#4 point 2).
  if (isZeroResult(result)) {
    return (
      <div className="inquiry-answer">
        <span className="inquiry-eyebrow">Answer</span>
        <h2 className="inquiry-ansq">{result.request.question}</h2>
        <div className="inquiry-banner inquiry-banner-zero">
          <span className="inquiry-bi">NO RESULT</span>
          <p>This run completed without producing camp verdicts, convergences, or evidence — not a
            zero score, an empty answer. Try again, or check the raw run for what happened.</p>
        </div>
        <div className="inquiry-rawrow">
          <button className="inquiry-ghost" onClick={reset}>Ask another question</button>
          <button className="inquiry-ghost" onClick={() => void handleSubmitToCommunity()}>Share to Community</button>
          <InquiryExportDropdown onExport={(f) => void handleExport(f)} />
          {jobId && <InquiryShareControl jobId={jobId} result={result} />}
          {result.debateId && <button className="inquiry-ghost" onClick={() => void handleViewRawRun(result.debateId!)}>View raw run</button>}
          <button className="inquiry-ghost" onClick={openList}>My Questions</button>
        </div>
        {shareStatus && <p className="inquiry-faint">{shareStatus}</p>}
        {exportError && <p className="inquiry-error" role="alert">{exportError}</p>}
        <RawRunDeletedNotice deleted={rawRunDeleted} />
      </div>
    );
  }

  const isTruncated = status === 'done_truncated';

  return (
    <div className="inquiry-answer">
      <span className="inquiry-eyebrow">Answer</span>
      <h2 className="inquiry-ansq">{result.request.question}</h2>
      <div className="inquiry-prov mono">
        <span>debaters <b>{result.derivation.models.debaters}</b></span>
        <span>evaluator <b>{result.derivation.models.evaluator}</b></span>
        <span><b>{result.derivation.rounds}</b> rounds</span>
        {result.derivation.callsUsed !== undefined && <span><b>{result.derivation.callsUsed}</b> of <b>{result.derivation.callBudget}</b> calls</span>}
      </div>

      {/* Gated on the terminal STATUS, not terminationReason — terminationReason is set on every
       *  completed debate ('unknown' is a valid member, TL t/3599), so gating on its presence would
       *  fire on every run (TL t/3583#4 point 1). */}
      {isTruncated && (
        <div className="inquiry-banner inquiry-banner-truncated">
          <span className="inquiry-bi">TRUNCATED</span>
          <p>This run hit its <b>{result.derivation.callBudget}-call budget</b>{terminationReason ? ` (${terminationReason})` : ''} and
            was cut off, rather than stopping at a decision point. The substance below still stands, but
            metrics marked <b>incomplete</b> measure how far the debate got — a budget wall leaves them
            unreadable, not merely low.</p>
        </div>
      )}

      {result.campVerdicts.length > 0 && (
        <div className="inquiry-sect">
          <span className="inquiry-eyebrow">How each camp draws the line</span>
          <div className="inquiry-camps">
            {result.campVerdicts.map((cv) => (
              <div className={`inquiry-camp inquiry-camp-${cv.camp}`} key={cv.camp}>
                <div className="inquiry-who">{CAMP_LABELS[cv.camp]}</div>
                <p>{cv.verdict}</p>
                {cv.nodes.length > 0 && (
                  <div className="inquiry-nodes mono">{cv.nodes.map((n) => n.label).join(' · ')}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {result.convergences.map((conv, i) => (
        <div className="inquiry-conv" key={i}>
          <span className="inquiry-eyebrow">Where they converged</span>
          <p>{conv.claim}</p>
          {conv.nodes.length > 0 && <div className="inquiry-nodes mono">{conv.nodes.map((n) => n.label).join(' · ')}</div>}
        </div>
      ))}

      {result.evidenceLayers.length > 0 && (
        <div className="inquiry-sect">
          <span className="inquiry-eyebrow">The layered answer the debate produced</span>
          <div className="inquiry-layers">
            {result.evidenceLayers.map((layer, i) => (
              <div className="inquiry-layer" key={i}>
                <span className="inquiry-ln">L{i + 1}</span>
                <div>
                  <h5>{layer.title}</h5>
                  <p>{layer.role} — {layer.solves}</p>
                  {layer.sources.length > 0 && <div className="inquiry-src mono">{layer.sources.join(' · ')}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.unresolvedGaps.length > 0 && (
        <div className="inquiry-sect">
          <span className="inquiry-eyebrow">Unresolved</span>
          <ul className="inquiry-gaps">
            {result.unresolvedGaps.map((g, i) => <li key={i}>{g.description} <span className="inquiry-faint">({g.confidence})</span></li>)}
          </ul>
        </div>
      )}

      {/* t/4591: Grounding replaces Calibration on this page — calibration data itself stays in
       *  the result and the export, this only removes it from the page. */}
      <InquiryGrounding grounding={result.grounding} />

      {/* Adjacency-by-construction (t/3734, SO condition via t/3667#6): the headline is the most
       *  quotable element of the answer, and singleRunCaveat is what keeps it from reading as a
       *  settled finding. Wrapping both means a future insertion has to edit inside this element,
       *  not just avoid adding a section between two siblings elsewhere in the tree. */}
      <div className="inquiry-headline-group">
        {result.synthesizedHeadline && <p className="inquiry-headline">{result.synthesizedHeadline}</p>}
        <div className="inquiry-caveat"><b>One run, not a finding.</b> {result.singleRunCaveat}</div>
      </div>

      <div className="inquiry-rawrow">
        <button className="inquiry-ghost" onClick={reset}>Ask another question</button>
        <button className="inquiry-ghost" onClick={() => void handleSubmitToCommunity()}>Share to Community</button>
        <InquiryExportDropdown onExport={(f) => void handleExport(f)} />
        {jobId && <InquiryShareControl jobId={jobId} result={result} />}
        {result.debateId && <button className="inquiry-ghost" onClick={() => void handleViewRawRun(result.debateId!)}>View raw run</button>}
        <button className="inquiry-ghost" onClick={openList}>My Questions</button>
      </div>
      {shareStatus && <p className="inquiry-faint">{shareStatus}</p>}
      {exportError && <p className="inquiry-error" role="alert">{exportError}</p>}
      <RawRunDeletedNotice deleted={rawRunDeleted} />
    </div>
  );
}
