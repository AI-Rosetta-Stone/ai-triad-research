// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4667: pure summary-text helpers for the Options disclosure toggle (`InquiryAskPanel.tsx`),
// extracted so the dialog component's own complexity doesn't absorb this (local/complexity-budget).

import type { TagSelection } from '@lib/schema/povTags';
import { tagSummaryLabel } from './InquiryTagPicker';

const TRUNCATE_AT = 32;

/** Design spec: each summary value truncates with an ellipsis at ~32 chars, full text in `title`. */
export function truncateLabel(s: string): string {
  return s.length > TRUNCATE_AT ? `${s.slice(0, TRUNCATE_AT - 1)}…` : s;
}

export function modelLabel(value: string, options: readonly { value: string; label: string }[]): string {
  return options.find(o => o.value === value)?.label ?? value;
}

/** "{model}" segment — just the debater model, or "Debaters {a} · Evaluator {b}" when they differ. */
export function modelSummarySegment(
  debaters: string, evaluator: string, options: readonly { value: string; label: string }[],
): string {
  return debaters === evaluator
    ? modelLabel(debaters, options)
    : `Debaters ${modelLabel(debaters, options)} · Evaluator ${modelLabel(evaluator, options)}`;
}

/** "{tag}" segment — the blocked reason (if any) wins over the normal tag/untagged text. */
export function tagSummarySegment(tagSelection: TagSelection | undefined, blockedReason: string | undefined): string {
  if (blockedReason) return `POV tag: ${blockedReason}`;
  if (!tagSelection) return 'Untagged';
  const label = tagSummaryLabel(tagSelection);
  return tagSelection.mode === 'prioritize' ? `${label} (prioritize)` : label;
}

/** Count of settings that differ from their defaults (no model override, no tag) — drives the
 *  change badge, mirroring New Debate's `diffCount`. t/4770: fidelity is hardwired to Quick and
 *  Debaters/Evaluator collapsed into one model, so this no longer reads fidelity and takes a
 *  single `model` override instead of two. */
export function optionsChangeCount(model: string | undefined, tagSelection: TagSelection | undefined): number {
  let n = 0;
  if (model) n++;
  if (tagSelection) n++;
  return n;
}
