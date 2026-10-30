// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { MODELS_BY_BACKEND } from '../../hooks/useTaxonomyStore/slices/settingsSlice';
import type { Fidelity } from '@lib/inquiry';
import { FIDELITY_LABELS, FIDELITY_DESCRIPTIONS } from './inquiryDisplay';
import { InquiryTagPicker, inquiryTagBlocked } from './InquiryTagPicker';
import {
  truncateLabel, modelSummarySegment, tagSummarySegment, fidelitySummarySegment, optionsChangeCount,
} from './InquiryOptionsSummary';
import { useFocusTrap } from '../debate/NewDebateDialog.hooks';
import './InquiryTab.css';

const FIDELITIES: Fidelity[] = ['quick', 'standard', 'deep'];

/** Flattened, alphabetically-grouped model list for the two pickers — sourced from
 *  ai-models.json's picker entries (deriveModelsByBackend), never a hardcoded model list. */
const ALL_MODEL_OPTIONS = Object.entries(MODELS_BY_BACKEND)
  .flatMap(([, entries]) => entries)
  .sort((a, b) => a.label.localeCompare(b.label));

interface InquiryAskPanelProps {
  /** Cancel, Esc, or an overlay click — inert while submitting. */
  onClose: () => void;
  /** A job id arrived — the dialog should close so the Running screen can take over. */
  onStarted: () => void;
}

// t/4667: roving tabIndex + arrow-key navigation for the fidelity radiogroup, extracted so the
// dialog's own complexity doesn't absorb the key-handling branches (local/complexity-budget).
function FidelityCards({ fidelity, onChange }: { fidelity: Fidelity; onChange: (f: Fidelity) => void }) {
  const cardRefs = useRef<Partial<Record<Fidelity, HTMLDivElement | null>>>({});

  function moveFocus(fromIdx: number, dir: 1 | -1): void {
    const next = FIDELITIES[(fromIdx + dir + FIDELITIES.length) % FIDELITIES.length];
    onChange(next);
    cardRefs.current[next]?.focus();
  }

  function handleKeyDown(e: ReactKeyboardEvent, idx: number, f: Fidelity): void {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(f); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); moveFocus(idx, 1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); moveFocus(idx, -1); }
  }

  return (
    <div className="inquiry-fid" role="radiogroup" aria-label="Fidelity">
      {FIDELITIES.map((f, idx) => (
        <div
          key={f}
          ref={(el) => { cardRefs.current[f] = el; }}
          className="inquiry-fcard"
          data-sel={fidelity === f ? '1' : undefined}
          tabIndex={fidelity === f ? 0 : -1}
          role="radio"
          aria-checked={fidelity === f}
          onClick={() => onChange(f)}
          onKeyDown={(e) => handleKeyDown(e, idx, f)}
        >
          <h4><span className="inquiry-tick" />{FIDELITY_LABELS[f]}</h4>
          <p>{FIDELITY_DESCRIPTIONS[f]}</p>
        </div>
      ))}
    </div>
  );
}

// t/4667: the Options toggle's summary line + change badge, extracted for the same reason —
// the string-building (truncation, per-segment titles) doesn't belong in the dialog's own body.
function OptionsToggleSummary({
  fidelity, modelSegment, tagSegment, tagBlocked, changeCount,
}: {
  fidelity: Fidelity; modelSegment: string; tagSegment: string; tagBlocked: boolean; changeCount: number;
}) {
  const fidelitySeg = fidelitySummarySegment(fidelity);
  return (
    <>
      <span className="inquiry-options-title">Options</span>
      {changeCount > 0 && (
        <span className="inquiry-options-badge" aria-label={`${changeCount} setting${changeCount > 1 ? 's' : ''} changed`}>
          {changeCount}
        </span>
      )}
      <span className="inquiry-options-summary">
        {' · '}
        <span title={fidelitySeg}>{truncateLabel(fidelitySeg)}</span>
        {' · '}
        <span title={modelSegment}>{truncateLabel(modelSegment)}</span>
        {' · '}
        <span id="inquiry-options-tag-reason" className={tagBlocked ? 'inquiry-options-seg-warning' : undefined} title={tagSegment}>
          {truncateLabel(tagSegment)}
        </span>
      </span>
    </>
  );
}

