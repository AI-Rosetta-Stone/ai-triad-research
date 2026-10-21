// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4355 (t/4278, SO e/343#2 C1/C5): superseded POV nodes in the editor.
//
// At load, a node with `superseded_by` is held aside, out of `state.<pov>.nodes`, so every list, picker,
// search and AI context skips it with no change on the reader's side. It is never edited and is written back
// unchanged, at its original position, on save. Readers that need the full set use the helpers here:
//
//   allPovNodes(state, pov)       full set for one POV  (validation, export, id generation, maintenance)
//   allNodesById(state)           exact node by id      (historical display: deep links, citations, banners)
//   isSuperseded(state, id)       marking
//   withSupersededForSave(state)  the full view save() validates and writes
//
// `resolveNode` (the canonical survivor, for new attribution) comes from lib's shared supersession logic.

import { POV_KEYS } from '@lib/debate/types';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { PovNode, PovTaxonomyFile } from '../../types/taxonomy';

export type PovKey = typeof POV_KEYS[number];
/** A superseded node and its position in the file as loaded, so save can put it back where it was. */
export interface HeldNode { node: PovNode; index: number }
export type HeldByPov = Record<PovKey, HeldNode[]>;

export const EMPTY_HELD: HeldByPov = { accelerationist: [], safetyist: [], skeptic: [] };

/** A node is superseded when `superseded_by` is set, whether or not its target resolves (dangling counts). */
export const isSupersededNode = (n: PovNode): boolean => typeof n.superseded_by === 'string' && n.superseded_by !== '';

/** Split a loaded file into its selectable nodes and the superseded nodes held aside with their positions. */
export function splitSuperseded(file: PovTaxonomyFile): { file: PovTaxonomyFile; held: HeldNode[] } {
  const held: HeldNode[] = [];
  const selectable: PovNode[] = [];
  file.nodes.forEach((node, index) => (isSupersededNode(node) ? held.push({ node, index }) : selectable.push(node)));
  return held.length === 0 ? { file, held } : { file: { ...file, nodes: selectable }, held };
}

/** Re-insert held nodes at their original positions (clamped when the file has since shrunk). */
export function mergeHeld(nodes: readonly PovNode[], held: readonly HeldNode[]): PovNode[] {
  if (held.length === 0) return [...nodes];
  const out = [...nodes];
  for (const h of [...held].sort((a, b) => a.index - b.index)) out.splice(Math.min(h.index, out.length), 0, h.node);
  return out;
}

type StateWithPovs = { supersededNodes: HeldByPov } & { [K in PovKey]: PovTaxonomyFile | null };

/** Load-time state patch: the selectable files, plus the held nodes for the POVs being loaded. */
export function splitForState<S extends StateWithPovs>(
  current: S, files: Partial<Record<PovKey, PovTaxonomyFile | null>>,
): Partial<StateWithPovs> {
  const patch: Partial<StateWithPovs> = {};
  const supersededNodes = { ...current.supersededNodes };
  let total = 0;
  for (const pov of Object.keys(files) as PovKey[]) {
    const file = files[pov];
    if (!file) { patch[pov] = file ?? null; supersededNodes[pov] = []; continue; }
    const split = splitSuperseded(file);
    patch[pov] = split.file;
    supersededNodes[pov] = split.held;
    total += split.held.length;
  }
  patch.supersededNodes = supersededNodes;
  if (total > 0) {
    getGlobalRecorder()?.record({
      type: 'state.change', component: 'taxonomy-store', level: 'info',
      message: `Held ${total} superseded node(s) out of selection`, data: { povs: Object.keys(files), held: total },
    });
  }
  return patch;
}

/** The full node list for one POV: selectable plus superseded, in file order. */
export function allPovNodes(state: StateWithPovs, pov: PovKey): PovNode[] {
  return mergeHeld(state[pov]?.nodes ?? [], state.supersededNodes[pov] ?? []);
}

