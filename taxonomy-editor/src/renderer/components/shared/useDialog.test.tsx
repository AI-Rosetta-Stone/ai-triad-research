// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4901: unit tests for the shared dialog a11y hook — AC "A test covers the shared wrapper."

import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useDialog } from './useDialog';

function TestDialog({ onCancel, closeOnEscape, initialFocusOnCancel }: {
  onCancel: () => void;
  closeOnEscape?: boolean;
  initialFocusOnCancel?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, titleId } = useDialog({
    onCancel, closeOnEscape,
    initialFocusRef: initialFocusOnCancel ? cancelRef : undefined,
  });
  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal aria-labelledby={titleId}>
        <h3 id={titleId}>Confirm</h3>
        <button ref={cancelRef}>Cancel</button>
        <button>Confirm</button>
      </div>
    </div>
  );
}

/** A dialog with no focusable child at all (e.g. a progress/status message) — t/4901 nit
 *  (p/29#262): initial focus must still land somewhere, not silently fail. */
function NoFocusableDialog({ onCancel }: { onCancel: () => void }) {
  const { dialogRef, titleId } = useDialog({ onCancel });
  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal aria-labelledby={titleId}>
        <h3 id={titleId}>Working…</h3>
        <p>Please wait.</p>
      </div>
    </div>
  );
}

/** A button rendered OUTSIDE the dialog, standing in for whatever control opened it. */
function Harness(props: { closeOnEscape?: boolean; initialFocusOnCancel?: boolean; onCancel: () => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(props.startOpen ?? true);
  return (
    <div>
      <button data-testid="opener" onClick={() => setOpen(true)}>Open</button>
      {open && <TestDialog {...props} onCancel={() => { props.onCancel(); setOpen(false); }} />}
    </div>
  );
}

describe('useDialog (t/4901)', () => {
  it('moves focus to the first focusable element inside the dialog on open', () => {
    render(<Harness onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('moves focus to initialFocusRef when given, not the first focusable element', () => {
    render(<Harness onCancel={vi.fn()} initialFocusOnCancel />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('Esc calls onCancel when closeOnEscape is true (the default)', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // t/4901 AC2: Esc must not close while a destructive action is in progress.
  it('Esc does nothing when closeOnEscape is false', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} closeOnEscape={false} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('traps Tab inside the dialog: Tab from the last control wraps to the first', () => {
    render(<Harness onCancel={vi.fn()} />);
    const dialog = within(screen.getByRole('dialog'));
    dialog.getByRole('button', { name: 'Confirm' }).focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('traps Shift+Tab from the first control, wrapping to the last', () => {
    render(<Harness onCancel={vi.fn()} />);
    const dialog = within(screen.getByRole('dialog'));
    dialog.getByRole('button', { name: 'Cancel' }).focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(dialog.getByRole('button', { name: 'Confirm' })).toHaveFocus();
  });

  it('falls back to focusing the dialog container when it has no focusable child (t/4901 nit)', () => {
    render(<NoFocusableDialog onCancel={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('tabindex', '-1');
    expect(dialog).toHaveFocus();
  });

  it('returns focus to the opener once the dialog closes', () => {
    render(<Harness onCancel={vi.fn()} startOpen={false} />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    fireEvent.click(opener); // opens the dialog — its mount effect captures the CURRENT activeElement (opener)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});
