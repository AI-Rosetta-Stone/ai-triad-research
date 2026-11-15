// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/81: RemoveConfirmPopover (admin delete confirm, shared by the Community grid and every
// LibraryListPage Community tab) is on the shared useDialog a11y contract, and still keeps its
// popover-style outside-click dismissal.

import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RemoveConfirmPopover } from './CommunityLibrary';

/** An opener button outside the popover, standing in for the row's admin ✕. */
function Harness({ onCancel, onConfirm }: { onCancel: () => void; onConfirm?: (r: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button data-testid="opener" onClick={() => setOpen(true)}>✕</button>
      <span data-testid="outside">elsewhere</span>
      {open && (
        <RemoveConfirmPopover
          title="Some debate"
          onCancel={() => { onCancel(); setOpen(false); }}
          onConfirm={onConfirm ?? vi.fn()}
        />
      )}
    </div>
  );
}

function openPopover(onCancel = vi.fn()) {
  render(<Harness onCancel={onCancel} />);
  const opener = screen.getByTestId('opener');
  opener.focus();
  fireEvent.click(opener);
  return { opener, onCancel, dialog: screen.getByRole('dialog') };
}

describe('RemoveConfirmPopover a11y (t/81)', () => {
  it('is a modal dialog labelled by its title', () => {
    const { dialog } = openPopover();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)).toHaveTextContent('Remove from Community Library?');
    expect(screen.getByRole('dialog', { name: 'Remove from Community Library?' })).toBe(dialog);
  });

  it('puts initial focus on the reason textarea (deliberate, not Cancel)', () => {
    openPopover();
    expect(screen.getByPlaceholderText('Reason (optional)')).toHaveFocus();
  });

  it('Escape calls onCancel and returns focus to the opener', () => {
    const { opener, onCancel, dialog } = openPopover();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('traps Tab: Tab from Remove wraps to the textarea, Shift+Tab from the textarea wraps to Remove', () => {
    const { dialog } = openPopover();
    const d = within(dialog);
    const textarea = d.getByPlaceholderText('Reason (optional)');
    const remove = d.getByRole('button', { name: 'Remove' });

    remove.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(textarea).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(remove).toHaveFocus();
  });

  it('still dismisses on an outside mousedown, but not on one inside', () => {
    const { onCancel, dialog } = openPopover();
    fireEvent.mouseDown(within(dialog).getByPlaceholderText('Reason (optional)'));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Remove passes the trimmed reason to onConfirm', () => {
    const onConfirm = vi.fn();
    render(<Harness onCancel={vi.fn()} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('opener'));
    fireEvent.change(screen.getByPlaceholderText('Reason (optional)'), { target: { value: '  spam  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledWith('spam');
  });
});
