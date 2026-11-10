// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/88: Debate's bulk-delete dialog handles failures like BulkDeleteInquiryDialog — stays open, keeps the
// failed rows selected, and a lone failure shows its own reason instead of the generic aggregate.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: mockRecord }) }));

import { BulkDeleteDialog } from './DebateBulkDeleteDialog';

const SESSIONS = [
  { id: 'd1', title: 'First debate', phase: 'closed', updated_at: '2026-01-01T00:00:00Z' },
  { id: 'd2', title: { final: 'Second debate' }, phase: 'debate', updated_at: '2026-01-02T00:00:00Z' },
  { id: 'd3', title: 'Third debate', phase: 'closed', updated_at: '2026-01-03T00:00:00Z' },
];

function renderDialog(selected: string[], deleteDebate: (id: string) => Promise<void>) {
  const props = {
    sessions: SESSIONS as never,
    selectedIds: new Set(selected),
    setShowBulkDeleteConfirm: vi.fn(),
    setEditMode: vi.fn(),
    setSelectedIds: vi.fn(),
    deleteDebate: vi.fn(deleteDebate),
  };
  render(<BulkDeleteDialog {...props} />);
  return props;
}

function clickDelete() {
  fireEvent.click(screen.getByRole('button', { name: /^Delete \d+ Debates?$/ }));
}

describe('BulkDeleteDialog — partial failure (t/88)', () => {
  beforeEach(() => mockRecord.mockReset());

  it('all deletes succeed: closes, exits edit mode, clears the selection, shows no error', async () => {
    const p = renderDialog(['d1', 'd3'], () => Promise.resolve());
    clickDelete();
    await waitFor(() => expect(p.setShowBulkDeleteConfirm).toHaveBeenCalledWith(false));
    expect(p.deleteDebate).toHaveBeenNthCalledWith(1, 'd1');
    expect(p.deleteDebate).toHaveBeenNthCalledWith(2, 'd3');
    expect(p.setEditMode).toHaveBeenCalledWith(false);
    expect(p.setSelectedIds).toHaveBeenCalledWith(new Set());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a lone selected item that fails shows its own reason, not the generic "Couldn\'t delete" text', async () => {
    const p = renderDialog(['d1'], () => Promise.reject(new Error('This debate is open in another window')));
    clickDelete();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Deleted 0 of 1. This debate is open in another window');
    expect(alert).not.toHaveTextContent("Couldn't delete");
    expect(p.setShowBulkDeleteConfirm).not.toHaveBeenCalled();
    expect(p.setEditMode).not.toHaveBeenCalled();
    expect(p.setSelectedIds).toHaveBeenCalledWith(new Set(['d1']));
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ type: 'system.error', component: 'debate-tab', level: 'warn' }));
  });

  it('a lone 429 failure gets the operation rate-limit text, never "switch to a different model" (t/127)', async () => {
    renderDialog(['d1'], () => Promise.reject(new Error('HTTP 429 Too Many Requests')));
    clickDelete();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Deleted 0 of 1. Too many requests. Wait a minute and try again.');
    expect(alert).not.toHaveTextContent(/model/i);
  });

  it('a multi-item batch keeps the generic aggregate message and keeps only the failed rows selected', async () => {
    const p = renderDialog(['d1', 'd2', 'd3'], (id) => (id === 'd2' ? Promise.reject(new Error('boom')) : Promise.resolve()));
    clickDelete();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Deleted 2 of 3. Couldn't delete: Second debate.");
    expect(alert).not.toHaveTextContent('boom');
    expect(p.deleteDebate).toHaveBeenCalledTimes(3);
    expect(p.setSelectedIds).toHaveBeenCalledWith(new Set(['d2']));
    expect(p.setShowBulkDeleteConfirm).not.toHaveBeenCalled();
  });
});
