// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));

// Stub heavy child components to isolate SaveBar logic.
const mockDrawer = vi.fn(() => null);
vi.mock('./UnsyncedChangesDrawer', () => ({ UnsyncedChangesDrawer: (props: unknown) => mockDrawer(props) }));
vi.mock('./SyncDiagnosticsDialog', () => ({ SyncDiagnosticsDialog: () => null }));
vi.mock('./TaxonomyDiffPanel', () => ({ TaxonomyDiffPanel: () => null }));
vi.mock('./TaxonomyUpdateToast', () => ({ TaxonomyUpdateToast: () => null }));
vi.mock('../shared', () => ({ TheoryLink: () => null }));

// Stub hooks with controllable return values.
const mockUseFlag = vi.fn();
vi.mock('../../hooks/useFeatureFlags', () => ({ useFlag: (flag: string) => mockUseFlag(flag) }));

const mockDismissSaveError = vi.fn();
const mockLoadAll = vi.fn();
let mockStaleBranchHint: { sessionBranch: string; behindBy: number; untouchedNodeIds: string[] } | null = null;
let mockSaveError: string | null = null;
let mockDirty = new Set<string>();

const mockReloadKeepingEdits = vi.fn();

vi.mock('../../hooks/useTaxonomyStore', () => {
  const useTaxonomyStore = () => ({
    dirty: mockDirty,
    save: vi.fn(),
    saveError: mockSaveError,
    dismissSaveError: mockDismissSaveError,
    validationErrors: {},
    integrityIssues: [],
    fixIntegrityErrors: vi.fn(),
    staleBranchHint: mockStaleBranchHint,
    loadAll: mockLoadAll,
  });
  useTaxonomyStore.getState = () => ({ reloadKeepingEdits: mockReloadKeepingEdits });
  return { useTaxonomyStore };
});

const mockRefreshSync = vi.fn();
vi.mock('../../hooks/useSyncStatus', () => ({
  useSyncStatus: () => ({
    status: {
      enabled: false,
      unsynced_count: 0,
      session_branch: null,
      pr_number: null,
      pr_url: null,
      push_pending: false,
      github_configured: false,
      main_updated_available: false,
      rebase_in_progress: false,
      has_conflicts: false,
    },
    refresh: mockRefreshSync,
  }),
}));

vi.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));

const mockResyncTracked = vi.fn();
vi.mock('../../utils/syncApi', async () => {
  const actual = await vi.importActual<typeof import('../../utils/syncApi')>('../../utils/syncApi');
  return { ...actual, resyncTracked: (mode: string) => mockResyncTracked(mode) };
});

const { SaveBar } = await import('./SaveBar');

