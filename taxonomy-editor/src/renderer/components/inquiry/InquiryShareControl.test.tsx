// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for the inquiry share control (t/3654). Covers: preview-gates-mint (no mint call until
// Confirm), copy+revoke ("already-shared" state per TL t/3654#3), and the Electron-hides-
// rather-than-errors posture.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InquiryResult } from '../../bridge/types';

const { mockApi, isElectronModeMock } = vi.hoisted(() => ({
  mockApi: { shareInquiry: vi.fn(), unshareInquiry: vi.fn() },
  isElectronModeMock: vi.fn(() => false),
}));
vi.mock('@bridge', () => ({ api: mockApi, isElectronMode: isElectronModeMock }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const { InquiryShareControl } = await import('./InquiryShareControl');

const SAMPLE_RESULT = {
  schemaVersion: 1,
  request: { question: 'What counts as an AI harm?', fidelity: 'standard' },
  campVerdicts: [],
  convergences: [],
  evidenceLayers: [],
  unresolvedGaps: [],
  calibration: [],
  derivation: { fidelity: 'standard', models: {}, rounds: 4, callBudget: 150 },
  grounding: { nodesByCamp: {} },
  singleRunCaveat: 'n=1',
} as unknown as InquiryResult;

describe('InquiryShareControl (t/3654)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isElectronModeMock.mockReturnValue(false);
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('shows a disabled web-only control on Electron rather than hiding silently (t/4611)', () => {
    isElectronModeMock.mockReturnValue(true);
    render(<InquiryShareControl jobId="job-1" result={SAMPLE_RESULT} />);
    const button = screen.getByRole('button', { name: 'Share (web only)' });
    expect(button).toBeDisabled();
    expect(mockApi.shareInquiry).not.toHaveBeenCalled();
  });

  it('clicking Share opens the preview WITHOUT minting — mint only fires on Confirm', () => {
    render(<InquiryShareControl jobId="job-1" result={SAMPLE_RESULT} />);
    fireEvent.click(screen.getByRole('button', { name: /Create a public share link/i }));

    expect(screen.getByText('This is what will be public')).toBeInTheDocument();
    expect(mockApi.shareInquiry).not.toHaveBeenCalled();
  });

  it('Cancel in the preview mints nothing and returns to idle', () => {
    render(<InquiryShareControl jobId="job-1" result={SAMPLE_RESULT} />);
    fireEvent.click(screen.getByRole('button', { name: /Create a public share link/i }));
    fireEvent.click(screen.getByText('Cancel'));

    expect(mockApi.shareInquiry).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Create a public share link/i })).toBeInTheDocument();
  });

  it('Confirm mints, copies the URL, and shows the already-shared state with Un-share', async () => {
    mockApi.shareInquiry.mockResolvedValue({ shareId: 'share-1', url: '/inquiries/share-1' });
    render(<InquiryShareControl jobId="job-1" result={SAMPLE_RESULT} />);
    fireEvent.click(screen.getByRole('button', { name: /Create a public share link/i }));
    fireEvent.click(screen.getByText('Create public link'));

    await waitFor(() => expect(screen.getByText(/Link copied|Public link ready/)).toBeInTheDocument());
    expect(mockApi.shareInquiry).toHaveBeenCalledWith('job-1');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('/inquiries/share-1'));
    expect(screen.getByRole('button', { name: 'Un-share' })).toBeInTheDocument();
  });

  it('Un-share revokes and returns to idle', async () => {
    mockApi.shareInquiry.mockResolvedValue({ shareId: 'share-1', url: '/inquiries/share-1' });
    mockApi.unshareInquiry.mockResolvedValue({ ok: true });
    render(<InquiryShareControl jobId="job-1" result={SAMPLE_RESULT} />);
    fireEvent.click(screen.getByRole('button', { name: /Create a public share link/i }));
    fireEvent.click(screen.getByText('Create public link'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Un-share' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Un-share' }));
    await waitFor(() => expect(mockApi.unshareInquiry).toHaveBeenCalledWith('job-1'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Create a public share link/i })).toBeInTheDocument());
  });
});
