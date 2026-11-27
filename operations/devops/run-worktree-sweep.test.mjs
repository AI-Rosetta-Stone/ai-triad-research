// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/9: run-worktree-sweep.mjs, the scheduled wrapper. Every refusal path runs NOTHING (Security p/278#9
// condition 4); --report-only passes --dry-run; the summary counts what the sweep printed.
// Run: node --test operations/devops/run-worktree-sweep.test.mjs

import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { run, summarize, scriptCurrency, resolveSh, SELF, DONE_LINE } from './run-worktree-sweep.mjs';

const CURRENT = () => ({ ok: true, reason: 'current', mainSha: 'abc123', paths: [SELF] });
const quiet = (fn) => async () => {
  const restore = [mock.method(console, 'log', () => {}), mock.method(console, 'error', () => {}), mock.method(console, 'warn', () => {})];
  try { await fn(); } finally { restore.forEach((m) => m.mock.restore()); }
};

test('summarize counts removals, would-removes, skips and keeps WARN lines', () => {
  const s = summarize([
    'sweep-landed-worktrees: removed /a (a, PR MERGED at its head)',
    'sweep-landed-worktrees: WOULD remove /b (b, PR MERGED at its head)',
    'sweep-landed-worktrees: skip /c (c): PR OPEN, not merged',
    'sweep-landed-worktrees: WARN /d (d) has merged (PR MERGED at its head) but is not clean: 1 modified/staged, 0 untracked.',
    'sweep-landed-worktrees: deleted local branch a',
  ].join('\n'));
  assert.deepEqual({ ...s, warnings: s.warnings.length }, { removed: 1, wouldRemove: 1, skipped: 1, warnings: 1 });
});

test('scriptCurrency: equal (CRLF-insensitive) passes; different, missing on main, or unreadable refuses', () => {
  assert.equal(scriptCurrency('a\r\nb\n', 'a\nb\n').ok, true);
  assert.equal(scriptCurrency('a\n', 'b\n').reason, 'differs');
  assert.equal(scriptCurrency('a\n', null).reason, 'missing_on_main');
  assert.equal(scriptCurrency(null, 'a\n').reason, 'read_failed');
});

test('a failed running-copy check runs NOTHING and exits 1', quiet(async () => {
  let swept = false;
  const code = await run({ reportOnly: false, currency: () => ({ ok: false, reason: 'differs', detail: SELF }), sweep: () => { swept = true; return { status: 0 }; } });
  assert.equal(code, 1);
  assert.equal(swept, false);
}));

test('a sweep script that differs from origin/main runs NOTHING and exits 1', quiet(async () => {
  let swept = false;
  const code = await run({ reportOnly: false, currency: CURRENT, gitFn: () => 'main copy\n', readLocal: () => 'edited copy\n', sweep: () => { swept = true; return { status: 0 }; } });
  assert.equal(code, 1);
  assert.equal(swept, false);
}));

test('a sweep script git cannot read from origin/main runs NOTHING (fail closed)', quiet(async () => {
  let swept = false;
  const code = await run({ reportOnly: true, currency: CURRENT, gitFn: () => { throw new Error('fatal'); }, readLocal: () => 'x\n', sweep: () => { swept = true; return { status: 0 }; } });
  assert.equal(code, 1);
  assert.equal(swept, false);
}));

test('current copy: runs the sweep, exits 0, and a failed sweep exits 1', quiet(async () => {
  const gitFn = (args) => (args[0] === 'show' ? 'same\n' : '.git');
  let calls = 0;
  const ok = await run({ reportOnly: true, currency: CURRENT, gitFn, readLocal: () => 'same\n', sweep: () => { calls += 1; return { status: 0, stdout: `sweep-landed-worktrees: WOULD remove /b (b, PR MERGED at its head)\n${DONE_LINE}\n`, stderr: '' }; } });
  assert.equal(ok, 0);
  assert.equal(calls, 1);
  const bad = await run({ reportOnly: true, currency: CURRENT, gitFn, readLocal: () => 'same\n', sweep: () => ({ status: 2, stdout: '', stderr: 'boom' }) });
  assert.equal(bad, 1);
}));

test('t/727: a sweep that exits 0 without its completion line is NOT reported ok (SO t/727#3)', async () => {
  const gitFn = (args) => (args[0] === 'show' ? 'same\n' : '.git');
  const attempt = async (stdout, stderr = '') => {
    const logs = []; const errors = [];
    const restore = [mock.method(console, 'log', (l) => logs.push(String(l))), mock.method(console, 'error', (l) => errors.push(String(l))), mock.method(console, 'warn', () => {})];
    try {
      const code = await run({ reportOnly: true, currency: CURRENT, gitFn, readLocal: () => 'same\n', sweep: () => ({ status: 0, stdout, stderr }) });
      return { code, last: JSON.parse(logs.at(-1)), errors: errors.join('\n') };
    } finally { restore.forEach((m) => m.mock.restore()); }
  };
  // A shell that ran nothing; the script's own early exit when gh is missing; a line that only resembles it.
  for (const [stdout, stderr] of [['', ''], ['', 'sweep-landed-worktrees: WARN gh not found; skipping sweep (no PR state available)\n'], ['sweep-landed-worktrees: done early\n', '']]) {
    const r = await attempt(stdout, stderr);
    assert.equal(r.code, 1, JSON.stringify([stdout, stderr]));
    assert.deepEqual({ ok: r.last.ok, failed: r.last.failed, reason: r.last.reason }, { ok: false, failed: true, reason: 'sweep_incomplete' });
    assert.match(r.errors, /did not complete/);
  }
  // The passing arm: nothing to do, but the walk finished.
  const clean = await attempt(`${DONE_LINE}\n`);
  assert.equal(clean.code, 0);
  assert.deepEqual({ ok: clean.last.ok, removed: clean.last.removed, wouldRemove: clean.last.wouldRemove }, { ok: true, removed: 0, wouldRemove: 0 });
});

