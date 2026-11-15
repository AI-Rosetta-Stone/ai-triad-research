// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/t1-enqueue-sweep.test.mjs
// Gate-signal proof for the T1 auto-enqueue arm (t/73, Orca t/4820): the pass arm and every
// refusal arm run against the real selection code (selectT1Candidates, which calls the shared
// sharedSkipReason and approvalAtHeadVerdict), and the shim tests run the real sweep ->
// enqueueOne path with only GitHub I/O faked.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectT1Candidates, declaresT1, headBoundApprover, sweep, postGuardNudge, parseCliArgs, GUARD_APPROVED_SUMMARY, GUARD_NUDGE_MARKER,
} from './t1-enqueue-sweep.mjs';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { selectT0Candidates } from './t0-enqueue-sweep.mjs';
import { fetchGuardRun } from './t1-approval-at-head.mjs';
import { latestRoleVerdicts } from './role-review-verdicts.mjs';
import { evaluateT1ApprovalGuard, latestRoleVerdicts as inlinedLatestRoleVerdicts } from './t1-approval-guard-predicate.mjs';

const HEAD = 'head2222';
const OLD_HEAD = 'head1111';
const REVIEWER = 'ai-triad-reviewer-jpsnover';
const start = '2026-11-09T10:00:00Z';
const green = (over = {}) => ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard']
  .map((name) => ({ name, status: 'COMPLETED', conclusion: over[name] ?? 'SUCCESS', startedAt: start }));
const guardOk = (over = {}) => ({
  lookupError: false,
  run: {
    status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-09T10:30:00Z',
    output: { title: 't1-approval-guard: OK', summary: GUARD_APPROVED_SUMMARY }, ...over,
  },
});
const approvalAt = (commitId, role = 'Quality') => ({
  body: `Approved (${role}): at ${commitId}.`, login: REVIEWER, commitId, submittedAt: '2026-11-09T10:29:00Z',
});
const pr = (over = {}) => ({
  number: 1, body: 'Tier: T1\n\nA cross-role contract.', headRefOid: HEAD, headRefName: 'devops/t73-x',
  baseRefName: 'main', isDraft: false, isInMergeQueue: false, mergeStateStatus: 'BLOCKED', author: 'ai-triad-author-jpsnover',
  labels: [], isCrossRepository: false, autoMergeRequest: null, contexts: green(),
  reviewDataError: false, files: ['operations/devops/x.mjs'], reviews: [approvalAt(HEAD)], comments: [], queueEvents: [],
  guard: guardOk(), ...over,
});
const only = (p) => selectT1Candidates([p]);
const skipReason = (p) => {
  const { enqueue, skip } = only(p);
  assert.deepEqual(enqueue, [], 'must NOT enqueue');
  return skip[0].reason;
};

// ---- pass arm ----
test('PASS: an approved T1 PR at its head with green ci-gate and all required contexts is enqueued', () => {
  const { enqueue, skip } = only(pr());
  assert.deepEqual(skip, []);
  assert.deepEqual(enqueue, [{ number: 1, headRefOid: HEAD, armed: false }]);
});

// Real fetchGuardRun (the same one enqueue-pr.mjs uses), with only the gh CLI faked.
const guardFrom = (runs) => fetchGuardRun('o/r', HEAD, () => JSON.stringify({ check_runs: runs }));
const run = (conclusion, startedAt, over = {}) => ({
  status: 'completed', conclusion, app: { slug: 'github-actions' }, started_at: startedAt,
  output: { summary: conclusion === 'success' ? GUARD_APPROVED_SUMMARY : null }, ...over,
});

test('PASS: guard runs [success, later ci.yml merge_group skip] -- the live #4730 shape -- is enqueued', () => {
  const guard = guardFrom([run('success', '2026-11-09T23:23:06Z'), run('skipped', '2026-11-09T23:29:34Z')]);
  assert.equal(only(pr({ guard })).enqueue.length, 1);
});

test('REFUSE: guard runs [success (older), failure (newer)] at the same head -- the latest non-skipped run wins', () => {
  const guard = guardFrom([run('success', '2026-11-09T10:00:00Z'), run('failure', '2026-11-09T10:05:00Z')]);
  assert.equal(skipReason(pr({ guard })), 't1-approval-guard at head is failure');
});

// ---- refusal arms ----
test('REFUSE: stale-head approval (review bound to the previous head) is not enqueued even though the guard says success', () => {
  // The committer-date gap: the guard passed at the new head, but the only approval is on the old one.
  assert.match(skipReason(pr({ reviews: [approvalAt(OLD_HEAD)] })), /no reviewer-App approval review bound to the current head SHA/);
});

test('REFUSE: a comment-only approval (not bound to a SHA) is not auto-enqueued', () => {
  const comment = { body: 'Approved (Quality): looks good', login: REVIEWER, createdAt: '2026-11-09T11:00:00Z', updatedAt: null };
  assert.match(skipReason(pr({ reviews: [], comments: [comment] })), /bound to the current head SHA/);
});

test('REFUSE: self-approval (the branch owner role approving its own devops/ branch) is not enqueued', () => {
  assert.match(skipReason(pr({ reviews: [approvalAt(HEAD, 'DevOps Lead')] })), /bound to the current head SHA/);
});

test('REFUSE: an approval from a human or another App login is ignored', () => {
  assert.match(skipReason(pr({ reviews: [{ ...approvalAt(HEAD), login: 'someone' }] })), /bound to the current head SHA/);
});

test('REFUSE: red ci-gate is not enqueued', () => {
  assert.equal(skipReason(pr({ contexts: green({ 'ci-gate': 'FAILURE' }) })), 'ci-gate is failed');
});

test('REFUSE: pending ci-gate and missing CodeQL Analysis are not enqueued', () => {
  const pending = green().map((c) => (c.name === 'ci-gate' ? { ...c, status: 'IN_PROGRESS', conclusion: null } : c));
  assert.equal(skipReason(pr({ contexts: pending })), 'ci-gate is pending');
  assert.equal(skipReason(pr({ contexts: green().filter((c) => c.name !== 'CodeQL Analysis') })), 'CodeQL Analysis is missing');
});

