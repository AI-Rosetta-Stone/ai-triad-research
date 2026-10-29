// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { DebateGettingStarted, DEBATE_STARTERS } from './DebateGettingStarted';

const DISMISSED_KEY = 'taxonomy-editor-debate-intro-dismissed';

/** Deterministic seeded rng for tests — same LCG as pickExamples.test.ts (t/4633), not
 *  cryptographic, just reproducible. */
function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function renderedStarterLabels(): string[] {
  const region = screen.getByRole('region');
  return within(region).getAllByRole('button')
    .map(b => b.textContent ?? '')
    .filter(label => DEBATE_STARTERS.some(s => s.label === label));
}

describe('DebateGettingStarted (t/4563, random 4-of-15 per t/4636)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders exactly 4 chips, each from the 15-item pool, with the hint', () => {
    render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} rng={seededRng(1)} />);
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(screen.getByText(/Argue it out across three perspectives/)).toBeInTheDocument();
    const labels = renderedStarterLabels();
    expect(labels).toHaveLength(4);
    expect(new Set(labels).size).toBe(4); // no duplicates
    for (const label of labels) expect(DEBATE_STARTERS.map(s => s.label)).toContain(label);
    expect(screen.getByText(/Debates use all three perspectives by default/)).toBeInTheDocument();
  });

  it('always includes at least one two-sided starter (mustInclude — keeps the hint true)', () => {
    // Several seeds, since mustInclude is the behavior under test, not luck.
    for (const seed of [1, 2, 3, 4, 5, 42, 99, 123456]) {
      const { unmount } = render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} rng={seededRng(seed)} />);
      const labels = renderedStarterLabels();
      const hasTwoSided = labels.some(label => DEBATE_STARTERS.find(s => s.label === label)?.povers);
      expect(hasTwoSided).toBe(true);
      unmount();
    }
  });

  it('a given seed produces the same 4 chips every render (stable per mount, reproducible across mounts)', () => {
    const { unmount } = render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} rng={seededRng(7)} />);
    const first = renderedStarterLabels();
    unmount();
    render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} rng={seededRng(7)} />);
    expect(renderedStarterLabels()).toEqual(first);
  });

  it('a motion chip (no povers) calls onPickStarter with its topic and no povers', async () => {
    const onPickStarter = vi.fn();
    const user = userEvent.setup();
    render(<DebateGettingStarted hasNoDebates={false} onPickStarter={onPickStarter} rng={seededRng(1)} />);
    const labels = renderedStarterLabels();
    const motionLabel = labels.find(label => !DEBATE_STARTERS.find(s => s.label === label)?.povers);
    expect(motionLabel).toBeDefined();
    await user.click(screen.getByRole('button', { name: motionLabel! }));
    const starter = DEBATE_STARTERS.find(s => s.label === motionLabel)!;
    expect(onPickStarter).toHaveBeenCalledWith(starter.topic, undefined);
  });

  it('a camp-pairing chip calls onPickStarter with its topic and exactly its two povers', async () => {
    const onPickStarter = vi.fn();
    const user = userEvent.setup();
    render(<DebateGettingStarted hasNoDebates={false} onPickStarter={onPickStarter} rng={seededRng(1)} />);
    const labels = renderedStarterLabels();
    const pairingLabel = labels.find(label => DEBATE_STARTERS.find(s => s.label === label)?.povers);
    expect(pairingLabel).toBeDefined();
    await user.click(screen.getByRole('button', { name: pairingLabel! }));
    const starter = DEBATE_STARTERS.find(s => s.label === pairingLabel)!;
    expect(onPickStarter).toHaveBeenCalledWith(starter.topic, starter.povers);
  });

  // t/4639: the card is an accordion — a single toggle collapses/expands the body in place.
  it('the toggle collapses the body and remembers the dismissal, across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} rng={seededRng(1)} />);
    const toggle = screen.getByRole('button', { name: /Hide examples/ });

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(renderedStarterLabels()).toHaveLength(0);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');

    unmount();
    render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} rng={seededRng(1)} />);
    expect(screen.getByRole('button', { name: /Show examples/ })).toHaveAttribute('aria-expanded', 'false');
  });

  // t/4639 regression: hasNoDebates no longer overrides an explicit collapse.
  it('hasNoDebates=true: an explicit toggle still collapses the card', async () => {
    const user = userEvent.setup();
    render(<DebateGettingStarted hasNoDebates={true} onPickStarter={vi.fn()} rng={seededRng(1)} />);
    await user.click(screen.getByRole('button', { name: /Hide examples/ }));
    expect(renderedStarterLabels()).toHaveLength(0);
  });

  it('shows the card expanded by default when the user has no debates yet and never dismissed', () => {
    render(<DebateGettingStarted hasNoDebates={true} onPickStarter={vi.fn()} rng={seededRng(1)} />);
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hide examples/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('the pool has 15 entries, all three pairings, and no label past the 78-char baseline', () => {
    expect(DEBATE_STARTERS).toHaveLength(15);
    const pairs = DEBATE_STARTERS.filter(s => s.povers).map(s => [...s.povers!].sort().join('-'));
    expect(new Set(pairs)).toEqual(new Set(['accelerationist-safetyist', 'safetyist-skeptic', 'accelerationist-skeptic']));
    for (const s of DEBATE_STARTERS) expect(s.label.length).toBeLessThanOrEqual(78);
  });
});
