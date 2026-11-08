// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { createTaxonomyCache, type CacheStats, type TaxonomyCache } from './taxonomyCache.js';

let taxonomyCache: TaxonomyCache | undefined;

function getCache(): TaxonomyCache {
  return taxonomyCache ??= createTaxonomyCache();
}

export function initTaxonomyCache(enabled?: boolean): void {
  taxonomyCache = createTaxonomyCache(enabled);
}

export function loadNodeWithCache<T>(
  nodeId: string,
  loader: () => Promise<T>,
): Promise<T> {
  return getCache().getNode(nodeId, loader);
}

export function loadNodesWithCache<T>(
  nodeIds: string[],
  loader: (nodeId: string) => Promise<T>,
): Promise<T[]> {
  const cache = getCache();
  return Promise.all(nodeIds.map((nodeId) => cache.getNode(nodeId, () => loader(nodeId))));
}

export function clearTaxonomyCache(): void {
  getCache().clear();
}

export function getTaxonomyCacheStats(): CacheStats {
  return getCache().getMetrics();
}
