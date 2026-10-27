// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { ChatMode } from '../../types/chat';
import {
  LibraryGettingStarted, useLibraryIntroDismissed,
} from '../shared/LibraryGettingStarted';

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
  return (
    <LibraryGettingStarted
      storageKey={DISMISSED_KEY}
      heading="Ask anything about AI policy & safety"
      why="Pick a perspective (Accelerationist, Safetyist or Skeptic) and talk it through. Answers draw on this project’s research, its claims, debates and sources, not the open web."
      chips={CHAT_STARTERS.map((starter) => ({ label: starter.text, value: starter }))}
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
