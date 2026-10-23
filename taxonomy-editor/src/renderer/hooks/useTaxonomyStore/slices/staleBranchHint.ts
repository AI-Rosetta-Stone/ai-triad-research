// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4325 (child of t/4324): a session branch behind main with no unique commits can carry stale data that
// fails schema validation on nodes the user never edited. When that's the shape of a failed save, the
// banner names the stale branch instead of only listing schema errors, and every `save.validation` event
// carries `session_branch` and `behind_by` so a flight-recorder dump alone shows it.
//
// "Untouched" is by reference: the store's edits replace a node object (`{ ...n, ...updates }`), so a node
// whose object is the one loaded or last saved has not been edited since. Errs toward "touched" (a node
// rebuilt without a real change), which only falls back to the ordinary message.

import { getSyncStatus } from '../../../utils/syncApi';
import type { SituationBdiRefusal } from '../../../utils/situationBdiGate';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

/** Node objects as last loaded or saved. A WeakSet, so replaced nodes are collected. */
let baselineNodes = new WeakSet<object>();
/**
 * t/4439: the node as last loaded or saved, by id. reloadKeepingEdits uses it to tell "changed upstream"
 * and "deleted locally" apart from "never seen". Each mark overwrites the id, so old objects are released.
 */
let baselineById = new Map<string, object>();

/** Record these node objects as the loaded/saved baseline. */
export function markNodesAsBaseline(nodes: readonly object[] | null | undefined): void {
  for (const n of nodes ?? []) {
    baselineNodes.add(n);
    const id = (n as { id?: unknown }).id;
    if (typeof id === 'string') baselineById.set(id, n);
  }
}

/** Whether this node object is the loaded/saved one (not edited since). */
export const isBaselineNode = (n: object): boolean => baselineNodes.has(n);

/** The node as last loaded or saved for this id, or undefined if this editor has never loaded it. */
export const baselineNodeFor = (id: string): object | undefined => baselineById.get(id);

/** Test seam. */
export function __resetBaselineNodesForTests(): void { baselineNodes = new WeakSet(); baselineById = new Map(); }

/** The ids, of those given, whose current node object is the loaded/saved one (not edited since). */
export function untouchedNodeIds(ids: readonly string[], nodesById: ReadonlyMap<string, object>): string[] {
  return ids.filter(id => {
    const n = nodesById.get(id);
    return n !== undefined && baselineNodes.has(n);
  });
}

export interface BranchContext {
  session_branch: string | null;
  /** null when the server didn't say (sync off, filesystem mode, or the lookup failed or timed out). */
  behind_by: number | null;
}

// Shared by every caller that times out, so frozen: no caller can mutate the fallback for the next (Quality, #3525).
const UNKNOWN: BranchContext = Object.freeze({ session_branch: null, behind_by: null });
export const BRANCH_CONTEXT_TIMEOUT_MS = 3_000;

/**
 * The session branch and how far behind main it is, from `/api/sync/status`. Never throws (getSyncStatus
 * returns a disabled status on failure); gives up after a short timeout with a WARN, so a slow status call
 * never holds the save-failure message back.
 */
export async function readBranchContext(timeoutMs = BRANCH_CONTEXT_TIMEOUT_MS): Promise<BranchContext> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const status = await Promise.race([getSyncStatus(), timeout]);
  clearTimeout(timer);
  if (!status) {
    getGlobalRecorder()?.record({
      type: 'state.change', component: 'taxonomy-store', level: 'warn',
      message: 'sync status lookup timed out; save.validation carries no branch context',
      data: { timeout_ms: timeoutMs },
    });
    return UNKNOWN;
  }
  return { session_branch: status.session_branch ?? null, behind_by: typeof status.behind_by === 'number' ? status.behind_by : null };
}

/** What the save bar needs to name the stale branch and offer a resync. */
export interface StaleBranchHint {
  sessionBranch: string;
  behindBy: number;
  /** Nodes with errors that the user hasn't edited since load/save. */
  untouchedNodeIds: string[];
}

/** A hint when errors sit on untouched nodes and the session branch is behind main; otherwise null. */
export function staleBranchHint(ctx: BranchContext, untouched: readonly string[]): StaleBranchHint | null {
  if (untouched.length === 0 || !ctx.session_branch || !ctx.behind_by || ctx.behind_by <= 0) return null;
  return { sessionBranch: ctx.session_branch, behindBy: ctx.behind_by, untouchedNodeIds: [...untouched] };
}

