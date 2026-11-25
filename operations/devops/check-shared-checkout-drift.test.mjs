// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/557: shared-checkout drift alert. Every reason, the fetch-failure path and an OK case, with an
// injected git (no network), plus the once-per-state ledger.
// Run: node --test operations/devops/check-shared-checkout-drift.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDrift, driftVerdict, run, stateKey, MAX_BEHIND_COMMITS } from './check-shared-checkout-drift.mjs';

const NOW = Date.parse('2026-11-25T01:00:00Z');
const sec = (iso) => String(Date.parse(iso) / 1000);

/** A fake git: { branch, ahead, behind, times: [iso], status, fetchFails } */
function fakeGit({ branch = 'main', ahead = 0, behind = 0, times = [], status = '', fetchFails = false } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'fetch') { if (fetchFails) throw Object.assign(new Error('fatal: unable to access origin'), { stderr: 'fatal: unable to access origin\n' }); return ''; }
    if (args[0] === 'rev-parse') return `${branch}\n`;
    if (args[0] === 'rev-list') return `${ahead}\t${behind}\n`;
    if (args[0] === 'log') return `${times.map(sec).join('\n')}\n`;
    if (args[0] === 'status') return status;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  git.calls = calls;
  return git;
}
const judge = (opts) => driftVerdict(collectDrift(fakeGit(opts)), NOW);

test('OK: on main, level with origin/main, clean', () => {
  const r = judge({});
  assert.equal(r.verdict, 'OK');
  assert.deepEqual(r.reasons, []);
});

test('OK: a little behind (<= 10 commits) and recently (< 2 h)', () => {
  const r = judge({ behind: 3, times: ['2026-11-25T00:30:00Z', '2026-11-25T00:45:00Z', '2026-11-25T00:50:00Z'] });
  assert.equal(r.verdict, 'OK');
  assert.equal(r.oldestMissingAgeMinutes, 30);
});

test('ALERT not-on-main', () => {
  assert.deepEqual(judge({ branch: 'feature/x' }).reasons, ['not-on-main']);
});

test('ALERT ahead-of-origin (diverged)', () => {
  assert.deepEqual(judge({ ahead: 1 }).reasons, ['ahead-of-origin']);
});

test('ALERT tracked-modifications, naming the paths (untracked files are not asked for)', () => {
  const git = fakeGit({ status: ' M AGENTS.md\nM  operations/devops/x.mjs\n' });
  const r = driftVerdict(collectDrift(git), NOW);
  assert.deepEqual(r.reasons, ['tracked-modifications']);
  assert.deepEqual(r.trackedMods, ['AGENTS.md', 'operations/devops/x.mjs']);
  assert.ok(git.calls.includes('status --porcelain --untracked-files=no'));
});

test(`ALERT behind-too-many-commits (> ${MAX_BEHIND_COMMITS}), even when recent`, () => {
  const times = Array.from({ length: 11 }, () => '2026-11-25T00:55:00Z');
  assert.deepEqual(judge({ behind: 11, times }).reasons, ['behind-too-many-commits']);
  assert.equal(judge({ behind: 10, times: times.slice(1) }).verdict, 'OK', '10 is still within the limit');
});

test('ALERT behind-too-long (oldest missing commit older than 2 h), even when only 1 behind', () => {
  const r = judge({ behind: 1, times: ['2026-11-24T22:30:00Z'] });
  assert.deepEqual(r.reasons, ['behind-too-long']);
  assert.equal(r.oldestMissingAgeMinutes, 150);
});

test('the t/537#40 shape (71 behind, ~29 h): both behind reasons', () => {
  const times = Array.from({ length: 71 }, (_, i) => new Date(Date.parse('2026-11-23T20:00:00Z') + i * 60000).toISOString());
  assert.deepEqual(judge({ behind: 71, times }).reasons.sort(), ['behind-too-long', 'behind-too-many-commits']);
});

test('ALERT cannot-verify when the fetch fails -- never OK, and nothing else is read', () => {
  const git = fakeGit({ fetchFails: true });
  const r = driftVerdict(collectDrift(git), NOW);
  assert.equal(r.verdict, 'ALERT');
  assert.deepEqual(r.reasons, ['cannot-verify']);
  assert.match(r.detail, /unable to access origin/);
  assert.deepEqual(git.calls, ['fetch -q origin']);
});

test('ALERT cannot-verify on unreadable rev-list output, or behind with no commit times', () => {
  const bad = (args) => (args[0] === 'rev-list' ? 'garbage' : args[0] === 'rev-parse' ? 'main' : '');
  assert.deepEqual(driftVerdict(collectDrift(bad), NOW).reasons, ['cannot-verify']);
  assert.deepEqual(judge({ behind: 2, times: [] }).reasons, ['cannot-verify']);
});

test('it never syncs: only fetch, rev-parse, rev-list, log and status are run', () => {
  const git = fakeGit({ behind: 2, ahead: 1, times: ['2026-11-25T00:00:00Z', '2026-11-25T00:10:00Z'] });
  collectDrift(git);
  for (const c of git.calls) assert.match(c, /^(fetch -q origin|rev-parse |rev-list |log |status )/, c);
});

test('ledger: an ALERT pings once per distinct state; --record stores it; an OK clears it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'drift-ledger-'));
  const ledgerFile = path.join(dir, 'l.json');
  try {
    const behindGit = () => fakeGit({ behind: 1, times: ['2026-11-24T20:00:00Z'] });
    const first = run({ git: behindGit(), nowMs: NOW, ledgerFile });
    assert.equal(first.isNewState, true, 'first ALERT is new');
    assert.equal(run({ git: behindGit(), nowMs: NOW, ledgerFile }).isNewState, true, 'still new until recorded');
    run({ git: behindGit(), nowMs: NOW, ledgerFile, record: true });
    assert.equal(run({ git: behindGit(), nowMs: NOW, ledgerFile }).isNewState, false, 'same state: no second ping');
    const other = run({ git: fakeGit({ ahead: 1 }), nowMs: NOW, ledgerFile });
    assert.equal(other.isNewState, true, 'a different state pings again');
    const ok = run({ git: fakeGit({}), nowMs: NOW, ledgerFile });
    assert.equal(ok.verdict, 'OK');
    assert.equal(ok.isNewState, false);
    assert.equal(run({ git: behindGit(), nowMs: NOW, ledgerFile }).isNewState, true, 'after a recovery the same ALERT pings again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stateKey is verdict plus sorted reasons', () => {
  assert.equal(stateKey({ verdict: 'ALERT', reasons: ['b', 'a'] }), 'ALERT:a,b');
  assert.equal(stateKey({ verdict: 'OK', reasons: [] }), 'OK:');
});