// t/4666: "New question" is now a dialog over the library page, matching New Chat / New Op-Ed —
// it only mounts while open, so capturing the trigger on mount / restoring focus on unmount is
// naturally open/close-symmetric (no separate `open` prop to track).
export function InquiryAskPanel({ onClose, onStarted }: InquiryAskPanelProps) {
  const { question, fidelity, debaterModel, evaluatorModel, error, setQuestion, setFidelity, setDebaterModel, setEvaluatorModel, tagSelection, setTagSelection, resolvedModels, startInquiry } = useInquiryStore();
  const [submitting, setSubmitting] = useState(false);
  // t/4667: collapsed by default every time the dialog opens — not persisted (unlike t/4639's
  // getting-started accordion). A blocked tag force-expands regardless of this toggle.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, true);

  // t/4666 (Design spec, p/29#178 fix 1): must run BEFORE the question-focus effect below —
  // effects run in declaration order, so capturing the trigger here first means
  // document.activeElement is still the "+ New Question" button / chip, not the textarea the
  // next effect is about to focus. Focus returns to it on close.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    return () => trigger?.focus();
  }, []);

  // t/4562 (Design review): focus drops to BODY on this screen otherwise — matches Op-Ed/Debates'
  // own create-dialog behavior, and a chip-prefilled question needs the cursor visibly placed,
  // not just a populated field. Cursor at the END (not a full select) so typing continues the
  // prefilled text rather than silently replacing it.
  useEffect(() => {
    const el = questionRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // Only on mount — the dialog remounts fresh each time it opens, so there is no "re-run on
    // every question change" risk to re-litigate.
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  const resolved = resolvedModels();
  // t/4246: a tag whose scope is too small blocks the run here, as it does in chat setup.
  const tagBlocked = inquiryTagBlocked(tagSelection);
  const canSubmit = question.trim().length > 0 && !submitting && !tagBlocked;
  // t/4667 (spec): a blocked tag auto-expands Options regardless of the manual toggle state.
  const optionsExpanded = optionsOpen || !!tagBlocked;
  const modelSegment = modelSummarySegment(resolved.debaters, resolved.evaluator, ALL_MODEL_OPTIONS);
  const tagSegment = tagSummarySegment(tagSelection, tagBlocked);
  const changeCount = optionsChangeCount(fidelity, debaterModel, evaluatorModel, tagSelection);

  // startInquiry() never rejects — it catches + records + sets `error` internally (single error
  // path shared with the poll loop). Once it resolves, the store's own jobId/status say whether
  // it actually started — a start failure keeps the dialog open with that error still in `error`.
  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    await startInquiry();
    setSubmitting(false);
    const { jobId, status } = useInquiryStore.getState();
    if (jobId && status !== 'failed') onStarted();
  }

  return (
    <div className="dialog-overlay" onClick={() => { if (!submitting) onClose(); }}>
      <div
        ref={dialogRef}
        className="dialog new-question-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="new-question-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="new-question-title">New question</h2>
        <div className="new-question-body">
          <label className="inquiry-asklab" htmlFor="inquiry-question">Research question</label>
          <textarea
            id="inquiry-question"
            ref={questionRef}
            className="inquiry-qfield"
            rows={2}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What counts as an AI harm, and what would prove one?"
          />

          <div className="inquiry-options" data-expanded={optionsExpanded}>
            <button
              type="button"
              className="inquiry-options-toggle"
              aria-expanded={optionsExpanded}
              aria-controls="inquiry-options-body"
              onClick={() => setOptionsOpen((o) => !o)}
            >
              <OptionsToggleSummary
                fidelity={fidelity}
                modelSegment={modelSegment}
                tagSegment={tagSegment}
                tagBlocked={!!tagBlocked}
                changeCount={changeCount}
              />
              <svg className="inquiry-options-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div id="inquiry-options-body" className="inquiry-options-body" hidden={!optionsExpanded}>
              <FidelityCards fidelity={fidelity} onChange={setFidelity} />

              <div className="inquiry-models">
                <div className="inquiry-mrow">
                  <span className="inquiry-mlab">Debaters</span>
                  <select
                    className="inquiry-msel"
                    aria-label="Debater model"
                    value={debaterModel ?? ''}
                    onChange={(e) => setDebaterModel(e.target.value || undefined)}
                  >
                    <option value="">{resolved.debaters} — from {FIDELITY_LABELS[fidelity]}</option>
                    {ALL_MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                <div className="inquiry-mrow">
                  <span className="inquiry-mlab">Evaluator</span>
                  <select
                    className="inquiry-msel"
                    aria-label="Evaluator model"
                    value={evaluatorModel ?? ''}
                    onChange={(e) => setEvaluatorModel(e.target.value || undefined)}
                  >
                    <option value="">{resolved.evaluator} — from {FIDELITY_LABELS[fidelity]}</option>
                    {ALL_MODEL_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                <InquiryTagPicker value={tagSelection} onChange={setTagSelection} />
                <p className="inquiry-mnote">Both default from the fidelity you picked. Change them when the model
                  <em> is</em> the variable you're testing — the answer records what actually ran.</p>
              </div>
            </div>
          </div>

          {error && <p className="inquiry-error" role="alert">{error}</p>}
        </div>

        <div className="new-question-actions">
          <span className="inquiry-costnote">Budget: <b>{resolved.callBudget}</b> API calls</span>
          <div className="new-question-actions-right">
            <button className="btn" onClick={onClose} disabled={submitting}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              aria-describedby={tagBlocked ? 'inquiry-options-tag-reason' : undefined}
            >
              {submitting ? 'Starting…' : 'Ask'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
