// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4439: reload the taxonomy from the (now rebased) session branch WITHOUT losing unsaved edits. Used by the
// save-bar Resync (t/4346): a save that failed on stale untouched nodes (t/4325) should succeed once those are
// refreshed, while the user's own edits stay exactly as they are. Design approved by Quality, t/4439#1-#3.
//
// Per node, against the load/save baseline (staleBranchHint.ts):
//   local untouched + upstream present  -> fresh
//   local untouched + upstream gone     -> dropped (deleted upstream)
//   local edited    + any               -> local kept (conflict if upstream changed it too)
//   new locally                         -> local kept, after its nearest preceding neighbour in the result
//   deleted locally + upstream present  -> stays deleted (conflict if upstream changed it)
//   new upstream                        -> added
// The user's local change always wins; a conflict is reported, never silently resolved.

import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { baselineNodeFor, isBaselineNode, markFilesAsBaseline } from './staleBranchHint';
import { api } from '@bridge';
import { POV_KEYS } from '@lib/debate/types';
import { mapErrorToUserMessage } from '../../../utils/errorMessages';
import { coerceSituationDivergence } from '../../../bridge/coerceSituationDivergence';
import { buildPovTagBaseline } from '../../../utils/povTagGate';
import { buildSituationBaseline } from '../../../utils/situationBdiGate';
import { buildPolicyIdBaseline } from '../../../utils/policyRecount';
import { allPovNodes, splitForState, type HeldByPov } from '../superseded';
import { normalizeLoadedPovFile } from './loadNormalize';
import type { PovTaxonomyFile, CrossCuttingFile as SituationsFile } from '../../../types/taxonomy';

export type ConflictKind = 'edited-also-changed-upstream' | 'edited-deleted-upstream' | 'deleted-also-changed-upstream';
export interface MergeConflict { id: string; kind: ConflictKind }
export interface MergeCounts { refreshed: number; kept: number; added: number; dropped: number; keptDeleted: number }
export interface MergeResult<N> { nodes: N[]; counts: MergeCounts; conflicts: MergeConflict[] }

/** Key-order-independent JSON, so "changed upstream" means a real value change, not a re-serialization. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
const sameValue = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/** Merge one file's nodes per the table above. Pure apart from reading the baseline registry. */
export function mergeNodes<N extends { id: string }>(local: readonly N[], fresh: readonly N[]): MergeResult<N> {
  const counts: MergeCounts = { refreshed: 0, kept: 0, added: 0, dropped: 0, keptDeleted: 0 };
  const conflicts: MergeConflict[] = [];
  const localById = new Map(local.map(n => [n.id, n]));
  const freshIds = new Set(fresh.map(n => n.id));
  const result: N[] = [];

  for (const f of fresh) {
    const l = localById.get(f.id);
    const base = baselineNodeFor(f.id);
    const changedUpstream = base !== undefined && !sameValue(f, base);
    if (l) {
      if (isBaselineNode(l)) { result.push(f); counts.refreshed++; continue; }
      result.push(l); counts.kept++;
      if (changedUpstream) conflicts.push({ id: f.id, kind: 'edited-also-changed-upstream' });
    } else if (base !== undefined) {
      counts.keptDeleted++; // the user deleted it: stays deleted
      if (changedUpstream) conflicts.push({ id: f.id, kind: 'deleted-also-changed-upstream' });
    } else {
      result.push(f); counts.added++;
    }
  }

  // Local nodes upstream doesn't have: drop the untouched ones (deleted upstream), keep the rest in place.
  const inResult = new Set(result.map(n => n.id));
  let prevId: string | null = null;
  for (const l of local) {
    if (!freshIds.has(l.id)) {
      if (isBaselineNode(l)) { counts.dropped++; continue; }
      if (baselineNodeFor(l.id) !== undefined) conflicts.push({ id: l.id, kind: 'edited-deleted-upstream' });
      const at = prevId === null ? 0 : result.findIndex(n => n.id === prevId) + 1;
      result.splice(at, 0, l);
      inResult.add(l.id);
      counts.kept++;
    }
    if (inResult.has(l.id)) prevId = l.id;
  }
  return { nodes: result, counts, conflicts };
}

const CONFLICT_TEXT: Record<ConflictKind, string> = {
  'edited-also-changed-upstream': 'you edited it and it also changed upstream; your edit was kept',
  'edited-deleted-upstream': 'you edited it and it was deleted upstream; your edit was kept',
  'deleted-also-changed-upstream': 'you deleted it and it also changed upstream; your delete was kept',
};

/** The user-visible note for conflicts, or null when there are none. */
export function conflictNote(conflicts: readonly MergeConflict[]): string | null {
  if (conflicts.length === 0) return null;
  const lines = conflicts.slice(0, 5).map(c => `${c.id}: ${CONFLICT_TEXT[c.kind]}`);
  const more = conflicts.length > 5 ? `\n…and ${conflicts.length - 5} more.` : '';
  return `Reloaded from the updated branch. ${conflicts.length} node${conflicts.length === 1 ? '' : 's'} changed on both sides:\n${lines.join('\n')}${more}`;
}

export interface ReloadReport {
  ok: boolean;
  /** For the caller to show: the conflict note, a read-failure message, or null when there's nothing to say. */
  message: string | null;
  counts: MergeCounts;
  conflicts: MergeConflict[];
}

