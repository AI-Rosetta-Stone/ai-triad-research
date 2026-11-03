// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState } from 'react';
import type { ChatMode } from '../../types/chat';
import {
  LibraryGettingStarted, useLibraryIntroDismissed,
} from '../shared/LibraryGettingStarted';
import { pickExamples } from '../shared/pickExamples';

/**
 * Starter pool (t/4536 round 3, t/4536#4; grown to 15 and spread across the three modes and
 * camps at t/4635, PI request via parent t/4633 — "15 examples per tool, random subset shown
 * per visit"). Each opens NewChatDialog prefilled with its mode + topic rather than a composer —
 * a chat's mode/POVer/topic are chosen before a conversation exists, not during one.
 *
 * t/4635 content rules: balanced across the three camps, no leading wording, no label longer
 * than the pre-t/4635 baseline (47 chars, "Strongest evidence for the Accelerationist case"),
 * no real private individuals, short and specific (never "Tell me about AI").
 */
export const CHAT_STARTERS: readonly { text: string; mode: ChatMode }[] = [
  { text: 'How would a Safetyist see compute caps?', mode: 'inform' },
  { text: 'Strongest evidence for the Accelerationist case', mode: 'inform' },
  { text: 'Brainstorm counterarguments to my position', mode: 'brainstorm' },
  { text: 'Work through a policy decision', mode: 'decide' },
  { text: 'How would a Skeptic read AI benchmark claims?', mode: 'inform' },
  { text: 'Brainstorm how to falsify an AI risk claim', mode: 'brainstorm' },
  { text: 'Decide: open-source or closed frontier models?', mode: 'decide' },
  { text: 'How would an Accelerationist weigh AI risk?', mode: 'inform' },
  { text: 'Brainstorm a case for slowing deployment', mode: 'brainstorm' },
  { text: 'Decide: regulate frontier models now or wait?', mode: 'decide' },
  { text: 'What proof would satisfy a Skeptic?', mode: 'inform' },
  { text: 'Brainstorm an Accelerationist pitch for open AI', mode: 'brainstorm' },
  { text: 'Decide: fund safety or capability research?', mode: 'decide' },
  { text: 'How would a Safetyist assess open-source risk?', mode: 'inform' },
  { text: 'Brainstorm how a Skeptic tests AI safety claims', mode: 'brainstorm' },
];

const DISMISSED_KEY = 'taxonomy-editor-chat-intro-dismissed';

/** Thin Chat-specific wrapper over the shared LibraryGettingStarted (t/4561). Unchanged storage
 *  key — an existing user's prior dismissal survives this refactor. */
export function useChatIntroDismissed(): [boolean, (value: boolean) => void] {
  return useLibraryIntroDismissed(DISMISSED_KEY);
}

interface ChatGettingStartedProps {
  /** Shown regardless of dismissal when true — a first-time user with no chats yet needs this
   *  most (t/4536#4 point 5). */
  hasNoChats: boolean;
  onPickStarter: (mode: ChatMode, topic: string) => void;
}

/** Compact getting-started card for the Chats library page (t/4536 round 3, t/4536#4; PI request
 *  p/351#30). Rendered via LibraryListPage's `intro` slot, between the header row and the
 *  My/Community tabs. Thin wrapper over the shared LibraryGettingStarted (t/4561) — Chat's exact
 *  copy/chips/hint, generalized mechanics. */
export function ChatGettingStarted({ hasNoChats, onPickStarter }: ChatGettingStartedProps) {
  // t/4635: random 4-of-15 per mount, guaranteeing at least one non-inform starter (AC2) — the
  // hint line explains all three modes, so a rotation that happened to land all-inform would
  // silently waste it. LibraryGettingStartedProps has no mustInclude passthrough yet (t/4633
  // didn't need one for Ask-a-Question/Op-Ed's mode-less pools), so this calls the same
  // pickExamples helper directly rather than through examplePool/exampleCount, and passes the
  // already-picked result via the legacy `chips` prop. useState (not useMemo) keeps the pick
  // stable across re-renders of this mount, same guarantee LibraryGettingStarted's own internal
  // examplePool path provides.
  const [pickedStarters] = useState(() => pickExamples(CHAT_STARTERS, 4, Math.random, s => s.mode !== 'inform'));
  return (
    <LibraryGettingStarted
      storageKey={DISMISSED_KEY}
      heading="Ask anything about AI policy & safety"
      why="Pick a perspective (Accelerationist, Safetyist or Skeptic) and talk it through. Answers draw on this project’s research, its claims, debates and sources, not the open web."
      chips={pickedStarters.map((starter) => ({ label: starter.text, value: starter }))}
      onSelectChip={(starter) => onPickStarter(starter.mode, starter.text)}
      hint={
        <>
          Every chat has a mode: <strong>Brainstorm</strong> to explore, <strong>Inform</strong> to learn,{' '}
          <strong>Decide</strong> to work through a choice.
        </>
      }
      hasNoItems={hasNoChats}
      hideAriaLabel="Hide chat introduction"
      showLinkLabel="Show chat tips"
    />
  );
}
