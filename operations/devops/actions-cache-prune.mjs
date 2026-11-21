// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4971: the Actions cache crossed the 10 GB eviction line (11.68 GB, 34 entries), close behind
// the twice-already-happened "eviction broke a build" incident actions-cache-budget.yml (t/4931)
// now alerts on. The budget alarm is ALERT ONLY by design (t/4931); this is its deletion
// counterpart.
//
// Root cause, per prefix (`keyPrefix`, shared with actions-cache-budget.mjs): several prefixes --
// ai-triad-data-v2 (one new key per UTC day, t/4870), and the built-in setup-node/setup-python/
// playwright caches (one new key per lockfile/model hash change) -- mint a fresh key on
// `refs/heads/main` over time and NOTHING ever deletes the older ones. Each is individually
// reasonable; together they never shrink.
//
// Policy: for every key prefix, on `refs/heads/main` ONLY, keep the `keep` most-recently-created
// entries and delete the rest. Never touches a non-main ref (a PR or merge-queue branch) -- that
// entry may still be read by a re-run of its own still-open PR, and GitHub evicts it on its own
// once the ref retires. This is strictly more conservative than the budget alarm's own
// "non-main ref over 1 GB" cleanup-candidate callout: it never acts on those at all.
//
// Pure core: planPrune. I/O shim: fetchCacheData (reused from actions-cache-budget.mjs) +
// deleteCaches (github-script, actual DELETE calls) in the caller workflow.
//
// Run the tests: node --test operations/devops/actions-cache-prune.test.mjs

import { keyPrefix, MAIN_REF } from './actions-cache-budget.mjs';

export const DEFAULT_KEEP_PER_PREFIX = 1;

/**
 * PURE. Given the full Actions cache list, return the entries to delete: group refs/heads/main
 * entries by their stable key prefix, keep the `keep` most-recently-created per group, and delete
 * every older one. Entries on any other ref are never returned (left to GitHub's own eviction).
 */
export function planPrune(caches, { keep = DEFAULT_KEEP_PER_PREFIX } = {}) {
  if (!Array.isArray(caches)) {
    throw new Error('planPrune: caches must be an array (got ' + typeof caches + ')');
  }
  const safeKeep = Math.max(1, Number.isInteger(keep) ? keep : DEFAULT_KEEP_PER_PREFIX);

  const groups = new Map();
  for (const c of caches) {
    if (!c || c.ref !== MAIN_REF || typeof c.key !== 'string') continue;
    const prefix = keyPrefix(c.key);
    const list = groups.get(prefix) ?? [];
    list.push(c);
    groups.set(prefix, list);
  }

  const toDelete = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    toDelete.push(...sorted.slice(safeKeep));
  }
  // Oldest first, so a log of the deletions reads chronologically.
  toDelete.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return toDelete;
}
