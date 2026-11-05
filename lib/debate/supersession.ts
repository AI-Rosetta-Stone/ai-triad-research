// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Browser-safe supersession index builder — POV node chains (t/4354-t/4356) and situation node
 * chains (t/4872), over one combined index so a cited id (POV or situation) always resolves the
 * same way. No `fs`, `path`, or network imports — safe for renderer and CLI consumers.
 */

import { nodeTypeFromId } from './nodeIdUtils.js';

export type WarnFn = (message: string) => void;

/** The minimal shape buildSupersessionIndex needs — PovNode and SituationNode both satisfy it. */
export interface SupersedableNode {
  id: string;
  superseded_by?: string;
}

interface SupersessionCaches {
  resolutionCache: Map<string, string | null>;
  depthCache: Map<string, number>;
}

/** How a supersession walk ended. */
type WalkEnd = 'survivor' | 'cached' | 'cycle' | 'dangling' | 'cross_kind';

interface SupersessionWalk {
  chain: string[];
  cur: string;
  end: WalkEnd;
  missingTarget?: string;
}

/** Follow `superseded_by` from `startId` until a survivor, a cached node, a cycle, a dangling
 *  target, or a cross-kind target (t/4872: a situation pointing at a POV id or vice versa —
 *  treated like dangling, never followed). */
function walkSupersession<T extends SupersedableNode>(
  startId: string,
  allNodesById: Map<string, T>,
  resolutionCache: Map<string, string | null>,
): SupersessionWalk {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = startId;
  while (!resolutionCache.has(cur)) {
    if (seen.has(cur)) return { chain, cur, end: 'cycle' };
    chain.push(cur);
    seen.add(cur);
    const nextId = allNodesById.get(cur)?.superseded_by;
    if (!nextId) return { chain, cur, end: 'survivor' };
    if (!allNodesById.has(nextId)) return { chain, cur, end: 'dangling', missingTarget: nextId };
    if (nodeTypeFromId(nextId) !== nodeTypeFromId(cur)) {
      return { chain, cur, end: 'cross_kind', missingTarget: nextId };
    }
    cur = nextId;
  }
  return { chain, cur, end: 'cached' };
}

function settleToSurvivor(
  chain: string[],
  survivor: string,
  caches: SupersessionCaches,
  warn: WarnFn,
): void {
  chain.forEach((id, i) => {
    if (id === survivor) return;
    caches.resolutionCache.set(id, survivor);
    caches.depthCache.set(id, chain.length - 1 - i);
  });
  if (chain.length - 1 > 1) {
    warn(`loadTaxonomy: supersession chain ${chain.join(' → ')} — resolves to ${survivor}`);
  }
}

function settleToCached(
  chain: string[],
  cur: string,
  caches: SupersessionCaches,
  warn: WarnFn,
): void {
  const existingRes = caches.resolutionCache.get(cur) ?? null;
  const cachedDepth = caches.depthCache.get(cur) ?? 0;
  if (existingRes !== null && chain.length + cachedDepth > 1) {
    warn(`loadTaxonomy: supersession chain ${[...chain, cur].join(' → ')} — resolves to ${existingRes}`);
  }
  chain.forEach((id, i) => {
    if (caches.resolutionCache.has(id)) return;
    caches.resolutionCache.set(id, existingRes);
    if (existingRes !== null) caches.depthCache.set(id, chain.length - i + cachedDepth);
  });
}

function settleWalk(walk: SupersessionWalk, caches: SupersessionCaches, warn: WarnFn): void {
  const { chain, cur } = walk;
  if (walk.end === 'cycle') {
    const cycleMembers = chain.slice(chain.indexOf(cur));
    warn(`loadTaxonomy: supersession cycle: ${[...cycleMembers, cur].join(' → ')} — members excluded from selection`);
    for (const id of chain) caches.resolutionCache.set(id, null);
  } else if (walk.end === 'dangling') {
    warn(`loadTaxonomy: node ${cur} superseded_by "${walk.missingTarget}" not found in taxonomy — treating as no survivor`);
    for (const id of chain) caches.resolutionCache.set(id, null);
  } else if (walk.end === 'cross_kind') {
    warn(`loadTaxonomy: node ${cur} superseded_by "${walk.missingTarget}" is a different node kind (t/4872: situations only supersede situations, POV nodes only supersede POV nodes) — treating as no survivor`);
    for (const id of chain) caches.resolutionCache.set(id, null);
  } else if (walk.end === 'survivor') {
    settleToSurvivor(chain, cur, caches, warn);
  } else {
    settleToCached(chain, cur, caches, warn);
  }
}

/**
 * Build a supersession index from a flat list of nodes — POV nodes, situation nodes, or both
 * combined (t/4872: callers now pass both so a cited id of either kind resolves consistently).
 *
 * @param nodes - All nodes eligible to participate (from all camps / situations), including
 *                superseded ones.
 * @param warn  - Called for each cycle, dangling target, cross-kind target, or long chain found.
 *                Defaults to a no-op so callers without a logger can omit it.
 *
 * @returns
 *   - `allNodesById`  — Map of every node by id, including superseded nodes.
 *   - `resolveNode`   — Follows supersession chains to the canonical survivor;
 *                       returns the node itself for cycles/dangling/cross-kind targets,
 *                       undefined for unknown ids.
 *   - `isSuperseded`  — True if the id belongs to a node with a `superseded_by` field.
 */
export function buildSupersessionIndex<T extends SupersedableNode>(
  nodes: T[],
  warn: WarnFn = () => {},
): {
  allNodesById: Map<string, T>;
  resolveNode: (id: string) => T | undefined;
  isSuperseded: (id: string) => boolean;
} {
  const allNodesById = new Map<string, T>(nodes.map(n => [n.id, n]));

  const caches: SupersessionCaches = { resolutionCache: new Map(), depthCache: new Map() };
  for (const startNode of nodes) {
    if (!startNode.superseded_by || caches.resolutionCache.has(startNode.id)) continue;
    settleWalk(walkSupersession(startNode.id, allNodesById, caches.resolutionCache), caches, warn);
  }

  const { resolutionCache } = caches;

  const resolveNode = (id: string): T | undefined => {
    const node = allNodesById.get(id);
    if (!node) return undefined;
    if (!node.superseded_by) return node;
    const resolved = resolutionCache.get(id);
    if (!resolved) return node; // cycle, dangling or cross-kind — return self
    return allNodesById.get(resolved) ?? node;
  };

  const supersededIds = new Set(nodes.filter(n => n.superseded_by).map(n => n.id));
  const isSuperseded = (id: string): boolean => supersededIds.has(id);

  return { allNodesById, resolveNode, isSuperseded };
}
