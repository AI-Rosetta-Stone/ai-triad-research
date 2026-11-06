// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useRef } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ProgressIndicator, PhaseProgressBar, DebaterToggles, TokenBudgetIndicator, DebateActions } from './DebateActionBar';
import { useSettingsDialog } from '../../hooks/useSettingsDialog';

// ── Mocks ────────────────────────────────────────────────────

const mockStore: Record<string, any> = {
  activeDebate: null,
  debateGenerating: null,
  debateActivity: null,
  debateProgress: null,
  debateError: null,
  togglePover: vi.fn(),
  askQuestion: vi.fn(),
  crossRespond: vi.fn(),
  requestSynthesis: vi.fn(),
  requestProbingQuestions: vi.fn(),
  requestReflections: vi.fn(),
  audience: 'policymaker',
  setAudience: vi.fn(),
};

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: Object.assign(
    (selector: any) => selector(mockStore),
    { getState: () => mockStore },
  ),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: any) => fn,
}));

vi.mock('../../types/debate', () => ({
  POVER_INFO: {
    accelerationist: { label: 'Accelerationist', color: 'var(--color-acc)' },
    safetyist: { label: 'Safetyist', color: 'var(--color-saf)' },
    skeptic: { label: 'Skeptic', color: 'var(--color-skp)' },
  },
  DEBATE_AUDIENCES: [
    { id: 'policymaker', label: 'Policymaker' },
    { id: 'technical', label: 'Technical' },
  ],
}));

vi.mock('@lib/debate/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/debate/types')>();
  return { ...actual };
});

vi.mock('./utils', () => ({
  speakerLabel: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
  ADAPTIVE_PHASES: ['confrontation', 'argumentation', 'concluding'],
  ADAPTIVE_PHASE_LABELS: {
    confrontation: 'Confrontation',
    argumentation: 'Argumentation',
    concluding: 'Concluding',
  },
  ADAPTIVE_PHASE_COLORS: {
    confrontation: '#ef4444',
    argumentation: '#f59e0b',
    concluding: '#22c55e',
  },
}));

vi.mock('../HarvestDialog', () => ({
  HarvestDialog: () => <div data-testid="harvest-dialog" />,
}));
vi.mock('../ReflectionsPanel', () => ({
  ReflectionsPanel: () => <div data-testid="reflections-panel" />,
}));
vi.mock('../NewsReportModal', () => ({
  NewsReportModal: () => <div data-testid="news-report-modal" />,
}));

const mockTierInfo: { tier: any; usage: any; loading: boolean; refresh: () => void } = {
  tier: null,
  usage: null,
  loading: false,
  refresh: vi.fn(),
};
vi.mock('../../hooks/useTierInfo', () => ({
  useTierInfo: () => mockTierInfo,
}));

// isElectronMode is controllable so the t/2298 regression test can vary it across renders.
const bridgeState = vi.hoisted(() => ({ electron: true }));
vi.mock('@bridge', () => ({
  isElectronMode: () => bridgeState.electron,
}));

// Real useFlag wraps a Zustand selector — i.e. it consumes a React hook.
// The mock must too, otherwise calling it conditionally (the t/2298 bug) is
// invisible to React's hook counter and the regression can't be reproduced.
vi.mock('../../hooks/useFeatureFlags', () => ({
  useFlag: () => {
    useRef(null);
    return false;
  },
}));

afterEach(() => { vi.clearAllMocks(); });

// ── ProgressIndicator ───────────────────────────────────────

