// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Browser-safe supersession index builder for POV node chains.
 * No `fs`, `path`, or network imports — safe for renderer and CLI consumers.
 */

import type { PovNode } from './taxonomyTypes.js';

export type WarnFn = (message: string) => void;

interface SupersessionCaches {
  resolutionCache: Map<string, string | null>;
  depthCache: Map<string, number>;
}

/** How a supersession walk ended. */
type WalkEnd = 'survivor' | 'cached' | 'cycle' | 'dangling';

interface SupersessionWalk {
  chain: string[];
  cur: string;
  end: WalkEnd;
  missingTarget?: string;
}

/** Follow `superseded_by` from `startId` until a survivor, a cached node, a cycle or a dangling target. */
function walkSupersession(
  startId: string,
  allNodesById: Map<string, PovNode>,
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
  } else if (walk.end === 'survivor') {
    settleToSurvivor(chain, cur, caches, warn);
  } else {
    settleToCached(chain, cur, caches, warn);
  }
}

/**
 * Build a supersession index from a flat list of POV nodes.
 *
 * @param povNodes - All POV nodes (from all camps), including superseded ones.
 * @param warn     - Called for each cycle, dangling target or long chain found.
 *                   Defaults to a no-op so callers without a logger can omit it.
 *
 * @returns
 *   - `allNodesById`  — Map of every node by id, including superseded nodes.
 *   - `resolveNode`   — Follows supersession chains to the canonical survivor;
 *                       returns the node itself for cycles/dangling targets, undefined for unknown ids.
 *   - `isSuperseded`  — True if the id belongs to a node with a `superseded_by` field.
 */
export function buildSupersessionIndex(
  povNodes: PovNode[],
  warn: WarnFn = () => {},
): {
  allNodesById: Map<string, PovNode>;
  resolveNode: (id: string) => PovNode | undefined;
  isSuperseded: (id: string) => boolean;
} {
  const allNodesById = new Map<string, PovNode>(povNodes.map(n => [n.id, n]));

  const caches: SupersessionCaches = { resolutionCache: new Map(), depthCache: new Map() };
  for (const startNode of povNodes) {
    if (!startNode.superseded_by || caches.resolutionCache.has(startNode.id)) continue;
    settleWalk(walkSupersession(startNode.id, allNodesById, caches.resolutionCache), caches, warn);
  }

  const { resolutionCache } = caches;

  const resolveNode = (id: string): PovNode | undefined => {
    const node = allNodesById.get(id);
    if (!node) return undefined;
    if (!node.superseded_by) return node;
    const resolved = resolutionCache.get(id);
    if (!resolved) return node; // cycle or dangling — return self
    return allNodesById.get(resolved) ?? node;
  };

  const supersededIds = new Set(povNodes.filter(n => n.superseded_by).map(n => n.id));
  const isSuperseded = (id: string): boolean => supersededIds.has(id);

  return { allNodesById, resolveNode, isSuperseded };
}
