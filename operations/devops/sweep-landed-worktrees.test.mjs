// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/9 (PI rule p/4#32; TL p/12#242): end-to-end arms for operations/devops/sweep-landed-worktrees.sh.
// Each test builds a throwaway origin + clone with real linked worktrees, and points SWEEP_GH at a fake
// `gh` that answers `gh pr view <branch> ...` from a map. Rule under test: remove a worktree only when its
// PR has MERGED (at its head, or with HEAD on origin/main) AND its tree is clean; WARN and skip a merged
// tree that is not clean; never touch an unmerged, PR-less, detached or locked worktree; never --force.
//
// Run: node --test operations/devops/sweep-landed-worktrees.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'sweep-landed-worktrees.sh');
const bash = process.platform === 'win32' ? 'bash.exe' : 'bash';
const haveBash = spawnSync(bash, ['-c', 'true']).status === 0;
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

function sh(cwd, cmd) {
  const r = spawnSync(bash, ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr}`);
  return r.stdout.trim();
}

/** origin (bare) + clone `repo` with one commit on main; returns paths and helpers. */
function setup() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');
  sh(tmp, `git init -q --bare -b main "${posix(origin)}"`);
  sh(tmp, `git clone -q "${posix(origin)}" "${posix(repo)}" 2>/dev/null; cd "${posix(repo)}" && git config user.email t@t && git config user.name t && git config core.hooksPath /nonexistent && echo a > a.txt && git add a.txt && git commit -qm base && git push -q origin HEAD:main`);
  const prMap = path.join(tmp, 'prs.txt');
  writeFileSync(prMap, '');
  const fakeGh = path.join(tmp, 'gh');
  // gh pr view <branch> --json ... -q ...  ->  "STATE HEADSHA" from prs.txt (branch|STATE|sha), else exit 1.
  writeFileSync(fakeGh, `#!/bin/bash\nline=$(grep "^$3|" "${posix(prMap)}" | head -1)\n[ -z "$line" ] && exit 1\nIFS='|' read -r b s h <<< "$line"\necho "$s $h"\n`);
  chmodSync(fakeGh, 0o755);
  const wt = (name, { commit = false, push = false } = {}) => {
    const p = path.join(tmp, 'wt', name);
    sh(repo, `git worktree add -q -b ${name} "${posix(p)}" origin/main 2>/dev/null || git worktree add -q -b ${name} "${posix(p)}" main`);
    if (commit) sh(p, `echo ${name} > ${name}.txt && git add ${name}.txt && git commit -qm ${name}`);
    if (push) sh(p, 'git push -q origin HEAD:main');
    return { path: p, head: sh(p, 'git rev-parse HEAD') };
  };
  const pr = (branch, state, sha) => sh(tmp, `echo "${branch}|${state}|${sha}" >> "${posix(prMap)}"`);
  const run = () => {
    const r = spawnSync(bash, [posix(SCRIPT)], { cwd: repo, encoding: 'utf8', env: { ...process.env, SWEEP_GH: posix(fakeGh) } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const branchExists = (b) => spawnSync(bash, ['-c', `git rev-parse -q --verify refs/heads/${b}`], { cwd: repo }).status === 0;
  return { repo, wt, pr, run, branchExists };
}

const opts = { skip: !haveBash && 'bash not available' };

test('merged PR at its head + clean tree -> removed, local branch deleted', opts, () => {
  const s = setup();
  const w = s.wt('done1', { commit: true });
  s.pr('done1', 'MERGED', w.head);
  const r = s.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /removed .*done1 \(done1, PR MERGED at its head\)/);
  assert.equal(existsSync(w.path), false);
  assert.equal(s.branchExists('done1'), false);
});

test('merged PR, HEAD differs from the PR head but is on origin/main (squash/rebase landed) + clean -> removed', opts, () => {
  const s = setup();
  const w = s.wt('landed', { commit: true, push: true });
  s.pr('landed', 'MERGED', '0000000000000000000000000000000000000000');
  const r = s.run();
  assert.match(r.out, /removed .*landed \(landed, PR MERGED, HEAD on origin\/main\)/);
  assert.equal(existsSync(w.path), false);
});

test('merged PR but an UNTRACKED file -> WARN naming it, left in place', opts, () => {
  const s = setup();
  const w = s.wt('dirty1', { commit: true });
  s.pr('dirty1', 'MERGED', w.head);
  writeFileSync(path.join(w.path, 'notes.txt'), 'keep me');
  const r = s.run();
  assert.match(r.out, /WARN .*dirty1 \(dirty1\) has merged .* not clean: 0 modified\/staged, 1 untracked/);
  assert.equal(existsSync(path.join(w.path, 'notes.txt')), true);
  assert.equal(s.branchExists('dirty1'), true);
});

test('merged PR but a MODIFIED tracked file -> WARN, left in place', opts, () => {
  const s = setup();
  const w = s.wt('dirty2', { commit: true });
  s.pr('dirty2', 'MERGED', w.head);
  writeFileSync(path.join(w.path, 'a.txt'), 'changed');
  const r = s.run();
  assert.match(r.out, /WARN .*dirty2 .* not clean: 1 modified\/staged, 0 untracked/);
  assert.equal(existsSync(w.path), true);
});

test('a fresh worktree cut from main with NO PR (on origin/main, clean) is never swept', opts, () => {
  const s = setup();
  const w = s.wt('fresh');
  const r = s.run();
  assert.doesNotMatch(r.out, /fresh/);
  assert.equal(existsSync(w.path), true);
});

test('an OPEN PR is left alone, silently', opts, () => {
  const s = setup();
  const w = s.wt('wip', { commit: true });
  s.pr('wip', 'OPEN', w.head);
  const r = s.run();
  assert.doesNotMatch(r.out, /wip/);
  assert.equal(existsSync(w.path), true);
});

test('merged PR but HEAD has a commit that never reached main -> skip with the reason, left in place', opts, () => {
  const s = setup();
  const w = s.wt('extra', { commit: true });
  s.pr('extra', 'MERGED', w.head);
  sh(w.path, 'echo more > more.txt && git add more.txt && git commit -qm more');
  const r = s.run();
  assert.match(r.out, /skip .*extra \(extra\): HEAD [0-9a-f]+ is neither PR head/);
  assert.equal(existsSync(w.path), true);
});

test('a detached worktree is left alone', opts, () => {
  const s = setup();
  const p = path.join(path.dirname(s.repo), 'wt', 'det');
  sh(s.repo, `git worktree add -q --detach "${posix(p)}" main`);
  const r = s.run();
  assert.equal(r.code, 0);
  assert.equal(existsSync(p), true);
});

test('--dry-run reports WOULD remove and removes nothing', opts, () => {
  const s = setup();
  const w = s.wt('dry', { commit: true });
  s.pr('dry', 'MERGED', w.head);
  const r = spawnSync(bash, [posix(SCRIPT), '--dry-run'], { cwd: s.repo, encoding: 'utf8', env: { ...process.env, SWEEP_GH: posix(path.join(path.dirname(s.repo), 'gh')) } });
  assert.match(`${r.stdout}${r.stderr}`, /WOULD remove .*dry/);
  assert.equal(existsSync(w.path), true);
});
