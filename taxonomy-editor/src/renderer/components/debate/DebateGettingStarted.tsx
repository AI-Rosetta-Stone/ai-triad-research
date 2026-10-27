// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { SpeakerId } from '../../types/debate';
import { LibraryGettingStarted } from '../shared/LibraryGettingStarted';

/** A starter chip's prefill: a motion (all three camps, `povers` omitted) or a camp pairing
 *  (`povers` set to exactly two). Opaque to LibraryGettingStarted — only this wrapper and
 *  NewDebateDialog (via onPickStarter) know the shape. */
export interface DebateStarter {
  topic: string;
  povers?: readonly SpeakerId[];
}

const DEBATE_STARTERS: readonly { label: string; topic: string; povers?: readonly SpeakerId[] }[] = [
  { label: 'Should frontier AI development be paused for six months?', topic: 'Should frontier AI development be paused for six months?' },
  { label: 'Accelerationist vs Safetyist: should labs self-regulate or face binding rules?', topic: 'Should AI labs self-regulate, or face binding government rules?', povers: ['accelerationist', 'safetyist'] },
  { label: 'Safetyist vs Skeptic: does alignment research reduce real risk?', topic: 'Does current alignment research meaningfully reduce AI risk?', povers: ['safetyist', 'skeptic'] },
  { label: 'Accelerationist vs Skeptic: is AI regulation premature?', topic: 'Is AI regulation premature given the technology’s current maturity?', povers: ['accelerationist', 'skeptic'] },
];

const DISMISSED_KEY = 'taxonomy-editor-debate-intro-dismissed';

interface DebateGettingStartedProps {
  /** Shown regardless of dismissal when true — a first-time user with no debates yet needs this most. */
  hasNoDebates: boolean;
  onPickStarter: (topic: string, povers?: readonly SpeakerId[]) => void;
}

/** Compact getting-started card for the Debates library page (t/4563), thin wrapper over the
 *  shared LibraryGettingStarted (t/4561) — mirrors ChatGettingStarted.tsx exactly. */
export function DebateGettingStarted({ hasNoDebates, onPickStarter }: DebateGettingStartedProps) {
  return (
    <LibraryGettingStarted
      storageKey={DISMISSED_KEY}
      heading="Argue it out across three perspectives"
      why="Three AI personas — Accelerationist, Safetyist, Skeptic — argue a motion drawn from this project's taxonomy, through structured rounds toward a verdict."
      chips={DEBATE_STARTERS.map((starter) => ({ label: starter.label, value: starter }))}
      onSelectChip={(starter) => onPickStarter(starter.topic, starter.povers)}
      hint="Debates use all three camps by default — pick a two-camp starter above, or write your own motion and choose debaters directly."
      hasNoItems={hasNoDebates}
      hideAriaLabel="Hide debate introduction"
      showLinkLabel="Show debate tips"
    />
  );
}
