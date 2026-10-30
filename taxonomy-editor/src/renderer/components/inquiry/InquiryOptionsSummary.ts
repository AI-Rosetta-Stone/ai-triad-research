// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4667: pure summary-text helpers for the Options disclosure toggle (`InquiryAskPanel.tsx`),
// extracted so the dialog component's own complexity doesn't absorb this (local/complexity-budget).

import type { Fidelity } from '@lib/inquiry';
import type { TagSelection } from '@lib/schema/povTags';
import { FIDELITY_LABELS } from './inquiryDisplay';
import { tagSummaryLabel } from './InquiryTagPicker';
import { DEFAULT_FIDELITY } from '../../hooks/useInquiryStore';

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

export function fidelitySummarySegment(fidelity: Fidelity): string {
  return FIDELITY_LABELS[fidelity];
}

/** Count of settings that differ from their defaults (fidelity DEFAULT_FIDELITY, no model
 *  overrides, no tag) — drives the change badge, mirroring New Debate's `diffCount`. */
export function optionsChangeCount(
  fidelity: Fidelity, debaterModel: string | undefined, evaluatorModel: string | undefined, tagSelection: TagSelection | undefined,
): number {
  let n = 0;
  if (fidelity !== DEFAULT_FIDELITY) n++;
  if (debaterModel) n++;
  if (evaluatorModel) n++;
  if (tagSelection) n++;
  return n;
}
