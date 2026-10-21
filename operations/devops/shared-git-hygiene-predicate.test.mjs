// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Both-arms proof (t/4149): a deny-worthy command on the shared root warns; the same command in a
// worktree stays silent. One fault per decision site. Run:
//   node --test operations/devops/shared-git-hygiene-predicate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateSharedGitHygiene } from './shared-git-hygiene-predicate.mjs';

const MODULE_PATH = fileURLToPath(new URL('./shared-git-hygiene-predicate.mjs', import.meta.url));

// ── Rule 1: HEAD-moving verbs on the shared root ────────────────────────────────────────────────

test('bare `git reset --hard` on the shared root WARNS', () => {
  const r = evaluateSharedGitHygiene({ command: 'git reset --hard origin/main' });
  assert.equal(r.action, 'warn');
  assert.equal(r.reason, 'head-moving-verb');
  assert.equal(r.op, 'reset');
});

test('`git stash` on the shared root WARNS', () => {
  const r = evaluateSharedGitHygiene({ command: 'git stash' });
  assert.equal(r.action, 'warn');
  assert.equal(r.op, 'stash');
});

test('`git checkout -- <path>` (pathspec restore) on the shared root WARNS', () => {
  const r = evaluateSharedGitHygiene({ command: 'git checkout -- some/file.ts' });
  assert.equal(r.action, 'warn');
  assert.equal(r.op, 'checkout');
});

test('`git restore <path>` on the shared root WARNS', () => {
  const r = evaluateSharedGitHygiene({ command: 'git restore some/file.ts' });
  assert.equal(r.action, 'warn');
  assert.equal(r.op, 'restore');
});

test('the SAME command inside `cd .worktrees/foo && ...` stays SILENT', () => {
  const r = evaluateSharedGitHygiene({ command: 'cd .worktrees/foo && git stash' });
  assert.equal(r.action, 'silent');
  assert.equal(r.reason, 'no-mutating-clause-on-shared-root');
});

test('`git -C .worktrees/foo stash` (no leading cd) stays SILENT', () => {
  const r = evaluateSharedGitHygiene({ command: 'git -C .worktrees/foo stash' });
  assert.equal(r.action, 'silent');
});

// Quality review gap 2 (p/432#13): the `-C <dir>` skip inside headMovingGitVerb/
// isCommitDashAOrAddAll was previously unexercised by any test — the one `-C` test above hits the
// pre-tokenize whole-command exemption before the tokenizer ever runs, so a `-C` target that is
// NOT a worktree never reached that skip-two-words branch. Prove it's the right amount of skip,
// not an accidental "any -C anywhere" bypass.
test('`git -C operations/devops reset --hard` (a non-worktree -C target) WARNS — the -C skip only '
  + 'skips the TWO WORDS `-C <dir>`, it is not a blanket -C exemption', () => {
  const r = evaluateSharedGitHygiene({ command: 'git -C operations/devops reset --hard' });
  assert.equal(r.action, 'warn');
  assert.equal(r.reason, 'head-moving-verb');
  assert.equal(r.op, 'reset');
});

test('`git -C operations/devops commit -a -m "x"` (a non-worktree -C target) WARNS', () => {
  const r = evaluateSharedGitHygiene({ command: 'git -C operations/devops commit -a -m "x"' });
  assert.equal(r.action, 'warn');
  assert.equal(r.reason, 'commit-a-or-add-all');
});

test('a Windows backslash worktree target stays SILENT (t/4212 lesson applied here too)', () => {
  const r = evaluateSharedGitHygiene({ command: 'cd .worktrees\\foo && git reset --hard' });
  assert.equal(r.action, 'silent');
});

test('`git merge --ff-only origin/main` on the shared root stays SILENT (the r/11 sync procedure)', () => {
  const r = evaluateSharedGitHygiene({ command: 'git merge --ff-only origin/main' });
  assert.equal(r.action, 'silent');
});

test('`git pull --ff-only` on the shared root stays SILENT', () => {
  const r = evaluateSharedGitHygiene({ command: 'git pull --ff-only' });
  assert.equal(r.action, 'silent');
});

test('a bare `git merge` (no --ff-only) on the shared root WARNS — the exemption is narrow', () => {
  const r = evaluateSharedGitHygiene({ command: 'git merge feature-branch' });
  assert.equal(r.action, 'warn');
  assert.equal(r.op, 'merge');
});

