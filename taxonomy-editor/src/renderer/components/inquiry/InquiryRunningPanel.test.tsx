// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4714: the running stage's detail line, its throttled screen-reader announcement, and the AC4
// fallback when the server/Electron build omits stageDetail.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { InquiryRunningPanel } from './InquiryRunningPanel';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('@bridge', () => ({ api: { startInquiry: vi.fn(), getInquiry: vi.fn(), listInquiries: vi.fn() } }));

const visible = (c: HTMLElement) => c.querySelector('.inquiry-stage-detail')?.textContent ?? null;
const announced = (c: HTMLElement) => c.querySelector('[aria-live="polite"]')?.textContent ?? null;

describe('InquiryRunningPanel (t/4714)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useInquiryStore.setState({
      question: 'What counts as an AI harm?',
      jobId: 'job-1',
      status: 'debating',
      progressPct: 40,
      stageDetail: null,
      pollError: null,
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('renders the detail line under the running stage, and announces the first one immediately', () => {
    useInquiryStore.setState({ stageDetail: 'Round 2 of 4 · Skeptic responding' });
    const { container } = render(<InquiryRunningPanel />);
    expect(visible(container)).toBe('Round 2 of 4 · Skeptic responding');
    expect(announced(container)).toBe('Round 2 of 4 · Skeptic responding');
  });

  it('renders no detail line when stageDetail is absent (AC4 fallback — older build)', () => {
    const { container } = render(<InquiryRunningPanel />);
    expect(visible(container)).toBeNull();
    expect(announced(container)).toBe('');
  });

  it('updates the visible line at once but defers (never drops) the announcement inside the throttle window', () => {
    useInquiryStore.setState({ stageDetail: 'Round 1 of 4' });
    const { container } = render(<InquiryRunningPanel />);

    act(() => { useInquiryStore.setState({ stageDetail: 'Round 2 of 4' }); });
    expect(visible(container)).toBe('Round 2 of 4');
    expect(announced(container)).toBe('Round 1 of 4'); // throttled

    act(() => { vi.advanceTimersByTime(10_000); });
    expect(announced(container)).toBe('Round 2 of 4'); // trailing announcement, not dropped
  });
});
