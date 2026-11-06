// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useRef, useState } from 'react';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { MODELS_BY_BACKEND, backendForModelWithFallback } from '../../hooks/useTaxonomyStore/slices/settingsSlice';
import { estimateInquiryDuration } from '@lib/inquiry';
import { ModelPicker } from '../shared/ModelPicker';
import { InquiryTagPicker, inquiryTagBlocked } from './InquiryTagPicker';
import {
  truncateLabel, modelSummarySegment, tagSummarySegment, optionsChangeCount,
} from './InquiryOptionsSummary';
import { useDialog } from '../shared/useDialog'; // t/4909
import './InquiryTab.css';

// t/4751: estimateInquiryDuration's table is still PLACEHOLDER data (TL condition, p/875#4/#10)
// — Azure's measured p50/p90 (t/4751 step 1) haven't replaced it yet, and the placeholders read
// low next to t/4753's longer runs. Don't surface it to users until that data lands; flip this
// once lib/inquiry/durationEstimate.ts's table cites a real Azure measurement instead of
// "PLACEHOLDER" in its header comment.
export const SHOW_DURATION_ESTIMATE = false;

/** t/4770 spec default — shown on the slider until the user moves it; `undefined` in the store
 *  (not this value) is what tells startInquiry() to omit the field and take the server default. */
const DEFAULT_TEMPERATURE = 0.8;

/** Flattened, alphabetically-grouped model list for the summary line — sourced from
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

// t/4667: the Options toggle's summary line + change badge, extracted for the same reason —
// the string-building (truncation, per-segment titles) doesn't belong in the dialog's own body.
function OptionsToggleSummary({
  modelSegment, tagSegment, tagBlocked, changeCount,
}: {
  modelSegment: string; tagSegment: string; tagBlocked: boolean; changeCount: number;
}) {
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
        <span title={modelSegment}>{truncateLabel(modelSegment)}</span>
        {' · '}
        <span className={tagBlocked ? 'inquiry-options-seg-warning' : undefined} title={tagSegment}>
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
  const { question, debaterModel, temperature, error, setQuestion, setFidelity, setDebaterModel, setEvaluatorModel, setTemperature, tagSelection, setTagSelection, resolvedModels, startInquiry } = useInquiryStore();
  const [submitting, setSubmitting] = useState(false);
  const resolved = resolvedModels();
  // t/4770: one model, used for both debaters and evaluator — the dialog no longer offers a
  // separate Evaluator choice. `family` is derived from it rather than tracked separately: the
  // only way to change family is through ModelPicker's own family select, which always follows
  // up with an onModelChange call for the new family's default model in the same handler, so the
  // next render's derived family is already correct.
  const model = debaterModel ?? resolved.debaters;
  const family = backendForModelWithFallback(model);
  // t/4667: collapsed by default every time the dialog opens — not persisted (unlike t/4639's
  // getting-started accordion). A blocked tag force-expands regardless of this toggle.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  // t/4909: useDialog's own mount effect (opener-capture + initial focus) must run BEFORE the
  // question-focus effect below, for the same reason the comment there used to give — effects
  // run in declaration order, so this call comes first. closeOnEscape mirrors the existing
  // overlay-click guard: inert while submitting.
  const { dialogRef, titleId } = useDialog({ onCancel: onClose, closeOnEscape: !submitting });

  // t/4562 (Design review): focus drops to BODY on this screen otherwise — matches Op-Ed/Debates'
  // own create-dialog behavior, and a chip-prefilled question needs the cursor visibly placed,
  // not just a populated field. Cursor at the END (not a full select) so typing continues the
  // prefilled text rather than silently replacing it. Runs after useDialog's own initial-focus
  // effect and overrides it with the more specific cursor placement.
  useEffect(() => {
    const el = questionRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // Only on mount — the dialog remounts fresh each time it opens, so there is no "re-run on
    // every question change" risk to re-litigate.
  }, []);

  // t/4770: every question runs at Quick now — no UI choice, but the request still needs
  // `fidelity: 'quick'` set on the store (startInquiry() reads it from there). Mount-only, same
  // rationale as the question-focus effect above: the dialog remounts fresh each open.
  useEffect(() => {
    setFidelity('quick');
  }, [setFidelity]);

  // t/4751: AC1 — updates whenever the model changes. Rendering is gated by
  // SHOW_DURATION_ESTIMATE until Azure's real numbers replace the helper's placeholder table.
  const durationEstimate = estimateInquiryDuration({ fidelity: 'quick', debaterModel: model });
  // t/4246: a tag whose scope is too small blocks the run here, as it does in chat setup.
  const tagBlocked = inquiryTagBlocked(tagSelection);
  const canSubmit = question.trim().length > 0 && !submitting && !tagBlocked;
  // t/4667 (spec): a blocked tag auto-expands Options regardless of the manual toggle state.
  const optionsExpanded = optionsOpen || !!tagBlocked;
  const modelSegment = modelSummarySegment(model, model, ALL_MODEL_OPTIONS);
  const tagSegment = tagSummarySegment(tagSelection, tagBlocked);
  const changeCount = optionsChangeCount(debaterModel, tagSelection);

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
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId}>New question</h2>
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
                modelSegment={modelSegment}
                tagSegment={tagSegment}
                tagBlocked={!!tagBlocked}
                changeCount={changeCount}
              />
              <svg className="inquiry-options-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {/* p/29#187: outside the toggle button, not inside — a descendant inside the button
                would double into its accessible name (and be read twice for a blocked reason).
                aria-describedby works on an element anywhere in the document. */}
            <span id="inquiry-options-tag-reason" className="inquiry-sr-only">{tagSegment}</span>
            <div id="inquiry-options-body" className="inquiry-options-body" hidden={!optionsExpanded}>
              <div className="inquiry-models">
                <ModelPicker
                  idPrefix="inquiry-model"
                  family={family}
                  model={model}
                  onFamilyChange={() => { /* derived from `model` on the next render — see the comment at `model`'s declaration */ }}
                  onModelChange={(m) => { setDebaterModel(m); setEvaluatorModel(m); }}
                  temperature={{ value: temperature ?? DEFAULT_TEMPERATURE, onChange: setTemperature }}
                />
                <InquiryTagPicker value={tagSelection} onChange={setTagSelection} />
              </div>
            </div>
          </div>

          {error && <p className="inquiry-error" role="alert">{error}</p>}
        </div>

        <div className="new-question-actions">
          {/* t/4770: the "Budget: N API calls" text is gone. SHOW_DURATION_ESTIMATE's slot stays
              (still flag-gated, t/4751) for when the time estimate is ready to ship. */}
          {SHOW_DURATION_ESTIMATE && (
            <span className="inquiry-costnote">Est. time: <b>~{durationEstimate.lowMin}&ndash;{durationEstimate.highMin} min</b></span>
          )}
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
