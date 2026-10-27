// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useRef, useState } from 'react';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { MODELS_BY_BACKEND } from '../../hooks/useTaxonomyStore/slices/settingsSlice';
import type { Fidelity } from '@lib/inquiry';
import { FIDELITY_LABELS, FIDELITY_DESCRIPTIONS } from './inquiryDisplay';
import { InquiryTagPicker, inquiryTagBlocked } from './InquiryTagPicker';
import './InquiryTab.css';

const FIDELITIES: Fidelity[] = ['quick', 'standard', 'deep'];

/** Flattened, alphabetically-grouped model list for the two pickers — sourced from
 *  ai-models.json's picker entries (deriveModelsByBackend), never a hardcoded model list. */
const ALL_MODEL_OPTIONS = Object.entries(MODELS_BY_BACKEND)
  .flatMap(([, entries]) => entries)
  .sort((a, b) => a.label.localeCompare(b.label));

export function InquiryAskPanel() {
  const { question, fidelity, debaterModel, evaluatorModel, error, setQuestion, setFidelity, setDebaterModel, setEvaluatorModel, tagSelection, setTagSelection, resolvedModels, startInquiry, openList } = useInquiryStore();
  const [submitting, setSubmitting] = useState(false);
  const questionRef = useRef<HTMLTextAreaElement>(null);

  // t/4562 (Design review): focus drops to BODY on this screen otherwise — matches Op-Ed/Debates'
  // own create-dialog behavior, and a chip-prefilled question needs the cursor visibly placed,
  // not just a populated field. Cursor at the END (not a full select) so typing continues the
  // prefilled text rather than silently replacing it.
  useEffect(() => {
    const el = questionRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // Only on mount — this screen remounts fresh each time Ask is (re)entered (reset()/openMy
    // unmount it), so there is no "re-run on every question change" risk to re-litigate.
  }, []);

  const resolved = resolvedModels();
  // t/4246: a tag whose scope is too small blocks the run here, as it does in chat setup.
  const tagBlocked = inquiryTagBlocked(tagSelection);
  const canSubmit = question.trim().length > 0 && !submitting && !tagBlocked;

  // startInquiry() never rejects — it catches + records + sets `error` internally (single error
  // path shared with the poll loop), so this only needs to track the in-flight spinner state.
  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    await startInquiry();
    setSubmitting(false);
  }

  return (
    <div className="inquiry-ask">
      <div className="inquiry-rawrow">
        <button className="inquiry-ghost inquiry-back" onClick={openList}>← My Questions</button>
      </div>
      <h2 className="inquiry-ask-heading">New question</h2>
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

      <div className="inquiry-fid" role="radiogroup" aria-label="Fidelity">
        {FIDELITIES.map((f) => (
          <div
            key={f}
            className="inquiry-fcard"
            data-sel={fidelity === f ? '1' : undefined}
            tabIndex={0}
            role="radio"
            aria-checked={fidelity === f}
            onClick={() => setFidelity(f)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFidelity(f); } }}
          >
            <h4><span className="inquiry-tick" />{FIDELITY_LABELS[f]}</h4>
            <p>{FIDELITY_DESCRIPTIONS[f]}</p>
          </div>
        ))}
      </div>

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

      <div className="inquiry-actions">
        <button className="inquiry-btn" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {submitting ? 'Starting…' : 'Ask'}
        </button>
        <span className="inquiry-costnote">Budget for this run: <b>{resolved.callBudget}</b> API calls. You'll see it deplete as it goes.</span>
      </div>
      {error && <p className="inquiry-error" role="alert">{error}</p>}
    </div>
  );
}