test('t/727: the real sweep script ends with the completion line the wrapper requires', () => {
  const sh = readFileSync(new URL('./sweep-landed-worktrees.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(sh, new RegExp(`\\necho "${DONE_LINE}"\\nexit 0\\n?$`), 'the last two lines print DONE_LINE and exit 0');
  assert.equal(sh.split(`echo "${DONE_LINE}"`).length, 2, 'printed in exactly one place, so no early exit can print it');
});

test('resolveSh: a relative PATH entry is ignored (it would resolve against the repo root)', () => {
  const r = resolveSh({ platform: 'linux', env: { PATH: 'bin:.:/usr/bin' }, exists: (f) => f === 'bin/sh' || f === 'sh' || f === '/usr/bin/sh' });
  assert.deepEqual(r, { sh: '/usr/bin/sh', how: 'path', searched: ['/usr/bin/sh'] });
  const w = resolveSh({ platform: 'win32', env: { PATH: 'tools;C:\\Git\\bin' }, exists: () => true, gitExecPath: () => '' });
  assert.equal(w.sh, 'C:\\Git\\bin\\sh.exe');
});

// ── t/727: finding sh (the scheduled task's PATH has Git\cmd but not Git\bin) ─────────────────────
const GIT = 'C:\\Program Files\\Git';
const has = (...files) => (f) => files.includes(f);

test('resolveSh: sh on PATH is used as found, with no fallback', () => {
  const r = resolveSh({ platform: 'win32', env: { PATH: `C:\\Windows;${GIT}\\bin` }, exists: has(`${GIT}\\bin\\sh.exe`), gitExecPath: () => { throw new Error('must not be asked'); } });
  assert.deepEqual({ sh: r.sh, how: r.how }, { sh: `${GIT}\\bin\\sh.exe`, how: 'path' });
  const posix = resolveSh({ platform: 'linux', env: { PATH: '/usr/local/bin:/bin' }, exists: has('/bin/sh') });
  assert.deepEqual({ sh: posix.sh, how: posix.how }, { sh: '/bin/sh', how: 'path' });
});

test('resolveSh: the task\'s PATH (Git\\cmd only) falls back to Git for Windows\' own sh, from git --exec-path', () => {
  const r = resolveSh({ platform: 'win32', env: { PATH: `C:\\Windows;${GIT}\\cmd` }, exists: has(`${GIT}\\bin\\sh.exe`), gitExecPath: () => 'C:/Program Files/Git/mingw64/libexec/git-core\n' });
  assert.deepEqual({ sh: r.sh, how: r.how }, { sh: `${GIT}\\bin\\sh.exe`, how: 'git-install' });
  // git cannot say where it lives: the usual install folders are still tried.
  const viaEnv = resolveSh({ platform: 'win32', env: { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, exists: has(`${GIT}\\usr\\bin\\sh.exe`), gitExecPath: () => '' });
  assert.deepEqual({ sh: viaEnv.sh, how: viaEnv.how }, { sh: `${GIT}\\usr\\bin\\sh.exe`, how: 'git-install' });
});

test('resolveSh: no sh anywhere returns null and names every place it looked; it never guesses', () => {
  const r = resolveSh({ platform: 'win32', env: { PATH: `C:\\Windows;${GIT}\\cmd`, ProgramFiles: 'C:\\Program Files' }, exists: () => false, gitExecPath: () => 'C:/Program Files/Git/mingw64/libexec/git-core' });
  assert.equal(r.sh, null);
  for (const p of ['C:\\Windows\\sh.exe', `${GIT}\\cmd\\sh.exe`, `${GIT}\\bin\\sh.exe`, `${GIT}\\usr\\bin\\sh.exe`]) assert.ok(r.searched.includes(p), `searched ${p}`);
  const posix = resolveSh({ platform: 'linux', env: { PATH: '/opt/x' }, exists: () => false });
  assert.deepEqual(posix, { sh: null, searched: ['/opt/x/sh'] });
  assert.deepEqual(resolveSh({ platform: 'linux', env: {}, exists: () => false }), { sh: null, searched: [] });
});

test('run: with no sh the sweep is reported as NOT run (exit 1, an error naming where it looked), never as clean', async () => {
  const errors = []; const logs = [];
  const restore = [mock.method(console, 'log', (l) => logs.push(String(l))), mock.method(console, 'error', (l) => errors.push(String(l))), mock.method(console, 'warn', () => {})];
  let code;
  try {
    code = await run({ reportOnly: true, currency: CURRENT, gitFn: (args) => (args[0] === 'show' ? 'same\n' : '.git'), readLocal: () => 'same\n', findSh: () => ({ sh: null, searched: ['C:\\Windows\\sh.exe'] }) });
  } finally { restore.forEach((m) => m.mock.restore()); }
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /Problem: no sh was found/);
  assert.match(errors.join('\n'), /C:\\Windows\\sh\.exe/);
  assert.match(errors.join('\n'), /Next steps:/);
  const last = JSON.parse(logs.at(-1));
  assert.deepEqual({ ok: last.ok, failed: last.failed, reason: last.reason }, { ok: false, failed: true, reason: 'sh_not_found' });
});

test('run: a fallback sh is used, and the WARN saying so is printed', async () => {
  const warns = [];
  const restore = [mock.method(console, 'log', () => {}), mock.method(console, 'error', () => {}), mock.method(console, 'warn', (l) => warns.push(String(l)))];
  let code;
  try {
    // node itself stands in for the found sh: it exists, and it fails on the .sh file, which is all this
    // test needs (the spawn used the path it was given, and the WARN was logged before it).
    code = await run({ reportOnly: true, currency: CURRENT, gitFn: (args) => (args[0] === 'show' ? 'same\n' : '.git'), readLocal: () => 'same\n', findSh: () => ({ sh: process.execPath, how: 'git-install', searched: [] }) });
  } finally { restore.forEach((m) => m.mock.restore()); }
  assert.equal(code, 1, 'node cannot run the shell script, so the sweep is reported as failed');
  assert.ok(warns.some((w) => /sh is not on PATH; using Git for Windows' own at /.test(w) && w.includes(process.execPath)));
});

// ── t/718 step 1: the remote-branch pass (report only) ──

async function runWithRemote(remotePass) {
  const logs = [];
  const restore = [mock.method(console, 'log', (l) => logs.push(String(l))), mock.method(console, 'error', () => {}), mock.method(console, 'warn', () => {})];
  let code;
  try {
    code = await run({
      reportOnly: true, currency: CURRENT, gitFn: (args) => (args[0] === 'show' ? 'same\n' : '.git'), readLocal: () => 'same\n',
      sweep: () => ({ status: 0, stdout: `sweep-landed-worktrees: skip /c (c): PR OPEN, not merged\n${DONE_LINE}\n`, stderr: '' }), remotePass,
    });
  } finally { restore.forEach((m) => m.mock.restore()); }
  return { code, logs, json: JSON.parse(logs.filter((l) => l.startsWith('{')).pop()) };
}

test('t/718: the remote-branch pass summary is printed, its counts go in the JSON line, and it adds no WARN', async () => {
  const counts = { withoutPr: 3, ancestor: 1, patchEquivalent: 1, unmerged: 1, protected: 4 };
  const r = await runWithRemote(() => ({ evaluated: true, lines: ['remote-branch: ancestor feat/t1-a tip=aaaaaaaaa pushed=2026-11-26 ticket=t/1'], summary: 'remote branches: 3 without a PR; 1 ancestor, 1 patch-equivalent, 1 unmerged; 4 protected (report only, nothing deleted)', counts }));
  assert.equal(r.code, 0);
  assert.ok(r.logs.some((l) => l.startsWith('run-worktree-sweep: remote branches: 3 without a PR;')));
  assert.deepEqual(r.json.remoteBranches, { evaluated: true, ...counts });
  assert.deepEqual(r.json.warnings, [], 'the pass raises no WARN, so the wrapper does not ping daily');
});

test('t/718: a remote pass that cannot evaluate, or that throws, never fails the sweep and says so', async () => {
  const cannot = await runWithRemote(() => ({ evaluated: false, lines: [], summary: 'remote branches: could not evaluate (open PR list: rate limit); nothing listed as merged', counts: null }));
  assert.equal(cannot.code, 0);
  assert.equal(cannot.json.remoteBranches.evaluated, false);
  assert.ok(cannot.logs.some((l) => /could not evaluate \(open PR list: rate limit\)/.test(l)));
  const threw = await runWithRemote(() => { throw new Error('boom'); });
  assert.equal(threw.code, 0, 'a crash in the pass is not a sweep failure');
  assert.equal(threw.json.remoteBranches.evaluated, false);
  assert.ok(threw.logs.some((l) => /could not evaluate \(boom\)/.test(l)));
});

test('t/718: without a remotePass (a test run) nothing remote is read; the CLI wires the real pass', async () => {
  const none = await runWithRemote(null);
  assert.equal(none.json.remoteBranches, null);
  const src = readFileSync(new URL('./run-worktree-sweep.mjs', import.meta.url), 'utf8');
  assert.match(src, /run\(\{ reportOnly: args\.includes\('--report-only'\), remotePass: \(\) => remoteBranchPass\(\) \}\)/);
});
