// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4714: the running stage's detail line, and the AC4 fallback when the server/Electron build
// omits stageDetail.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { InquiryRunningPanel } from './InquiryRunningPanel';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('@bridge', () => ({ api: { startInquiry: vi.fn(), getInquiry: vi.fn(), listInquiries: vi.fn() } }));

describe('InquiryRunningPanel (t/4714)', () => {
  beforeEach(() => {
    useInquiryStore.setState({
      question: 'What counts as an AI harm?',
      jobId: 'job-1',
      status: 'debating',
      progressPct: 40,
      stageDetail: null,
      pollError: null,
    });
  });

  it('renders the detail line under the running stage when stageDetail is present', () => {
    useInquiryStore.setState({ stageDetail: 'Round 2 of 4 · Skeptic responding' });
    render(<InquiryRunningPanel />);
    expect(screen.getByText('Round 2 of 4 · Skeptic responding')).toBeInTheDocument();
  });

  it('renders no detail line when stageDetail is absent (AC4 fallback — older build)', () => {
    render(<InquiryRunningPanel />);
    expect(screen.queryByText(/Round \d+ of \d+/)).not.toBeInTheDocument();
  });
});
