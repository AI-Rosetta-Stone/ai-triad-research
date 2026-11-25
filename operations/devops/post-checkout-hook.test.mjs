// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/565 (Quality incident p/8#196): .githooks/post-checkout warns loudly when the SHARED checkout goes
// detached, stays silent for a detached linked worktree and on main, and keeps the t/2209 nudge for a
// feature branch. Runs the real hook in a scratch repository.
// Run: node --test operations/devops/post-checkout-hook.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(here, '..', '..', '.githooks', 'post-checkout');
const haveGit = spawnSync('git', ['--version']).status === 0 && spawnSync('sh', ['-c', 'exit 0']).status === 0;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function scratchRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'post-checkout-'));
  const repo = path.join(dir, 'shared');
  mkdirSync(path.join(repo, '.githooks'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', repo);
  copyFileSync(HOOK, path.join(repo, '.githooks', 'post-checkout'));
  writeFileSync(path.join(repo, 'a.txt'), '1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  writeFileSync(path.join(repo, 'a.txt'), '2\n');
  git(repo, 'commit', '-q', '-am', 'two');
  git(repo, 'config', 'core.hooksPath', '.githooks');
  return { dir, repo };
}

test('t/565: the shared checkout going DETACHED warns loudly, naming the commit and the fix', { skip: !haveGit && 'no git or sh' }, () => {
  const { dir, repo } = scratchRepo();
  try {
    const r = git(repo, 'checkout', '-q', '--detach', 'HEAD~1');
    assert.equal(r.code, 0);
    assert.match(r.err, /WARNING: the SHARED checkout is now DETACHED at [0-9a-f]+/);
    assert.match(r.err, /git checkout main/);
    assert.match(r.err, /git worktree add --detach/);
    // Back to main: silent.
    const back = git(repo, 'checkout', '-q', 'main');
    assert.equal(back.code, 0);
    assert.doesNotMatch(back.err, /WARNING|⚠/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('t/565: a LINKED worktree may sit detached: no warning', { skip: !haveGit && 'no git or sh' }, () => {
  const { dir, repo } = scratchRepo();
  try {
    const r = git(repo, 'worktree', 'add', '-q', '--detach', path.join(dir, 'wt'), 'HEAD~1');
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.err, /WARNING|⚠/);
    const again = git(path.join(dir, 'wt'), 'checkout', '-q', '--detach', 'main');
    assert.doesNotMatch(again.err, /WARNING|⚠/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('t/2209 kept: the shared checkout on a feature branch still gets the worktree nudge', { skip: !haveGit && 'no git or sh' }, () => {
  const { dir, repo } = scratchRepo();
  try {
    const r = git(repo, 'checkout', '-q', '-b', 'feat/x');
    assert.equal(r.code, 0);
    assert.match(r.err, /The shared `main` checkout is now on 'feat\/x'/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file checkout ($3 == 0) never warns, even when detached', { skip: !haveGit && 'no git or sh' }, () => {
  const { dir, repo } = scratchRepo();
  try {
    git(repo, 'checkout', '-q', '--detach', 'HEAD~1');
    writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    const r = git(repo, 'checkout', '--', 'a.txt');
    assert.doesNotMatch(r.err, /WARNING|⚠/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
