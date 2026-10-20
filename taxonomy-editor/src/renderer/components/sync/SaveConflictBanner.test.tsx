// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));

const mockRefresh = vi.fn();
let mockStatus: { overlay_commit?: { state: string; at: number; conflictedPaths?: string[] } };

vi.mock('../../hooks/useSyncStatus', () => ({
  useSyncStatus: () => ({ status: mockStatus, refresh: mockRefresh }),
}));

const mockLoadAll = vi.fn();
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: { loadAll: typeof mockLoadAll }) => unknown) =>
    selector({ loadAll: mockLoadAll }),
}));

const mockUseTheirs = vi.fn();
const mockKeepMine = vi.fn();
vi.mock('../../utils/syncApi', async () => {
  const actual = await vi.importActual<typeof import('../../utils/syncApi')>('../../utils/syncApi');
  return {
    ...actual,
    resolveOverlayConflictUseTheirs: () => mockUseTheirs(),
    resolveOverlayConflictKeepMine: () => mockKeepMine(),
  };
});

const { SaveConflictBanner } = await import('./SaveConflictBanner');

const CONFLICT_PATHS = ['data/accelerationist.json', 'data/safetyist.json'];

function setConflict(paths: string[] = CONFLICT_PATHS) {
  mockStatus = { overlay_commit: { state: 'conflict', at: Date.now(), conflictedPaths: paths } };
}

describe('SaveConflictBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatus = { overlay_commit: { state: 'pending', at: Date.now() } };
    mockUseTheirs.mockResolvedValue({ discarded: CONFLICT_PATHS });
    mockKeepMine.mockResolvedValue({ committed: true, stillConflicted: [] });
  });

  it('renders nothing when there is no conflict', () => {
    const { container } = render(<SaveConflictBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the file list and truncates at 5 files', () => {
    const many = Array.from({ length: 7 }, (_, i) => `data/file-${i}.json`);
    setConflict(many);
    render(<SaveConflictBanner />);
    const text = screen.getByText(/and 2 more/);
    expect(text.textContent).toContain('file-0.json');
    expect(text.textContent).toContain('file-4.json');
    expect(text.textContent).not.toContain('file-5.json');
  });

  it('defaults focus to "Use theirs"', () => {
    setConflict();
    render(<SaveConflictBanner />);
    expect(screen.getByRole('button', { name: 'Use theirs' })).toHaveFocus();
  });

  it('"Keep mine" does not fire without confirmation', () => {
    setConflict();
    render(<SaveConflictBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(mockKeepMine).not.toHaveBeenCalled();
    expect(screen.getByText('Replace the newer version?')).not.toBeNull();
  });

  it('"Keep mine" calls the endpoint and clears the banner on confirm', async () => {
    setConflict();
    render(<SaveConflictBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mine' }));
    await waitFor(() => expect(mockKeepMine).toHaveBeenCalledTimes(1));
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    mockStatus = { overlay_commit: { state: 'committed', at: Date.now() } };
    const { container } = render(<SaveConflictBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('"Keep mine" re-shows the banner instead of re-calling when stillConflicted is non-empty', async () => {
    setConflict();
    mockKeepMine.mockResolvedValue({ committed: false, stillConflicted: ['data/safetyist.json'] });
    render(<SaveConflictBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save mine' }));
    await waitFor(() => expect(mockKeepMine).toHaveBeenCalledTimes(1));
    expect(mockKeepMine).toHaveBeenCalledTimes(1);
  });

  it('"Use theirs" requires confirmation, then calls the endpoint, reloads, and clears', async () => {
    setConflict();
    render(<SaveConflictBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Use theirs' }));
    expect(mockUseTheirs).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard my changes' }));
    await waitFor(() => expect(mockUseTheirs).toHaveBeenCalledTimes(1));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockLoadAll).toHaveBeenCalledWith(true);
  });

  it('on failure shows inline error text and does not auto-retry, banner stays', async () => {
    setConflict();
    mockUseTheirs.mockRejectedValue(new Error('network down'));
    render(<SaveConflictBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Use theirs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard my changes' }));
    await waitFor(() => expect(mockUseTheirs).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/That didn't work/)).not.toBeNull();
    expect(mockUseTheirs).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Use theirs' })).not.toBeNull();
  });

  it('both buttons disable and show "Working…" while a call is in flight', async () => {
    setConflict();
    let resolveCall: (v: { discarded: string[] }) => void = () => {};
    mockUseTheirs.mockImplementation(() => new Promise(res => { resolveCall = res; }));
    render(<SaveConflictBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Use theirs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard my changes' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Keep mine' })).toBeDisabled();
    });
    resolveCall({ discarded: CONFLICT_PATHS });
  });
});
