// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4246: a tag selection whose scope is too small disables Run, with the picker rendered in the panel.
// t/4666 phase 1: "New question" is now a dialog, matching New Chat / New Op-Ed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const gate = vi.hoisted(() => ({ blocked: undefined as string | undefined }));
const store = vi.hoisted(() => ({
  question: 'Is AI hype outrunning evidence?', fidelity: 'quick', debaterModel: undefined, evaluatorModel: undefined, error: null,
  jobId: null as string | null, status: null as string | null,
  tagSelection: { pov: 'skeptic', tag: 'critical', mode: 'scope' },
  setQuestion: () => {}, setFidelity: () => {}, setDebaterModel: () => {}, setEvaluatorModel: () => {}, setTagSelection: () => {},
  resolvedModels: () => ({ debaters: 'd', evaluator: 'e', callBudget: 10 }), startInquiry: async () => {}, openList: () => {},
}));
const useInquiryStoreMock = Object.assign(() => store, { getState: () => store });
vi.mock('../../hooks/useInquiryStore', () => ({ useInquiryStore: useInquiryStoreMock }));
vi.mock('../../hooks/useTaxonomyStore/slices/settingsSlice', () => ({ MODELS_BY_BACKEND: {} }));
vi.mock('./InquiryTagPicker', () => ({
  InquiryTagPicker: () => <div>tag-picker</div>,
  inquiryTagBlocked: () => gate.blocked,
}));

const { InquiryAskPanel } = await import('./InquiryAskPanel');

function renderDialog(onClose = vi.fn(), onStarted = vi.fn()) {
  return { onClose, onStarted, ...render(<InquiryAskPanel onClose={onClose} onStarted={onStarted} />) };
}

beforeEach(() => {
  gate.blocked = undefined;
  store.jobId = null;
  store.status = null;
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
});

describe('InquiryAskPanel dialog shell (t/4666 phase 1)', () => {
  it('renders as a labelled dialog titled "New question"', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal');
    expect(screen.getByRole('heading', { name: 'New question' })).toBeInTheDocument();
    expect(dialog).toHaveAccessibleName('New question');
  });

  it('shows the budget and Cancel/Ask in the footer', () => {
    renderDialog();
    expect(screen.getByText(/Budget:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument();
  });

  it('Cancel calls onClose', async () => {
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc calls onClose', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the overlay calls onClose, but clicking inside the dialog does not', async () => {
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByRole('heading', { name: 'New question' }));
    expect(onClose).not.toHaveBeenCalled();
    // eslint-disable-next-line testing-library/no-node-access -- the overlay itself has no accessible role
    await userEvent.click(screen.getByRole('dialog').parentElement!);
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
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    resolveStart();
  });
});
