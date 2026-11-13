// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/280 (t/278 B): the How section under Why. Tests: both methods links open the Ask theory docs, the
// debate button calls onOpenDebate with the id, and no debate button renders without a debateId
// (public share).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockOpenExternal } = vi.hoisted(() => ({ mockOpenExternal: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bridge', () => ({ api: { openExternal: mockOpenExternal }, isElectronMode: () => false }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const { InquiryHowSection } = await import('./InquiryHowSection');

function openHow(): void {
  fireEvent.click(screen.getByRole('button', { name: /^How$/ }));
  fireEvent.click(screen.getByRole('button', { name: /Methods/ }));
}

describe('InquiryHowSection (t/280)', () => {
  it('opens the Ask theory docs from the Methods links', async () => {
    render(<InquiryHowSection />);
    openHow();
    fireEvent.click(screen.getByRole('button', { name: 'Theory of Success' }));
    await waitFor(() => expect(mockOpenExternal).toHaveBeenCalledWith(expect.stringContaining('docs/ux/ask-a-question-theory-of-success.md')));
    fireEvent.click(screen.getByRole('button', { name: 'Theory of Operations' }));
    await waitFor(() => expect(mockOpenExternal).toHaveBeenCalledWith(expect.stringContaining('docs/ux/ask-a-question-theory-of-operations.md')));
  });

  it('calls onOpenDebate with the debate id when the debate button is clicked', () => {
    const onOpenDebate = vi.fn();
    render(<InquiryHowSection debateId="debate-1" onOpenDebate={onOpenDebate} />);
    fireEvent.click(screen.getByRole('button', { name: /^How$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the debate that produced this answer' }));
    expect(onOpenDebate).toHaveBeenCalledWith('debate-1');
  });

  it('shows no debate button when debateId is absent (public share)', () => {
    render(<InquiryHowSection />);
    fireEvent.click(screen.getByRole('button', { name: /^How$/ }));
    expect(screen.queryByRole('button', { name: 'Open the debate that produced this answer' })).toBeNull();
    expect(screen.getByText('The debate behind this answer is not shown here.')).toBeInTheDocument();
  });
});
