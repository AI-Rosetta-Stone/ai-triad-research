// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import {
  LibraryGettingStarted, useLibraryIntroDismissed,
} from '../shared/LibraryGettingStarted';

/** Starter chips (t/4562): each opens NewOpEdDialog prefilled with the topic — an op-ed's
 *  topic is chosen before the set exists, not during it (mirrors Chat's starter pattern). */
export const OPED_STARTERS: readonly { text: string; topic: string }[] = [
  { text: 'Should AI labs face mandatory compute caps?', topic: 'Mandatory compute caps for frontier AI labs' },
  { text: 'Is open-weight AI a security risk or a safety net?', topic: 'Open-weight AI models: security risk or safety net' },
  { text: 'What would meaningful AI accountability look like?', topic: 'What meaningful accountability for AI harms would look like' },
];

const DISMISSED_KEY = 'taxonomy-editor-oped-intro-dismissed';

export function useOpEdIntroDismissed(): [boolean, (value: boolean) => void] {
  return useLibraryIntroDismissed(DISMISSED_KEY);
}

interface OpEdGettingStartedProps {
  /** Shown regardless of dismissal when true — a first-time user with no op-eds yet needs this
   *  most (mirrors Chat's hasNoChats rule). */
  hasNoOpEds: boolean;
  onPickStarter: (topic: string) => void;
}

/** Compact getting-started card for the Op-Ed Studies library page (t/4562). Rendered via
 *  LibraryListPage's `intro` slot, between the header row and the My/Community tabs. */
export function OpEdGettingStarted({ hasNoOpEds, onPickStarter }: OpEdGettingStartedProps) {
  return (
    <LibraryGettingStarted
      storageKey={DISMISSED_KEY}
      heading="See how the three camps argue a topic"
      why="Pick a topic and Op-Ed Studies drafts an op-ed in each camp's voice — Accelerationist, Safetyist, Skeptic — grounded in this project's taxonomy, not the open web."
      chips={OPED_STARTERS.map((starter) => ({ label: starter.text, value: starter }))}
      onSelectChip={(starter) => onPickStarter(starter.topic)}
      hasNoItems={hasNoOpEds}
      hideAriaLabel="Hide op-ed introduction"
      showLinkLabel="Show op-ed tips"
    />
  );
}
