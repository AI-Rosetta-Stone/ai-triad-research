// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Both-arms proof (t/4212, TL design review t/4212#2, acceptance criterion 2) — one fault per
// decision site: a non-owner mutation warns, the owner's own mutation and a read-only command stay
// silent, and an absent/empty identity on either side counts as unknown, never a match. Run:
//   node --test operations/devops/worktree-owner-core.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractCdTarget,
  resolveWorktree,
  ownerVerdict,
  detectMutatingGitOp,
  extractRmTarget,
  extractOverrideTicket,
  evaluateShellCommand,
  evaluateFilePath,
  canonAbs,
} from './worktree-owner-core.mjs';

// ── extractCdTarget (TL cond. 1: parse the COMMAND, never the session cwd) ─────────────────────────

test('extractCdTarget: bash `cd <dir> &&`', () => {
  assert.equal(extractCdTarget('cd .worktrees/foo && git stash'), '.worktrees/foo');
});

test('extractCdTarget: bash `cd <dir>;`', () => {
  assert.equal(extractCdTarget('cd .worktrees/foo; git stash pop'), '.worktrees/foo');
});

test('extractCdTarget: PowerShell `Set-Location <dir>;`', () => {
  assert.equal(extractCdTarget("Set-Location .worktrees/foo; git commit -m x"), '.worktrees/foo');
});

test('extractCdTarget: `git -C <dir>` wins even without a leading cd', () => {
  assert.equal(extractCdTarget('git -C .worktrees/foo stash'), '.worktrees/foo');
});

test('extractCdTarget: `--git-dir=` form', () => {
  assert.equal(extractCdTarget('git --git-dir=.worktrees/foo/.git stash'), '.worktrees/foo/.git');
});

test('extractCdTarget: no cd/-C present → empty (runs at session cwd)', () => {
  assert.equal(extractCdTarget('git status'), '');
});

// ── resolveWorktree ──────────────────────────────────────────────────────────────────────────────

const ROOT = 'C:/repo';

test('resolveWorktree: under root .worktrees/<name> resolves the name', () => {
  const r = resolveWorktree('C:/repo/.worktrees/foo', ROOT);
  assert.equal(r.name, 'foo');
});

test('resolveWorktree: a subpath still resolves to the same worktree', () => {
  const r = resolveWorktree('C:/repo/.worktrees/foo/src/x.ts', ROOT);
  assert.equal(r.name, 'foo');
});

test('resolveWorktree: the shared main checkout (not under .worktrees) is exempt — returns null', () => {
  assert.equal(resolveWorktree('C:/repo', ROOT), null);
  assert.equal(resolveWorktree('C:/repo/lib/debate', ROOT), null);
});

test('resolveWorktree: a relative path resolves against the given cwd', () => {
  const r = resolveWorktree('.worktrees/foo', ROOT, ROOT);
  assert.equal(r.name, 'foo');
});

test('resolveWorktree: a relative path from a DIFFERENT cwd resolves there, not under root — null', () => {
  // TL cond. 1: the session cwd always resets to the role's scope dir, so a relative `.worktrees/foo`
  // is only realistic when the real shell cwd IS the repo root — from any other cwd it genuinely
  // would NOT reach the root's worktree, and this guard must resolve it exactly as the real shell
  // would, not as the agent probably intended.
  const r = resolveWorktree('.worktrees/foo', ROOT, 'C:/repo/operations/devops');
  assert.equal(r, null);
});

// ── ownerVerdict (TL cond. 3: empty on EITHER side is unknown, never a match) ───────────────────────

test('ownerVerdict: both present and equal → match', () => {
  assert.equal(ownerVerdict('agent-a', 'agent-a'), 'match');
});

test('ownerVerdict: both present and different → mismatch', () => {
  assert.equal(ownerVerdict('agent-a', 'agent-b'), 'mismatch');
});

test('ownerVerdict: empty owner → unknown, NOT a match, even if caller id is also empty', () => {
  assert.equal(ownerVerdict('', ''), 'unknown');
  assert.equal(ownerVerdict('', 'agent-a'), 'unknown');
  assert.equal(ownerVerdict('agent-a', ''), 'unknown');
});

// ── detectMutatingGitOp (owner commands and read-only commands must never warn) ─────────────────────

