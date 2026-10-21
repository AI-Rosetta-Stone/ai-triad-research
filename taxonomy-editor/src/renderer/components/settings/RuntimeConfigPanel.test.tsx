import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RuntimeConfig, ConfigState } from '../../hooks/useRuntimeConfigStore';

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

let mockIsElectron = false;
vi.mock('@bridge', () => ({
  api: {},
  isElectronMode: () => mockIsElectron,
}));

function makeConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    resilience: {
      circuitThreshold: 5, circuitCooldownMs: 30000, retryBaseDelayMs: 1000,
      retryMaxDelayMs: 30000, retryJitterMaxMs: 500, maxRetryAfterMs: 120000,
      throttleWindowSize: 10, throttleBaselineCount: 5, throttleEnterFactor: 2.0,
      throttleExitFactor: 0.5, throttleDelayMs: 1000,
    },
    rateLimiting: { windowMs: 60000, cleanupCutoffMs: 120000 },
    tiers: {
      platform: { requestsPerMinute: 100, tokensPerDay: 1000000, allowedBackends: ['gemini', 'claude', 'groq'] },
      byok: { requestsPerMinute: 60, tokensPerDay: 500000, allowedBackends: ['gemini', 'claude', 'groq'] },
      anonymous: { requestsPerMinute: 10, tokensPerDay: 50000, allowedBackends: ['gemini'] },
      free: { requestsPerMinute: 20, tokensPerDay: 100000, allowedBackends: ['gemini'], pinnedModel: 'gemini-2.0-flash-lite' },
    },
    quotas: { defaultMaxChats: 50, defaultMaxDebates: 10 },
    sessions: {
      anonymousTtlMs: 86400000, anonymousMaxSessions: 100, anonymousMaxSizeBytes: 1048576,
      tokenFreshnessThresholdMs: 300000, lockAcquireTimeoutMs: 5000, lockHoldTtlMs: 30000,
    },
    analytics: { retentionDays: 90, bufferRequeueLimit: 3 },
    flightRecorder: {
      minDumpIntervalMs: 60000, maxDumpsPerWindow: 5, dumpWindowMs: 3600000,
      maxRetainedDumps: 20, maxTotalDumpSizeBytes: 10485760,
    },
    community: { maxPendingPerUser: 5, globalPendingCap: 100 },
    feedback: { defaultPageLimit: 20, maxPageLimit: 100 },
    server: {
      conflictsCacheTtlMs: 300000, gitCloneTimeoutMs: 120000, gitFetchTimeoutMs: 60000,
      gitDefaultTimeoutMs: 30000, gitBufferLimitBytes: 52428800, apiKeyMaskLength: 8,
    },
    cache: { defaultTtlMs: 300000 },
    generation: { opedVoiceTimeoutMs: 360000 },
    pollGate: { enabled: false },
    ...overrides,
  };
}

const defaultConfig = makeConfig();

const mockFetch = vi.fn().mockResolvedValue(undefined);
const mockSave = vi.fn().mockResolvedValue(true);
const mockReload = vi.fn().mockResolvedValue(undefined);
const mockResetAll = vi.fn();
const mockSetField = vi.fn();
const mockResetField = vi.fn();

let mockStoreState: {
  serverState: ConfigState | null;
  draft: RuntimeConfig | null;
  loading: boolean;
  saving: boolean;
  saveErrors: string[];
  fetchError: string | null;
};