const addCounts = (a: MergeCounts, b: MergeCounts): MergeCounts => ({
  refreshed: a.refreshed + b.refreshed, kept: a.kept + b.kept, added: a.added + b.added,
  dropped: a.dropped + b.dropped, keptDeleted: a.keptDeleted + b.keptDeleted,
});
export const ZERO_COUNTS: MergeCounts = Object.freeze({ refreshed: 0, kept: 0, added: 0, dropped: 0, keptDeleted: 0 }) as MergeCounts;

/** Merge every given (local, fresh) file pair; re-mark the fresh files as the new baseline; record one event. */
export function mergeFiles<F extends { nodes: { id: string }[] }>(
  pairs: readonly { key: string; local: readonly { id: string }[]; fresh: F }[],
): { merged: Map<string, F>; report: ReloadReport } {
  const merged = new Map<string, F>();
  let counts = ZERO_COUNTS;
  const conflicts: MergeConflict[] = [];
  for (const { key, local, fresh } of pairs) {
    const r = mergeNodes(local, fresh.nodes);
    merged.set(key, { ...fresh, nodes: r.nodes });
    counts = addCounts(counts, r.counts);
    conflicts.push(...r.conflicts);
  }
  // The fresh files are what the server now holds: they're the baseline for the next stale check and merge.
  // Kept local edits are different objects, so they stay "edited".
  markFilesAsBaseline(pairs.map(p => p.fresh));
  for (const c of conflicts) {
    getGlobalRecorder()?.record({ type: 'state.change', component: 'taxonomy-store', level: 'warn', message: `reloadKeepingEdits: ${c.kind}`, data: { nodeId: c.id, kind: c.kind } });
  }
  getGlobalRecorder()?.record({ type: 'state.change', component: 'taxonomy-store', level: 'info', message: 'reloadKeepingEdits.done', data: { ...counts, conflicts: conflicts.length, files: pairs.map(p => p.key) } });
  return { merged, report: { ok: true, message: conflictNote(conflicts), counts, conflicts } };
}

// ── The store action (wired in taxonomyDataSlice as `reloadKeepingEdits`) ──

/** The slice of store state this action reads and writes. */
export interface ReloadState {
  accelerationist: PovTaxonomyFile | null;
  safetyist: PovTaxonomyFile | null;
  skeptic: PovTaxonomyFile | null;
  situations: SituationsFile | null;
  supersededNodes: HeldByPov;
}

const FILES = ['accelerationist', 'safetyist', 'skeptic', 'situations'] as const;

/**
 * Re-read all four files from the current branch and merge them into the store, keeping every unsaved edit.
 * `dirty` is left as it is. All reads happen before any state changes, and the save's version cells move only
 * if every read succeeded (loadTaxonomyFilesForEdit), so a failure leaves the store and the cells untouched.
 */
export async function runReloadKeepingEdits<S extends ReloadState>(
  get: () => S, set: (patch: Partial<S>) => void,
): Promise<ReloadReport> {
  let raw: unknown[];
  try {
    raw = await api.loadTaxonomyFilesForEdit(FILES);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'taxonomy-store', level: 'error', message: 'reloadKeepingEdits: reading the branch failed; nothing changed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { ok: false, message: `Couldn't reload from the updated branch: ${mapErrorToUserMessage(err)}`, counts: ZERO_COUNTS, conflicts: [] };
  }
  const missing = FILES.filter((_, i) => !Array.isArray((raw[i] as { nodes?: unknown } | null)?.nodes));
  if (missing.length > 0) {
    // A file with no nodes array would read as "everything deleted upstream". Refuse rather than drop the user's view.
    getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'error', message: 'reloadKeepingEdits: a file came back without nodes; nothing changed', data: { missing } });
    return { ok: false, message: `Couldn't reload from the updated branch: ${missing.join(', ')} came back empty.`, counts: ZERO_COUNTS, conflicts: [] };
  }

  const fresh = {
    accelerationist: normalizeLoadedPovFile(raw[0] as PovTaxonomyFile, 'accelerationist') as PovTaxonomyFile,
    safetyist: normalizeLoadedPovFile(raw[1] as PovTaxonomyFile, 'safetyist') as PovTaxonomyFile,
    skeptic: normalizeLoadedPovFile(raw[2] as PovTaxonomyFile, 'skeptic') as PovTaxonomyFile,
    situations: coerceSituationDivergence(raw[3]) as SituationsFile, // t/3002, as in loadAll
  };
  const state = get();
  const { merged, report } = mergeFiles([
    // POV files merge over the full set (superseded included, t/4355), then split again below.
    ...POV_KEYS.map(pov => ({ key: pov, local: allPovNodes(state, pov), fresh: fresh[pov] as { nodes: { id: string }[] } })),
    { key: 'situations', local: state.situations?.nodes ?? [], fresh: fresh.situations as unknown as { nodes: { id: string }[] } },
  ]);
  const povNodes = [...fresh.accelerationist.nodes, ...fresh.safetyist.nodes, ...fresh.skeptic.nodes];
  set({
    ...splitForState(state, {
      accelerationist: merged.get('accelerationist') as unknown as PovTaxonomyFile,
      safetyist: merged.get('safetyist') as unknown as PovTaxonomyFile,
      skeptic: merged.get('skeptic') as unknown as PovTaxonomyFile,
    }),
    situations: merged.get('situations') as unknown as SituationsFile,
    // The save gates compare against what the server now holds.
    situationsBaseline: buildSituationBaseline(fresh.situations.nodes),
    povTagsBaseline: buildPovTagBaseline(povNodes),
    policyIdsBaseline: buildPolicyIdBaseline([...povNodes, ...fresh.situations.nodes]),
    embeddingDirty: true,
  } as unknown as Partial<S>);
  return report;
}