test('detectMutatingGitOp: matches the TL-enumerated mutating subcommands', () => {
  assert.equal(detectMutatingGitOp('git commit -m x'), 'commit');
  assert.equal(detectMutatingGitOp('git stash'), 'stash');
  assert.equal(detectMutatingGitOp('git stash pop'), 'stash');
  assert.equal(detectMutatingGitOp('git checkout -- file.ts'), 'checkout--');
  assert.equal(detectMutatingGitOp('git restore file.ts'), 'restore');
  assert.equal(detectMutatingGitOp('git reset --hard'), 'reset');
  assert.equal(detectMutatingGitOp('git merge main'), 'merge');
  assert.equal(detectMutatingGitOp('git rebase main'), 'rebase');
  assert.equal(detectMutatingGitOp('git clean -fd'), 'clean');
  assert.equal(detectMutatingGitOp('git worktree remove --force .worktrees/foo'), 'worktree-remove');
  assert.equal(detectMutatingGitOp('git worktree prune'), 'worktree-prune');
});

test('detectMutatingGitOp: a branch-switch `checkout` is NOT a pathspec restore — no match', () => {
  assert.equal(detectMutatingGitOp('git checkout main'), '');
});

test('detectMutatingGitOp: read-only commands never match', () => {
  for (const c of ['git status', 'git diff', 'git log', 'git show HEAD']) {
    assert.equal(detectMutatingGitOp(c), '', c);
  }
});

// ── extractRmTarget / extractOverrideTicket ─────────────────────────────────────────────────────────

test('extractRmTarget: bash `rm -rf <path>`', () => {
  assert.equal(extractRmTarget('rm -rf .worktrees/foo'), '.worktrees/foo');
});

test('extractRmTarget: PowerShell `Remove-Item <path> -Recurse -Force`', () => {
  assert.equal(extractRmTarget('Remove-Item .worktrees/foo -Recurse -Force'), '.worktrees/foo');
});

test('extractRmTarget: not an rm/Remove-Item → empty', () => {
  assert.equal(extractRmTarget('git status'), '');
});

test('extractOverrideTicket: bash inline form', () => {
  assert.equal(extractOverrideTicket('ORCA_WT_OVERRIDE=t/4212 git stash'), 't/4212');
});

test('extractOverrideTicket: PowerShell inline form', () => {
  assert.equal(extractOverrideTicket("$env:ORCA_WT_OVERRIDE='t/4212'; git stash"), 't/4212');
});

test('extractOverrideTicket: absent → empty', () => {
  assert.equal(extractOverrideTicket('git stash'), '');
});

// ── evaluateShellCommand / evaluateFilePath — full integration over a real tmp "repo" ───────────────

function makeRepoWithOwner(ownerId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtowner-'));
  const admin = path.join(root, '.git', 'worktrees', 'foo');
  fs.mkdirSync(admin, { recursive: true });
  if (ownerId !== undefined) fs.writeFileSync(path.join(admin, 'orca-owner'), ownerId);
  return root;
}

test('evaluateShellCommand: non-owner `cd .worktrees/foo && git stash` WARNS (today\'s real collision)', () => {
  const root = makeRepoWithOwner('agent-owner');
  const r = evaluateShellCommand({
    command: 'cd .worktrees/foo && git stash',
    callerId: 'agent-other',
    repoRoot: root,
    cwd: root,
  });
  assert.equal(r.action, 'warn');
  assert.equal(r.reason, 'mismatch');
  assert.equal(r.worktreeName, 'foo');
});

test('evaluateShellCommand: the OWNER\'s own `cd .worktrees/foo && git stash` is SILENT', () => {
  const root = makeRepoWithOwner('agent-owner');
  const r = evaluateShellCommand({
    command: 'cd .worktrees/foo && git stash',
    callerId: 'agent-owner',
    repoRoot: root,
    cwd: root,
  });
  assert.equal(r.action, 'silent');
  assert.equal(r.reason, 'owner-match');
});

test('evaluateShellCommand: a read-only command in a non-owner worktree is SILENT', () => {
  const root = makeRepoWithOwner('agent-owner');
  const r = evaluateShellCommand({
    command: 'cd .worktrees/foo && git status',
    callerId: 'agent-other',
    repoRoot: root,
    cwd: root,
  });
  assert.equal(r.action, 'silent');
  assert.equal(r.reason, 'not-a-mutating-command');
});

