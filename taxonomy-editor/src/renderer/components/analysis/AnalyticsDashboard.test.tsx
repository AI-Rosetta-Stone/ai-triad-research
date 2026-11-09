// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn() }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

// SystemOverviewRow (embedded above the cards) pulls from these — stub so the
// dashboard tests focus on the period-comparison behaviour.
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: () => ({
    accelerationist: { nodes: [] }, safetyist: { nodes: [] },
    skeptic: { nodes: [] }, situations: { nodes: [] },
    setToolbarPanel: () => {},
  }),
}));
vi.mock('@bridge', () => ({
  api: {
    getCalibrationLog: () => Promise.resolve({ entries: [], validationReport: null }),
    listDebateSessionsMeta: () => Promise.resolve([]),
  },
}));

// Bridge mock — current window (to === today) vs the preceding window.
// Chosen so the four cards exercise: increase, decrease, zero-baseline, flat.
// `usersOverride` lets individual tests populate the Active Users table without
// disturbing the period-comparison fixtures above.
const { usersOverrideRef } = vi.hoisted(() => ({ usersOverrideRef: { current: [] as unknown[] } }));
vi.mock('../../bridge/web-bridge', () => {
  const today = new Date().toISOString().slice(0, 10);
  const CURRENT = { activeUsers: 110, sessions: 42, totalEvents: 1000, avgSessionDurationMs: 60000 };
  const PREVIOUS = { activeUsers: 100, sessions: 50, totalEvents: 0, avgSessionDurationMs: 60000 };
  return {
    bridgeGet: vi.fn(async (url: string) => {
      if (url.includes('&user=')) return { events: [] };
      const params = new URLSearchParams(url.split('?')[1] ?? '');
      const summary = params.get('to') === today ? CURRENT : PREVIOUS;
      return { summary, daily: [], featureUsage: {}, users: usersOverrideRef.current };
    }),
  };
});

const { AnalyticsDashboard } = await import('./AnalyticsDashboard');

describe('AnalyticsDashboard period comparison (t/889)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders summary cards without deltas until comparison is enabled', async () => {
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('110')).toBeInTheDocument());
    // Current value shown; no delta percentages before toggling.
    expect(screen.getByText('110')).toBeInTheDocument();
    expect(container.textContent).not.toContain('10.0%');
  });

  it('shows directional deltas when "vs. previous" is toggled on', async () => {
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('110')).toBeInTheDocument());

    fireEvent.click(screen.getByText('vs. previous'));

    await waitFor(() => expect(container.textContent).toContain('10.0%'));
    // Active Users 110 vs 100 → +10% up
    expect(container.textContent).toContain('↑');
    expect(container.textContent).toContain('10.0%');
    // Sessions 42 vs 50 → -16% down
    expect(container.textContent).toContain('↓');
    expect(container.textContent).toContain('16.0%');
  });

  it('handles a zero previous value gracefully (no divide-by-zero)', async () => {
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('110')).toBeInTheDocument());

    fireEvent.click(screen.getByText('vs. previous'));

    // Total Events: previous 0, current 1000 → "new", not "Infinity%" / "NaN%"
    await waitFor(() => expect(screen.getByText('new')).toBeInTheDocument());
    expect(container.textContent).not.toContain('Infinity');
    expect(container.textContent).not.toContain('NaN');
  });

  it('shows a flat indicator when a metric is unchanged', async () => {
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('110')).toBeInTheDocument());

    fireEvent.click(screen.getByText('vs. previous'));

    // Avg Session 60000 vs 60000 → flat
    await waitFor(() => expect(container.textContent).toContain('→'));
    expect(container.textContent).toContain('0.0%');
  });

  it('hides deltas again when comparison is toggled off', async () => {
    const { container } = render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('110')).toBeInTheDocument());

    fireEvent.click(screen.getByText('vs. previous'));
    await waitFor(() => expect(container.textContent).toContain('10.0%'));

    fireEvent.click(screen.getByText('vs. previous'));
    await waitFor(() => expect(container.textContent).not.toContain('10.0%'));
  });
});

describe('AnalyticsDashboard Active Users — unparseable lastActive (t/4961)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    recordMock.mockClear();
    usersOverrideRef.current = [];
  });

  const VALID_USER = { user: 'alice', lastActive: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), sessions: 3, events: 20, topCategory: 'debate' };
  const BAD_USER = { user: 'smoke-probe', lastActive: '', sessions: 1, events: 1, topCategory: 'ai' };

  it('renders "unknown" (never "NaN") for a user with an unparseable lastActive, alongside a normal relative time', async () => {
    usersOverrideRef.current = [VALID_USER, BAD_USER];
    render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('smoke-probe')).toBeInTheDocument());
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.getByText('2h ago')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('logs one WARN per unparseable user per data load, not per render', async () => {
    usersOverrideRef.current = [VALID_USER, BAD_USER];
    render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('unknown')).toBeInTheDocument());
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      message: expect.stringContaining('smoke-probe'),
    }));

    // Sorting re-renders every row (relativeTime runs again) but doesn't reload data —
    // the warn must not fire again.
    fireEvent.click(screen.getByText('User'));
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it('does not warn when every lastActive parses', async () => {
    usersOverrideRef.current = [VALID_USER];
    render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('2h ago')).toBeInTheDocument());
    expect(recordMock).not.toHaveBeenCalled();
  });
});
