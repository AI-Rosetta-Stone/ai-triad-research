// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Adjacency test (t/3734, SO condition via t/3667#6): synthesizedHeadline must render adjacent
// to singleRunCaveat — structurally, not merely both-present-somewhere-on-the-page. A test that
// only checks "headline appears" would pass a layout putting the caveat three sections away,
// which is exactly the failure this ticket exists to prevent.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InquiryResult } from '../../bridge/types';

const { mockUseInquiryStore, mockLoadDebate, mockSetActiveTab, mockApi } = vi.hoisted(() => ({
  mockUseInquiryStore: vi.fn(),
  mockLoadDebate: vi.fn(),
  mockSetActiveTab: vi.fn(),
  mockApi: { loadDebateSession: vi.fn() },
}));
vi.mock('../../hooks/useInquiryStore', () => ({ useInquiryStore: mockUseInquiryStore }));
vi.mock('../../hooks/useDebateStore', () => ({ useDebateStore: (sel: (s: { loadDebate: () => void }) => unknown) => sel({ loadDebate: mockLoadDebate }) }));
vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: (sel: (s: { setActiveTab: () => void }) => unknown) => sel({ setActiveTab: mockSetActiveTab }) }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('@bridge', () => ({ api: mockApi, isElectronMode: () => false }));

const { InquiryAnswerPanel } = await import('./InquiryAnswerPanel');

const BASE_RESULT = {
  request: { question: 'What counts as an AI harm?' },
  // Non-empty so isZeroResult() doesn't short-circuit into the zero-state branch, which renders
  // before the headline/caveat block entirely — this data is about avoiding that branch, not
  // about testing camp-verdict rendering.
  campVerdicts: [{ camp: 'acc', verdict: 'Harm requires realized, measurable damage.', nodes: [] }],
  convergences: [],
  evidenceLayers: [],
  unresolvedGaps: [],
  calibration: [],
  derivation: { models: { debaters: 'claude-sonnet-5', evaluator: 'claude-opus-5' }, rounds: 4, callBudget: 150 },
  grounding: { nodesByCamp: {} },
  singleRunCaveat: 'This is one run of a stochastic process, not a repeated-measures finding.',
  debateId: 'debate-1',
} as unknown as InquiryResult;

function setResult(result: InquiryResult): void {
  mockUseInquiryStore.mockReturnValue({
    status: 'done', result, error: null, terminationReason: null, jobId: 'job-1', reset: vi.fn(),
  });
}

describe('InquiryAnswerPanel headline/caveat adjacency (t/3734)', () => {
  it('renders synthesizedHeadline immediately adjacent to singleRunCaveat, inside one wrapper', () => {
    setResult({ ...BASE_RESULT, synthesizedHeadline: 'Camps converge on outcome, diverge on intent.' } as InquiryResult);
    render(<InquiryAnswerPanel />);

    const headline = screen.getByText('Camps converge on outcome, diverge on intent.');
    const caveat = screen.getByText(BASE_RESULT.singleRunCaveat, { exact: false });

    // Structural, not incidental: same parent, headline is the caveat's immediately preceding sibling.
    expect(headline.parentElement).toBe(caveat.parentElement);
    expect(caveat.previousElementSibling).toBe(headline);
  });

  it('suppresses the headline slot (not an inline qualifier) when synthesizedHeadline is absent, caveat still renders', () => {
    setResult({ ...BASE_RESULT, synthesizedHeadline: undefined } as InquiryResult);
    render(<InquiryAnswerPanel />);

    const caveat = screen.getByText(BASE_RESULT.singleRunCaveat, { exact: false });
    expect(caveat.previousElementSibling).toBeNull();
  });
});

