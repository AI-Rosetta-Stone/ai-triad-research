// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import './LibraryGettingStarted.css';

function readDismissed(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) === '1';
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'library-getting-started', level: 'debug',
      message: 'Failed to read intro dismissal from localStorage',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return false;
  }
}

function writeDismissed(storageKey: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(storageKey, '1');
    else localStorage.removeItem(storageKey);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'library-getting-started', level: 'debug',
      message: 'Failed to save intro dismissal to localStorage',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** Per-viewer dismissal, persisted in localStorage under a tool-specific key (wrapped; falls
 *  back to "shown" on any storage failure — a private window, cleared/blocked site data, etc.).
 *  Generalized from Chat's useChatIntroDismissed (t/4536 round 3) for every library-page tool
 *  that wants its own getting-started card (t/4561). */
export function useLibraryIntroDismissed(storageKey: string): [boolean, (value: boolean) => void] {
  const [dismissed, setDismissedState] = useState(() => readDismissed(storageKey));
  const setDismissed = useCallback((value: boolean) => {
    setDismissedState(value);
    writeDismissed(storageKey, value);
  }, [storageKey]);
  return [dismissed, setDismissed];
}

export interface LibraryGettingStartedChip<T> {
  label: string;
  value: T;
}

export interface LibraryGettingStartedProps<T> {
  /** Per-tool localStorage key for the Hide dismissal — each adopting tool gets its own. */
  storageKey: string;
  heading: string;
  /** One-line why — what this tool does and where its answers come from. */
  why: string;
  chips: LibraryGettingStartedChip<T>[];
  /** The host opens its own New dialog prefilled with the chip's value. */
  onSelectChip: (value: T) => void;
  /** Optional hint line below the chips (Chat's mode legend is bolded inline text, hence ReactNode). */
  hint?: ReactNode;
  /** Shown regardless of dismissal when true — a first-time user with nothing yet needs this most. */
  hasNoItems: boolean;
  /** aria-label for the Hide button — tool-specific, e.g. "Hide chat introduction". */
  hideAriaLabel: string;
  /** Label for the collapsed "show again" link. Default: "Show tips". */
  showLinkLabel?: string;
}

/** Compact getting-started card for a library-page tool (Chat, Op-Ed Studies, Ask a Question,
 *  Debates — t/4561, generalized from Chat's ChatGettingStarted, t/4536 round 3). Rendered via
 *  LibraryListPage's `intro` slot, between the header row and the My/Community tabs. No entrance
 *  animation — nothing here to gate behind reduced-motion. */
export function LibraryGettingStarted<T>({
  storageKey, heading, why, chips, onSelectChip, hint, hasNoItems, hideAriaLabel, showLinkLabel = 'Show tips',
}: LibraryGettingStartedProps<T>) {
  const [dismissed, setDismissed] = useLibraryIntroDismissed(storageKey);
  const showLinkRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // t/4536#8 (non-blocking fold): focus follows the state change instead of dropping to BODY.
  const prevDismissed = useRef(dismissed);
  useEffect(() => {
    if (prevDismissed.current === dismissed) return;
    prevDismissed.current = dismissed;
    if (dismissed) showLinkRef.current?.focus();
    else headingRef.current?.focus();
  }, [dismissed]);

  if (dismissed && !hasNoItems) {
    return (
      <button
        ref={showLinkRef}
        type="button"
        className="lib-getting-started-show-link"
        onClick={() => setDismissed(false)}
      >
        {showLinkLabel}
      </button>
    );
  }

  return (
    <div className="lib-getting-started" role="region" aria-label="Getting started">
      {/* t/4536#8 (non-blocking fold): heading before Hide in DOM order, so a screen reader
          announces the card's subject before its dismiss control. CSS keeps Hide top-right. */}
      <h2 ref={headingRef} tabIndex={-1} className="lib-getting-started-heading">
        {heading}
      </h2>
      <button
        type="button"
        className="lib-getting-started-hide"
        aria-label={hideAriaLabel}
        onClick={() => setDismissed(true)}
      >
        Hide
      </button>
      <p className="lib-getting-started-why">{why}</p>
      <div className="lib-getting-started-chips">
        {chips.map(({ label, value }) => (
          <button
            key={label}
            type="button"
            className="lib-getting-started-chip"
            onClick={() => onSelectChip(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {hint && <p className="lib-getting-started-hint">{hint}</p>}
    </div>
  );
}
