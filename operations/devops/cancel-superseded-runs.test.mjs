// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/391: what the superseded-run canceller may and may not cancel.
// Run: node --test operations/devops/cancel-superseded-runs.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRunsToCancel, collect, executeCancellations } from './cancel-superseded-runs.mjs';

const REPO = 'o/r';
const pr = (number, sha, ref = `b${number}`, repo = REPO) => ({ number, head: { sha, ref, repo: { full_name: repo } } });
let nextId = 1;
const run = (o) => ({ id: nextId++, name: 'CI', event: 'pull_request', status: 'queued', head_repository: { full_name: REPO }, pull_requests: [], ...o });
const pick = (runs, openPrs, selfRunId = null) => selectRunsToCancel({ runs, openPrs, selfRunId }).map((x) => x.run.id);

test('cancels a run for an old head of an open PR; keeps the current head', () => {
  const old = run({ head_sha: 'old', head_branch: 'b7', pull_requests: [{ number: 7 }] });
  const cur = run({ head_sha: 'new', head_branch: 'b7', pull_requests: [{ number: 7 }] });
  const r = selectRunsToCancel({ runs: [old, cur], openPrs: [pr(7, 'new')], selfRunId: null });
  assert.deepEqual(r.map((x) => x.run.id), [old.id]);
  assert.match(r[0].reason, /^superseded: PR #7 head is new/);
});

test('cancels in_progress as well as queued', () => {
  const r = run({ status: 'in_progress', head_sha: 'old', pull_requests: [{ number: 7 }] });
  assert.deepEqual(pick([r], [pr(7, 'new')]), [r.id]);
});

test('cancels runs of a closed PR (linked number not open)', () => {
  const r = run({ head_sha: 'x', head_branch: 'gone', pull_requests: [{ number: 9 }] });
  const out = selectRunsToCancel({ runs: [r], openPrs: [pr(7, 'new')], selfRunId: null });
  assert.equal(out[0].reason, 'PR #9 is closed');
});

test('NEVER cancels merge_group, push, schedule, workflow_dispatch or pull_request_target runs', () => {
  const runs = ['merge_group', 'push', 'schedule', 'workflow_dispatch', 'pull_request_target']
    .map((event) => run({ event, head_sha: 'old', head_branch: 'b7', pull_requests: [{ number: 7 }] }));
  assert.deepEqual(pick(runs, [pr(7, 'new')]), []);
});

test('NEVER cancels completed runs or its own run', () => {
  const done = run({ status: 'completed', head_sha: 'old', pull_requests: [{ number: 7 }] });
  const self = run({ head_sha: 'old', pull_requests: [{ number: 7 }] });
  assert.deepEqual(pick([done, self], [pr(7, 'new')], self.id), []);
});

test('a fork PR run (no pull_requests link) is matched by head repo + branch', () => {
  const fork = run({ head_sha: 'old', head_branch: 'feature', head_repository: { full_name: 'someone/r' } });
  assert.deepEqual(pick([fork], [pr(8, 'new', 'feature', 'someone/r')]), [fork.id]);
  const sameBranchOtherRepo = run({ head_sha: 'old', head_branch: 'feature', head_repository: { full_name: 'other/r' } });
  assert.deepEqual(pick([sameBranchOtherRepo], [pr(8, 'new', 'feature', 'someone/r')]), [], 'a same-named branch in another fork is not that PR');
});

test('fail-safe: an unattributable run (no link, no open PR on its branch) is left alone', () => {
  const orphan = run({ head_sha: 'x', head_branch: 'deleted' });
  assert.deepEqual(pick([orphan], [pr(7, 'new')]), []);
});

// ── the push-between race (Quality, #5109 p/119#36; TL p/9#75) ──
// One fake repo: PR #7's head and the active runs both change when `push()` is called.
function fakeRepo() {
  const state = { head: 'H1', runs: [] };
  const mk = (sha) => run({ head_sha: sha, head_branch: 'b7', pull_requests: [{ number: 7 }] });
  state.runs.push(mk('H1'));
  return {
    state,
    push(sha) { state.head = sha; state.runs.push(mk(sha)); },
    listRuns: async () => state.runs.map((r) => ({ ...r })),
    listOpenPrs: async () => ({ items: [pr(7, state.head)], truncated: false }),
    getPr: async () => ({ state: 'open', ...pr(7, state.head) }),
  };
}

test('RACE: a push between the two listings never gets its new head run cancelled', async () => {
  const repo = fakeRepo();
  // The push lands after whichever listing collect() makes first.
  let first = true;
  const once = (fn) => async () => { const out = await fn(); if (first) { first = false; repo.push('H2'); } return out; };
  const { runs, openPrs, openPrsTruncated } = await collect({ listRuns: once(repo.listRuns), listOpenPrs: once(repo.listOpenPrs) });
  const picks = selectRunsToCancel({ runs, openPrs, selfRunId: null, openPrsTruncated });
  assert.deepEqual(picks.map((p) => p.run.head_sha), ['H1'], 'only the old head is a candidate; the H2 run was listed after or not at all');
});

test('RACE: collect() lists runs BEFORE open PRs', async () => {
  const order = [];
  await collect({ listRuns: async () => { order.push('runs'); return []; }, listOpenPrs: async () => { order.push('prs'); return { items: [], truncated: false }; } });
  assert.deepEqual(order, ['runs', 'prs']);
});

test('RACE: the PR is re-read before each cancel; a run that is now at the PR head is skipped', async () => {
  const repo = fakeRepo();
  const picks = [{ run: repo.state.runs[0], prNumber: 7, reason: 'superseded' }];
  repo.state.head = 'H1'; // e.g. a force-push back to H1 after the listing
  const cancelled = [];
  const out = await executeCancellations({ picks, getPr: repo.getPr, cancel: async (r) => cancelled.push(r.id), log: () => {} });
  assert.deepEqual(out.map((o) => o.outcome), ['skipped-current-head']);
  assert.deepEqual(cancelled, []);
});

test('re-read: a closed PR or a moved head is cancelled; an unreadable PR is left running', async () => {
  const r = run({ head_sha: 'old', pull_requests: [{ number: 7 }] });
  const cancelled = [];
  const cancel = async (x) => cancelled.push(x.id);
  const picks = [{ run: r, prNumber: 7, reason: 'x' }];
  assert.equal((await executeCancellations({ picks, getPr: async () => ({ state: 'closed', ...pr(7, 'old') }), cancel, log: () => {} }))[0].outcome, 'cancelled');
  assert.equal((await executeCancellations({ picks, getPr: async () => ({ state: 'open', ...pr(7, 'new') }), cancel, log: () => {} }))[0].outcome, 'cancelled');
  assert.equal((await executeCancellations({ picks, getPr: async () => { throw new Error('HTTP 502'); }, cancel, log: () => {} }))[0].outcome, 'skipped-unverified');
  assert.equal(cancelled.length, 2);
});

test('a truncated open-PR list never marks a run "closed"', () => {
  const r = run({ head_sha: 'x', head_branch: 'b99', pull_requests: [{ number: 99 }] });
  assert.deepEqual(selectRunsToCancel({ runs: [r], openPrs: [pr(7, 'new')], selfRunId: null, openPrsTruncated: true }), []);
});