describe('InquiryAnswerPanel "View raw run" deleted-debate notice (t/4684)', () => {
  it('shows the deleted notice on a web 404 and does not switch to the Debate tab', async () => {
    mockApi.loadDebateSession.mockRejectedValueOnce(Object.assign(new Error('GET /api/debates/debate-1 failed with HTTP 404: not found'), { httpStatus: 404 }));
    setResult(BASE_RESULT);
    render(<InquiryAnswerPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'View raw run' }));

    await waitFor(() => {
      expect(screen.getByText('The debate behind this answer was deleted.')).toBeInTheDocument();
    });
    expect(mockLoadDebate).not.toHaveBeenCalled();
    expect(mockSetActiveTab).not.toHaveBeenCalled();
  });

  it('shows the deleted notice on an Electron "not found" message (IPC strips the structured error)', async () => {
    mockApi.loadDebateSession.mockRejectedValueOnce(new Error('Debate session not found: debate-1'));
    setResult(BASE_RESULT);
    render(<InquiryAnswerPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'View raw run' }));

    await waitFor(() => {
      expect(screen.getByText('The debate behind this answer was deleted.')).toBeInTheDocument();
    });
    expect(mockLoadDebate).not.toHaveBeenCalled();
    expect(mockSetActiveTab).not.toHaveBeenCalled();
  });

  it('still opens the Debate tab when the probe succeeds', async () => {
    mockApi.loadDebateSession.mockResolvedValueOnce({ id: 'debate-1' });
    setResult(BASE_RESULT);
    render(<InquiryAnswerPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'View raw run' }));

    await waitFor(() => {
      expect(mockLoadDebate).toHaveBeenCalledWith('debate-1');
    });
    expect(mockSetActiveTab).toHaveBeenCalledWith('debate');
    expect(screen.queryByText('The debate behind this answer was deleted.')).not.toBeInTheDocument();
  });

  it('falls through to the existing debate-tab path on a non-404 error (network failure)', async () => {
    mockApi.loadDebateSession.mockRejectedValueOnce(new Error('network error'));
    setResult(BASE_RESULT);
    render(<InquiryAnswerPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'View raw run' }));

    await waitFor(() => {
      expect(mockLoadDebate).toHaveBeenCalledWith('debate-1');
    });
    expect(mockSetActiveTab).toHaveBeenCalledWith('debate');
    expect(screen.queryByText('The debate behind this answer was deleted.')).not.toBeInTheDocument();
  });
});

// t/4753 part B: the TRUNCATED banner previously always said "hit its N-call budget"
// regardless of terminationReason — wrong whenever a turn cap, not the budget, cut the run off.
describe('InquiryAnswerPanel TRUNCATED banner names the real cause (t/4753)', () => {
  function setTruncated(terminationReason: string | null): void {
    mockUseInquiryStore.mockReturnValue({
      status: 'done_truncated', result: BASE_RESULT, error: null, terminationReason, jobId: 'job-1', reset: vi.fn(),
    });
  }

  it('api_ceiling: names the call budget', () => {
    setTruncated('api_ceiling');
    render(<InquiryAnswerPanel />);
    expect(screen.getByText('TRUNCATED').closest('.inquiry-banner')).toHaveTextContent('This run hit its 150-call budget and was cut off');
  });

  it('max_iterations (a turn cap): names the round limit, not the budget', () => {
    setTruncated('max_iterations');
    render(<InquiryAnswerPanel />);
    const banner = screen.getByText('TRUNCATED').closest('.inquiry-banner');
    expect(banner).toHaveTextContent('This run hit its round limit and was cut off');
    expect(banner).not.toHaveTextContent('call budget');
  });

  it('an unrecognized reason: states it verbatim rather than defaulting to "budget"', () => {
    setTruncated('situation_cap');
    render(<InquiryAnswerPanel />);
    const banner = screen.getByText('TRUNCATED').closest('.inquiry-banner');
    expect(banner).toHaveTextContent('This run was stopped early (situation_cap) and was cut off');
    expect(banner).not.toHaveTextContent('call budget');
  });

  it('no terminationReason: falls back to the budget wording (historical default)', () => {
    setTruncated(null);
    render(<InquiryAnswerPanel />);
    expect(screen.getByText('TRUNCATED').closest('.inquiry-banner')).toHaveTextContent('This run hit its 150-call budget and was cut off');
  });
});

describe('InquiryAnswerPanel How section (t/280)', () => {
  it('opens the debate from the How section through the same deleted-debate probe', async () => {
    mockApi.loadDebateSession.mockResolvedValueOnce({});
    setResult(BASE_RESULT);
    render(<InquiryAnswerPanel />);

    fireEvent.click(screen.getByRole('button', { name: /How/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the debate that produced this answer' }));

    await waitFor(() => expect(mockApi.loadDebateSession).toHaveBeenCalledWith('debate-1'));
    expect(mockLoadDebate).toHaveBeenCalledWith('debate-1');
    expect(mockSetActiveTab).toHaveBeenCalledWith('debate');
  });
});
