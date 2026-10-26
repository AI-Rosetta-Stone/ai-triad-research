// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { ChatMode } from '../../types/chat';
import './ChatGettingStarted.css';

/** Starter chips (t/4536 revised spec, p/686#10): each opens NewChatDialog prefilled with its
 *  mode + topic rather than the composer — a chat's mode/POVer/topic are chosen before a
 *  conversation exists, not during one. */
export const CHAT_STARTERS: readonly { text: string; mode: ChatMode }[] = [
  { text: 'How would a Safetyist see compute caps?', mode: 'inform' },
  { text: 'Strongest evidence for the Accelerationist case', mode: 'inform' },
  { text: 'Brainstorm counterarguments to my position', mode: 'brainstorm' },
  { text: 'Work through a policy decision', mode: 'decide' },
];

interface ChatGettingStartedProps {
  onPickStarter: (mode: ChatMode, topic: string) => void;
  onNewChat: () => void;
}

/** "No chat selected" getting-started region (t/4536; PI request p/351#30; re-targeted from the
 *  conversation pane to here at p/686#10, since a chat's mode/POVer/topic make its auto-generated
 *  opening real content, not filler). No entrance animation — nothing here to gate behind
 *  reduced-motion. */
export function ChatGettingStarted({ onPickStarter, onNewChat }: ChatGettingStartedProps) {
  return (
    <div className="chat-getting-started" role="region" aria-label="Getting started">
      <h2 className="chat-getting-started-heading">Ask anything about AI policy &amp; safety</h2>
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
        Pick a mode above: <strong>Brainstorm</strong> to explore, <strong>Inform</strong> to learn,{' '}
        <strong>Decide</strong> to work through a choice.
      </p>
      <button type="button" className="btn btn-primary chat-getting-started-new" onClick={onNewChat}>
        + New chat
      </button>
    </div>
  );
}
