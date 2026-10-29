// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useCallback, useState, type ReactNode } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { pickExamples } from './pickExamples';
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
  /** Per-tool localStorage key for the collapse persistence — each adopting tool gets its own. */
  storageKey: string;
  heading: string;
  /** One-line why — what this tool does and where its answers come from. */
  why: string;
  /** The chips to show, already picked by the caller. Mutually exclusive with examplePool —
   *  when examplePool is given, chips is ignored. Kept for callers that haven't migrated to
   *  the random-subset pool yet (t/4633 adds examplePool without breaking this). */
  chips?: LibraryGettingStartedChip<T>[];
  /** t/4633: the full candidate pool (e.g. 15 starters). When given (together with
   *  exampleCount), the card picks a random, non-repeating subset via pickExamples ONCE per
   *  mount — re-renders don't reshuffle what the user is reading. */
  examplePool?: LibraryGettingStartedChip<T>[];
  /** How many chips to show when using examplePool. Required together with examplePool;
   *  ignored otherwise. */
  exampleCount?: number;
  /** The host opens its own New dialog prefilled with the chip's value. */
  onSelectChip: (value: T) => void;
  /** Optional hint line below the chips (Chat's mode legend is bolded inline text, hence ReactNode). */
  hint?: ReactNode;
  /** @deprecated t/4639: no longer changes rendering — an explicit collapse/expand always wins
   *  over this. Kept optional, accepted-but-unused, so existing callers don't need to drop it
   *  from their call sites. Design's t/4639#1 spec: "absent (never chosen) → expanded, for every
   *  user" already covers the "no items yet" case this was meant for. */
  hasNoItems?: boolean;
  /** @deprecated t/4639: replaced by the accordion toggle's own fixed "Hide examples"/"Show
   *  examples" label (Design's spec — one label pair across all four tools). Kept optional so
   *  existing callers don't need to drop it. */
  hideAriaLabel?: string;
  /** @deprecated t/4639: the separate show-link is gone (replaced by the always-visible toggle
   *  strip). Kept optional so existing callers don't need to drop it. */
  showLinkLabel?: string;
}

/** Compact getting-started card for a library-page tool (Chat, Op-Ed Studies, Ask a Question,
 *  Debates — t/4561, generalized from Chat's ChatGettingStarted, t/4536 round 3). Rendered via
 *  LibraryListPage's `intro` slot, between the header row and the My/Community tabs. No entrance
 *  animation — nothing here to gate behind reduced-motion. */
export function LibraryGettingStarted<T>({
  storageKey, heading, why, chips, examplePool, exampleCount, onSelectChip, hint,
}: LibraryGettingStartedProps<T>) {
  // t/4639: `dismissed` persistence is unchanged (same storageKey, same '1'/absent values) — it
  // now drives an accordion's collapsed state instead of gating a full unmount. An explicit
  // toggle always wins; there is no hasNoItems override anymore (Design's t/4639#1 spec: "absent
  // → expanded, for every user" already covers the "no items yet" case that override was for).
  const [dismissed, setDismissed] = useLibraryIntroDismissed(storageKey);
  const expanded = !dismissed;
  const headingId = `lib-getting-started-heading-${storageKey}`;
  const bodyId = `lib-getting-started-body-${storageKey}`;

  // t/4633: computed once per mount (lazy useState initializer, not useMemo — no dependency
  // array to accidentally re-trigger on) so re-renders — including a collapse/expand toggle —
  // never reshuffle what's on screen. Only consulted when the caller supplies
  // examplePool+exampleCount; legacy callers passing `chips` directly are untouched (chips is
  // re-read fresh every render, exactly as before).
  const [pickedChips] = useState<LibraryGettingStartedChip<T>[] | null>(() =>
    examplePool && exampleCount != null ? pickExamples(examplePool, exampleCount) : null,
  );
  const visibleChips = pickedChips ?? chips ?? [];

  return (
    <div className="lib-getting-started" data-expanded={expanded} role="region" aria-labelledby={headingId}>
      <h2 className="lib-getting-started-heading" id={headingId}>
        <button
          type="button"
          className="lib-getting-started-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setDismissed(expanded)}
        >
          <span className="lib-getting-started-title">{heading}</span>
          <span className="lib-getting-started-toggle-label">
            {expanded ? 'Hide examples' : 'Show examples'}
            <svg className="lib-getting-started-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      </h2>
      <div id={bodyId} className="lib-getting-started-body" hidden={!expanded}>
        <p className="lib-getting-started-why">{why}</p>
        <div className="lib-getting-started-chips">
          {visibleChips.map(({ label, value }) => (
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
    </div>
  );
}
