// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import {
  LibraryGettingStarted, useLibraryIntroDismissed,
} from '../shared/LibraryGettingStarted';

/**
 * Starter pool (t/4562; grown to 15 at t/4637 — PI request via parent t/4633, "15 examples per
 * tool, random subset shown per visit"). Each opens NewOpEdDialog prefilled with the topic — an
 * op-ed's topic is chosen before the set exists, not during it (mirrors Chat's starter pattern).
 *
 * t/4637 content rules: balanced across the three camps (none favoured, no leading wording), no
 * `text` (the displayed label) longer than the pre-t/4637 baseline (52 chars — `topic` has no
 * such cap, since it's never rendered as a chip), no real private individuals, short and
 * specific (never "Tell me about AI"). Random 3-of-15 via shared/LibraryGettingStarted's
 * pickExamples (t/4633, landed).
 */
export const OPED_STARTERS: readonly { text: string; topic: string }[] = [
  { text: 'Should AI labs face mandatory compute caps?', topic: 'Mandatory compute caps for frontier AI labs' },
  { text: 'Is open-weight AI a security risk or a safety net?', topic: 'Open-weight AI models: security risk or safety net' },
  { text: 'What would meaningful AI accountability look like?', topic: 'What meaningful accountability for AI harms would look like' },
  { text: 'Does faster AI deployment help or hurt safety?', topic: 'Whether faster AI deployment helps or hurts safety research' },
  { text: 'Should AI safety evaluations be made public?', topic: 'Whether AI labs should publish their safety evaluations' },
  { text: 'Is alignment keeping pace with AI capability?', topic: 'Whether alignment research is keeping pace with AI capability gains' },
  { text: 'What should trigger a pause in AI development?', topic: 'What conditions should trigger a pause in frontier AI development' },
  { text: 'Do export controls slow AI proliferation?', topic: 'Whether export controls effectively slow AI proliferation' },
  { text: 'Who is liable when an AI system causes harm?', topic: 'Who bears liability when an AI system causes real-world harm' },
  { text: 'Is international AI coordination realistic?', topic: 'Whether meaningful international AI coordination is realistic' },
  { text: 'Should AI benchmarks be independently audited?', topic: 'Whether AI benchmark claims need independent auditing' },
  { text: 'Does AI regulation help or hinder innovation?', topic: 'Whether AI regulation helps or hinders innovation' },
  { text: 'What should AI incident reporting require?', topic: 'What a meaningful AI incident-reporting requirement would include' },
  { text: 'Is AI risk assessment outrunning the evidence?', topic: 'Whether current AI risk assessments outrun the evidence' },
  { text: 'Should frontier AI need a safety license?', topic: 'Whether frontier AI models should require a safety license' },
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
      heading="See how each perspective argues a topic"
      why="Pick a topic and Op-Ed Studies drafts an op-ed in each perspective's voice (Accelerationist, Safetyist, Skeptic), grounded in this project's taxonomy, not the open web."
      examplePool={OPED_STARTERS.map((starter) => ({ label: starter.text, value: starter }))}
      exampleCount={3}
      onSelectChip={(starter) => onPickStarter(starter.topic)}
      hasNoItems={hasNoOpEds}
      hideAriaLabel="Hide op-ed introduction"
      showLinkLabel="Show op-ed tips"
    />
  );
}
