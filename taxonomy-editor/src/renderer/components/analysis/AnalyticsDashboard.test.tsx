// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));

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
const { bridgeGetMock } = vi.hoisted(() => ({ bridgeGetMock: vi.fn() }));
vi.mock('../../bridge/web-bridge', () => {
  const today = new Date().toISOString().slice(0, 10);
  const CURRENT = { activeUsers: 110, sessions: 42, totalEvents: 1000, avgSessionDurationMs: 60000 };
  const PREVIOUS = { activeUsers: 100, sessions: 50, totalEvents: 0, avgSessionDurationMs: 60000 };
  bridgeGetMock.mockImplementation(async (url: string) => {
    if (url.includes('&user=')) return { events: [] };
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    const summary = params.get('to') === today ? CURRENT : PREVIOUS;
    return { summary, daily: [], featureUsage: {}, users: [] };
  });
  return { bridgeGet: bridgeGetMock };
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

describe('AnalyticsDashboard exclusion toggles (t/4961)', () => {
  afterEach(() => { vi.restoreAllMocks(); bridgeGetMock.mockClear(); });

  it('renders all three toggles disabled, with the pending-dependency caption', async () => {
    render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('110')).toBeInTheDocument());

    const internal = screen.getByText('Show internal/test traffic');
    const system = screen.getByText('Show system checks');
    const listed = screen.getByText('Show flagged sessions');
    expect(internal).toBeDisabled();
    expect(system).toBeDisabled();
    expect(listed).toBeDisabled();
    expect(screen.getByText(/Requires t\/4960\/t\/4962/)).toBeInTheDocument();
  });

  it('clicking a disabled toggle does nothing, and the fetch URL never carries the exclusion params', async () => {
    render(<AnalyticsDashboard />);
    await waitFor(() => expect(screen.getByText('110')).toBeInTheDocument());

    const internal = screen.getByText('Show internal/test traffic');
    fireEvent.click(internal);
    expect(internal).toHaveAttribute('aria-pressed', 'false');

    for (const call of bridgeGetMock.mock.calls) {
      const url = call[0] as string;
      expect(url).not.toContain('includeInternal');
      expect(url).not.toContain('includeSystem');
      expect(url).not.toContain('includeListed');
    }
  });
});
