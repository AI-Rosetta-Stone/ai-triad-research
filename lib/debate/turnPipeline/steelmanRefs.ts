// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/388: plan-level steelman references. The plan records the ids it was offered, and an ATTACK tag
// is kept only when its id was offered. A tag outside the offered list is stripped, with a WARN.

import type { OpeningPlanWorkProduct } from '../types/pipeline.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';

const ATTACK_TAG = /^ATTACK \[([^\]]+)\]:/;

/** The ids offered to a plan, from the pipeline input. */
export function offeredIdsOf(input: { steelmanRefsOffered?: { id: string }[] }): string[] {
  return (input.steelmanRefsOffered ?? []).map(r => r.id);
}

/** Apply the offered list to a plan: record the offered ids, and strip any ATTACK tag not among them. */
export function applyPlanSteelmanRefs(plan: OpeningPlanWorkProduct | undefined, offeredIds: string[], debateId?: string): void {
  if (!plan) return;
  plan.steelman_refs_offered = offeredIds;
  if (!Array.isArray(plan.anticipated_challenges)) return;
  const allowed = new Set(offeredIds);
  plan.anticipated_challenges = plan.anticipated_challenges.map(c => {
    const m = typeof c === 'string' ? ATTACK_TAG.exec(c) : null;
    if (!m || allowed.has(m[1])) return c;
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'turn-pipeline', level: 'warn', debate_id: debateId,
      message: `plan ATTACK tag [${m[1]}] is not in steelman_refs_offered; tag stripped (t/388)`,
    });
    return c.replace(ATTACK_TAG, 'ATTACK:');
  });
}
