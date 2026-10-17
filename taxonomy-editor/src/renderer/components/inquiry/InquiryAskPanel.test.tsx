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
    expect(screen.getByRole('button', { name: 'Run inquiry' })).toBeEnabled();
  });

  it('Run is disabled when the tag scope is below the floor', () => {
    gate.blocked = '3 in scope — below the minimum (5)';
    render(<InquiryAskPanel />);
    expect(screen.getByRole('button', { name: 'Run inquiry' })).toBeDisabled();
  });
});