vi.mock('../../hooks/useRuntimeConfigStore', () => ({
  useRuntimeConfigStore: () => ({
    ...mockStoreState,
    fetch: mockFetch,
    save: mockSave,
    reload: mockReload,
    resetAll: mockResetAll,
    setField: mockSetField,
    resetField: mockResetField,
  }),
  getNestedValue: (obj: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>(
      (cur, key) => (cur != null && typeof cur === 'object') ? (cur as Record<string, unknown>)[key] : undefined,
      obj,
    ),
  countLeafDiffs: () => 0,
}));

import { RuntimeConfigPanel } from './RuntimeConfigPanel';

describe('RuntimeConfigPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsElectron = false;
    mockStoreState = {
      serverState: {
        config: defaultConfig,
        defaults: defaultConfig,
        errors: [],
        fileExists: true,
        lastModified: '2026-06-01T12:00:00Z',
      },
      draft: defaultConfig,
      loading: false,
      saving: false,
      saveErrors: [],
      fetchError: null,
    };
  });

  it('renders web-only message in electron mode', () => {
    mockIsElectron = true;
    render(<RuntimeConfigPanel />);
    expect(screen.getByText('Runtime configuration is only available in web mode.')).toBeInTheDocument();
  });

  it('renders loading state', () => {
    mockStoreState.serverState = null;
    mockStoreState.draft = null;
    mockStoreState.loading = true;
    render(<RuntimeConfigPanel />);
    expect(screen.getByText(/Loading configuration/)).toBeInTheDocument();
  });

  it('renders fetch error state', () => {
    mockStoreState.serverState = null;
    mockStoreState.draft = null;
    mockStoreState.fetchError = 'Connection refused';
    render(<RuntimeConfigPanel />);
    expect(screen.getByText('Connection refused')).toBeInTheDocument();
  });

  it('renders config sections when loaded', () => {
    render(<RuntimeConfigPanel />);
    expect(screen.getByText('Resilience')).toBeInTheDocument();
    expect(screen.getByText('Rate Limiting')).toBeInTheDocument();
    expect(screen.getByText('Quotas')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Tiers')).toBeInTheDocument();
  });

  it('renders toolbar buttons', () => {
    render(<RuntimeConfigPanel />);
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText(/Reload/)).toBeInTheDocument();
    expect(screen.getByText('Reset')).toBeInTheDocument();
  });

  it('disables Save when not dirty', () => {
    render(<RuntimeConfigPanel />);
    expect(screen.getByText('Save')).toBeDisabled();
  });

  it('calls fetch on mount', () => {
    render(<RuntimeConfigPanel />);
    expect(mockFetch).toHaveBeenCalled();
  });

  it('renders save errors when present', () => {
    mockStoreState.saveErrors = ['Validation failed: circuitThreshold must be positive'];
    render(<RuntimeConfigPanel />);
    expect(screen.getByText(/Save failed/)).toBeInTheDocument();
    expect(screen.getByText(/circuitThreshold must be positive/)).toBeInTheDocument();
  });

  it('renders file info when config exists on disk', () => {
    render(<RuntimeConfigPanel />);
    expect(screen.getByText(/Last modified/)).toBeInTheDocument();
  });

  it('renders no-file message when config does not exist on disk', () => {
    mockStoreState.serverState!.fileExists = false;
    render(<RuntimeConfigPanel />);
    expect(screen.getByText(/No config file on disk/)).toBeInTheDocument();
  });

  it('toggles modified-only filter', async () => {
    const user = userEvent.setup();
    render(<RuntimeConfigPanel />);
    const checkbox = screen.getByLabelText(/Modified only/);
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  // ── t/4371: Poll Gate toggle ──

  it('renders the Poll Gate section with its help text', () => {
    render(<RuntimeConfigPanel />);
    expect(screen.getByText('Poll Gate')).toBeInTheDocument();
    expect(screen.getByText(/Stop background polling in hidden or idle tabs/)).toBeInTheDocument();
  });

  it('round-trips pollGate.enabled through a checkbox', async () => {
    const user = userEvent.setup();
    render(<RuntimeConfigPanel />);
    const label = screen.getByText('Enabled');
    const checkbox = label.closest('.rc-field')!.querySelector('input[type="checkbox"]')!;
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);

    expect(mockSetField).toHaveBeenCalledWith('pollGate.enabled', true);
  });
});