for (const label of ['no-auto-enqueue', 'consult-hold', 'joint-gv']) {
  test(`REFUSE: a PR labelled ${label} is not enqueued`, () => {
    assert.equal(skipReason(pr({ labels: [label] })), `label ${label}`);
  });
}

test('REFUSE: a draft is not enqueued', () => {
  assert.equal(skipReason(pr({ isDraft: true })), 'draft');
});

test('REFUSE (idempotency): a PR already in the merge queue is not enqueued again', () => {
  assert.equal(skipReason(pr({ isInMergeQueue: true })), 'already in merge queue');
});

test('REFUSE: unapproved T1 (guard failure) is not enqueued', () => {
  assert.equal(skipReason(pr({ guard: guardOk({ conclusion: 'failure' }) })), 't1-approval-guard at head is failure');
});

test('REFUSE: guard missing, in progress, or from a non-github-actions App is not enqueued', () => {
  // No head-bound approval here, so these are plain refusals (the approved case is the nudge below).
  const unapproved = { reviews: [] };
  assert.equal(skipReason(pr({ ...unapproved, guard: { run: null, lookupError: false } })), 't1-approval-guard at head is missing');
  assert.equal(skipReason(pr({ guard: guardOk({ status: 'in_progress', conclusion: null }) })), 't1-approval-guard at head is in_progress');
  assert.equal(skipReason(pr({ ...unapproved, guard: guardOk({ app: { slug: 'other-app' } }) })), 't1-approval-guard at head is missing');
});

// ---- guard never ran on an approved head (2026-11-11: runs stuck in `queued` for good) ----
test('NUDGE: approved at head, green, but the guard has no run there -> skipped with a guardNudge', () => {
  const { enqueue, skip } = only(pr({ guard: { run: null, lookupError: false } }));
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^WARN: t1-approval-guard never evaluated this head \(missing\)/);
  assert.deepEqual(skip[0].guardNudge, { headRefOid: HEAD });
});

test('NUDGE: only ci.yml skipped placeholders at the head (the live #5120 shape) -> guardNudge', () => {
  const guard = guardFrom([run('skipped', '2026-11-12T00:03:31Z'), run('skipped', '2026-11-14T16:44:31Z')]);
  const { enqueue, skip } = only(pr({ guard }));
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /never evaluated this head \(skipped\)/);
  assert.deepEqual(skip[0].guardNudge, { headRefOid: HEAD });
});

test('NO NUDGE: a real failure, a running guard, a lookup error, or no head-bound approval never nudges', () => {
  for (const over of [
    { guard: guardOk({ conclusion: 'failure' }) },
    { guard: guardOk({ status: 'in_progress', conclusion: null }) },
    { guard: guardOk({ status: 'queued', conclusion: null }) },
    { guard: { run: null, lookupError: true } },
    { guard: { run: null, lookupError: false }, reviews: [approvalAt(OLD_HEAD)] },
    { guard: { run: null, lookupError: false }, reviews: [approvalAt(HEAD, 'DevOps')] }, // self-approval
  ]) {
    const { enqueue, skip } = only(pr(over));
    assert.deepEqual(enqueue, []);
    assert.equal(skip[0].guardNudge, undefined, JSON.stringify(over));
  }
});

test('NO NUDGE: a PR the shared filters already skip (red ci-gate, draft, consult-hold) is not nudged', () => {
  for (const over of [{ contexts: green({ 'ci-gate': 'FAILURE' }) }, { isDraft: true }, { labels: ['consult-hold'] }]) {
    const { skip } = only(pr({ guard: { run: null, lookupError: false }, ...over }));
    assert.equal(skip[0].guardNudge, undefined, JSON.stringify(over));
  }
});

