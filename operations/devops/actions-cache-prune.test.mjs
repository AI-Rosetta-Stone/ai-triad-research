// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planPrune, DEFAULT_KEEP_PER_PREFIX, isPrunableKey, formatPlanSummary, SUPERSEDING_FAMILIES } from './actions-cache-prune.mjs';

const MAIN = 'refs/heads/main';

// keyPrefix's VARYING_SUFFIX_RE only strips a hash of >=12 hex chars (or an ISO date) -- a short
// suffix like "aaa" is too short to match, so it stays part of the "prefix" and the key is its
// own group of one. Every fixture below uses a realistic 32-hex-char suffix so same-prefix keys
// actually collapse into one group, matching the live cache keys this module prunes.
const HEX = (n) => n.toString(16).padStart(32, '0');

function cache(key, { ref = MAIN, created_at, id, size_in_bytes = 1000 } = {}) {
  return { key, ref, created_at, id: id ?? key, size_in_bytes };
}

test('empty cache list prunes nothing', () => {
  assert.deepEqual(planPrune([]), []);
});

test('a single entry per prefix is never pruned', () => {
  const caches = [
    cache('ai-triad-data-v2-2026-11-20', { created_at: '2026-11-20T00:00:00Z' }),
    cache(`hf-embed-Linux-${HEX(1)}`, { created_at: '2026-11-10T00:00:00Z' }),
  ];
  assert.deepEqual(planPrune(caches), []);
});

test('t/4971 live shape: 3 ai-triad-data-v2 daily keys on main, keep=1 deletes the 2 oldest', () => {
  const caches = [
    cache('ai-triad-data-v2-2026-11-18', { created_at: '2026-11-18T16:30:51Z' }),
    cache('ai-triad-data-v2-2026-11-19', { created_at: '2026-11-19T04:00:50Z' }),
    cache('ai-triad-data-v2-2026-11-20', { created_at: '2026-11-20T16:13:14Z' }),
  ];
  const result = planPrune(caches, { keep: 1 });
  assert.deepEqual(result.map((c) => c.key), [
    'ai-triad-data-v2-2026-11-18',
    'ai-triad-data-v2-2026-11-19',
  ]);
});

test('a non-main ref is never pruned, even when it duplicates a main-ref prefix', () => {
  const caches = [
    cache(`node-cache-Linux-x64-pnpm-${HEX(1)}`, { ref: 'refs/pull/5020/merge', created_at: '2026-11-19T03:58:34Z' }),
    cache(`node-cache-Linux-x64-pnpm-${HEX(1)}`, { ref: 'refs/heads/gh-readonly-queue/main/pr-5020-xyz', created_at: '2026-11-19T04:11:32Z', id: 'q' }),
    cache(`node-cache-Linux-x64-pnpm-${HEX(1)}`, { ref: MAIN, created_at: '2026-11-19T04:22:09Z', id: 'm' }),
  ];
  const result = planPrune(caches);
  assert.deepEqual(result, []); // only one main entry for this prefix, and the other two aren't on main
});

test('keeps the N most recent per prefix when keep > 1', () => {
  const caches = [
    cache(`taxonomy-snapshot-${HEX(1)}`, { created_at: '2026-11-16T14:06:45Z' }),
    cache(`taxonomy-snapshot-${HEX(2)}`, { created_at: '2026-11-19T04:02:20Z' }),
    cache(`taxonomy-snapshot-${HEX(3)}`, { created_at: '2026-11-19T21:41:26Z' }),
  ];
  const result = planPrune(caches, { keep: 2 });
  assert.deepEqual(result.map((c) => c.key), [`taxonomy-snapshot-${HEX(1)}`]);
});

test('different prefixes on main are pruned independently', () => {
  const caches = [
    cache(`ms-playwright-Linux-${HEX(1)}`, { created_at: '2026-11-11T20:18:46Z' }),
    cache(`ms-playwright-Linux-${HEX(2)}`, { created_at: '2026-11-19T04:24:06Z' }),
    cache(`setup-python-Linux-x64-pip-${HEX(3)}`, { created_at: '2026-11-11T12:00:01Z' }),
    cache(`setup-python-Linux-x64-pip-${HEX(4)}`, { created_at: '2026-11-19T04:15:50Z' }),
  ];
  const result = planPrune(caches, { keep: 1 }).map((c) => c.key).sort();
  assert.deepEqual(result, [`ms-playwright-Linux-${HEX(1)}`, `setup-python-Linux-x64-pip-${HEX(3)}`].sort());
});

test('keep=0 is clamped to 1 (never deletes everything in a group)', () => {
  const caches = [
    cache(`onnx-model-${HEX(1)}`, { created_at: '2026-11-10T00:00:00Z' }),
  ];
  assert.deepEqual(planPrune(caches, { keep: 0 }), []);
});

test('default keep matches DEFAULT_KEEP_PER_PREFIX (1)', () => {
  assert.equal(DEFAULT_KEEP_PER_PREFIX, 1);
});

test('throws on a non-array input rather than silently no-op (fail loud, not fail open)', () => {
  assert.throws(() => planPrune(null), /must be an array/);
  assert.throws(() => planPrune(undefined), /must be an array/);
});

