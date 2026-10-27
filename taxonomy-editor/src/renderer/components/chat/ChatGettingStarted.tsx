// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { ChatMode } from '../../types/chat';
import './ChatGettingStarted.css';

/** Starter chips (t/4536 round 3, t/4536#4): each opens NewChatDialog prefilled with its mode +
 *  topic rather than a composer — a chat's mode/POVer/topic are chosen before a conversation
 *  exists, not during one. */
export const CHAT_STARTERS: readonly { text: string; mode: ChatMode }[] = [
  { text: 'How would a Safetyist see compute caps?', mode: 'inform' },
  { text: 'Strongest evidence for the Accelerationist case', mode: 'inform' },
  { text: 'Brainstorm counterarguments to my position', mode: 'brainstorm' },
  { text: 'Work through a policy decision', mode: 'decide' },
];

const DISMISSED_KEY = 'taxonomy-editor-chat-intro-dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'chat-getting-started', level: 'debug',
      message: 'Failed to read chat-intro dismissal from localStorage',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return false;
  }
}

function writeDismissed(value: boolean): void {
  try {
    if (value) localStorage.setItem(DISMISSED_KEY, '1');
    else localStorage.removeItem(DISMISSED_KEY);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'chat-getting-started', level: 'debug',
      message: 'Failed to save chat-intro dismissal to localStorage',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** Per-viewer dismissal, persisted in localStorage (wrapped; falls back to "shown" on any
 *  storage failure — a private window, cleared/blocked site data, etc.). */
export function useChatIntroDismissed(): [boolean, (value: boolean) => void] {
  const [dismissed, setDismissedState] = useState(readDismissed);
  const setDismissed = useCallback((value: boolean) => {
    setDismissedState(value);
    writeDismissed(value);
  }, []);
  return [dismissed, setDismissed];
}

interface ChatGettingStartedProps {
  /** Shown regardless of dismissal when true — a first-time user with no chats yet needs this
   *  most (t/4536#4 point 5). */
  hasNoChats: boolean;
  onPickStarter: (mode: ChatMode, topic: string) => void;
}

/** Compact getting-started card for the Chats library page (t/4536 round 3, t/4536#4; PI request
 *  p/351#30). Rendered via LibraryListPage's `intro` slot, between the header row and the
 *  My/Community tabs. No entrance animation — nothing here to gate behind reduced-motion. */
export function ChatGettingStarted({ hasNoChats, onPickStarter }: ChatGettingStartedProps) {
  const [dismissed, setDismissed] = useChatIntroDismissed();
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

  if (dismissed && !hasNoChats) {
    return (
      <button
        ref={showLinkRef}
        type="button"
        className="chat-getting-started-show-link"
        onClick={() => setDismissed(false)}
      >
        Show chat tips
      </button>
    );
  }

  return (
    <div className="chat-getting-started" role="region" aria-label="Getting started">
      {/* t/4536#8 (non-blocking fold): heading before Hide in DOM order, so a screen reader
          announces the card's subject before its dismiss control. CSS keeps Hide top-right. */}
      <h2 ref={headingRef} tabIndex={-1} className="chat-getting-started-heading">
        Ask anything about AI policy &amp; safety
      </h2>
      <button
        type="button"
        className="chat-getting-started-hide"
        aria-label="Hide chat introduction"
        onClick={() => setDismissed(true)}
      >
        Hide
      </button>
      <p className="chat-getting-started-why">
        Pick a perspective (Accelerationist, Safetyist or Skeptic) and talk it through. Answers
        draw on this project&rsquo;s research, its claims, debates and sources, not the open web.
      </p>
      <div className="chat-getting-started-chips">
        {CHAT_STARTERS.map(({ text, mode }) => (
          <button
            key={text}
            type="button"
            className="chat-getting-started-chip"
            onClick={() => onPickStarter(mode, text)}
          >
            {text}
          </button>
        ))}
      </div>
      <p className="chat-getting-started-mode-hint">
        Every chat has a mode: <strong>Brainstorm</strong> to explore, <strong>Inform</strong> to learn,{' '}
        <strong>Decide</strong> to work through a choice.
      </p>
    </div>
  );
}
