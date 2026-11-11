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

const visible = (c: HTMLElement) => {
  const labels = c.querySelectorAll('.inquiry-step[data-current="true"] .inquiry-step-label');
  return labels.length ? labels[labels.length - 1].textContent : null;
};
const announced = (c: HTMLElement) => c.querySelector('[aria-live="polite"]')?.textContent ?? null;
const progressLabel = (c: HTMLElement) => c.querySelector('.inquiry-budget-top')?.textContent ?? null;
const timers = (c: HTMLElement) => Array.from(c.querySelectorAll('.inquiry-timer')).map(e => e.textContent);
const emptyTimings = () => ({ grounding: {}, debating: {}, judging: {}, synthesizing: {} });

describe('InquiryRunningPanel (t/4714)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useInquiryStore.setState({
      question: 'What counts as an AI harm?',
      jobId: 'job-1',
      status: 'debating',
      progressPct: 40,
      stageDetail: null,
      stageDetailHistory: {},
      stageTimings: emptyTimings(),
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

  it('rounds the progress label to a whole percentage (t/4750)', () => {
    useInquiryStore.setState({ progressPct: 18.611111111111111 });
    const { container } = render(<InquiryRunningPanel />);
    expect(progressLabel(container)).toBe('Progress19%');
  });

  describe('stage timers (t/324)', () => {
    it('ticks the running stage each second, shows final time for done stages, blank for waiting', () => {
      const t0 = Date.now();
      useInquiryStore.setState({
        status: 'debating',
        stageTimings: { ...emptyTimings(), grounding: { startedAt: t0 - 102_000, endedAt: t0 - 60_000 }, debating: { startedAt: t0 - 7_000 } },
      });
      const { container } = render(<InquiryRunningPanel />);
      expect(timers(container)).toEqual(['0:42', '0:07', '', '']);
      act(() => { vi.advanceTimersByTime(3_000); });
      expect(timers(container)).toEqual(['0:42', '0:10', '', '']);
    });

    it('freezes a stage once it is done (no further ticking)', () => {
      const t0 = Date.now();
      useInquiryStore.setState({
        status: 'debating',
        stageTimings: { ...emptyTimings(), grounding: { startedAt: t0 - 20_000, endedAt: t0 - 5_000 }, debating: { startedAt: t0 - 5_000 } },
      });
      const { container } = render(<InquiryRunningPanel />);
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(timers(container)[0]).toBe('0:15');
      expect(timers(container)[1]).toBe('0:15');
    });

    it('shows an em dash for a done stage with no known start', () => {
      useInquiryStore.setState({ status: 'judging', stageTimings: { ...emptyTimings(), judging: { startedAt: Date.now() } } });
      const { container } = render(<InquiryRunningPanel />);
      expect(timers(container)).toEqual(['—', '—', '0:00', '']);
    });

    it('gives a done row the spoken duration for screen readers, and never makes the clock a live region', () => {
      const t0 = Date.now();
      useInquiryStore.setState({
        status: 'debating',
        stageTimings: { ...emptyTimings(), grounding: { startedAt: t0 - 102_000, endedAt: t0 }, debating: { startedAt: t0 } },
      });
      const { container } = render(<InquiryRunningPanel />);
      const first = container.querySelector('.inquiry-sg')!;
      expect(first.textContent).toContain('done, 1 minute 42 seconds');
      expect(container.querySelector('.inquiry-timer')!.getAttribute('aria-hidden')).toBe('true');
      expect(container.querySelector('.inquiry-timer [aria-live]')).toBeNull();
    });

    it('shows total elapsed in the Progress header (on by default, t/346) and omits it before any stage started', () => {
      const none = render(<InquiryRunningPanel />);
      expect(progressLabel(none.container)).toBe('Progress40%');
      none.unmount();
      const t0 = Date.now();
      useInquiryStore.setState({ stageTimings: { ...emptyTimings(), grounding: { startedAt: t0 - 252_000, endedAt: t0 - 200_000 }, debating: { startedAt: t0 - 200_000 } } });
      const on = render(<InquiryRunningPanel />);
      expect(progressLabel(on.container)).toBe('Progress · 4:12 elapsed40%');
      expect(on.container.querySelector('.inquiry-budget-top [aria-live]')).toBeNull();
    });

    it('stops its interval on unmount', () => {
      const { unmount } = render(<InquiryRunningPanel />);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('sub-step checklist (t/328)', () => {
    const labels = (c: HTMLElement) => Array.from(c.querySelectorAll('.inquiry-step-label')).map(e => e.textContent);

    it('lists every step; earlier ones are done (✓), the last is in progress', () => {
      useInquiryStore.setState({ stageDetailHistory: { debating: ['Accelerationist brief', 'Safetyist brief', 'Skeptic brief'] }, stageDetail: 'Skeptic brief' });
      const { container } = render(<InquiryRunningPanel />);
      expect(labels(container)).toEqual(['Accelerationist brief', 'Safetyist brief', 'Skeptic brief']);
      expect(container.querySelectorAll('.inquiry-step-check')).toHaveLength(2);
      expect(container.querySelectorAll('.inquiry-step[data-current="true"]')).toHaveLength(1);
      expect(visible(container)).toBe('Skeptic brief');
    });

    it('collapses a done stage behind a disclosure that expands to the ✓ list', () => {
      useInquiryStore.setState({ status: 'judging', stageDetailHistory: { debating: ['a', 'b', 'c'] } });
      const { container } = render(<InquiryRunningPanel />);
      const toggle = container.querySelector<HTMLButtonElement>('.inquiry-steps-toggle')!;
      expect(toggle.textContent).toContain('3 steps');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(labels(container)).toEqual([]);
      act(() => { toggle.click(); });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(labels(container)).toEqual(['a', 'b', 'c']);
      expect(container.querySelectorAll('.inquiry-step-check')).toHaveLength(3);
      expect(container.querySelector('.inquiry-step[data-current="true"]')).toBeNull();
    });

    it('makes the list focusable and labelled only once it exceeds 10 rows', () => {
      const steps = Array.from({ length: 10 }, (_, i) => `step ${i}`);
      useInquiryStore.setState({ stageDetailHistory: { debating: steps } });
      const { container, rerender } = render(<InquiryRunningPanel />);
      expect(container.querySelector('.inquiry-steps')!.hasAttribute('tabindex')).toBe(false);
      act(() => { useInquiryStore.setState({ stageDetailHistory: { debating: [...steps, 'step 10'] } }); });
      rerender(<InquiryRunningPanel />);
      const list = container.querySelector('.inquiry-steps')!;
      expect(list.getAttribute('tabindex')).toBe('0');
      expect(list.getAttribute('aria-label')).toBe('Debate steps');
    });

    it('keeps the newest row in view unless the user scrolled up', () => {
      const steps = Array.from({ length: 12 }, (_, i) => `step ${i}`);
      useInquiryStore.setState({ stageDetailHistory: { debating: steps } });
      const { container } = render(<InquiryRunningPanel />);
      const list = container.querySelector<HTMLElement>('.inquiry-steps')!;
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 300 });
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 180 });

      act(() => { useInquiryStore.setState({ stageDetailHistory: { debating: [...steps, 'step 12'] } }); });
      expect(list.scrollTop).toBe(300);

      list.scrollTop = 20; // user scrolls up
      act(() => { list.dispatchEvent(new Event('scroll')); });
      act(() => { useInquiryStore.setState({ stageDetailHistory: { debating: [...steps, 'step 12', 'step 13'] } }); });
      expect(list.scrollTop).toBe(20);
    });
  });
});
