// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4898: Questions tab edit mode (select + bulk delete), My rows only. Mocks LibraryListPage
// just enough to drive edit mode / selection / bulk-delete, without re-testing LibraryListPage's
// own rendering (covered by its own suite) — mirrors ChatTab.editMode.test.tsx (t/4896).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { LibraryListPageConfig } from '../shared/LibraryListPage.types';

const deleteHistoryItemMock = vi.fn();
let historyState: { jobId: string; question: string; debateId: string | null; truncated: boolean; createdAt: string }[] = [];

vi.mock('../../hooks/useInquiryStore', () => ({
  useInquiryStore: (selector: (s: unknown) => unknown) => selector({
    screen: () => 'list',
    _stopPolling: vi.fn(),
    history: historyState,
    historyLoading: false,
    reset: vi.fn(),
    setQuestion: vi.fn(),
    openFromHistory: vi.fn(),
    openCommunityResult: vi.fn(),
    fetchHistory: vi.fn().mockResolvedValue(undefined),
    openList: vi.fn(),
    renameHistoryItem: vi.fn(),
    deleteHistoryItem: deleteHistoryItemMock,
  }),
}));

vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: (selector: (s: unknown) => unknown) => selector({
    inquiries: [], loading: false, fetchInquiries: vi.fn().mockResolvedValue(undefined),
    copyItem: vi.fn(), removeItem: vi.fn(), renameItem: vi.fn(),
  }),
}));

vi.mock('@bridge', () => ({ api: {} }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('./InquiryAskPanel', () => ({ InquiryAskPanel: () => null }));
vi.mock('./InquiryRunningPanel', () => ({ InquiryRunningPanel: () => <div>running-screen</div> }));
vi.mock('./InquiryAnswerPanel', () => ({ InquiryAnswerPanel: () => <div>answer-screen</div> }));
vi.mock('./InquiryGettingStarted', () => ({ InquiryGettingStarted: () => null }));

type MyRow = { id: string };

vi.mock('../shared/LibraryListPage', () => ({
  // Exposes config.showEdit/config.editMode so these tests can drive edit mode, enter/select/
  // bulk-delete, without re-testing LibraryListPage's own rendering (covered by its own suite).
  LibraryListPage: ({ config, myRows }: { config: LibraryListPageConfig<MyRow, MyRow>; myRows: MyRow[] }) => (
    <div data-testid="library-list-page">
      {config.showEdit && (
        <button data-testid="enter-edit-mode" onClick={config.editMode?.onEnter}>Edit</button>
      )}
      {config.editMode?.active && (
        <div data-testid="edit-mode-bar">
          {config.editMode.actions.map(a => (
            <button key={a.label} data-testid={`action-${a.label}`} onClick={a.onClick}>{a.label}</button>
          ))}
        </div>
      )}
      {myRows.map(row => (
        <button
          key={row.id}
          data-testid={`row-${row.id}`}
          onClick={() => config.editMode?.active && config.editMode.onToggleSelect(row.id)}
        >
          {row.id}
          {config.editMode?.active && config.editMode.selectedIds.has(row.id) ? ' [selected]' : ''}
        </button>
      ))}
    </div>
  ),
}));

const { InquiryTab } = await import('./InquiryTab');

describe('InquiryTab — edit mode delete (t/4898)', () => {
  beforeEach(() => {
    deleteHistoryItemMock.mockReset().mockResolvedValue(undefined);
    historyState = [
      { jobId: 'job-1', question: 'First question?', debateId: null, truncated: false, createdAt: '2026-01-01T00:00:00Z' },
      { jobId: 'job-2', question: 'Second question?', debateId: null, truncated: false, createdAt: '2026-01-02T00:00:00Z' },
    ];
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('the list declares showEdit and offers All/None/Done with no Delete until something is selected', () => {
    render(<InquiryTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    expect(screen.getByTestId('action-All')).toBeInTheDocument();
    expect(screen.getByTestId('action-None')).toBeInTheDocument();
    expect(screen.getByTestId('action-Done')).toBeInTheDocument();
    expect(screen.queryByTestId(/^action-Delete/)).toBeNull();
  });

  it('bulk delete confirm dialog lists the selected questions and deletes each on confirm', async () => {
    render(<InquiryTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-job-1'));
    fireEvent.click(screen.getByTestId('row-job-2'));
    fireEvent.click(screen.getByTestId('action-Delete 2'));

    expect(screen.getByText('First question?')).toBeInTheDocument();
    expect(screen.getByText('Second question?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Delete 2 Questions$/ }));
    await vi.waitFor(() => {
      expect(deleteHistoryItemMock).toHaveBeenCalledWith('job-1');
      expect(deleteHistoryItemMock).toHaveBeenCalledWith('job-2');
    });
    expect(deleteHistoryItemMock).toHaveBeenCalledTimes(2);
  });

  // t/4898 (Design required fix, p/29#274): matches the pattern approved for Chat's bulk delete
  // (#4585/ChatBulkDeleteDialog) — the dialog stays open on a partial failure, shows "Deleted X
  // of Y", and keeps only the failed id(s) selected.
  it('a failed delete keeps the dialog open, reports the partial result, and keeps the failed id selected', async () => {
    deleteHistoryItemMock.mockImplementation((jobId: string) =>
      jobId === 'job-2' ? Promise.reject(new Error('boom')) : Promise.resolve(undefined),
    );
    render(<InquiryTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-job-1'));
    fireEvent.click(screen.getByTestId('row-job-2'));
    fireEvent.click(screen.getByTestId('action-Delete 2'));
    fireEvent.click(screen.getByRole('button', { name: /^Delete 2 Questions$/ }));

    await vi.waitFor(() => {
      expect(screen.getByText("Deleted 1 of 2. Couldn't delete: Second question?.")).toBeInTheDocument();
    });
    expect(screen.queryByText('First question?')).toBeNull();
    expect(screen.getByText('Second question?')).toBeInTheDocument();
    expect(screen.getByTestId('edit-mode-bar')).toBeInTheDocument();
  });

  // t/4898 (Quality, t/4898#3/p/356#166 should-fix): a still-running delete is a plain HTTP 409
  // on web — mapped to a friendlier message than the generic "Couldn't delete: X".
  it('a single still-running (409) delete shows the friendly "still running" message, not the generic one', async () => {
    deleteHistoryItemMock.mockRejectedValue(Object.assign(new Error('still running'), { httpStatus: 409 }));
    render(<InquiryTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-job-1'));
    fireEvent.click(screen.getByTestId('action-Delete 1'));
    fireEvent.click(screen.getByRole('button', { name: /^Delete 1 Question$/ }));

    await vi.waitFor(() => {
      expect(screen.getByText('Deleted 0 of 1. This question is still running — try deleting it again once it finishes.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Couldn't delete/)).toBeNull();
  });
});
