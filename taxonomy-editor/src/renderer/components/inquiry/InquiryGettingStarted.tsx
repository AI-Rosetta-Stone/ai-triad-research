// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import {
  LibraryGettingStarted, useLibraryIntroDismissed,
} from '../shared/LibraryGettingStarted';

/** Starter chips (t/4562): each seeds the question field and opens the Ask screen — a question
 *  is chosen before the run starts, not during it (mirrors Chat's starter pattern). */
export const QUESTION_STARTERS: readonly string[] = [
  'Is AI hype outrunning the evidence?',
  'What counts as an AI harm, and what would prove one?',
  'Should frontier models be regulated like critical infrastructure?',
];

const DISMISSED_KEY = 'taxonomy-editor-inquiry-intro-dismissed';

export function useInquiryIntroDismissed(): [boolean, (value: boolean) => void] {
  return useLibraryIntroDismissed(DISMISSED_KEY);
}

interface InquiryGettingStartedProps {
  /** Shown regardless of dismissal when true — a first-time user with no questions yet needs
   *  this most (mirrors Chat's hasNoChats rule). */
  hasNoQuestions: boolean;
  onPickStarter: (question: string) => void;
}

/** Compact getting-started card for the Ask a Question library page (t/4562). Rendered via
 *  LibraryListPage's `intro` slot, between the header row and the My/Community tabs. */
export function InquiryGettingStarted({ hasNoQuestions, onPickStarter }: InquiryGettingStartedProps) {
  return (
    <LibraryGettingStarted
      storageKey={DISMISSED_KEY}
      heading="Get a reasoned answer, not a search result"
      why="Ask a question and the three perspectives (Accelerationist, Safetyist, Skeptic) debate it, grounded in this project's taxonomy, with their points of agreement and disagreement called out."
      chips={QUESTION_STARTERS.map((question) => ({ label: question, value: question }))}
      onSelectChip={onPickStarter}
      hasNoItems={hasNoQuestions}
      hideAriaLabel="Hide question introduction"
      showLinkLabel="Show question tips"
    />
  );
}