/** Every POV node id, superseded included. Use for "does this id exist?" and new-id uniqueness. */
export function allPovNodeIds(state: StateWithPovs): Set<string> {
  const ids = new Set<string>();
  for (const pov of POV_KEYS) for (const n of allPovNodes(state, pov)) ids.add(n.id);
  return ids;
}

/** The state save() should validate and write: each POV file with its superseded nodes back in place. */
export function withSupersededForSave<S extends StateWithPovs>(state: S): S {
  let out = state;
  for (const pov of POV_KEYS) {
    const held = state.supersededNodes[pov];
    const file = state[pov];
    if (!file || held.length === 0) continue;
    if (out === state) out = { ...state };
    (out as StateWithPovs)[pov] = { ...file, nodes: mergeHeld(file.nodes, held) };
  }
  return out;
}

// One cached index per (files, held) snapshot: readers like getLabelForId call this on every render.
let indexCache: { key: unknown[]; byId: Map<string, PovNode>; povById: Map<string, PovKey> } | null = null;

function index(state: StateWithPovs) {
  const key = [state.accelerationist, state.safetyist, state.skeptic, state.supersededNodes];
  if (indexCache && indexCache.key.every((k, i) => k === key[i])) return indexCache;
  const byId = new Map<string, PovNode>();
  const povById = new Map<string, PovKey>();
  for (const pov of POV_KEYS) for (const n of allPovNodes(state, pov)) { byId.set(n.id, n); povById.set(n.id, pov); }
  indexCache = { key, byId, povById };
  return indexCache;
}

/** The exact stored node for any POV id, superseded or not (historical display). */
export function allNodesById(state: StateWithPovs): Map<string, PovNode> {
  return index(state).byId;
}

/** The POV file a node lives in (superseded included), or undefined for an unknown id. */
export function povOfNode(state: StateWithPovs, id: string): PovKey | undefined {
  return index(state).povById.get(id);
}

/** Whether a POV node id is superseded (for marking; false for unknown ids and non-POV ids). */
export function isSuperseded(state: StateWithPovs, id: string): boolean {
  const n = allNodesById(state).get(id);
  return n !== undefined && isSupersededNode(n);
}

/** Edits by id never touch a superseded node (it is cited history). WARN and refuse rather than no-op silently. */
export function refuseSupersededEdit(state: StateWithPovs, id: string, op: string): boolean {
  if (!isSuperseded(state, id)) return false;
  getGlobalRecorder()?.record({
    type: 'state.change', component: 'taxonomy-store', level: 'warn',
    message: `${op} refused: ${id} is superseded (read-only)`,
    data: { op, nodeId: id, superseded_by: allNodesById(state).get(id)?.superseded_by },
  });
  return true;
}

/**
 * Rename cascade into the held superseded nodes: rewrite parent_id, children and superseded_by that point at
 * `oldId`. The one write that changes a superseded node (TL p/336#635): otherwise its references would dangle.
 */
export function rewriteHeldRefs(held: HeldByPov, oldId: string, newId: string): { held: HeldByPov; changed: PovKey[] } {
  const changed: PovKey[] = [];
  const out = { ...held };
  for (const pov of POV_KEYS) {
    let povChanged = false;
    out[pov] = held[pov].map(h => {
      const n = h.node;
      const hit = n.parent_id === oldId || (n.children ?? []).includes(oldId) || n.superseded_by === oldId;
      if (!hit) return h;
      povChanged = true;
      return { index: h.index, node: {
        ...n,
        parent_id: n.parent_id === oldId ? newId : n.parent_id,
        children: (n.children ?? []).map(c => (c === oldId ? newId : c)),
        superseded_by: n.superseded_by === oldId ? newId : n.superseded_by,
      } };
    });
    if (povChanged) changed.push(pov);
  }
  return { held: changed.length ? out : held, changed };
}

/** Test seam. */
export function __resetSupersededCacheForTests(): void { indexCache = null; }