test('result is sorted oldest-first regardless of input order', () => {
  const caches = [
    cache(`hf-embed-Linux-${HEX(1)}`, { created_at: '2026-11-19T00:00:00Z' }),
    cache(`hf-embed-Linux-${HEX(2)}`, { created_at: '2026-11-10T00:00:00Z' }),
    cache(`hf-embed-Linux-${HEX(3)}`, { created_at: '2026-11-15T00:00:00Z' }),
    cache(`hf-embed-Linux-${HEX(4)}`, { created_at: '2026-11-20T00:00:00Z' }), // most recent, kept
  ];
  const result = planPrune(caches, { keep: 1 });
  assert.deepEqual(result.map((c) => c.key), [
    `hf-embed-Linux-${HEX(2)}`,
    `hf-embed-Linux-${HEX(3)}`,
    `hf-embed-Linux-${HEX(1)}`,
  ]);
});

// ── #5281 review (Quality + TL, t/539): content-addressed families are never pruned ──

const SHA = (n) => n.toString(16).padStart(64, '0');

test('BuildKit layer blobs are content-addressed: many on main, none planned for deletion', () => {
  const caches = Array.from({ length: 53 }, (_, i) =>
    cache(`buildkit-blob-1-sha256:${SHA(i + 1)}`, { created_at: new Date(Date.UTC(2026, 10, 1 + (i % 28))).toISOString(), id: i + 1 }));
  caches.push(cache('index-shared-docker-1-f921bd05#96', { created_at: '2026-11-20T00:00:00Z', id: 'i96' }));
  caches.push(cache('index-shared-docker-1-f921bd05#97', { created_at: '2026-11-21T00:00:00Z', id: 'i97' }));
  assert.deepEqual(planPrune(caches), []);
});

test('only allowlisted families are pruned: codeql-trap, pester and an unknown family are left alone', () => {
  const caches = [
    cache(`codeql-trap-1-2.27.5-javascript-${HEX(1)}`, { created_at: '2026-11-10T00:00:00Z' }),
    cache(`codeql-trap-1-2.27.5-javascript-${HEX(2)}`, { created_at: '2026-11-20T00:00:00Z' }),
    cache(`brand-new-family-${HEX(3)}`, { created_at: '2026-11-10T00:00:00Z' }),
    cache(`brand-new-family-${HEX(4)}`, { created_at: '2026-11-20T00:00:00Z' }),
    cache('pester-5.7.1-Linux', { created_at: '2026-11-20T00:00:00Z' }),
  ];
  assert.deepEqual(planPrune(caches), []);
});

test('isPrunableKey: NEVER_PRUNE wins over the allowlist; families match whole segments', () => {
  assert.equal(isPrunableKey(`buildkit-blob-1-sha256:${SHA(1)}`), false);
  assert.equal(isPrunableKey('index-shared-docker-1-f921bd05#97'), false);
  assert.equal(isPrunableKey('ai-triad-data-v2-2026-11-24'), true);
  assert.equal(isPrunableKey(`hf-embed-Linux-${HEX(1)}`), true);
  assert.equal(isPrunableKey(`hf-embedder-Linux-${HEX(1)}`), false, 'a family is a whole segment, not a string prefix');
  assert.ok(SUPERSEDING_FAMILIES.every((f) => !/^(buildkit|index)/.test(f)));
});

// TL condition (p/9#510): a test built from the REAL cache listing. Snapshot of
// GET /repos/{owner}/{repo}/actions/caches (all pages), 2026-11-24, in fixtures/.
test('real cache listing (2026-11-24 snapshot): every Docker layer blob and index is kept; only superseded allowlisted keys go', () => {
  const snap = JSON.parse(readFileSync(new URL('./fixtures/actions-cache-listing-2026-11-24.json', import.meta.url), 'utf8'));
  const caches = snap.actions_caches;
  const mainBlobs = caches.filter((c) => c.ref === MAIN && c.key.startsWith('buildkit-blob-'));
  assert.ok(mainBlobs.length >= 30, `the snapshot should hold the live blob set (got ${mainBlobs.length})`);

  const plan = planPrune(caches);
  const planned = new Set(plan.map((c) => c.id));
  for (const b of mainBlobs) assert.ok(!planned.has(b.id), `blob ${b.key} must be kept`);
  assert.ok(plan.every((c) => !/^(buildkit|index)-/.test(c.key)), 'no BuildKit entry in the plan');
  assert.ok(plan.every((c) => c.ref === MAIN && isPrunableKey(c.key)));

  // Every allowlisted prefix on main keeps exactly its newest entry.
  const kept = caches.filter((c) => c.ref === MAIN && isPrunableKey(c.key) && !planned.has(c.id));
  const newestByPrefix = new Map();
  for (const c of caches.filter((x) => x.ref === MAIN && isPrunableKey(x.key))) {
    const p = c.key.replace(/-[0-9a-f]{12,}$|-\d{4}-\d{2}-\d{2}$/i, '');
    const cur = newestByPrefix.get(p);
    if (!cur || new Date(c.created_at) > new Date(cur.created_at)) newestByPrefix.set(p, c);
  }
  assert.deepEqual(kept.map((c) => c.id).sort(), [...newestByPrefix.values()].map((c) => c.id).sort());
});

test('formatPlanSummary names the mode, the count and every planned key', () => {
  const plan = [cache('ai-triad-data-v2-2026-11-18', { created_at: '2026-11-18T00:00:00Z', id: 11, size_in_bytes: 1.5e9 })];
  const dry = formatPlanSummary(plan, { dryRun: true });
  assert.match(dry, /DRY RUN \(nothing deleted\)/);
  assert.match(dry, /1 entry planned, 1\.50 GB/);
  assert.match(dry, /`ai-triad-data-v2-2026-11-18` \| 11 \|/);
  assert.match(formatPlanSummary([], { dryRun: false }), /DELETE[\s\S]*0 entries planned/);
});
