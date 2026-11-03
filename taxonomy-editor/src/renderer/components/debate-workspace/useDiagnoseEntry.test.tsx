// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4642: useDiagnoseEntry — the shared diagnose-and-focus hook both StatementCard's Diagnose
// button and DebateWorkspace's TranscriptEntryRow onClick route through. Covers the three
// bridge-result arms (focused/inline → no notice, not-open → notice shown) plus the
// not-yet-enabled first-open path, which is unchanged from before this ticket.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const { focusDiagnosticsWindow, openDiagnosticsWindow } = vi.hoisted(() => ({
  focusDiagnosticsWindow: vi.fn(),
  openDiagnosticsWindow: vi.fn(),
}));
vi.mock('@bridge', () => ({ api: { focusDiagnosticsWindow, openDiagnosticsWindow } }));

const debateState = {
  diagnosticsEnabled: false,
  toggleDiagnostics: vi.fn(),
  selectDiagEntry: vi.fn(),
};
vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: (selector: (s: typeof debateState) => unknown) => selector(debateState),
}));

import { useDiagnoseEntry } from './useDiagnoseEntry';

function Harness() {
  const { diagnose, notice } = useDiagnoseEntry();
  return (
    <div>
      <button onClick={() => diagnose('e1')}>diagnose</button>
      {notice}
    </div>
  );
}

describe('useDiagnoseEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    debateState.diagnosticsEnabled = false;
  });

  it('when diagnostics is not yet enabled, enables it and delay-selects (unchanged first-open path)', () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.click(screen.getByText('diagnose'));

    expect(debateState.toggleDiagnostics).toHaveBeenCalledTimes(1);
    expect(debateState.selectDiagEntry).not.toHaveBeenCalled();
    expect(focusDiagnosticsWindow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1200);
    expect(debateState.selectDiagEntry).toHaveBeenCalledWith('e1', true);
    vi.useRealTimers();
  });

  it('when diagnostics is already enabled and the window focuses, shows no notice', async () => {
    debateState.diagnosticsEnabled = true;
    focusDiagnosticsWindow.mockResolvedValue('focused');
    render(<Harness />);
    fireEvent.click(screen.getByText('diagnose'));

    expect(debateState.selectDiagEntry).toHaveBeenCalledWith('e1', true);
    await waitFor(() => expect(focusDiagnosticsWindow).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('when diagnostics is already enabled and shown inline (narrow-window drawer), shows no notice', async () => {
    debateState.diagnosticsEnabled = true;
    focusDiagnosticsWindow.mockResolvedValue('inline');
    render(<Harness />);
    fireEvent.click(screen.getByText('diagnose'));

    await waitFor(() => expect(focusDiagnosticsWindow).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('when the window cannot be focused (not-open), shows the fallback notice', async () => {
    debateState.diagnosticsEnabled = true;
    focusDiagnosticsWindow.mockResolvedValue('not-open');
    render(<Harness />);
    fireEvent.click(screen.getByText('diagnose'));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByText('Shown in the Diagnostics tab')).toBeInTheDocument();
  });

  it('the notice\'s Open action calls openDiagnosticsWindow and dismisses the notice', async () => {
    debateState.diagnosticsEnabled = true;
    focusDiagnosticsWindow.mockResolvedValue('not-open');
    render(<Harness />);
    fireEvent.click(screen.getByText('diagnose'));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Open'));
    expect(openDiagnosticsWindow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('the notice\'s Dismiss action clears it without opening anything', async () => {
    debateState.diagnosticsEnabled = true;
    focusDiagnosticsWindow.mockResolvedValue('not-open');
    render(<Harness />);
    fireEvent.click(screen.getByText('diagnose'));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Dismiss'));
    expect(openDiagnosticsWindow).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('the notice auto-dismisses after its timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    debateState.diagnosticsEnabled = true;
    focusDiagnosticsWindow.mockResolvedValue('not-open');
    render(<Harness />);
    fireEvent.click(screen.getByText('diagnose'));
    await vi.waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('a focusDiagnosticsWindow rejection also falls back to the notice, not a silent failure', async () => {
    debateState.diagnosticsEnabled = true;
    focusDiagnosticsWindow.mockRejectedValue(new Error('bridge unavailable'));
    render(<Harness />);
    fireEvent.click(screen.getByText('diagnose'));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
  });
});