describe('ProgressIndicator', () => {
  it('renders nothing when no activity', () => {
    mockStore.debateActivity = null;
    mockStore.debateProgress = null;
    const { container } = render(<ProgressIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('renders activity text', () => {
    mockStore.debateActivity = 'Generating response...';
    mockStore.debateProgress = null;
    render(<ProgressIndicator />);
    expect(screen.getByText('Generating response...')).toBeInTheDocument();
  });

  it('shows retry info when retrying', () => {
    mockStore.debateActivity = 'Calling AI...';
    mockStore.debateProgress = { attempt: 2, maxRetries: 3, phase: 'retry', backoffSeconds: 5 };
    render(<ProgressIndicator />);
    expect(screen.getByText(/Retry 2\/3/)).toBeInTheDocument();
    expect(screen.getByText(/waiting 5s/)).toBeInTheDocument();
  });

  it('shows limit message when present', () => {
    mockStore.debateActivity = 'Calling AI...';
    mockStore.debateProgress = { attempt: 1, maxRetries: 3, phase: 'active', limitMessage: 'Rate limited' };
    render(<ProgressIndicator />);
    expect(screen.getByText('Rate limited')).toBeInTheDocument();
  });
});

// ── PhaseProgressBar ────────────────────────────────────────

describe('PhaseProgressBar', () => {
  it('renders all three phase segments', () => {
    const { container } = render(
      <PhaseProgressBar
        currentPhase="confrontation"
        phaseProgress={0.5}
        roundsInPhase={3}
        approachingTransition={false}
      />
    );
    expect(container.querySelectorAll('.adaptive-phase-segment').length).toBe(3);
  });

  it('marks current phase as active', () => {
    const { container } = render(
      <PhaseProgressBar
        currentPhase="argumentation"
        phaseProgress={0.3}
        roundsInPhase={2}
        approachingTransition={false}
      />
    );
    const segments = container.querySelectorAll('.adaptive-phase-segment');
    expect(segments[0]?.classList.contains('completed')).toBe(true);
    expect(segments[1]?.classList.contains('active')).toBe(true);
  });

  it('shows transition hint when approaching', () => {
    render(
      <PhaseProgressBar
        currentPhase="confrontation"
        phaseProgress={0.9}
        roundsInPhase={5}
        approachingTransition={true}
      />
    );
    expect(screen.getByText('Approaching transition')).toBeInTheDocument();
  });

  it('shows rationale when provided', () => {
    render(
      <PhaseProgressBar
        currentPhase="concluding"
        phaseProgress={0.6}
        roundsInPhase={4}
        approachingTransition={false}
        rationale="Arguments are converging"
      />
    );
    expect(screen.getByText('Arguments are converging')).toBeInTheDocument();
  });
});

// ── DebaterToggles ──────────────────────────────────────────

describe('DebaterToggles', () => {
  it('renders nothing when no active debate', () => {
    mockStore.activeDebate = null;
    const { container } = render(<DebaterToggles />);
    expect(container.innerHTML).toBe('');
  });

  it('renders toggle pills for all AI povers', () => {
    mockStore.activeDebate = {
      active_povers: ['accelerationist', 'safetyist'],
      transcript: [],
    };
    mockStore.debateGenerating = null;
    render(<DebaterToggles />);
    expect(screen.getByText(/Accelerationist/)).toBeInTheDocument();
    expect(screen.getByText(/Safetyist/)).toBeInTheDocument();
    expect(screen.getByText(/Skeptic/)).toBeInTheDocument();
  });

  it('shows active styling for included povers', () => {
    mockStore.activeDebate = {
      active_povers: ['accelerationist', 'safetyist'],
      transcript: [],
    };
    mockStore.debateGenerating = null;
    const { container } = render(<DebaterToggles />);
    const pills = container.querySelectorAll('.debate-debater-pill');
    const accPill = Array.from(pills).find(p => p.textContent?.includes('Accelerationist'));
    const skpPill = Array.from(pills).find(p => p.textContent?.includes('Skeptic'));
    expect(accPill?.classList.contains('debate-debater-pill-active')).toBe(true);
    expect(skpPill?.classList.contains('debate-debater-pill-inactive')).toBe(true);
  });

  it('labels a sat-out debater as sitting out, not as hidden (t/4748)', () => {
    mockStore.activeDebate = {
      active_povers: ['safetyist', 'skeptic'],
      transcript: [],
    };
    mockStore.debateGenerating = null;
    render(<DebaterToggles />);
    const accPill = screen.getByRole('button', { name: /Accelerationist/ });
    const safPill = screen.getByRole('button', { name: /Safetyist/ });

    expect(accPill).toHaveAttribute('aria-pressed', 'false');
    expect(accPill).toHaveTextContent('sitting out');
    expect(accPill).toHaveAttribute('title', 'Add Accelerationist back to the next rounds.');

    expect(safPill).toHaveAttribute('aria-pressed', 'true');
    expect(safPill).not.toHaveTextContent('sitting out');
    expect(safPill.getAttribute('title')).toContain('Their turns so far stay in the transcript.');
  });

  it('disables pills when generating', () => {
    mockStore.activeDebate = {
      active_povers: ['accelerationist'],
      transcript: [],
    };
    mockStore.debateGenerating = 'accelerationist';
    const { container } = render(<DebaterToggles />);
    const buttons = container.querySelectorAll('button');
    buttons.forEach(btn => expect(btn.disabled).toBe(true));
  });

  it('renders nothing for a read-only community debate (t/4905)', () => {
    mockStore.activeDebate = { active_povers: ['accelerationist', 'safetyist'], transcript: [] };
    mockStore.debateGenerating = null;
    mockStore.communityReadOnly = true;
    try {
      const { container } = render(<DebaterToggles />);
      expect(container.innerHTML).toBe('');
    } finally {
      mockStore.communityReadOnly = false;
    }
  });
});

// ── TokenBudgetIndicator (t/964) ───────────────────────────

describe('TokenBudgetIndicator', () => {
  afterEach(() => {
    mockTierInfo.usage = null;
  });

  it('renders nothing when usage is null (Electron)', () => {
    mockTierInfo.usage = null;
    const { container } = render(<TokenBudgetIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when usage is below 1%', () => {
    mockTierInfo.usage = {
      tier: 'free',
      limits: { requestsPerMinute: 10, tokensPerDay: 500000 },
      usage: { requestsInWindow: 0, tokensToday: 100 },
    };
    const { container } = render(<TokenBudgetIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('renders bar without warning below 80%', () => {
    mockTierInfo.usage = {
      tier: 'free',
      limits: { requestsPerMinute: 10, tokensPerDay: 500000 },
      usage: { requestsInWindow: 1, tokensToday: 200000 },
    };
    const { container } = render(<TokenBudgetIndicator />);
    expect(container.querySelector('.token-budget-indicator')).toBeTruthy();
    expect(container.querySelector('.token-budget-indicator.warning')).toBeNull();
    expect(container.querySelector('.token-budget-indicator.urgent')).toBeNull();
    expect(screen.getByText('300k left')).toBeInTheDocument();
    expect(container.querySelector('.token-budget-banner')).toBeNull();
  });

  it('shows warning banner at 80% usage', () => {
    mockTierInfo.usage = {
      tier: 'free',
      limits: { requestsPerMinute: 10, tokensPerDay: 500000 },
      usage: { requestsInWindow: 5, tokensToday: 420000 },
    };
    const { container } = render(<TokenBudgetIndicator />);
    expect(container.querySelector('.token-budget-indicator.warning')).toBeTruthy();
    expect(screen.getByText(/84% of today/)).toBeInTheDocument();
    expect(screen.getByText('80k left')).toBeInTheDocument();
  });

  it('shows urgent banner at 95% usage', () => {
    mockTierInfo.usage = {
      tier: 'free',
      limits: { requestsPerMinute: 10, tokensPerDay: 500000 },
      usage: { requestsInWindow: 8, tokensToday: 490000 },
    };
    const { container } = render(<TokenBudgetIndicator />);
    expect(container.querySelector('.token-budget-indicator.urgent')).toBeTruthy();
    expect(screen.getByText(/Almost out of today/)).toBeInTheDocument();
    expect(screen.getByText('10k left')).toBeInTheDocument();
  });

  it('shows reset time when resetsAt is provided', () => {
    const twoHoursFromNow = new Date(Date.now() + 2 * 3600000 + 15 * 60000).toISOString();
    mockTierInfo.usage = {
      tier: 'free',
      limits: { requestsPerMinute: 10, tokensPerDay: 500000 },
      usage: { requestsInWindow: 5, tokensToday: 420000, resetsAt: twoHoursFromNow },
    };
    render(<TokenBudgetIndicator />);
    expect(screen.getByText(/resets in 2h \d+m/)).toBeInTheDocument();
  });
});

// ── DebateActions — hook-count stability (t/2298 regression) ─────────
//
// `useFlag('permission-admin-features')` was called conditionally as the RHS of
// `isElectronMode() || useFlag(...)`. When isElectronMode() flips between renders
// of the same fiber, the hook count changed and React crashed the debate popup
// with "Rendered fewer/more hooks than expected". The test varies isElectronMode()
// across a rerender of the SAME instance — the only way to catch a re-introduction.

describe('DebateActions — hook-count stability (t/2298)', () => {
  const noop = () => {};
  const actionsProps = {
    showParamHistory: false,
    setShowParamHistory: noop,
    showEvaluation: false,
    setShowEvaluation: noop,
  };

  afterEach(() => {
    bridgeState.electron = true;
  });

  const primeStore = () => {
    mockStore.activeDebate = {
      phase: 'active',
      active_povers: ['accelerationist', 'safetyist'],
      transcript: [],
      neutral_evaluations: [],
    };
    mockStore.debateGenerating = null;
    mockStore.debateError = null;
    mockStore.debateRetryAction = null;
    mockStore.dailyLimitPaused = false;
    mockStore.toggleStepMode = vi.fn();
    mockStore.setDebatePhase = vi.fn();
    mockStore.setError = vi.fn();
  };

  it('keeps a stable hook count when isElectronMode() flips across renders', () => {
    primeStore();

    // First render short-circuits the old `||` (Electron true → useFlag skipped).
    bridgeState.electron = true;
    const { rerender } = render(<DebateActions {...actionsProps} />);

    // Flip to web: the old code would now CALL useFlag → hook count changes → crash.
    bridgeState.electron = false;
    expect(() => rerender(<DebateActions {...actionsProps} />)).not.toThrow();

    // Flip back for good measure — count must stay stable in both directions.
    bridgeState.electron = true;
    expect(() => rerender(<DebateActions {...actionsProps} />)).not.toThrow();
  });

  it('mounts without crashing in the web build (isElectronMode() false)', () => {
    primeStore();
    bridgeState.electron = false;
    expect(() => render(<DebateActions {...actionsProps} />)).not.toThrow();
  });
});

// ── ProgressIndicator — live countdown (t/2442) ─────────────

describe('ProgressIndicator — live countdown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('ticks countdown down from backoffSeconds toward 0', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    mockStore.debateActivity = 'Calling AI...';
    mockStore.debateProgress = { attempt: 2, maxRetries: 3, phase: 'retry', backoffSeconds: 3 };
    render(<ProgressIndicator />);

    expect(screen.getByText(/waiting 3s/)).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/waiting 2s/)).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText(/retrying now/)).toBeInTheDocument();
  });

  it('shows attempt N of M alongside the countdown', () => {
    mockStore.debateActivity = 'Calling AI...';
    mockStore.debateProgress = { attempt: 2, maxRetries: 3, phase: 'retry', backoffSeconds: 30 };
    render(<ProgressIndicator />);
    const retryEl = screen.getByText(/Retry 2\/3/);
    expect(retryEl).toBeInTheDocument();
    expect(retryEl.textContent).toMatch(/waiting 30s/);
  });

  it('suppresses retry badge on the first attempt', () => {
    mockStore.debateActivity = 'Calling AI...';
    mockStore.debateProgress = { attempt: 1, maxRetries: 3, phase: 'active', backoffSeconds: undefined };
    render(<ProgressIndicator />);
    expect(screen.queryByText(/Retry/)).toBeNull();
  });
});

// ── DebateActions — exhaustion error banner (t/2442) ─────────

describe('DebateActions — exhaustion error banner', () => {
  const noop = () => {};
  const actionsProps = {
    showParamHistory: false,
    setShowParamHistory: noop,
    showEvaluation: false,
    setShowEvaluation: noop,
  };

  beforeEach(() => {
    mockStore.activeDebate = {
      phase: 'active',
      active_povers: ['accelerationist', 'safetyist'],
      transcript: [],
      neutral_evaluations: [],
    };
    mockStore.debateGenerating = null;
    mockStore.debateRetryAction = null;
    mockStore.dailyLimitPaused = false;
    mockStore.toggleStepMode = vi.fn();
    mockStore.setDebatePhase = vi.fn();
    mockStore.setError = vi.fn();
  });

  it('renders attempt count and elapsed time, no "Click Retry" text in the message', () => {
    mockStore.debateError = 'Opening statements failed for Skeptic after 2 attempts (~45s).';
    render(<DebateActions {...actionsProps} />);
    expect(screen.getByText(/Opening statements failed for Skeptic after 2 attempts/)).toBeInTheDocument();
    expect(screen.queryByText(/Click Retry/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows no error banner when debateError is null', () => {
    mockStore.debateError = null;
    render(<DebateActions {...actionsProps} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  // t/3190: daily-cap banner offers an "Add API key" deep-link to Settings (the
  // "continue now" path), and no Retry (the cap is not retryable).
  it('daily-limit banner shows "Add API key" (not Retry) and opens Settings on click', () => {
    useSettingsDialog.setState({ isOpen: false });
    mockStore.debateError = 'Daily AI usage limit reached (resets at midnight UTC).';
    mockStore.dailyLimitPaused = true;
    render(<DebateActions {...actionsProps} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    const addKey = screen.getByRole('button', { name: 'Add API key' });
    fireEvent.click(addKey);
    expect(useSettingsDialog.getState().isOpen).toBe(true);
    useSettingsDialog.setState({ isOpen: false });
  });
});
