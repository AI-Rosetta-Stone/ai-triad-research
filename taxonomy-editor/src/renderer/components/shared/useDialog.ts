// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useId, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Tab-traps a dialog's own focusable elements — the same shape as NewDebateDialog's original
 *  useFocusTrap (t/4689), moved here so every dialog shares one implementation instead of
 *  reinventing it (t/4901). */
function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active || !ref.current) return;
    const el = ref.current;
    const getFocusable = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [active, ref]);
}

export interface UseDialogOptions {
  /** Called on Esc (while closeOnEscape) — the same effect as the dialog's own Cancel button. */
  onCancel: () => void;
  /** Default true. Pass false while a destructive action is in flight (t/4901 AC2) — mirrors
   *  ChatBulkDeleteDialog's existing `!deleting &&` guard on its overlay click. */
  closeOnEscape?: boolean;
  /** Which element gets focus on open. Defaults to the first focusable element inside the
   *  dialog — pass the Cancel button's ref for a destructive confirm (t/4901 AC3: "the first
   *  safe control"). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Pass an existing ref when the dialog already owns one for other reasons (e.g. HelpDialog's
   *  drag/resize positioning) — otherwise this hook creates its own. */
  dialogRef?: RefObject<HTMLDivElement | null>;
}

export interface UseDialogResult {
  /** Attach as `ref` on the `.dialog` element. */
  dialogRef: RefObject<HTMLDivElement | null>;
  /** Set as the `.dialog` element's `aria-labelledby`, and as the `id` of its heading. */
  titleId: string;
}

/**
 * The shared a11y contract for every `.dialog-overlay > .dialog` (t/4901 — Design found the gaps
 * across #4436 New Chat, #4585 Chat bulk delete, Debate's bulk delete): role/aria-modal/
 * aria-labelledby, Esc-to-cancel, initial focus moved in, Tab trapped inside, and focus returned
 * to the opener on close.
 *
 * A hook rather than a `<Dialog>` wrapper component: existing dialogs vary too much in layout
 * (HelpDialog drags/resizes its own ref; NewDebateDialog already had its own focus
 * trap/Escape handling pre-t/4901) to force through one JSX shape. This gives every dialog the
 * SAME logic to attach to its own markup instead of each reinventing it.
 */
export function useDialog({ onCancel, closeOnEscape = true, initialFocusRef, dialogRef: externalRef }: UseDialogOptions): UseDialogResult {
  const ownRef = useRef<HTMLDivElement>(null);
  const dialogRef = externalRef ?? ownRef;
  const titleId = useId();
  // Read through a ref so the Esc listener (added once, below) always calls the LATEST
  // onCancel without needing to re-attach the listener on every render.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useFocusTrap(dialogRef, true);

  // Initial focus in, and return focus to the opener on close — bookends the dialog's whole
  // lifetime, so this deliberately runs once on mount/unmount only. Re-running it on an
  // initialFocusRef identity change (most callers pass a fresh ref object per render) would
  // yank focus back mid-dialog.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const target = initialFocusRef?.current
      ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ?? null;
    target?.focus();
    return () => { opener?.focus(); };
  }, []);

  useEffect(() => {
    if (!closeOnEscape) return;
    const el = dialogRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCancelRef.current();
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [closeOnEscape, dialogRef]);

  return { dialogRef, titleId };
}
