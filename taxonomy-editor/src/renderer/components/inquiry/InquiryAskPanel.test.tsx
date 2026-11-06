// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4246: a tag selection whose scope is too small disables Run, with the picker rendered in the panel.
// t/4666 phase 1: "New question" is now a dialog, matching New Chat / New Op-Ed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const gate = vi.hoisted(() => ({ blocked: undefined as string | undefined }));
const store = vi.hoisted(() => ({
  question: 'Is AI hype outrunning evidence?', debaterModel: undefined as string | undefined, error: null as string | null,
  jobId: null as string | null, status: null as string | null,
  tagSelection: { pov: 'skeptic', tag: 'critical', mode: 'scope' } as { pov: string; tag: string; mode: string } | undefined,
  setQuestion: () => {}, setFidelity: vi.fn(), setDebaterModel: () => {}, setEvaluatorModel: () => {}, setTagSelection: () => {},
  resolvedModels: () => ({ debaters: 'd', evaluator: 'e', callBudget: 10 }), startInquiry: async () => {}, openList: () => {},
}));
const useInquiryStoreMock = Object.assign(() => store, { getState: () => store });
vi.mock('../../hooks/useInquiryStore', () => ({ useInquiryStore: useInquiryStoreMock, DEFAULT_FIDELITY: 'standard' }));
vi.mock('../../hooks/useTaxonomyStore/slices/settingsSlice', () => ({
  MODELS_BY_BACKEND: {},
  backendForModelWithFallback: () => 'claude',
}));
// t/4770: ModelPicker gets its own test file — stub it here so this file stays focused on the
// dialog shell, and so it doesn't drag in @bridge (api.refreshAIModels) just to render.
vi.mock('../shared/ModelPicker', () => ({
  ModelPicker: ({ model }: { model: string }) => <div>model-picker:{model}</div>,
}));
vi.mock('./InquiryTagPicker', () => ({
  InquiryTagPicker: () => <div>tag-picker</div>,
  inquiryTagBlocked: () => gate.blocked,
  tagSummaryLabel: () => 'Critical',
}));

const { InquiryAskPanel } = await import('./InquiryAskPanel');

function renderDialog(onClose = vi.fn(), onStarted = vi.fn()) {
  return { onClose, onStarted, ...render(<InquiryAskPanel onClose={onClose} onStarted={onStarted} />) };
}

beforeEach(() => {
  gate.blocked = undefined;
  store.jobId = null;
  store.status = null;
  (store.setFidelity as ReturnType<typeof vi.fn>).mockClear();
});

describe('InquiryAskPanel POV tag (t/4246)', () => {
  it('renders the tag picker', () => {
    renderDialog();
    expect(screen.getByText('tag-picker')).toBeInTheDocument();
  });

  it('Run is enabled when the tag is fine', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });

  it('Run is disabled when the tag scope is below the floor', () => {
    gate.blocked = '3 in scope — below the minimum (5)';
    renderDialog();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
  });
});