test('postGuardNudge: posts one marker comment per head, and never a second one', () => {
  const mocks = [mock.method(console, 'log', () => {})];
  try {
    const posted = [];
    let existing = [];
    const ghFn = (args) => {
      if (args.includes('-f')) { posted.push(args.at(-1)); return ''; }
      return JSON.stringify(existing);
    };
    assert.equal(postGuardNudge('o/r', 7, { headRefOid: HEAD }, { ghFn }), 'posted');
    assert.equal(posted.length, 1);
    assert.ok(posted[0].includes(`${GUARD_NUDGE_MARKER}${HEAD} -->`));
    // The body must not read as a role verdict to the guard or the sweeps.
    assert.doesNotMatch(posted[0], /^body=\**(Approved|Changes requested|Design-exempt)/i);
    assert.doesNotMatch(posted[0], /changes requested/i);

    existing = [{ body: posted[0].replace(/^body=/, ''), created_at: '2026-11-15T10:00:00Z' }];
    assert.equal(postGuardNudge('o/r', 7, { headRefOid: HEAD }, { ghFn, nowMs: Date.parse('2026-11-15T12:00:00Z') }), 'already');
    assert.equal(posted.length, 1);
    // A new head is a new episode.
    assert.equal(postGuardNudge('o/r', 7, { headRefOid: 'head3333' }, { ghFn }), 'posted');
    assert.equal(posted.length, 2);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('postGuardNudge: a failed API call only WARNs', () => {
  const logs = [];
  const m = mock.method(console, 'log', (l) => logs.push(l));
  try {
    assert.equal(postGuardNudge('o/r', 7, { headRefOid: HEAD }, { ghFn: () => { throw new Error('HTTP 502'); } }), 'failed');
    assert.match(logs[0], /^WARN: #7: could not post the guard re-run comment \(HTTP 502\)/);
  } finally { m.mock.restore(); }
});

// ---- the nudge comment is never a review verdict (Second Opinion, #4795) ----
// The body-text assertions above are not proof. These feed the EXACT body postGuardNudge posts to
// the real verdict parsers as a PR comment: role-review-verdicts.mjs (what the sweeps read) and its
// inlined copy in t1-approval-guard-predicate.mjs (what the guard reads), in the default mode and in
// `mode: 'gate'`, under every author it could be attributed to. In gate mode a comment from ANY
// login that matches the strict grammar counts, so a nudge that started `Approved (<role>):` would
// approve the very PR it is posted on.
function capturedNudgeBody() {
  const m = mock.method(console, 'log', () => {});
  try {
    const posted = [];
    const ghFn = (args) => { if (args.includes('-f')) { posted.push(args.at(-1)); return ''; } return '[]'; };
    assert.equal(postGuardNudge('o/r', 7, { headRefOid: HEAD }, { ghFn }), 'posted');
    assert.equal(posted.length, 1);
    assert.match(posted[0], /^body=/);
    return posted[0].slice('body='.length);
  } finally { m.mock.restore(); }
}

const LAST_PUSH = '2026-11-15T10:00:00Z';
const AFTER_PUSH = '2026-11-15T11:00:00Z';
// GraphQL gives an App's login without `[bot]` (the sweeps), REST gives it with (the guard).
const REVIEWER_REST = `${REVIEWER}[bot]`;
const NUDGE_AUTHORS = [
  ['the reviewer App (GraphQL login)', REVIEWER],
  ['the reviewer App (REST login)', REVIEWER_REST],
  ['the sweep\'s own App (GraphQL login)', 'ai-triad-dependabot-merge'],
  ['the sweep\'s own App (REST login)', 'ai-triad-dependabot-merge[bot]'],
  ['the shared human login', 'jpsnover'],
];
const PARSERS = [['role-review-verdicts.mjs', latestRoleVerdicts], ['the guard\'s inlined copy', inlinedLatestRoleVerdicts]];
const MODES = [['default', undefined], ['gate', 'gate']];
// A comment posted after the last push, so nothing filters it out for being stale.
const commentBy = (login, body) => ({ body, login, createdAt: AFTER_PUSH, updatedAt: null });
const verdictsFor = (parse, mode, login, body, reviewerAppLogin) => parse({
  reviews: [], comments: [commentBy(login, body)], reviewerAppLogin, headSha: HEAD, lastPushAt: LAST_PUSH, mode,
});

test('nudge body: no verdict is read from it by either parser, in either mode, under any author', () => {
  const body = capturedNudgeBody();
  let checked = 0;
  for (const [parserName, parse] of PARSERS) {
    for (const [modeName, mode] of MODES) {
      for (const [who, login] of NUDGE_AUTHORS) {
        for (const reviewerAppLogin of [REVIEWER, REVIEWER_REST]) {
          const verdicts = verdictsFor(parse, mode, login, body, reviewerAppLogin);
          assert.deepEqual([...verdicts.entries()], [], `${parserName}, ${modeName} mode, posted by ${who}, reviewer App = ${reviewerAppLogin}`);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 2 * 2 * 5 * 2);
});

test('nudge body control: the same harness DOES read a verdict from a real verdict comment', () => {
  // Without this, an empty result above could just mean the harness filters everything out.
  for (const [parserName, parse] of PARSERS) {
    for (const [modeName, mode] of MODES) {
      for (const [text, kind] of [['Approved (Quality): looks good', 'approved'], ['Changes requested (Quality): fix it', 'changes_requested']]) {
        const fromReviewer = verdictsFor(parse, mode, REVIEWER, text, REVIEWER);
        assert.deepEqual([...fromReviewer.values()].map((v) => v.kind), [kind], `${parserName}, ${modeName} mode, reviewer App: ${text}`);
      }
    }
    // Gate mode also reads a strict-grammar comment from any other login (the shared-login path).
    const fromSweepApp = verdictsFor(parse, 'gate', 'ai-triad-dependabot-merge[bot]', 'Approved (Quality): looks good', REVIEWER_REST);
    assert.deepEqual([...fromSweepApp.values()].map((v) => v.kind), ['approved'], `${parserName}, gate mode, another login`);
  }
});

test('nudge body: the guard predicate gives the same verdict with and without the nudge comment', () => {
  const body = capturedNudgeBody();
  const HEAD40 = 'b'.repeat(40);
  const guard = (over) => evaluateT1ApprovalGuard({
    body: 'Tier: T1\n\nA cross-role contract.', headRefName: 'devops/t73-x', headSha: HEAD40, lastPushAt: LAST_PUSH,
    approvalComments: [], botReviews: [], reviewerAppLogin: REVIEWER_REST, ...over,
  });
  const approval = { commitId: HEAD40, state: 'APPROVED', submittedAt: '2026-11-15T10:30:00Z', login: REVIEWER_REST, body: 'Approved (Quality): at the head.' };
  const block = { commitId: HEAD40, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-15T10:30:00Z', login: REVIEWER_REST, body: 'Changes requested (Quality): fix the error path.' };

  // Unapproved: still fails for lack of approval. The nudge must not approve it.
  const unapproved = guard({});
  assert.deepEqual(unapproved, { pass: false, tier: 'T1', reason: 'no-post-push-approval' });
  // Approved at the head: still passes. The nudge must not block it.
  const approved = guard({ botReviews: [approval] });
  assert.equal(approved.pass, true);
  assert.equal(approved.reason, 'approved-after-push');
  // A changes-request outstanding: still blocked. The nudge (posted later) must not clear it.
  const blocked = guard({ botReviews: [block] });
  assert.equal(blocked.pass, false);
  assert.equal(blocked.reason, 'changes-requested-outstanding');

  for (const [who, login] of NUDGE_AUTHORS) {
    const approvalComments = [commentBy(login, body)];
    assert.deepEqual(guard({ approvalComments }), unapproved, `unapproved, nudge posted by ${who}`);
    assert.deepEqual(guard({ approvalComments, botReviews: [approval] }), approved, `approved, nudge posted by ${who}`);
    assert.deepEqual(guard({ approvalComments, botReviews: [block] }), blocked, `changes requested, nudge posted by ${who}`);
  }
});

test('REFUSE: a guard lookup error, or no guard read at all, fails closed', () => {
  assert.match(skipReason(pr({ guard: { run: null, lookupError: true } })), /^WARN: could not look up t1-approval-guard/);
  assert.match(skipReason(pr({ guard: undefined })), /^WARN: could not look up t1-approval-guard/);
});

test('REFUSE: guard success whose summary is "not a T1 PR" fails closed', () => {
  assert.match(skipReason(pr({ guard: guardOk({ output: { summary: 'not a T1 PR' } }) })), /summary is "not a T1 PR"/);
});

test('REFUSE: an active changes-request from another role at the head blocks, even with a Quality approval', () => {
  const cr = { body: 'Changes requested (Design): fix the layout.', login: REVIEWER, commitId: HEAD, submittedAt: '2026-11-09T10:31:00Z' };
  assert.equal(skipReason(pr({ reviews: [approvalAt(HEAD), cr] })), 'changes requested by Design');
});

test('REFUSE: fork PRs and unknown fork status are not enqueued', () => {
  assert.match(skipReason(pr({ isCrossRepository: true })), /^fork PR/);
  assert.match(skipReason(pr({ isCrossRepository: undefined })), /^fork PR/);
});

test('REFUSE: a manual dequeue with nothing pushed since holds the PR', () => {
  const queueEvents = [{ type: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-09T11:00:00Z', reason: 'manual', actor: 'x' }];
  assert.match(skipReason(pr({ queueEvents })), /^WARN: manually dequeued/);
});

// ---- non-T1 paths untouched ----
test('non-T1: T0, T2, no tier and Dependabot bodies are all skipped as not declared Tier: T1', () => {
  for (const body of ['Tier: T0\nx', 'Tier: T2\nx', 'no tier here', '']) {
    assert.equal(skipReason(pr({ body })), 'not declared Tier: T1');
  }
  assert.equal(skipReason(pr({ author: 'dependabot[bot]' })), 'Dependabot PR (handled by dependabot-enqueue-sweep)');
});

test('non-T1: the T0 sweep still ignores this approved T1 PR, and still enqueues a green idle T0 PR', () => {
  const t0 = pr({ number: 2, body: 'Tier: T0\nx', reviews: [], guard: undefined });
  const { enqueue, skip } = selectT0Candidates([pr(), t0], Date.parse('2026-11-09T12:00:00Z'));
  assert.deepEqual(enqueue, [{ number: 2, headRefOid: HEAD, armed: false }]);
  assert.deepEqual(skip, [{ number: 1, reason: 'not declared Tier: T0' }]);
});

test('declaresT1 uses the guard parser: first line only, exact tier', () => {
  assert.equal(declaresT1('Tier: T1\nmore'), true);
  assert.equal(declaresT1('\n  tier: t1'), true);
  assert.equal(declaresT1('Tier: T0\nTier: T1'), false);
  assert.equal(declaresT1('Tier: T12'), false);
});

test('headBoundApprover names the head-bound non-self role', () => {
  assert.equal(headBoundApprover(pr()), 'Quality');
  assert.equal(headBoundApprover(pr({ reviews: [approvalAt(OLD_HEAD)] })), null);
});

// ---- shim: real sweep -> enqueueOne, GitHub I/O faked ----
function harness({ listed, live }) {
  const calls = { enqueue: [], gh: [], guard: [] };
  const deps = {
    list: () => listed.map((p) => ({ ...p })),
    fetchGuard: (repo, sha) => { calls.guard.push(sha); return guardOk(); },
    enqueueDeps: {
      readLive: () => live,
      enqueue: async (repo, n, opts) => { calls.enqueue.push({ n, opts }); return { ok: true, state: 'queued' }; },
      ghFn: (args) => { calls.gh.push(args); return ''; },
    },
  };
  return { calls, deps };
}

const quiet = () => [mock.method(console, 'log', () => {}), mock.method(console, 'warn', () => {})];

test('shim: an approved T1 PR is enqueued once, pinned to the approved head (expectedHeadOid)', async () => {
  const mocks = quiet();
  try {
    const { calls, deps } = harness({ listed: [pr()], live: { state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: HEAD } });
    const out = await sweep('o/r', { enqueueEnabled: true, deps });
    assert.deepEqual(out, { 1: 'enqueued' });
    assert.deepEqual(calls.enqueue, [{ n: 1, opts: { expectedHeadOid: HEAD } }]);
    assert.deepEqual(calls.guard, [HEAD]);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('shim idempotency: a second sweep after the PR is queued makes no enqueue call', async () => {
  const mocks = quiet();
  try {
    const { calls, deps } = harness({ listed: [pr({ isInMergeQueue: true })], live: null });
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, deps }), {});
    assert.equal(calls.enqueue.length, 0);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('shim idempotency: search lag says unqueued but the live read says merged or queued -> no enqueue, no failure', async () => {
  const mocks = quiet();
  try {
    for (const live of [
      { state: 'MERGED', isInMergeQueue: false, isDraft: false, headRefOid: HEAD },
      { state: 'OPEN', isInMergeQueue: true, isDraft: false, headRefOid: HEAD },
    ]) {
      const { calls, deps } = harness({ listed: [pr()], live });
      assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, deps }), { 1: 'skipped' });
      assert.equal(calls.enqueue.length, 0);
    }
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('shim: head moved between listing and enqueue -> no enqueue', async () => {
  const mocks = quiet();
  try {
    const { calls, deps } = harness({ listed: [pr()], live: { state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: 'newhead' } });
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, deps }), { 1: 'skipped' });
    assert.equal(calls.enqueue.length, 0);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('shim: a guard that never ran on an approved head is nudged once and not enqueued; a dry run only reports', async () => {
  const mocks = quiet();
  try {
    const { calls, deps } = harness({ listed: [pr()], live: null });
    const nudged = [];
    const withNudge = { ...deps, fetchGuard: () => ({ run: null, lookupError: false }), nudge: (repo, n, x) => nudged.push({ n, ...x }) };
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, nudgeEnabled: true, deps: withNudge }), {});
    assert.deepEqual(nudged, [{ n: 1, headRefOid: HEAD }]);
    assert.equal(calls.enqueue.length, 0);
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, nudgeEnabled: true, dryRun: true, deps: withNudge }), {});
    assert.equal(nudged.length, 1);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

// ---- the enqueue and nudge gates (Second Opinion's conditions on #4795): both ship off, fail safe ----
// Every shim test above passes `enqueueEnabled: true` (and `nudgeEnabled: true` where it nudges)
// on purpose. These cover the gates themselves.
// `gateHarness` also counts live re-reads, which the enqueue gate must not make either.
function gateHarness(listed) {
  const live = { state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: HEAD };
  const { calls, deps } = harness({ listed, live });
  calls.readLive = 0;
  calls.nudged = [];
  deps.enqueueDeps.readLive = () => { calls.readLive++; return live; };
  deps.nudge = (repo, n, x) => calls.nudged.push({ n, ...x });
  const logs = [];
  const mocks = [mock.method(console, 'log', (l) => logs.push(String(l))), mock.method(console, 'warn', () => {})];
  return { calls, deps, logs, restore: () => mocks.forEach((m) => m.mock.restore()) };
}
const armedPr = () => pr({ autoMergeRequest: { enabledAt: 't' } }); // armed: enqueueOne would disarm it first

test('gate OFF BY DEFAULT: an approved, green T1 PR gets no enqueue, no disarm and no live re-read, only an [enqueue off] line', async () => {
  // Only the boolean `true` turns it on: a string from a careless caller ('off', 'false', 'on') does not.
  for (const opts of [{}, { enqueueEnabled: false }, { enqueueEnabled: undefined }, { enqueueEnabled: 'off' }, { enqueueEnabled: 'false' }, { enqueueEnabled: 'on' }, { enqueueEnabled: 1 }]) {
    const h = gateHarness([armedPr()]);
    try {
      assert.deepEqual(await sweep('o/r', { ...opts, deps: h.deps }), {}, JSON.stringify(opts));
    } finally { h.restore(); }
    assert.deepEqual(h.calls.enqueue, [], 'no enqueue call');
    assert.deepEqual(h.calls.gh, [], 'no disarm call');
    assert.equal(h.calls.readLive, 0, 'no live re-read');
    assert.deepEqual(h.calls.guard, [HEAD], 'the guard is still looked up');
    assert.ok(h.logs.includes(`[enqueue off] would enqueue #1 at ${HEAD}`), h.logs.join('\n'));
    assert.ok(h.logs.some((l) => /^T1 sweep: enqueue is OFF/.test(l)), h.logs.join('\n'));
    assert.ok(!h.logs.some((l) => /^enqueued #/.test(l)));
  }
});

// #1: approved, guard never ran -> would be nudged. #2: draft. #3: approved with a guard success
// at its own head -> would be enqueued. #4: like #1, at a third head -> would be nudged.
const READY = 'head9999';
const LOST = 'head7777';
function mixedHarness() {
  const h = gateHarness([
    pr(), pr({ number: 2, isDraft: true }),
    pr({ number: 3, headRefOid: READY, reviews: [approvalAt(READY)] }),
    pr({ number: 4, headRefOid: LOST, reviews: [approvalAt(LOST)] }),
  ]);
  h.deps.fetchGuard = (repo, sha) => (sha === READY ? guardOk() : { run: null, lookupError: false });
  h.deps.enqueueDeps.readLive = () => { h.calls.readLive++; return { state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: READY }; };
  // The real postGuardNudge, with gh faked: counts the comment-list reads and the posts.
  h.calls.nudgeGh = [];
  h.deps.nudge = (repo, n, x) => {
    h.calls.nudged.push({ n, ...x });
    return postGuardNudge(repo, n, x, { ghFn: (args) => { h.calls.nudgeGh.push(args); return args.includes('-f') ? '' : '[]'; } });
  };
  return h;
}
const NUDGE_OFF_1 = `[nudge off] would ask t1-approval-guard to re-run for #1 at ${HEAD}`;
const NUDGE_OFF_4 = `[nudge off] would ask t1-approval-guard to re-run for #4 at ${LOST}`;
const ENQUEUE_OFF_3 = `[enqueue off] would enqueue #3 at ${READY}`;

test('nudge gate OFF BY DEFAULT: a never-evaluated head gets no nudge call, no comment read and no post, only a [nudge off] line', async () => {
  // Only the boolean `true` turns it on.
  for (const opts of [{}, { nudgeEnabled: false }, { nudgeEnabled: undefined }, { nudgeEnabled: 'off' }, { nudgeEnabled: 'on' }, { nudgeEnabled: 1 },
    { nudgeOnlyPr: null }, { nudgeOnlyPr: '1' }, { nudgeOnlyPr: 0 }, { nudgeOnlyPr: true }, { nudgeOnlyPr: 1.5 }]) {
    const h = mixedHarness();
    try {
      assert.deepEqual(await sweep('o/r', { ...opts, deps: h.deps }), {}, JSON.stringify(opts));
    } finally { h.restore(); }
    assert.deepEqual(h.calls.nudged, [], `no nudge call: ${JSON.stringify(opts)}`);
    assert.deepEqual(h.calls.nudgeGh, [], 'no comment list read and no post');
    assert.deepEqual(h.calls.enqueue, []);
    assert.ok(h.logs.includes(NUDGE_OFF_1) && h.logs.includes(NUDGE_OFF_4), h.logs.join('\n'));
    assert.ok(h.logs.some((l) => /^skip #1: WARN: t1-approval-guard never evaluated this head/.test(l)), h.logs.join('\n'));
    assert.ok(h.logs.includes('skip #2: draft'), h.logs.join('\n'));
    assert.ok(h.logs.includes('T1 sweep: enqueue is OFF (no --enqueue); guard nudges are OFF (no --nudge). This run only reports.'), h.logs.join('\n'));
  }
});

test('the two gates are independent: each of the four combinations does exactly what its gates allow', async () => {
  for (const [enqueueEnabled, nudgeEnabled] of [[false, false], [false, true], [true, false], [true, true]]) {
    const label = `enqueue ${enqueueEnabled}, nudge ${nudgeEnabled}`;
    const h = mixedHarness();
    let out;
    try {
      out = await sweep('o/r', { enqueueEnabled, nudgeEnabled, deps: h.deps });
    } finally { h.restore(); }
    // Enqueue side: #3 only.
    assert.deepEqual(out, enqueueEnabled ? { 3: 'enqueued' } : {}, label);
    assert.deepEqual(h.calls.enqueue, enqueueEnabled ? [{ n: 3, opts: { expectedHeadOid: READY } }] : [], label);
    assert.equal(h.calls.readLive, enqueueEnabled ? 1 : 0, label);
    assert.equal(h.logs.includes(ENQUEUE_OFF_3), !enqueueEnabled, label);
    // Nudge side: #1 and #4 only, one comment-list read and one post each.
    assert.deepEqual(h.calls.nudged, nudgeEnabled ? [{ n: 1, headRefOid: HEAD }, { n: 4, headRefOid: LOST }] : [], label);
    assert.equal(h.calls.nudgeGh.length, nudgeEnabled ? 4 : 0, label);
    assert.equal(h.calls.nudgeGh.filter((a) => a.includes('-f')).length, nudgeEnabled ? 2 : 0, label);
    assert.equal(h.logs.includes(NUDGE_OFF_1), !nudgeEnabled, label);
    assert.equal(h.logs.includes(NUDGE_OFF_4), !nudgeEnabled, label);
    assert.ok(h.logs.includes(
      `T1 sweep: enqueue is ${enqueueEnabled ? 'ON (--enqueue)' : 'OFF (no --enqueue)'}; guard nudges are ${nudgeEnabled ? 'ON (--nudge)' : 'OFF (no --nudge)'}.` +
      (enqueueEnabled || nudgeEnabled ? '' : ' This run only reports.')), `${label}\n${h.logs.join('\n')}`);
  }
});

test('nudgeOnlyPr: with the nudge gate off, exactly that PR is nudged, the other is not, and nothing is enqueued', async () => {
  const h = mixedHarness();
  try {
    assert.deepEqual(await sweep('o/r', { nudgeOnlyPr: 4, deps: h.deps }), {});
  } finally { h.restore(); }
  assert.deepEqual(h.calls.nudged, [{ n: 4, headRefOid: LOST }]);
  assert.equal(h.calls.nudgeGh.filter((a) => a.includes('-f')).length, 1);
  assert.ok(h.logs.includes(NUDGE_OFF_1) && !h.logs.includes(NUDGE_OFF_4), h.logs.join('\n'));
  assert.deepEqual(h.calls.enqueue, [], 'it cannot enqueue');
  assert.equal(h.calls.readLive, 0);
  assert.ok(h.logs.includes(ENQUEUE_OFF_3));
  assert.ok(h.logs.includes('T1 sweep: enqueue is OFF (no --enqueue); guard nudges are OFF except for #4 (--nudge-pr).'), h.logs.join('\n'));

  // A PR that is not a nudge candidate (#3 qualifies for enqueue, #2 is a draft) is not nudged by naming it.
  for (const n of [2, 3, 99]) {
    const g = mixedHarness();
    try { await sweep('o/r', { nudgeOnlyPr: n, deps: g.deps }); } finally { g.restore(); }
    assert.deepEqual(g.calls.nudged, [], `nudgeOnlyPr ${n}`);
    assert.deepEqual(g.calls.enqueue, [], `nudgeOnlyPr ${n}`);
  }
});

test('dryRun wins over both gates and nudgeOnlyPr: nothing enqueued, nothing nudged, no status line', async () => {
  const h = mixedHarness();
  try {
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, nudgeEnabled: true, nudgeOnlyPr: 1, dryRun: true, deps: h.deps }), {});
  } finally { h.restore(); }
  assert.deepEqual(h.calls.enqueue, []);
  assert.equal(h.calls.readLive, 0);
  assert.deepEqual(h.calls.nudged, []);
  assert.deepEqual(h.calls.nudgeGh, []);
  assert.ok(h.logs.includes(`[dry-run] would enqueue #3 at ${READY}`), h.logs.join('\n'));
  assert.ok(h.logs.includes('[dry-run] would comment on #1: ask t1-approval-guard to re-run'), h.logs.join('\n'));
  assert.ok(!h.logs.some((l) => l.startsWith('T1 sweep:') || l.startsWith('[nudge off]') || l.startsWith('[enqueue off]')));
});

test('gate ON: the same PR is enqueued (disarmed first, pinned to its head), with no [enqueue off] line', async () => {
  const h = gateHarness([armedPr()]);
  try {
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, deps: h.deps }), { 1: 'enqueued' });
  } finally { h.restore(); }
  assert.deepEqual(h.calls.enqueue, [{ n: 1, opts: { expectedHeadOid: HEAD } }]);
  assert.deepEqual(h.calls.gh, [['pr', 'merge', '1', '-R', 'o/r', '--disable-auto']]);
  assert.equal(h.calls.readLive, 1);
  assert.ok(!h.logs.some((l) => l.startsWith('[enqueue off]')));
  assert.ok(h.logs.some((l) => /^T1 sweep: enqueue is ON/.test(l)));
});

test('gate ON + dryRun: dry run wins -- nothing enqueued and nothing nudged', async () => {
  const h = gateHarness([armedPr(), pr({ number: 2 })]);
  h.deps.fetchGuard = (repo, sha) => (h.calls.guard.push(sha) === 1 ? guardOk() : { run: null, lookupError: false });
  try {
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, nudgeEnabled: true, dryRun: true, deps: h.deps }), {});
  } finally { h.restore(); }
  assert.deepEqual(h.calls.enqueue, []);
  assert.deepEqual(h.calls.gh, []);
  assert.equal(h.calls.readLive, 0);
  assert.deepEqual(h.calls.nudged, []);
  assert.ok(h.logs.includes(`[dry-run] would enqueue #1 at ${HEAD}`), h.logs.join('\n'));
  assert.ok(h.logs.includes('[dry-run] would comment on #2: ask t1-approval-guard to re-run'), h.logs.join('\n'));
});

test('parseCliArgs: each gate is on only with its own exact flag, independently of the other', () => {
  const OFF = { repo: 'o/r', dryRun: false, enqueueEnabled: false, nudgeEnabled: false, nudgeOnlyPr: null };
  assert.deepEqual(parseCliArgs(['o/r']), OFF);
  assert.deepEqual(parseCliArgs(['o/r', '--enqueue']), { ...OFF, enqueueEnabled: true });
  assert.deepEqual(parseCliArgs(['o/r', '--nudge']), { ...OFF, nudgeEnabled: true });
  assert.deepEqual(parseCliArgs(['o/r', '--nudge', '--enqueue']), { ...OFF, nudgeEnabled: true, enqueueEnabled: true });
  assert.deepEqual(parseCliArgs(['o/r', '--dry-run']), { ...OFF, dryRun: true });
  assert.deepEqual(parseCliArgs(['o/r', '--dry-run', '--nudge', '--enqueue']), { ...OFF, dryRun: true, nudgeEnabled: true, enqueueEnabled: true });
  assert.deepEqual(parseCliArgs(['o/r', '--nudge-pr=5170']), { ...OFF, nudgeOnlyPr: 5170 });
  // Near misses turn nothing on. (An empty $DRY_RUN or flag variable vanishes in the shell.)
  for (const off of [['o/r', ''], ['o/r', '--enqueue=false'], ['o/r', '--enqueued'], ['o/r', '-enqueue'], ['o/r', 'enqueue'], ['o/r', '--ENQUEUE'],
    ['o/r', '--nudge=true'], ['o/r', '--nudged'], ['o/r', '-nudge'], ['o/r', 'nudge'], ['o/r', '--NUDGE'], ['o/r', '--nudge-enqueue'],
    ['o/r', '--nudge-pr'], ['o/r', '--nudge-pr='], ['o/r', '--nudge-pr=0'], ['o/r', '--nudge-pr=-1'], ['o/r', '--nudge-pr=12a'], ['o/r', '--nudge-pr=1 --enqueue'],
    ['o/r', '--nudge-pr=1.5'], ['o/r', '--nudge-pr=all'], ['o/r', '--nudge-pr=1234567890']]) {
    assert.deepEqual(parseCliArgs(off), OFF, JSON.stringify(off));
  }
  // --nudge-pr never implies --nudge or --enqueue, and --nudge never implies --enqueue.
  assert.equal(parseCliArgs(['o/r', '--nudge-pr=7']).nudgeEnabled, false);
  assert.equal(parseCliArgs(['o/r', '--nudge-pr=7']).enqueueEnabled, false);
  assert.equal(parseCliArgs(['o/r', '--nudge']).enqueueEnabled, false);
  assert.equal(parseCliArgs(['o/r', '--enqueue']).nudgeEnabled, false);
  assert.equal(parseCliArgs([]).repo, null);
  assert.equal(parseCliArgs(['--enqueue', '--nudge']).repo, null);
});

// Flipping T1_NUDGE to 'on' lets the sweep comment on real PRs; flipping T1_ENQUEUE to 'on' arms
// auto-enqueue on the next sweep. Each is a separate, reviewed (T2) commit, and it has to change
// this test in the same commit.
function t1StepOfWorkflow() {
  const yml = readFileSync(new URL('../../.github/workflows/enqueue-sweep.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = yml.split('\n').filter((l) => !/^\s*#/.test(l)); // comments don't count
  const stepStart = code.findIndex((l) => /^      - name: T1 sweep \(/.test(l));
  assert.notEqual(stepStart, -1, 'the T1 step exists and its name does not claim to enqueue');
  const rest = code.slice(stepStart + 1);
  const next = rest.findIndex((l) => /^      - /.test(l));
  const step = [code[stepStart], ...rest.slice(0, next === -1 ? rest.length : next)].filter((l) => l.trim() !== '');
  const runAt = step.indexOf('        run: |');
  assert.notEqual(runAt, -1, step.join('\n'));
  return { code, step, env: step.slice(step.indexOf('        env:') + 1, runAt).map((l) => l.trim()), run: step.slice(runAt + 1).map((l) => l.trim()) };
}

test('enqueue-sweep.yml SHIPS REPORT-ONLY: T1_NUDGE and T1_ENQUEUE are the literal \'off\', and each flag is passed only when its switch is \'on\'', () => {
  const { code, step, env, run } = t1StepOfWorkflow();
  assert.equal(step[0], "      - name: T1 sweep (report-only unless T1_NUDGE / T1_ENQUEUE is 'on')");

  // Each switch: a literal in the step's env, assigned once in the whole file, never an expression.
  assert.deepEqual(code.filter((l) => /T1_ENQUEUE\s*:/.test(l)).map((l) => l.trim()), ["T1_ENQUEUE: 'off'"]);
  assert.deepEqual(code.filter((l) => /T1_NUDGE\s*:/.test(l)).map((l) => l.trim()), ["T1_NUDGE: 'off'"]);
  // The whole env of the step. NUDGE_PR is read only on workflow_dispatch.
  assert.deepEqual(env, [
    'GH_TOKEN: ${{ steps.app.outputs.token }}',
    "DRY_RUN: ${{ inputs.dry_run && '--dry-run' || '' }}",
    "NUDGE_PR: ${{ github.event_name == 'workflow_dispatch' && inputs.nudge_pr || '' }}",
    "T1_NUDGE: 'off'",
    "T1_ENQUEUE: 'off'",
  ]);
  // The whole run block: each flag exists only behind its own test, and the sweep is called once.
  assert.deepEqual(run, [
    "NUDGE_FLAG=''",
    'if [ "$T1_NUDGE" = "on" ]; then NUDGE_FLAG=\'--nudge\'; fi',
    "NUDGE_PR_FLAG=''",
    'case "$NUDGE_PR" in \'\'|*[!0-9]*) ;; *) NUDGE_PR_FLAG="--nudge-pr=$NUDGE_PR" ;; esac',
    "ENQUEUE_FLAG=''",
    'if [ "$T1_ENQUEUE" = "on" ]; then ENQUEUE_FLAG=\'--enqueue\'; fi',
    'node operations/devops/t1-enqueue-sweep.mjs "${{ github.repository }}" $DRY_RUN $NUDGE_FLAG $NUDGE_PR_FLAG $ENQUEUE_FLAG',
  ]);
  // Nowhere else in the workflow can a flag, the script or the dispatch input appear.
  assert.equal(code.filter((l) => l.includes('--enqueue')).length, 1);
  assert.equal(code.filter((l) => l.includes('--nudge')).length, 2, '--nudge once, --nudge-pr= once');
  assert.equal(code.filter((l) => /--nudge'/.test(l)).length, 1);
  assert.equal(code.filter((l) => l.includes('t1-enqueue-sweep.mjs')).length, 1);
  assert.equal(code.filter((l) => l.includes('ENQUEUE_FLAG=')).length, 2);
  assert.equal(code.filter((l) => /(^|[^_])NUDGE_FLAG=/.test(l)).length, 2);
  assert.equal(code.filter((l) => l.includes('NUDGE_PR_FLAG=')).length, 2);
  assert.equal(code.filter((l) => l.includes('inputs.nudge_pr')).length, 1);
  // The dispatch input: a string that defaults to empty. No dispatch input mentions enqueue.
  const at = code.indexOf('      nudge_pr:');
  assert.notEqual(at, -1);
  assert.deepEqual(code.slice(at + 2, at + 5).map((l) => l.trim()), ['required: false', "default: ''", 'type: string']);
  const inputsAt = code.indexOf('    inputs:');
  const inputNames = code.slice(inputsAt + 1, code.indexOf('permissions:')).filter((l) => /^      [a-z_]+:$/.test(l)).map((l) => l.trim());
  assert.deepEqual(inputNames, ['dry_run:', 'nudge_pr:']);
});

// The step's shell, really run: the node call is replaced by an echo of its arguments.
test('enqueue-sweep.yml T1 step shell: as shipped it passes no flag; no NUDGE_PR value can add --enqueue or --nudge', (t) => {
  const { run } = t1StepOfWorkflow();
  const probe = spawnSync('sh', ['-c', 'exit 0']);
  if (probe.status !== 0) {
    assert.ok(!process.env.GITHUB_ACTIONS, 'sh must exist in CI');
    t.skip('no sh on this machine; the text of the run block is pinned by the test above');
    return;
  }
  const script = run.join('\n').replace('node operations/devops/t1-enqueue-sweep.mjs "${{ github.repository }}"', 'printf "[%s]" o/r');
  assert.ok(!script.includes('${{'), script);
  const args = (env) => {
    const r = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, DRY_RUN: '', NUDGE_PR: '', T1_NUDGE: 'off', T1_ENQUEUE: 'off', ...env } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.slice(1, -1).split('][');
  };
  assert.deepEqual(args({}), ['o/r'], 'as shipped: report-only');
  assert.deepEqual(args({ DRY_RUN: '--dry-run' }), ['o/r', '--dry-run']);
  assert.deepEqual(args({ T1_NUDGE: 'on' }), ['o/r', '--nudge']);
  assert.deepEqual(args({ T1_ENQUEUE: 'on' }), ['o/r', '--enqueue']);
  assert.deepEqual(args({ T1_NUDGE: 'on', T1_ENQUEUE: 'on' }), ['o/r', '--nudge', '--enqueue']);
  assert.deepEqual(args({ NUDGE_PR: '5170' }), ['o/r', '--nudge-pr=5170']);
  // Fails closed on anything other than exactly 'on'.
  for (const v of ['', 'ON', 'On', 'true', '1', 'yes', 'on ', ' on', 'off', "'on'"]) {
    assert.deepEqual(args({ T1_NUDGE: v, T1_ENQUEUE: v }), ['o/r'], JSON.stringify(v));
  }
  // A NUDGE_PR that is not all digits is dropped whole, so it cannot smuggle in another flag.
  for (const v of ['1 --enqueue', '--enqueue', '--nudge', '1;--enqueue', '1\n--enqueue', '12a', '-1', '1.5', ' 7', '7 ', '$(echo 7)', '*']) {
    assert.deepEqual(args({ NUDGE_PR: v }), ['o/r'], JSON.stringify(v));
  }
  // Every output of the shell, parsed by the CLI: enqueue is on only when T1_ENQUEUE is 'on'.
  for (const env of [{}, { T1_NUDGE: 'on' }, { NUDGE_PR: '5170' }, { NUDGE_PR: '1 --enqueue' }, { DRY_RUN: '--dry-run', NUDGE_PR: '9', T1_NUDGE: 'on' }]) {
    assert.equal(parseCliArgs(args(env)).enqueueEnabled, false, JSON.stringify(env));
  }
  assert.deepEqual(parseCliArgs(args({})), { repo: 'o/r', dryRun: false, enqueueEnabled: false, nudgeEnabled: false, nudgeOnlyPr: null });
});

test('shim: the guard is fetched only for T1 PRs; T0 PRs are not touched', async () => {
  const mocks = quiet();
  try {
    const { calls, deps } = harness({ listed: [pr({ number: 3, body: 'Tier: T0\nx', guard: undefined })], live: null });
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, deps }), {});
    assert.deepEqual(calls.guard, []);
    assert.equal(calls.enqueue.length, 0);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});
