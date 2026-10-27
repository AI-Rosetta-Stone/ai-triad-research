// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4246: a tag selection whose scope is too small disables Run, with the picker rendered in the panel.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const gate = vi.hoisted(() => ({ blocked: undefined as string | undefined }));
const store = vi.hoisted(() => ({
  question: 'Is AI hype outrunning evidence?', fidelity: 'quick', debaterModel: undefined, evaluatorModel: undefined, error: null,
  tagSelection: { pov: 'skeptic', tag: 'critical', mode: 'scope' },
  setQuestion: () => {}, setFidelity: () => {}, setDebaterModel: () => {}, setEvaluatorModel: () => {}, setTagSelection: () => {},
  resolvedModels: () => ({ debaters: 'd', evaluator: 'e', callBudget: 10 }), startInquiry: async () => {}, openList: () => {},
}));
vi.mock('../../hooks/useInquiryStore', () => ({ useInquiryStore: () => store }));
vi.mock('../../hooks/useTaxonomyStore/slices/settingsSlice', () => ({ MODELS_BY_BACKEND: {} }));
vi.mock('./InquiryTagPicker', () => ({
  InquiryTagPicker: () => <div>tag-picker</div>,
  inquiryTagBlocked: () => gate.blocked,
}));

const { InquiryAskPanel } = await import('./InquiryAskPanel');

beforeEach(() => { gate.blocked = undefined; });

describe('InquiryAskPanel POV tag (t/4246)', () => {
  it('renders the tag picker', () => {
    render(<InquiryAskPanel />);
    expect(screen.getByText('tag-picker')).toBeInTheDocument();
  });

  it('Run is enabled when the tag is fine', () => {
    render(<InquiryAskPanel />);
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });

  it('Run is disabled when the tag scope is below the floor', () => {
    gate.blocked = '3 in scope — below the minimum (5)';
    render(<InquiryAskPanel />);
    expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
  });
});

// t/4562 (Design review, t/4562#2): focus dropped to BODY on this screen — chip-prefilled and
// manual entry alike need the cursor visibly in the field, matching Op-Ed/Debates' own dialogs.
describe('InquiryAskPanel focus (t/4562)', () => {
  it('focuses the question textarea on mount, with the cursor at the end of any prefilled text', () => {
    render(<InquiryAskPanel />);
    const field = screen.getByLabelText('Research question') as HTMLTextAreaElement;
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(store.question.length);
    expect(field.selectionEnd).toBe(store.question.length);
  });

  it('renders the "New question" heading and a "← My Questions" back link', () => {
    render(<InquiryAskPanel />);
    expect(screen.getByRole('heading', { name: 'New question' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '← My Questions' })).toBeInTheDocument();
  });
});