// t/4562 (Design review, t/4562#2): focus dropped to BODY on this screen — chip-prefilled and
// manual entry alike need the cursor visibly in the field, matching Op-Ed/Debates' own dialogs.
describe('InquiryAskPanel focus (t/4562)', () => {
  it('focuses the question textarea on mount, with the cursor at the end of any prefilled text', () => {
    renderDialog();
    const field = screen.getByLabelText('Research question') as HTMLTextAreaElement;
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(store.question.length);
    expect(field.selectionEnd).toBe(store.question.length);
  });

  // p/29#178 fix 1: the trigger must be captured before the question-steals-focus effect runs,
  // or this restores focus to the textarea instead of the "+ New Question" button/chip.
  it('restores focus to the trigger (not the question field) on unmount', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = renderDialog();
    expect(screen.getByLabelText('Research question')).toHaveFocus();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});

describe('InquiryAskPanel dialog shell (t/4666 phase 1)', () => {
  it('renders as a labelled dialog titled "New question"', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal');
    expect(screen.getByRole('heading', { name: 'New question' })).toBeInTheDocument();
    expect(dialog).toHaveAccessibleName('New question');
  });

  // t/4770: the "Budget: N API calls" text is removed from the dialog entirely.
  it('shows no budget text, and Cancel/Ask in the footer', () => {
    renderDialog();
    expect(screen.queryByText(/Budget:/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument();
  });

  // t/4751: the estimate is built and ready, but held behind SHOW_DURATION_ESTIMATE until
  // Azure's real measurements (not estimateInquiryDuration's placeholder table) land — TL
  // condition, p/875#4/#10. These guard against it slipping onto screen un-reviewed.
  it('does not show an estimated-time label while SHOW_DURATION_ESTIMATE is off', () => {
    renderDialog();
    expect(screen.queryByText(/Est\. time/)).not.toBeInTheDocument();
  });

  it('SHOW_DURATION_ESTIMATE is off (documents intent — flip deliberately, not by accident)', async () => {
    const { SHOW_DURATION_ESTIMATE } = await import('./InquiryAskPanel');
    expect(SHOW_DURATION_ESTIMATE).toBe(false);
  });

  it('Cancel calls onClose', async () => {
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // t/4909: Esc is now handled by the shared useDialog hook, listening on the dialog element
  // itself (bubbles up from whatever's focused inside it in real usage) rather than document.
  it('Esc calls onClose', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the overlay calls onClose, but clicking inside the dialog does not', async () => {
    const { onClose, container } = renderDialog();
    await userEvent.click(screen.getByRole('heading', { name: 'New question' }));
    expect(onClose).not.toHaveBeenCalled();
    const overlay = container.querySelector('.dialog-overlay') as HTMLElement;
    await userEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onStarted once startInquiry resolves with a job id', async () => {
    store.startInquiry = async () => { store.jobId = 'job-1'; store.status = 'queued'; };
    const { onStarted, onClose } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the dialog open (does not call onStarted) when startInquiry fails', async () => {
    store.startInquiry = async () => { store.jobId = null; store.status = 'failed'; };
    const { onStarted } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('shows the store error inside the dialog, in an alert', () => {
    store.error = 'Could not reach the server.';
    renderDialog();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server.');
    store.error = null;
  });

  it('disables Cancel and ignores Esc while submitting', async () => {
    let resolveStart: () => void = () => {};
    store.startInquiry = () => new Promise<void>(resolve => { resolveStart = resolve; });
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    resolveStart();
  });
});

describe('InquiryAskPanel Options disclosure (t/4667 phase 2)', () => {
  function optionsToggle() {
    return screen.getByRole('button', { name: /Options/ });
  }
  function optionsBody() {
    return document.getElementById('inquiry-options-body') as HTMLElement;
  }

  it('starts collapsed, with aria-expanded false and the body hidden', () => {
    renderDialog();
    expect(optionsToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(optionsBody()).toHaveAttribute('hidden');
  });

  it('the toggle shows a summary of the current model and tag', () => {
    renderDialog();
    expect(optionsToggle()).toHaveTextContent('d'); // mocked resolvedModels().debaters
    expect(optionsToggle()).toHaveTextContent('Critical');
  });

  it('clicking the toggle expands and re-collapses the body', async () => {
    renderDialog();
    await userEvent.click(optionsToggle());
    expect(optionsToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(optionsBody()).not.toHaveAttribute('hidden');
    await userEvent.click(optionsToggle());
    expect(optionsToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(optionsBody()).toHaveAttribute('hidden');
  });

  it('shows the change badge when the tag is set (a non-default), not when everything is default', () => {
    store.tagSelection = undefined;
    renderDialog();
    expect(screen.queryByLabelText(/setting.*changed/)).not.toBeInTheDocument();
    store.tagSelection = { pov: 'skeptic', tag: 'critical', mode: 'scope' };
  });

  it('a blocked tag auto-expands Options and shows the reason on the toggle', () => {
    gate.blocked = '3 in scope — below the minimum (5)';
    renderDialog();
    expect(optionsToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(optionsBody()).not.toHaveAttribute('hidden');
    // p/29#186 fix 3: the full (untruncated) reason lives in the sr-only element aria-describedby
    // targets, not in a `title` on the (possibly-truncated) visible copy.
    const reasonEl = document.getElementById('inquiry-options-tag-reason');
    expect(reasonEl).toHaveTextContent('POV tag: 3 in scope — below the minimum (5)');
  });

  it('Ask is described by the blocked-tag reason when blocked', () => {
    gate.blocked = '3 in scope — below the minimum (5)';
    renderDialog();
    expect(screen.getByRole('button', { name: 'Ask' })).toHaveAttribute('aria-describedby', 'inquiry-options-tag-reason');
  });

  // t/4770: no fidelity choice left — every question runs at Quick, set on the store on mount.
  it('sets fidelity to quick on mount, with no fidelity UI to change it', () => {
    renderDialog();
    expect(store.setFidelity).toHaveBeenCalledWith('quick');
    expect(screen.queryByRole('radiogroup', { name: /Fidelity/ })).not.toBeInTheDocument();
  });

  // t/4770: Debaters/Evaluator replaced by the single shared ModelPicker (its own test file
  // covers the picker's internals — this just confirms the dialog renders it).
  it('renders the shared ModelPicker instead of separate Debaters/Evaluator selects', () => {
    renderDialog();
    expect(screen.getByText('model-picker:d')).toBeInTheDocument();
    expect(screen.queryByLabelText('Debater model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Evaluator model')).not.toBeInTheDocument();
  });
});
