// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/597: disarm-pr.mjs, with an injected gh (no network).
// Run: node --test operations/devops/disarm-pr.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { disarmPR, planDisarm, readBackVerdict } from './disarm-pr.mjs';

const ARMED = { enabledAt: '2026-11-25T01:00:00Z' };
const QUEUED = { position: 2, state: 'QUEUED' };

/** A fake gh over a PR state; mutations change it as GitHub would unless `stuck` says otherwise. */
function fakeGh({ queued = false, armed = false, failMutation = null, stuck = null, failRead = false } = {}) {
  const st = { mergeQueueEntry: queued ? QUEUED : null, isInMergeQueue: queued, autoMergeRequest: armed ? ARMED : null };
  const calls = [];
  const fn = (args) => {
    const q = args.find((a) => a.startsWith('query=')) ?? '';
    if (q.includes('dequeuePullRequest')) {
      calls.push('dequeue');
      if (failMutation === 'dequeue') throw Object.assign(new Error('GraphQL: something went wrong'), { stderr: 'GraphQL: something went wrong' });
      if (stuck !== 'queued') { st.mergeQueueEntry = null; st.isInMergeQueue = false; st.autoMergeRequest = null; }
      return '{}';
    }
    if (q.includes('disablePullRequestAutoMerge')) {
      calls.push('disable-auto');
      if (failMutation === 'disable-auto') throw new Error('GraphQL: Pull request is not in the correct state to disable auto-merge');
      if (stuck !== 'armed') st.autoMergeRequest = null;
      return '{}';
    }
    calls.push('read');
    if (failRead) throw new Error('HTTP 502');
    return JSON.stringify({ data: { repository: { pullRequest: { id: 'PR_kw1', state: 'OPEN', ...st } } } });
  };
  fn.calls = calls;
  return fn;
}
const run = (opts) => { const g = fakeGh(opts); const logs = []; const r = disarmPR('o/r', 7, { gh: g, log: (m) => logs.push(m) }); return { r, calls: g.calls, logs }; };

test('armed only: disablePullRequestAutoMerge, read back clean', () => {
  const { r, calls } = run({ armed: true });
  assert.deepEqual(r.did, ['disable-auto']);
  assert.deepEqual(calls, ['read', 'disable-auto', 'read']);
});

test('queued only: dequeuePullRequest, read back clean', () => {
  const { r, calls } = run({ queued: true });
  assert.deepEqual(r.did, ['dequeue']);
  assert.deepEqual(calls, ['read', 'dequeue', 'read']);
});

test('queued and armed: dequeue first, then disable-auto (GitHub may say it is already off; the read-back decides)', () => {
  const g = fakeGh({ queued: true, armed: true });
  const logs = [];
  // After dequeue GitHub clears auto-merge too, so disable-auto errors "not in the correct state".
  const real = g;
  let dequeued = false;
  const gh = (args) => {
    const q = args.find((a) => a.startsWith('query=')) ?? '';
    if (q.includes('dequeuePullRequest')) dequeued = true;
    if (dequeued && q.includes('disablePullRequestAutoMerge')) { real.calls.push('disable-auto'); throw new Error('GraphQL: Pull request is not in the correct state to disable auto-merge'); }
    return real(args);
  };
  const r = disarmPR('o/r', 7, { gh, log: (m) => logs.push(m) });
  assert.deepEqual(r.did, ['dequeue', 'disable-auto']);
  assert.deepEqual(real.calls, ['read', 'dequeue', 'disable-auto', 'read']);
  assert.ok(logs.some((l) => /WARN #7: disable-auto returned an error/.test(l)));
});

test('already clean: no mutation, exit-0 result (idempotent)', () => {
  const { r, calls, logs } = run({});
  assert.deepEqual(r.did, []);
  assert.deepEqual(calls, ['read']);
  assert.ok(logs.some((l) => /already disarmed and not queued/.test(l)));
});

test('a mutation error that leaves it armed refuses (ActionableError) at the read-back', () => {
  assert.throws(() => run({ armed: true, failMutation: 'disable-auto' }), (err) => {
    assert.equal(err.name, 'ActionableError');
    assert.match(err.message, /auto-merge still armed after disable-auto/);
    assert.match(err.message, /Goal:[\s\S]*Problem:[\s\S]*Location:[\s\S]*Next steps:[\s\S]*Do not push/);
    return true;
  });
});

test('read-back still armed (the mutation "succeeded" but nothing changed): refuses', () => {
  assert.throws(() => run({ armed: true, stuck: 'armed' }), /auto-merge still armed/);
  assert.throws(() => run({ queued: true, stuck: 'queued' }), /still in the merge queue/);
});

test('an unreadable state refuses before any mutation', () => {
  const g = fakeGh({ armed: true, failRead: true });
  assert.throws(() => disarmPR('o/r', 7, { gh: g, log: () => {} }), /could not read #7's queue and auto-merge state \(HTTP 502\)/);
  assert.deepEqual(g.calls, ['read']);
});

test('pure: planDisarm orders dequeue before disable-auto; readBackVerdict lists what remains', () => {
  assert.deepEqual(planDisarm({ mergeQueueEntry: QUEUED, autoMergeRequest: ARMED }), ['dequeue', 'disable-auto']);
  assert.deepEqual(planDisarm({}), []);
  assert.deepEqual(readBackVerdict({ autoMergeRequest: ARMED, isInMergeQueue: true }).left, ['still in the merge queue', 'auto-merge still armed']);
});

test('it never shells out to gh pr merge (t/4939)', () => {
  const src = readFileSync(new URL('./disarm-pr.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /'pr',\s*'merge'|gh pr merge/);
});

test('t/597: check-queued-push-guard.sh names disarm-pr.mjs in both refusals, never gh pr merge', () => {
  const sh = readFileSync(new URL('./check-queued-push-guard.sh', import.meta.url), 'utf8');
  const fixes = sh.split('\n').filter((l) => /Fix:/.test(l));
  assert.equal(fixes.length, 2);
  for (const l of fixes) {
    assert.match(l, /node operations\/devops\/disarm-pr\.mjs \$REPO_SLUG \$PR_NUM/);
    assert.match(l, /enqueue-pr\.mjs/);
  }
  assert.doesNotMatch(sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'), /gh pr merge/);
});
