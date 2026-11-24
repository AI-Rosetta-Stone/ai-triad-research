// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4971: the Actions cache crossed the 10 GB eviction line (11.68 GB, 34 entries), close behind
// the twice-already-happened "eviction broke a build" incident actions-cache-budget.yml (t/4931)
// now alerts on. The budget alarm is ALERT ONLY by design (t/4931); this is its deletion
// counterpart.
//
// Root cause: some cache families mint a fresh key on `refs/heads/main` whenever their input
// changes (a daily date, a lockfile hash, a model pin, a data-repo head), and NOTHING ever deletes
// the older ones. For those families the newest key SUPERSEDES the older ones.
//
// ALLOWLIST, NOT "EVERY PREFIX" (Quality changes-request on #5281, t/539). Grouping every key by
// `keyPrefix` folded all `buildkit-blob-1-sha256:<digest>` entries into one group, so keep=1 would
// have deleted every Docker layer blob but one (52 of 53 at review time, 1.6 GB, all live). Those
// keys are CONTENT-ADDRESSED: each digest is a different layer, referenced by the
// `index-shared-docker-*` manifests, and none supersedes another. So a family is pruned only when
// it is listed in SUPERSEDING_FAMILIES below, after reading how its key is built; everything else
// (BuildKit blobs and indexes, CodeQL TRAP caches, fixed keys like pester, any new family) is
// never touched. NEVER_PRUNE is a second, explicit line for the content-addressed families.
//
// Policy within an allowed family: on `refs/heads/main` ONLY, keep the `keep` most-recently-created
// entries per key prefix and delete the rest. A non-main ref (a PR or merge-queue branch) is never
// touched: its entry may still be read by a re-run of its own PR, and GitHub evicts it once the
// ref retires.
//
// Pure core: planPrune, formatPlanSummary. I/O shim: fetchCacheData (from actions-cache-budget.mjs)
// plus the delete loop in actions-cache-prune.yml.
//
// Run the tests: node --test operations/devops/actions-cache-prune.test.mjs

import { keyPrefix, MAIN_REF } from './actions-cache-budget.mjs';

export const DEFAULT_KEEP_PER_PREFIX = 1;

// Families whose newest key supersedes the older ones, each checked against the key it is built
// from (t/539). A family matches a keyPrefix that equals it or starts with it plus '-'.
//   ai-triad-data-v2   checkout-ai-triad-data: one key per UTC day, restored by prefix (t/4870)
//   setup-python       actions/setup-python `cache: pip`, keyed by scripts/requirements.txt's hash
//   node-cache         actions/setup-node `cache: 'pnpm'`, keyed by pnpm-lock.yaml's hash
//   ms-playwright      ci.yml: hashFiles('taxonomy-editor/pnpm-lock.yaml')
//   apt-playwright     ci.yml: same
//   hf-embed           ci.yml: hashFiles(fetch_embed_models.py, embed_model_pins.json)
//   onnx-model         ci.yml: the pinned model revision
//   taxonomy-snapshot  container.yml: the data repo head, restored by prefix (restore-keys)
export const SUPERSEDING_FAMILIES = Object.freeze([
  'ai-triad-data-v2',
  'setup-python',
  'node-cache',
  'ms-playwright',
  'apt-playwright',
  'hf-embed',
  'onnx-model',
  'taxonomy-snapshot',
]);

// Content-addressed families: never pruned, even if someone later widens the allowlist by mistake.
export const NEVER_PRUNE = Object.freeze([/^buildkit-/i, /^index-/i]);

/** PURE. True when a cache key belongs to a family whose older keys are safe to delete. */
export function isPrunableKey(key) {
  const k = String(key ?? '');
  if (NEVER_PRUNE.some((re) => re.test(k))) return false;
  const prefix = keyPrefix(k);
  return SUPERSEDING_FAMILIES.some((f) => prefix === f || prefix.startsWith(`${f}-`));
}

/**
 * PURE. Given the full Actions cache list, return the entries to delete: refs/heads/main entries of
 * an allowed family, grouped by key prefix, keeping the `keep` most-recently-created per group.
 * Entries on any other ref, or of any family not on the allowlist, are never returned.
 */
export function planPrune(caches, { keep = DEFAULT_KEEP_PER_PREFIX } = {}) {
  if (!Array.isArray(caches)) {
    throw new Error('planPrune: caches must be an array (got ' + typeof caches + ')');
  }
  const safeKeep = Math.max(1, Number.isInteger(keep) ? keep : DEFAULT_KEEP_PER_PREFIX);

  const groups = new Map();
  for (const c of caches) {
    if (!c || c.ref !== MAIN_REF || typeof c.key !== 'string') continue;
    if (!isPrunableKey(c.key)) continue;
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

/** PURE. Markdown for the job summary: the mode, the planned deletions and their total size. */
export function formatPlanSummary(toDelete, { dryRun }) {
  const gb = (b) => `${(Number(b) / 1e9).toFixed(2)} GB`;
  const total = toDelete.reduce((s, c) => s + (Number(c.size_in_bytes) || 0), 0);
  const lines = [
    `## actions-cache-prune: ${dryRun ? 'DRY RUN (nothing deleted)' : 'DELETE'}`,
    '',
    `${toDelete.length} entr${toDelete.length === 1 ? 'y' : 'ies'} planned, ${gb(total)}. ` +
      `Allowed families: ${SUPERSEDING_FAMILIES.join(', ')}. Only refs/heads/main.`,
  ];
  if (toDelete.length) {
    lines.push('', '| key | id | created | size |', '|---|---|---|---|');
    for (const c of toDelete) lines.push(`| \`${c.key}\` | ${c.id} | ${c.created_at} | ${gb(c.size_in_bytes)} |`);
  }
  return lines.join('\n') + '\n';
}