test('evaluateShellCommand: an UNKNOWN owner (no orca-owner file) WARNS, not silent (fail-closed)', () => {
  const root = makeRepoWithOwner(undefined);
  const r = evaluateShellCommand({
    command: 'cd .worktrees/foo && git stash',
    callerId: 'agent-other',
    repoRoot: root,
    cwd: root,
  });
  assert.equal(r.action, 'warn');
  assert.equal(r.reason, 'unknown');
});

test('evaluateShellCommand: an EMPTY orca-owner file WARNS, not silent, even for the "owner"', () => {
  const root = makeRepoWithOwner('');
  const r = evaluateShellCommand({
    command: 'cd .worktrees/foo && git stash',
    callerId: '',
    repoRoot: root,
    cwd: root,
  });
  assert.equal(r.action, 'warn');
  assert.equal(r.reason, 'unknown');
});

test('evaluateShellCommand: the shared main checkout (no cd, no -C) is exempt — SILENT', () => {
  const root = makeRepoWithOwner('agent-owner');
  const r = evaluateShellCommand({
    command: 'git stash',
    callerId: 'agent-other',
    repoRoot: root,
    cwd: root,
  });
  assert.equal(r.action, 'silent');
  assert.equal(r.reason, 'not-under-worktrees-root');
});

test('evaluateShellCommand: the override token bypasses a real mismatch — SILENT, ticket captured', () => {
  const root = makeRepoWithOwner('agent-owner');
  const r = evaluateShellCommand({
    command: 'cd .worktrees/foo && ORCA_WT_OVERRIDE=t/4212 git stash',
    callerId: 'agent-other',
    repoRoot: root,
    cwd: root,
  });
  assert.equal(r.action, 'silent');
  assert.equal(r.reason, 'override-used');
  assert.equal(r.overrideTicket, 't/4212');
});

test('evaluateShellCommand: `git worktree remove --force` on a non-owner worktree WARNS', () => {
  const root = makeRepoWithOwner('agent-owner');
  const r = evaluateShellCommand({
    command: 'git worktree remove --force .worktrees/foo',
    callerId: 'agent-other',
    repoRoot: root,
    cwd: root,
  });
  assert.equal(r.action, 'warn');
  assert.equal(r.op, 'worktree-remove');
});

test('evaluateShellCommand: `rm -rf` of a non-owner worktree root WARNS (blank #2, TL cond. 4)', () => {
  const root = makeRepoWithOwner('agent-owner');
  const r = evaluateShellCommand({
    command: 'rm -rf .worktrees/foo',
    callerId: 'agent-other',
    repoRoot: root,
    cwd: root,
  });
  assert.equal(r.action, 'warn');
  assert.equal(r.worktreeName, 'foo');
});

test('evaluateFilePath: an Edit under a non-owner worktree WARNS (blank #1, TL cond. 4)', () => {
  const root = makeRepoWithOwner('agent-owner');
  const r = evaluateFilePath({
    filePath: path.join(root, '.worktrees', 'foo', 'src', 'x.ts'),
    callerId: 'agent-other',
    repoRoot: root,
  });
  assert.equal(r.action, 'warn');
  assert.equal(r.op, 'edit');
});

test('evaluateFilePath: the OWNER\'s own Edit is SILENT', () => {
  const root = makeRepoWithOwner('agent-owner');
  const r = evaluateFilePath({
    filePath: path.join(root, '.worktrees', 'foo', 'src', 'x.ts'),
    callerId: 'agent-owner',
    repoRoot: root,
  });
  assert.equal(r.action, 'silent');
  assert.equal(r.reason, 'owner-match');
});

test('evaluateFilePath: a file outside .worktrees/ (shared tree) is exempt — SILENT', () => {
  const root = makeRepoWithOwner('agent-owner');
  const r = evaluateFilePath({
    filePath: path.join(root, 'lib', 'debate', 'x.ts'),
    callerId: 'agent-other',
    repoRoot: root,
  });
  assert.equal(r.action, 'silent');
  assert.equal(r.reason, 'not-under-worktrees-root');
});

// ── canonAbs normalization (reused from worktree-target-guard's proven idiom) ───────────────────────

test('canonAbs: Windows backslash + drive-case fold to the same canonical form', () => {
  assert.equal(canonAbs('C:/repo/.worktrees/foo'), canonAbs('c:\\repo\\.worktrees\\foo'));
});