type NodeFile = { nodes: readonly { id: string }[] } | null | undefined;

/** id -> current node object, across the given taxonomy files. */
export function nodesById(files: readonly NodeFile[]): Map<string, object> {
  const m = new Map<string, object>();
  for (const f of files) for (const n of f?.nodes ?? []) m.set(n.id, n);
  return m;
}

/** Record every node in these files as the baseline (after a load or a successful save). */
export function markFilesAsBaseline(files: readonly NodeFile[]): void {
  for (const f of files) markNodesAsBaseline(f?.nodes);
}

export interface ValidationFailureAssessment {
  ctx: BranchContext;
  untouched: string[];
  /** Errors on nodes the user did edit (or not attributable to an untouched node). */
  touchedErrorCount: number;
  hint: StaleBranchHint | null;
}

/**
 * Branch context for a failed save, and the stale-branch hint when the failure has that shape.
 * `errorNodeIds` holds one entry per error: the node it's on, or null when it isn't on a node.
 */
export async function assessValidationFailure(errorNodeIds: readonly (string | null)[], files: readonly NodeFile[]): Promise<ValidationFailureAssessment> {
  const ctx = await readBranchContext();
  const ids = [...new Set(errorNodeIds.filter((id): id is string => id !== null))];
  const untouched = untouchedNodeIds(ids, nodesById(files));
  const untouchedSet = new Set(untouched);
  const touchedErrorCount = errorNodeIds.filter(id => id === null || !untouchedSet.has(id)).length;
  return { ctx, untouched, touchedErrorCount, hint: staleBranchHint(ctx, untouched) };
}

/** The node id in a validation error key (`nodes.<id>.<field>`), or null. */
export const errorKeyNodeId = (key: string): string | null => /^nodes\.([^.]+)\./.exec(key)?.[1] ?? null;

/** The `save.validation` event fields this ticket adds. */
export const branchEventData = (v: ValidationFailureAssessment) =>
  ({ ...v.ctx, untouched_error_node_count: v.untouched.length, stale_branch_hint: v.hint !== null });

/** Schema-stage banner: the stale-branch message when the failure has that shape, else the usual one. */
export function schemaFailureMessage(v: ValidationFailureAssessment, bdi: SituationBdiRefusal, totalErrors: number): string {
  return v.hint ? staleBranchMessage(v.hint, v.touchedErrorCount) : saveFailureMessage(bdi, totalErrors);
}

/** Integrity-stage banner: the stale-branch message ahead of the integrity summary when it applies. */
export function integrityFailureMessage(v: ValidationFailureAssessment, summary: string): string {
  return v.hint ? `${staleBranchMessage(v.hint, v.touchedErrorCount)}\n${summary}` : summary;
}

/** The schema-stage message when the branch isn't the cause (moved from taxonomyDataSlice.ts, t/3888). */
export function saveFailureMessage(bdi: SituationBdiRefusal, totalErrors: number): string {
  if (!bdi.message) return 'Validation failed. Fix errors before saving.';
  const other = totalErrors - Object.keys(bdi.errors).length;
  return other > 0 ? `${bdi.message}\nAlso fix the ${other} other highlighted field${other === 1 ? '' : 's'}.` : bdi.message;
}

const plural =(n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The banner text for a stale-branch failure. `touchedErrorCount` = errors on nodes the user did edit. */
export function staleBranchMessage(hint: StaleBranchHint, touchedErrorCount: number): string {
  const ids = hint.untouchedNodeIds;
  const shown = ids.length <= 3 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')} + ${ids.length - 3} more`;
  const lines = [
    `Save blocked: validation failed on ${plural(ids.length, 'node')} you didn't edit (${shown}).`,
    `Your session branch ${hint.sessionBranch} is ${plural(hint.behindBy, 'commit')} behind main and likely carries stale data. Resync it with main, then save again.`,
  ];
  if (touchedErrorCount > 0) lines.push(`Also fix the ${plural(touchedErrorCount, 'highlighted field')} on nodes you edited.`);
  return lines.join('\n');
}
