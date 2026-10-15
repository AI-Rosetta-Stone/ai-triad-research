// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4214 R-5 (spec t/4211 §6, M2): save each reflection decision into the debate file. requestReflections
// snapshots the results into the reflection transcript entry (`metadata.reflection_results`) once, at request
// time, and later applies and dismissals only changed the in-memory `reflections`. So every stored edit read
// `pending` and the override rate could not be measured. These pure helpers return the debate with the decision
// written into that snapshot; the slice then saves it.

import type { DebateSession } from '@lib/debate/types';
import type { ReflectionDecision, ReflectionResult } from '../types';

type Target = { kind: 'edit'; index: number } | { kind: 'proposal'; index: number };

/** The most recent reflection entry whose snapshot has a result for `pover` (a debate can be reflected on twice). */
function findSnapshotEntry(debate: DebateSession, pover: string): number {
  for (let i = debate.transcript.length - 1; i >= 0; i--) {
    const entry = debate.transcript[i];
    if (entry.type !== 'reflection') continue;
    const results = (entry.metadata as { reflection_results?: ReflectionResult[] } | undefined)?.reflection_results;
    if (results?.some(r => r.pover === pover)) return i;
  }
  return -1;
}

function decide(result: ReflectionResult, target: Target, decision: ReflectionDecision): ReflectionResult {
  if (target.kind === 'proposal') {
    return { ...result, proposal_decisions: { ...result.proposal_decisions, [target.index]: decision } };
  }
  const status = decision.outcome === 'dismissed' ? 'dismissed' as const : 'approved' as const;
  return { ...result, edits: result.edits.map((e, i) => (i === target.index ? { ...e, status, decision } : e)) };
}

/**
 * The debate with `decision` recorded on `pover`'s edit or proposal in the reflection snapshot, or `null` when
 * there is no snapshot to write to (for example a debate from before reflections were snapshotted). The caller
 * logs that case; the in-memory decision still stands.
 */
export function withReflectionDecision(
  debate: DebateSession, pover: string, target: Target, decision: ReflectionDecision,
): DebateSession | null {
  const at = findSnapshotEntry(debate, pover);
  if (at < 0) return null;
  const entry = debate.transcript[at];
  const meta = entry.metadata as { reflection_results: ReflectionResult[] };
  const results = meta.reflection_results.map(r => (r.pover === pover ? decide(r, target, decision) : r));
  const transcript = debate.transcript.map((e, i) => (i === at ? { ...e, metadata: { ...meta, reflection_results: results } } : e));
  return { ...debate, transcript };
}

/** `applied` unless a gate was overridden; `overrides` lists which, for the M2 override rate. */
export function appliedDecision(overrides: ReflectionDecision['overrides']): ReflectionDecision {
  return { outcome: overrides && overrides.length > 0 ? 'overridden' : 'applied', at: new Date().toISOString(), ...(overrides && overrides.length > 0 ? { overrides } : {}) };
}

export function dismissedDecision(): ReflectionDecision {
  return { outcome: 'dismissed', at: new Date().toISOString() };
}