describe('SaveBar admin gate', () => {
  it('renders nothing for non-admin users', () => {
    mockUseFlag.mockReturnValue(false);
    const { container } = render(<SaveBar />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the bar for admin users', () => {
    mockUseFlag.mockReturnValue(true);
    const { container } = render(<SaveBar />);
    expect(container.querySelector('.save-bar')).not.toBeNull();
  });
});

describe('SaveBar resync button (t/4346)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFlag.mockReturnValue(true);
    mockStaleBranchHint = null;
    mockSaveError = null;
    mockDirty = new Set();
    mockReloadKeepingEdits.mockResolvedValue({ ok: true, message: null, counts: { refreshed: 0, kept: 0, added: 0, dropped: 0, keptDeleted: 0 }, conflicts: [] });
  });

  it('does not render a Resync button without a stale-branch hint', () => {
    mockSaveError = 'Some other validation failure';
    render(<SaveBar />);
    expect(screen.queryByRole('button', { name: /^Resync/ })).toBeNull();
  });

  it('renders Resync when staleBranchHint is set alongside the save error', () => {
    mockSaveError = 'Your session branch (feature/x) is 3 commits behind main — resync to pick up the latest.';
    mockStaleBranchHint = { sessionBranch: 'feature/x', behindBy: 3, untouchedNodeIds: ['acc-goal-001'] };
    render(<SaveBar />);
    expect(screen.getByRole('button', { name: 'Resync' })).not.toBeNull();
  });

  it('on success, calls resyncTracked, dismisses the error, and refreshes', async () => {
    mockSaveError = 'behind main';
    mockStaleBranchHint = { sessionBranch: 'feature/x', behindBy: 3, untouchedNodeIds: ['acc-goal-001'] };
    mockResyncTracked.mockResolvedValue({ ok: true, mode: 'rebase', session_ahead: 0, main_sha: 'abc', conflicts: false, message: 'Resynced' });
    render(<SaveBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
    await waitFor(() => expect(mockResyncTracked).toHaveBeenCalledWith('rebase'));
    expect(mockDismissSaveError).toHaveBeenCalledTimes(1);
    expect(mockRefreshSync).toHaveBeenCalledTimes(1);
  });

  it('t/4439: a successful Resync calls reloadKeepingEdits after refreshing sync status', async () => {
    mockSaveError = 'behind main';
    mockStaleBranchHint = { sessionBranch: 'feature/x', behindBy: 3, untouchedNodeIds: ['acc-goal-001'] };
    mockResyncTracked.mockResolvedValue({ ok: true, mode: 'rebase', session_ahead: 0, main_sha: 'abc', conflicts: false, message: 'Resynced' });
    render(<SaveBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
    await waitFor(() => expect(mockReloadKeepingEdits).toHaveBeenCalledTimes(1));
    expect(mockRefreshSync).toHaveBeenCalledTimes(1);
  });

  it('t/4439: shows reloadKeepingEdits\' message (a conflict note or read-failure) when it reports one', async () => {
    mockSaveError = 'behind main';
    mockStaleBranchHint = { sessionBranch: 'feature/x', behindBy: 3, untouchedNodeIds: ['acc-goal-001'] };
    mockResyncTracked.mockResolvedValue({ ok: true, mode: 'rebase', session_ahead: 0, main_sha: 'abc', conflicts: false, message: 'Resynced' });
    mockReloadKeepingEdits.mockResolvedValue({ ok: true, message: '1 node changed on both sides', counts: { refreshed: 1, kept: 1, added: 0, dropped: 0, keptDeleted: 0 }, conflicts: [{ id: 'acc-goal-003', kind: 'edited-also-changed-upstream' }] });
    render(<SaveBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
    expect(await screen.findByText('1 node changed on both sides')).not.toBeNull();
  });

  it('fix-forward (#3731 comment 6335280772): a successful Resync never calls loadAll, so unsaved edits survive', async () => {
    mockSaveError = 'behind main';
    mockStaleBranchHint = { sessionBranch: 'feature/x', behindBy: 3, untouchedNodeIds: ['acc-goal-001'] };
    mockDirty = new Set(['acc-goal-002']); // the node the user actually edited — distinct from the untouched one
    mockResyncTracked.mockResolvedValue({ ok: true, mode: 'rebase', session_ahead: 0, main_sha: 'abc', conflicts: false, message: 'Resynced' });
    render(<SaveBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
    await waitFor(() => expect(mockResyncTracked).toHaveBeenCalledWith('rebase'));
    expect(mockDismissSaveError).toHaveBeenCalledTimes(1);
    expect(mockLoadAll).not.toHaveBeenCalled();
    expect(mockDirty.has('acc-goal-002')).toBe(true);
    expect(mockDirty.size).toBe(1);
  });

  it('on conflicts, opens the sync drawer, shows an inline message, and does not dismiss the error', async () => {
    mockSaveError = 'behind main';
    mockStaleBranchHint = { sessionBranch: 'feature/x', behindBy: 3, untouchedNodeIds: ['acc-goal-001'] };
    mockResyncTracked.mockResolvedValue({ ok: true, mode: 'rebase', session_ahead: 0, main_sha: 'abc', conflicts: true, message: 'Conflicts' });
    render(<SaveBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
    await waitFor(() => expect(mockResyncTracked).toHaveBeenCalledTimes(1));
    expect(mockDismissSaveError).not.toHaveBeenCalled();
    expect(await screen.findByText(/resolve them in the sync panel/)).not.toBeNull();
    await waitFor(() => expect(mockDrawer).toHaveBeenLastCalledWith(expect.objectContaining({ open: true })));
  });

  it('on failure (the resync-failure arm), shows inline error text, does not auto-retry, and leaves the hint in place', async () => {
    mockSaveError = 'behind main';
    mockStaleBranchHint = { sessionBranch: 'feature/x', behindBy: 3, untouchedNodeIds: ['acc-goal-001'] };
    mockResyncTracked.mockRejectedValue(new Error('network down'));
    render(<SaveBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
    await waitFor(() => expect(mockResyncTracked).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('network down')).not.toBeNull();
    expect(mockDismissSaveError).not.toHaveBeenCalled();
    expect(mockResyncTracked).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Resync' })).not.toBeNull();
  });

  it('disables Resync while a resync is in flight', async () => {
    mockSaveError = 'behind main';
    mockStaleBranchHint = { sessionBranch: 'feature/x', behindBy: 3, untouchedNodeIds: ['acc-goal-001'] };
    let resolveCall: (v: unknown) => void = () => {};
    mockResyncTracked.mockImplementation(() => new Promise(res => { resolveCall = res; }));
    render(<SaveBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Resync' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resyncing…' })).toBeDisabled());
    resolveCall({ ok: true, mode: 'rebase', session_ahead: 0, main_sha: 'abc', conflicts: false, message: 'Resynced' });
  });
});
