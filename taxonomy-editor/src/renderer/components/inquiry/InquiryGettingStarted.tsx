// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import {
  LibraryGettingStarted, useLibraryIntroDismissed,
} from '../shared/LibraryGettingStarted';

/**
 * Starter pool (t/4562; grown to 15 at t/4637 — PI request via parent t/4633, "15 examples per
 * tool, random subset shown per visit"). Each seeds the question field and opens the Ask screen
 * — a question is chosen before the run starts, not during it (mirrors Chat's starter pattern).
 *
 * t/4637 content rules: balanced across the three camps (none favoured, no leading wording), no
 * label longer than the pre-t/4637 baseline (67 chars, "Should frontier models be regulated like
 * critical infrastructure?"), no real private individuals, short and specific (never "Tell me
 * about AI"). Random 3-of-15 via shared/LibraryGettingStarted's pickExamples (t/4633, landed).
 */
export const QUESTION_STARTERS: readonly string[] = [
  'Is AI hype outrunning the evidence?',
  'What counts as an AI harm, and what would prove one?',
  'Should frontier models be regulated like critical infrastructure?',
  'Does open-weight AI reduce or increase systemic risk?',
  'What would a credible AI safety case look like?',
  'Is compute governance more effective than content rules?',
  'How should liability work when an AI system causes harm?',
  'What would meaningful international AI coordination require?',
  'Does faster AI deployment outweigh unverified risks?',
  'What evidence would change a skeptic’s mind about AI risk?',
  'Should AI labs publish their safety evaluations?',
  'Is alignment research keeping pace with capability gains?',
  'What makes an AI benchmark trustworthy?',
  'Should export controls slow AI proliferation?',
  'How do we judge whether an AI policy actually worked?',
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
      examplePool={QUESTION_STARTERS.map((question) => ({ label: question, value: question }))}
      exampleCount={3}
      onSelectChip={onPickStarter}
      hasNoItems={hasNoQuestions}
      hideAriaLabel="Hide question introduction"
      showLinkLabel="Show question tips"
    />
  );
}
