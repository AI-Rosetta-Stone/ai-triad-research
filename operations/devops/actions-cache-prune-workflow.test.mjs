// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// #5281 review (Quality + TL p/9#510, t/539): runs the REAL github-script block of
// .github/workflows/actions-cache-prune.yml against a mock GitHub, so the two workflow-side rules are
// pinned: a schedule run never deletes, and a delete that fails with anything but 404 fails the job.
//
// Run: node --test operations/devops/actions-cache-prune-workflow.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const WORKFLOW = path.join(root, '.github', 'workflows', 'actions-cache-prune.yml');
const nodeRequire = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const MAIN = 'refs/heads/main';
const HEX = (n) => n.toString(16).padStart(32, '0');

function scriptBlock(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^\s*script:\s*\|\s*$/.test(l));
  assert.ok(start >= 0, 'no `script: |` block in the workflow');
  const body = [];
  let indent = null;
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') { body.push(''); continue; }
    const ind = l.match(/^ */)[0].length;
    if (indent === null) indent = ind;
    if (ind < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

// Two superseded ai-triad-data-v2 keys (planned) plus a BuildKit blob pair (never planned).
const CACHES = [
  { id: 1, key: 'ai-triad-data-v2-2026-11-20', ref: MAIN, created_at: '2026-11-20T00:00:00Z', size_in_bytes: 1e9 },
  { id: 2, key: 'ai-triad-data-v2-2026-11-21', ref: MAIN, created_at: '2026-11-21T00:00:00Z', size_in_bytes: 1e9 },
  { id: 3, key: 'ai-triad-data-v2-2026-11-22', ref: MAIN, created_at: '2026-11-22T00:00:00Z', size_in_bytes: 1e9 },
  { id: 4, key: `buildkit-blob-1-sha256:${HEX(1)}${HEX(2)}`, ref: MAIN, created_at: '2026-11-01T00:00:00Z', size_in_bytes: 5e7 },
  { id: 5, key: `buildkit-blob-1-sha256:${HEX(3)}${HEX(4)}`, ref: MAIN, created_at: '2026-11-02T00:00:00Z', size_in_bytes: 5e7 },
];

async function runPrune({ deleteMode, deleteError = () => null }) {
  const deleted = [];
  const log = { info: [], error: [], failed: [], summary: '' };
  const github = {
    rest: {
      actions: {
        getActionsCacheUsage: async () => ({ data: {} }),
        getActionsCacheList: async () => ({ data: { actions_caches: CACHES } }),
        deleteActionsCacheById: async ({ cache_id }) => {
          const err = deleteError(cache_id);
          if (err) throw err;
          deleted.push(cache_id);
          return { data: {} };
        },
      },
    },
    paginate: async (method, params, map) => map(await method(params)),
  };
  const core = {
    info: (m) => log.info.push(m), warning: (m) => log.info.push(m),
    error: (m) => log.error.push(m), setFailed: (m) => log.failed.push(m),
    summary: { addRaw(s) { log.summary += s; return this; }, async write() { return this; } },
  };
  const prev = { ws: process.env.GITHUB_WORKSPACE, del: process.env.PRUNE_DELETE };
  process.env.GITHUB_WORKSPACE = root;
  process.env.PRUNE_DELETE = deleteMode ? 'true' : 'false';
  try {
    await new AsyncFunction('require', 'github', 'context', 'core', scriptBlock(readFileSync(WORKFLOW, 'utf8')))(
      nodeRequire, github, { repo: { owner: 'o', repo: 'r' } }, core);
  } finally {
    for (const [k, v] of [['GITHUB_WORKSPACE', prev.ws], ['PRUNE_DELETE', prev.del]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return { deleted, log };
}

test('PRUNE_DELETE is true ONLY for a workflow_dispatch with mode=delete (a schedule run is always a dry run)', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');
  assert.match(yml, /PRUNE_DELETE: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.mode == 'delete' && 'true' \|\| 'false' \}\}/);
  assert.match(yml, /default: dry-run/);
});

test('dry run (schedule, or dispatch default): plan in the job summary, nothing deleted, job green', async () => {
  const { deleted, log } = await runPrune({ deleteMode: false });
  assert.deepEqual(deleted, []);
  assert.deepEqual(log.failed, []);
  assert.match(log.summary, /DRY RUN \(nothing deleted\)/);
  assert.match(log.summary, /ai-triad-data-v2-2026-11-20/);
  assert.doesNotMatch(log.summary, /buildkit-blob/);
});

test('delete mode: deletes only the superseded allowlisted keys, never a BuildKit blob', async () => {
  const { deleted, log } = await runPrune({ deleteMode: true });
  assert.deepEqual(deleted, [1, 2]);
  assert.deepEqual(log.failed, []);
  assert.match(log.summary, /actions-cache-prune: DELETE/);
});

test('a non-404 delete failure FAILS the job (after trying the rest of the plan)', async () => {
  const { deleted, log } = await runPrune({
    deleteMode: true,
    deleteError: (id) => (id === 1 ? Object.assign(new Error('Resource not accessible by integration'), { status: 403 }) : null),
  });
  assert.deepEqual(deleted, [2], 'the rest of the plan still runs');
  assert.equal(log.failed.length, 1);
  assert.match(log.failed[0], /1 of 2 deletes failed/);
  assert.ok(log.error.some((e) => /could not delete 'ai-triad-data-v2-2026-11-20' \(id 1\): 403/.test(e)));
});

test('a 404 on delete (already gone) is not a failure', async () => {
  const { log } = await runPrune({
    deleteMode: true,
    deleteError: (id) => (id === 1 ? Object.assign(new Error('Not Found'), { status: 404 }) : null),
  });
  assert.deepEqual(log.failed, []);
  assert.ok(log.info.some((m) => /already gone \(404\)/.test(m)));
});
