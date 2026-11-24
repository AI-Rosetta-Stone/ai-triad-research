// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/440 (Quality's non-blocking gap on #5425): the missing-Tier comment in `--dry-run`. Runs the
// real CLI (`node t0-enqueue-sweep.mjs <repo> --dry-run`) end to end against a stub `gh` on PATH
// that serves one canned open-PR search page and records every call. A dry run must say it WOULD
// ask a no-Tier PR, must not say so for a PR that declares a tier or for a draft, and must make no
// comment read or post (its other gh calls are reads the sweep makes anyway, answered empty).
//
// POSIX only: the stub is an executable script found through PATH, which execFileSync('gh')
// cannot resolve to a script on Windows. It runs on the Linux CI runners.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SWEEP = join(here, 't0-enqueue-sweep.mjs');

const prNode = (number, body, over = {}) => ({
  number, body, headRefOid: `head${number}abcdef`, headRefName: `feat/x${number}`, baseRefName: 'main',
  isDraft: false, isInMergeQueue: false, mergeStateStatus: 'BLOCKED', isCrossRepository: false,
  author: { login: 'jpsnover' }, labels: { nodes: [] }, autoMergeRequest: null,
  timelineItems: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }] },
  files: { pageInfo: { hasNextPage: false }, nodes: [] },
  reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
  comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
  ...over,
});

const SEARCH = {
  data: {
    search: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        prNode(30, 'Fixes a thing, no tier line.'),
        prNode(31, 'Tier: T1\n\nNeeds Quality.'),
        prNode(33, 'Draft, no tier line.', { isDraft: true }),
      ],
    },
  },
};

// The stub: append argv to calls.jsonl; answer the GraphQL search with the canned page and the
// sweep's other reads (e.g. ejected-batch.mjs's merge_group runs) with an empty list. A comment read
// or post is answered too, so a regression shows up in the assertions, not as a stub failure.
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args[1] === 'graphql') {
  process.stdout.write(fs.readFileSync(path.join(__dirname, 'search.json'), 'utf8'));
  process.exit(0);
}
process.stdout.write('[]');
process.exit(0);
`;

test('t/440: --dry-run says it would ask the no-Tier PR, and reads or posts no comment', { skip: process.platform === 'win32' ? 'POSIX-only: the stub gh is a PATH script (runs on Linux CI)' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 't440-dryrun-'));
  try {
    writeFileSync(join(dir, 'search.json'), JSON.stringify(SEARCH));
    writeFileSync(join(dir, 'gh'), STUB);
    chmodSync(join(dir, 'gh'), 0o755);
    // The stub is CommonJS (require); keep the temp dir out of any ESM package scope.
    writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');

    const r = spawnSync(process.execPath, [SWEEP, 'o/r', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GH_TOKEN: 'stub', GITHUB_TOKEN: '' },
    });
    assert.equal(r.status, 0, `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    // The arm under test: one dry-run line for #30 only.
    assert.match(r.stdout, /^skip #30: not declared Tier: T0$/m);
    assert.match(r.stdout, /^\[dry-run\] would ask #30 for a Tier line/m);
    assert.doesNotMatch(r.stdout, /would ask #31/, 'a PR that declares Tier: T1 is not asked');
    assert.doesNotMatch(r.stdout, /would ask #33/, 'a draft is not asked');
    assert.match(r.stdout, /^skip #31: not declared Tier: T0$/m);
    assert.match(r.stdout, /^skip #33: /m);
    assert.doesNotMatch(r.stdout, /commented on #|WARN: #30: could not post/);

    // The stub really ran (the search came through it), and no call read or posted a PR comment.
    assert.ok(existsSync(join(dir, 'calls.jsonl')), 'the stub gh was never called (PATH not used?)');
    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.some((c) => c[0] === 'api' && c[1] === 'graphql'), 'the open-PR search did not go through the stub');
    const commentCalls = calls.filter((c) => c.some((a) => /issues\/\d+\/comments|^body=/.test(a)));
    assert.deepEqual(commentCalls, [], 'a dry run read or posted a PR comment');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
