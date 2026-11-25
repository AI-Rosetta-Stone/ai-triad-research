// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/9: run-worktree-sweep.mjs, the scheduled wrapper. Every refusal path runs NOTHING (Security p/278#9
// condition 4); --report-only passes --dry-run; the summary counts what the sweep printed.
// Run: node --test operations/devops/run-worktree-sweep.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { run, summarize, scriptCurrency, SELF } from './run-worktree-sweep.mjs';

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
  const ok = await run({ reportOnly: true, currency: CURRENT, gitFn, readLocal: () => 'same\n', sweep: () => { calls += 1; return { status: 0, stdout: 'sweep-landed-worktrees: WOULD remove /b (b, PR MERGED at its head)\n', stderr: '' }; } });
  assert.equal(ok, 0);
  assert.equal(calls, 1);
  const bad = await run({ reportOnly: true, currency: CURRENT, gitFn, readLocal: () => 'same\n', sweep: () => ({ status: 2, stdout: '', stderr: 'boom' }) });
  assert.equal(bad, 1);
}));
