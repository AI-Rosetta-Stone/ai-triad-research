// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState } from 'react';
import type { SpeakerId } from '../../types/debate';
import { LibraryGettingStarted } from '../shared/LibraryGettingStarted';
import { pickExamples } from '../shared/pickExamples';

/** A starter chip's prefill: a motion (all three camps, `povers` omitted) or a camp pairing
 *  (`povers` set to exactly two). Opaque to LibraryGettingStarted — only this wrapper and
 *  NewDebateDialog (via onPickStarter) know the shape. */
export interface DebateStarter {
  topic: string;
  povers?: readonly SpeakerId[];
}

/**
 * Starter pool (t/4636, PI request via parent t/4633 — "15 examples per tool, random subset
 * shown per visit"). 6 three-way motions (`povers` omitted) + 3 per camp pairing, an even split
 * so no camp is over/under-represented (Accelerationist, Safetyist, Skeptic each appear in
 * exactly 6 of the 9 two-sided starters).
 *
 * Content rules (t/4636): AI policy/safety topics this project covers; balanced across camps, no
 * leading wording; no label longer than the pre-t/4636 baseline (78 chars, the original
 * "Accelerationist vs Safetyist: should labs self-regulate or face binding rules?"); no real
 * private individuals; short and specific.
 */
export const DEBATE_STARTERS: readonly { label: string; topic: string; povers?: readonly SpeakerId[] }[] = [
  { label: 'Should frontier AI development be paused for six months?', topic: 'Should frontier AI development be paused for six months?' },
  { label: 'Should AI companies be legally liable for harms their models cause?', topic: 'Should AI companies be legally liable for harms their models cause?' },
  { label: 'Should autonomous weapons systems be banned outright?', topic: 'Should autonomous weapons systems be banned outright?' },
  { label: 'Should AI-generated political ads be banned before elections?', topic: 'Should AI-generated political ads be banned before elections?' },
  { label: 'Should governments mandate interpretability research before deployment?', topic: 'Should governments mandate interpretability research before deployment?' },
  { label: 'Should AI labs disclose their training data sources?', topic: 'Should AI labs disclose their training data sources?' },
  { label: 'Accelerationist vs Safetyist: should labs self-regulate or face binding rules?', topic: 'Should AI labs self-regulate, or face binding government rules?', povers: ['accelerationist', 'safetyist'] },
  { label: 'Accelerationist vs Safetyist: does rapid deployment outweigh safety delays?', topic: 'Does rapid AI deployment outweigh the risks of safety delays?', povers: ['accelerationist', 'safetyist'] },
  { label: 'Accelerationist vs Safetyist: should open-source model weights be restricted?', topic: 'Should open-source AI model weights be restricted?', povers: ['accelerationist', 'safetyist'] },
  { label: 'Safetyist vs Skeptic: does alignment research reduce real risk?', topic: 'Does current alignment research meaningfully reduce AI risk?', povers: ['safetyist', 'skeptic'] },
  { label: 'Safetyist vs Skeptic: is existential AI risk overstated or urgent?', topic: 'Is the existential risk from AI overstated, or is it urgent?', povers: ['safetyist', 'skeptic'] },
  { label: 'Safetyist vs Skeptic: should labs fund independent safety audits?', topic: 'Should AI labs be required to fund independent safety audits?', povers: ['safetyist', 'skeptic'] },
  { label: 'Accelerationist vs Skeptic: is AI regulation premature?', topic: 'Is AI regulation premature given the technology’s current maturity?', povers: ['accelerationist', 'skeptic'] },
  { label: 'Accelerationist vs Skeptic: will AI mostly displace or create jobs?', topic: 'Will AI mostly displace jobs, or create new ones?', povers: ['accelerationist', 'skeptic'] },
  { label: 'Accelerationist vs Skeptic: should compute exports face export controls?', topic: 'Should advanced AI compute exports face strict export controls?', povers: ['accelerationist', 'skeptic'] },
];

const DISMISSED_KEY = 'taxonomy-editor-debate-intro-dismissed';

interface DebateGettingStartedProps {
  /** @deprecated t/4639: LibraryGettingStarted no longer branches on this. Kept so DebateTab's
   *  call site doesn't need to change. */
  hasNoDebates: boolean;
  onPickStarter: (topic: string, povers?: readonly SpeakerId[]) => void;
  /** Test seam (t/4636 AC4) — injects a seeded rng for deterministic chip selection. Production
   *  callers never pass this; defaults to Math.random, same as pickExamples itself. */
  rng?: () => number;
}

/** Compact getting-started card for the Debates library page (t/4563), thin wrapper over the
 *  shared LibraryGettingStarted (t/4561) — mirrors ChatGettingStarted.tsx exactly.
 *
 * t/4636: picks a random 4-of-15 once per mount via the shared pickExamples (t/4633), with
 * mustInclude guaranteeing at least one two-sided starter — the hint line below says "Pick a
 * two-sided starter above", so it must stay true every visit. Computed here (passed through
 * LibraryGettingStarted's `chips`, not `examplePool`/`exampleCount`) because the shared
 * component's pool path doesn't expose a mustInclude passthrough. */
export function DebateGettingStarted({ hasNoDebates, onPickStarter, rng = Math.random }: DebateGettingStartedProps) {
  void hasNoDebates;
  const [visibleStarters] = useState(() => pickExamples(DEBATE_STARTERS, 4, rng, s => !!s.povers));
  return (
    <LibraryGettingStarted
      storageKey={DISMISSED_KEY}
      heading="Argue it out across three perspectives"
      why="Accelerationist, Safetyist and Skeptic AI voices argue a motion you choose, grounded in this project's taxonomy, over structured rounds. Then an independent evaluation weighs the exchange."
      chips={visibleStarters.map((starter) => ({ label: starter.label, value: starter }))}
      onSelectChip={(starter) => onPickStarter(starter.topic, starter.povers)}
      hint={<>Debates use all three perspectives by default. Pick a two-sided starter above, or write your own motion and use <em>Change voices</em>.</>}
    />
  );
}