test('a command that ever mentions .worktrees/ stays SILENT even if a later clause cds back out — '
  + 'deliberately coarse, whole-command exemption (module header: accepted false-negative, warn-only)', () => {
  const r = evaluateSharedGitHygiene({ command: 'cd .worktrees/foo && git status; cd ..; git reset --hard' });
  assert.equal(r.action, 'silent');
});

test('a sibling data-repo cd target (ai-triad-data) stays SILENT — out of scope per t/4149', () => {
  const r = evaluateSharedGitHygiene({ command: 'cd ../ai-triad-data && git reset --hard' });
  assert.equal(r.action, 'silent');
});

// ── Rule 2: commit -a / add -A / add . on the shared root ───────────────────────────────────────

test('`git commit -a -m "x"` on the shared root WARNS', () => {
  const r = evaluateSharedGitHygiene({ command: 'git commit -a -m "x"' });
  assert.equal(r.action, 'warn');
  assert.equal(r.reason, 'commit-a-or-add-all');
});

test('`git add -A` on the shared root WARNS', () => {
  const r = evaluateSharedGitHygiene({ command: 'git add -A' });
  assert.equal(r.action, 'warn');
});

test('`git add .` on the shared root WARNS', () => {
  const r = evaluateSharedGitHygiene({ command: 'git add .' });
  assert.equal(r.action, 'warn');
});

test('`git commit -m "x" -- path/to/file.ts` (explicit pathspec) stays SILENT', () => {
  const r = evaluateSharedGitHygiene({ command: 'git commit -m "x" -- path/to/file.ts' });
  assert.equal(r.action, 'silent');
});

test('`git add -A` INSIDE a worktree stays SILENT', () => {
  const r = evaluateSharedGitHygiene({ command: 'cd .worktrees/foo && git add -A' });
  assert.equal(r.action, 'silent');
});

test('an overlay commit (--git-dir=.orca-git) is exempt even with -a, by design (t/4149#1)', () => {
  const r = evaluateSharedGitHygiene({ command: 'git --git-dir=.orca-git --work-tree=. commit -a -m "x"' });
  assert.equal(r.action, 'silent');
});

// ── Read-only / unrelated commands never match either rule ──────────────────────────────────────

test('`git status` on the shared root stays SILENT', () => {
  const r = evaluateSharedGitHygiene({ command: 'git status' });
  assert.equal(r.action, 'silent');
  assert.equal(r.reason, 'no-mutating-clause-on-shared-root');
});

test('`git log` / `git diff` / `git show` all stay SILENT', () => {
  assert.equal(evaluateSharedGitHygiene({ command: 'git log --oneline -5' }).action, 'silent');
  assert.equal(evaluateSharedGitHygiene({ command: 'git diff --stat' }).action, 'silent');
  assert.equal(evaluateSharedGitHygiene({ command: 'git show HEAD' }).action, 'silent');
});

test('a non-git command never matches', () => {
  assert.equal(evaluateSharedGitHygiene({ command: 'npm test' }).action, 'silent');
});

// ── Empty / malformed input never throws ─────────────────────────────────────────────────────────

test('empty/undefined command — silent, not a throw', () => {
  assert.equal(evaluateSharedGitHygiene({ command: '' }).action, 'silent');
  assert.equal(evaluateSharedGitHygiene({ command: undefined }).action, 'silent');
});

// ── CLI shim (test==runtime): the actual subprocess invocation each feedback rule makes ──────────

function runCli(command) {
  return execFileSync(process.execPath, [MODULE_PATH, command], { encoding: 'utf8', timeout: 5000 });
}

test('CLI shim: head-moving verb on the shared root prints its own reason string', () => {
  assert.equal(runCli('git reset --hard origin/main'), 'head-moving-verb');
});

test('CLI shim: commit -a on the shared root prints its own reason string', () => {
  assert.equal(runCli('git commit -am "wip"'), 'commit-a-or-add-all');
});

test('CLI shim: the same head-moving verb inside a worktree prints nothing', () => {
  assert.equal(runCli('cd .worktrees/foo && git reset --hard origin/main'), '');
});

test('CLI shim: `merge --ff-only` on the shared root prints nothing (r/11 sync exemption)', () => {
  assert.equal(runCli('git merge --ff-only origin/main'), '');
});

test('CLI shim: a non-matching command prints nothing', () => {
  assert.equal(runCli('npm test'), '');
});
