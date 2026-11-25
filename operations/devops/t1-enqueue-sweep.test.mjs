// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/t1-enqueue-sweep.test.mjs
// Gate-signal proof for the T1 auto-enqueue arm (t/73, Orca t/4820): the pass arm and every
// refusal arm run against the real selection code (selectT1Candidates, which calls the shared
// sharedSkipReason and approvalFromApiVerdict, t/534 part A), and the shim tests run the real sweep ->
// enqueueOne path with only GitHub I/O faked.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectT1Candidates, declaresT1, headBoundApprover, sweep, postGuardNudge, parseCliArgs, GUARD_APPROVED_SUMMARY, GUARD_NUDGE_MARKER,
} from './t1-enqueue-sweep.mjs';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { selectT0Candidates, enqueueOne } from './t0-enqueue-sweep.mjs';
import { budgetRefusalMessage } from './pr-budget.mjs';
import { latestRoleVerdicts } from './role-review-verdicts.mjs';
import { evaluateT1ApprovalGuard, latestRoleVerdicts as inlinedLatestRoleVerdicts } from './t1-approval-guard-predicate.mjs';

const HEAD = 'head2222';
const OLD_HEAD = 'head1111';
const REVIEWER = 'ai-triad-reviewer-jpsnover';
const start = '2026-11-09T10:00:00Z';
const green = (over = {}) => ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard']
  .map((name) => ({ name, status: 'COMPLETED', conclusion: over[name] ?? 'SUCCESS', startedAt: start }));
// A guard check run, green and summarised as approved. t/534 part A: the sweep never reads it, so a
// PR carrying one (forged or real) is decided by its reviews alone.
const GREEN_GUARD_ROW = {
  lookupError: false,
  run: { status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-09T10:30:00Z',
    output: { title: 't1-approval-guard: OK', summary: GUARD_APPROVED_SUMMARY } },
};
const approvalAt = (commitId, role = 'Quality') => ({
  body: `Approved (${role}): at ${commitId}.`, login: REVIEWER, commitId, submittedAt: '2026-11-09T10:29:00Z',
});
const basePr = (over = {}) => ({
  number: 1, body: 'Tier: T1\n\nA cross-role contract.', headRefOid: HEAD, headRefName: 'devops/t73-x',
  baseRefName: 'main', isDraft: false, isInMergeQueue: false, mergeStateStatus: 'BLOCKED', author: 'ai-triad-author-jpsnover',
  labels: [], isCrossRepository: false, autoMergeRequest: null, contexts: green(),
  reviewDataError: false, files: ['operations/devops/x.mjs'], reviews: [approvalAt(HEAD)], comments: [], queueEvents: [],
  ...over,
});
// What fetchApprovalInputs reads at the head (REST shape), built from the same reviews and comments
// the listing carries. GraphQL gives the App's login without `[bot]`, REST with it.
const APP_REST = `${REVIEWER}[bot]`;
const PUSHED = '2026-11-09T10:00:00Z';
const restLogin = (l) => (l === REVIEWER ? APP_REST : l);
function apiFrom(p) {
  return {
    error: null,
    pr: { head: { sha: p.headRefOid, ref: p.headRefName }, body: p.body, created_at: '2026-11-09T09:00:00Z' },
    commits: [{ commit: { committer: { date: PUSHED } } }],
    comments: (p.comments ?? []).map((c) => ({ body: c.body, created_at: c.createdAt, updated_at: c.updatedAt ?? c.createdAt, user: { login: restLogin(c.login) } })),
    reviews: (p.reviews ?? []).map((r) => ({
      body: r.body, state: r.state ?? (/^Changes requested/.test(r.body) ? 'CHANGES_REQUESTED' : 'APPROVED'),
      submitted_at: r.submittedAt, commit_id: r.commitId, user: { login: restLogin(r.login) },
    })),
  };
}
const pr = (over = {}) => {
  const p = basePr(over);
  if (!('approvalInputs' in over)) p.approvalInputs = apiFrom(p);
  return p;
};
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

// ---- t/534 part A: the decision is the API-read approval, never a check run ----
test('t/534 A: a green (forged) guard row on an unapproved PR does not get it selected', () => {
  assert.equal(skipReason(pr({ reviews: [], guard: GREEN_GUARD_ROW })), 'approval at head is no_approval');
});

test('t/534 A: an approved PR is selected with no guard row at all (a missing run no longer blocks)', () => {
  assert.equal(only(pr({ guard: undefined })).enqueue.length, 1);
});

test('t/534 A (Security condition 1): an approval only from a shared-login comment is not selected', () => {
  const comment = { body: 'Approved (Quality): fine', login: 'jpsnover', createdAt: '2026-11-09T11:00:00Z', updatedAt: null };
  assert.equal(skipReason(pr({ reviews: [], comments: [comment] })), 'approval at head is no_approval');
});

// ---- refusal arms ----
test('REFUSE: stale-head approval (review bound to the previous head) is not enqueued', () => {
  assert.equal(skipReason(pr({ reviews: [approvalAt(OLD_HEAD)] })), 'approval at head is no_approval');
});

test('REFUSE: a comment-only approval (not bound to a SHA), even the reviewer App\'s, is not auto-enqueued (comments never approve, Lead t/534)', () => {
  const comment = { body: 'Approved (Quality): looks good', login: REVIEWER, createdAt: '2026-11-09T11:00:00Z', updatedAt: null };
  assert.equal(skipReason(pr({ reviews: [], comments: [comment] })), 'approval at head is no_approval');
});

test('REFUSE: self-approval (the branch owner role approving its own devops/ branch) is not enqueued', () => {
  assert.equal(skipReason(pr({ reviews: [approvalAt(HEAD, 'DevOps Lead')] })), 'approval at head is no_approval');
});

test('REFUSE: an approval from a human or another App login is ignored', () => {
  assert.equal(skipReason(pr({ reviews: [{ ...approvalAt(HEAD), login: 'someone' }] })), 'approval at head is no_approval');
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

test('REFUSE: unapproved T1 (no approval at the head) is not enqueued', () => {
  assert.equal(skipReason(pr({ reviews: [] })), 'approval at head is no_approval');
});

test('t/534 A: guard nudges are retired -- no selection result ever carries a guardNudge', () => {
  for (const over of [{}, { guard: undefined }, { reviews: [] }, { reviews: [approvalAt(OLD_HEAD)] }, { approvalInputs: { error: new Error('x') } }]) {
    const { enqueue, skip } = only(pr(over));
    for (const s of skip) assert.equal(s.guardNudge, undefined, JSON.stringify(over));
    assert.ok(enqueue.length + skip.length === 1);
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

test('REFUSE (Security condition 2): an approval read that failed, or none at all, fails closed', () => {
  assert.match(skipReason(pr({ approvalInputs: { error: new Error('HTTP 502') } })), /^WARN: could not read the approval at the head \(HTTP 502\)/);
  assert.match(skipReason(pr({ approvalInputs: undefined })), /^WARN: could not read the approval at the head/);
});

test('REFUSE: an API read for a different head than the listing is a lookup error', () => {
  const p = pr();
  p.approvalInputs = apiFrom({ ...p, headRefOid: 'otherhead' });
  assert.match(skipReason(p), /^WARN: could not read the approval at the head \(the API read is for otherhead, not head2222\)/);
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
  const t0 = pr({ number: 2, body: 'Tier: T0\nx', reviews: [] });
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
  const calls = { enqueue: [], gh: [], approval: [], nudged: [] };
  const deps = {
    list: () => listed.map((p) => ({ ...p })),
    fetchApproval: (repo, n, sha) => { calls.approval.push(sha); return listed.find((p) => p.number === n).approvalInputs; },
    // Retired (t/534): the sweep must never call it, whatever the flags say.
    nudge: (repo, n, x) => calls.nudged.push({ n, ...x }),
    enqueueDeps: {
      readLive: () => live,
      enqueue: async (repo, n, opts) => { calls.enqueue.push({ n, opts }); return { ok: true, state: 'queued' }; },
      ghFn: (args) => {
        calls.gh.push(args);
        // t/600: the disarm is GraphQL now; answer the node-id read.
        if (args.join(' ').includes('pullRequest(number')) return JSON.stringify({ data: { repository: { pullRequest: { id: 'PR_1', autoMergeRequest: { enabledAt: 'x' } } } } });
        return '';
      },
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
    assert.deepEqual(calls.approval, [HEAD]);
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

// t/602: enqueue-pr's real budget refusal message (pr-budget.mjs) drives these, so a change to its wording breaks them.
const refusal = (reason) => Object.assign(
  new Error(budgetRefusalMessage({ repo: 'o/r', prNumber: 1, verdict: { reason, rank: 21, budget: 20, day: '2026-11-24', dayBudget: 20 } })),
  { name: 'ActionableError', reason });
const liveOpen = { state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: HEAD };

test('t/602, t/656: a wrong-vehicle refusal (not_a_vehicle, feature_too_small, incident_not_open) is a logged skip; the sweep does not throw and nothing is re-armed', async () => {
  for (const reason of ['not_a_vehicle', 'feature_too_small', 'incident_not_open']) {
    const logs = [];
    const mocks = [mock.method(console, 'log', (l) => logs.push(String(l))), mock.method(console, 'warn', () => {}),
      mock.method(console, 'error', (l) => logs.push(`ERR ${l}`))];
    try {
      const { calls, deps } = harness({ listed: [pr()], live: liveOpen });
      deps.enqueueDeps.enqueue = async (repo, n, opts) => { calls.enqueue.push({ n, opts }); throw refusal(reason); };
      assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, deps }), { 1: 'skipped' }, reason);
      assert.equal(calls.enqueue.length, 1, reason);
      assert.ok(logs.includes(`skip #1: not on a landing vehicle (${reason}); land it on an area train (t/656)`), logs.join('\n'));
      assert.ok(!logs.some((l) => l.startsWith('ERR ')), `no ::error:: for ${reason}`);
      assert.ok(!calls.gh.some((a) => a.join(' ').includes('enablePullRequestAutoMerge')), 'never re-armed (t/600)');
    } finally { mocks.forEach((m) => m.mock.restore()); }
  }
});

test('t/602: every other refusal still fails the sweep (gate files, approval, vehicle_read_failed, budget_exempt_invalid) and a non-refusal error too', async () => {
  const errs = [
    new Error('enqueue-pr: refusing to arm/enqueue #1 on o/r (gate_files_changed).\n  Goal: x'),
    new Error('enqueue-pr: refusing to arm/enqueue #1 on o/r (no_approval_at_head).'),
    refusal('vehicle_read_failed'),
    refusal('budget_exempt_invalid'),
    new Error('gh: HTTP 502'),
  ];
  for (const err of errs) {
    const mocks = [mock.method(console, 'log', () => {}), mock.method(console, 'warn', () => {}), mock.method(console, 'error', () => {})];
    try {
      const { deps } = harness({ listed: [pr()], live: liveOpen });
      deps.enqueueDeps.enqueue = async () => { throw err; };
      await assert.rejects(sweep('o/r', { enqueueEnabled: true, deps }), /t1-enqueue-sweep: failed to enqueue #1/, err.message.split('\n')[0]);
    } finally { mocks.forEach((m) => m.mock.restore()); }
  }
});

test('t/602: the T0 path shares enqueueOne, so a budget refusal returns skipped there too', async () => {
  const mocks = [mock.method(console, 'log', () => {}), mock.method(console, 'error', () => {})];
  try {
    const deps = { readLive: () => liveOpen, enqueue: async () => { throw refusal('not_a_vehicle'); }, ghFn: () => '' };
    assert.equal(await enqueueOne('o/r', { number: 1, headRefOid: HEAD, armed: false }, { deps }), 'skipped');
    deps.enqueue = async () => { throw new Error('enqueue-pr: refusing to arm/enqueue #1 on o/r (gate_files_changed).'); };
    assert.equal(await enqueueOne('o/r', { number: 1, headRefOid: HEAD, armed: false }, { deps }), 'failed');
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('t/656 (SO p/136#75): an incident/* PR is skipped by the sweeps with a reason, before any live read or enqueue', async () => {
  const logs = [];
  const mocks = [mock.method(console, 'log', (l) => logs.push(String(l))), mock.method(console, 'error', (l) => logs.push(`ERR ${l}`))];
  try {
    let reads = 0;
    let enqueues = 0;
    const deps = { readLive: () => { reads++; return liveOpen; }, enqueue: async () => { enqueues++; return { ok: true }; }, ghFn: () => '' };
    assert.equal(await enqueueOne('o/r', { number: 1, headRefOid: HEAD, armed: false, headRefName: 'incident/t650-key' }, { deps }), 'skipped');
    assert.equal(reads, 0); assert.equal(enqueues, 0);
    assert.ok(logs.some((l) => /^skip #1: an incident PR \(incident\/t650-key\) is enqueued by hand/.test(l)), logs.join('\n'));
    assert.ok(!logs.some((l) => l.startsWith('ERR ')));
    // Any other branch still goes through the live read and the enqueue.
    assert.equal(await enqueueOne('o/r', { number: 1, headRefOid: HEAD, armed: false, headRefName: 'train/devops-20261126' }, { deps }), 'enqueued');
    assert.equal(enqueues, 1);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

test('shim (t/534 A): a failed approval read WARNs and skips the PR; nothing is enqueued', async () => {
  const logs = [];
  const mocks = [mock.method(console, 'log', (l) => logs.push(String(l))), mock.method(console, 'warn', (l) => logs.push(String(l)))];
  try {
    const { calls, deps } = harness({ listed: [pr({ approvalInputs: { error: new Error('HTTP 502') } })], live: null });
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, deps }), {});
    assert.equal(calls.enqueue.length, 0);
    assert.ok(logs.some((l) => /^WARN: could not read the approval for #1 at head2222 \(HTTP 502\)/.test(l)), logs.join('\n'));
  } finally { mocks.forEach((m) => m.mock.restore()); }
});

// ---- the enqueue gate (Second Opinion's conditions on #4795): ships off, fails safe ----
function gateHarness(listed) {
  const live = { state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: HEAD };
  const { calls, deps } = harness({ listed, live });
  calls.readLive = 0;
  deps.enqueueDeps.readLive = () => { calls.readLive++; return live; };
  const logs = [];
  const mocks = [mock.method(console, 'log', (l) => logs.push(String(l))), mock.method(console, 'warn', () => {})];
  return { calls, deps, logs, restore: () => mocks.forEach((m) => m.mock.restore()) };
}
const armedPr = () => pr({ autoMergeRequest: { enabledAt: 't' } }); // armed: enqueueOne would disarm it first
const STATUS_OFF = 'T1 sweep: enqueue is OFF (no --enqueue); guard nudges are retired (t/534). This run only reports.';

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
    assert.deepEqual(h.calls.approval, [HEAD], 'the approval is still read');
    assert.ok(h.logs.includes(`[enqueue off] would enqueue #1 at ${HEAD}`), h.logs.join('\n'));
    assert.ok(h.logs.includes(STATUS_OFF), h.logs.join('\n'));
    assert.ok(!h.logs.some((l) => /^enqueued #/.test(l)));
  }
});

test('t/534 A: guard nudges are retired -- no nudge option comments on anything; only the enqueue gate acts', async () => {
  const listed = [pr(), pr({ number: 2, reviews: [] }), pr({ number: 4, isDraft: true })];
  for (const opts of [{}, { nudgeEnabled: true }, { nudgeOnlyPr: 2 }, { nudgeEnabled: true, nudgeOnlyPr: 1 }, { nudgeEnabled: true, enqueueEnabled: true }]) {
    const h = gateHarness(listed);
    let out;
    try {
      out = await sweep('o/r', { ...opts, deps: h.deps });
    } finally { h.restore(); }
    const label = JSON.stringify(opts);
    assert.deepEqual(h.calls.nudged, [], `no nudge: ${label}`);
    assert.ok(!h.logs.some((l) => l.startsWith('[nudge off]') || /re-run/.test(l)), `${label}\n${h.logs.join('\n')}`);
    assert.deepEqual(out, opts.enqueueEnabled === true ? { 1: 'enqueued' } : {}, label);
    const nudgeAsked = opts.nudgeEnabled === true || opts.nudgeOnlyPr != null;
    assert.ok(h.logs.some((l) => l.startsWith('T1 sweep: enqueue is') && l.includes('guard nudges are retired (t/534)') &&
      (l.includes('--nudge / --nudge-pr do nothing') === nudgeAsked)), `${label}\n${h.logs.join('\n')}`);
    assert.ok(h.logs.includes('skip #2: approval at head is no_approval'), h.logs.join('\n'));
    assert.ok(h.logs.includes('skip #4: draft'), h.logs.join('\n'));
  }
});

test('dryRun wins over the enqueue gate and the nudge flags: nothing enqueued, nothing nudged, no status line', async () => {
  const h = gateHarness([armedPr(), pr({ number: 2, reviews: [] })]);
  try {
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, nudgeEnabled: true, nudgeOnlyPr: 2, dryRun: true, deps: h.deps }), {});
  } finally { h.restore(); }
  assert.deepEqual(h.calls.enqueue, []);
  assert.deepEqual(h.calls.gh, []);
  assert.equal(h.calls.readLive, 0);
  assert.deepEqual(h.calls.nudged, []);
  assert.ok(h.logs.includes(`[dry-run] would enqueue #1 at ${HEAD}`), h.logs.join('\n'));
  assert.ok(!h.logs.some((l) => l.startsWith('T1 sweep:') || l.startsWith('[enqueue off]')));
});

test('gate ON: the same PR is enqueued (disarmed first, pinned to its head), with no [enqueue off] line', async () => {
  const h = gateHarness([armedPr()]);
  try {
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, deps: h.deps }), { 1: 'enqueued' });
  } finally { h.restore(); }
  assert.deepEqual(h.calls.enqueue, [{ n: 1, opts: { expectedHeadOid: HEAD } }]);
  // t/600: disarmed through GraphQL (node-id read, then disablePullRequestAutoMerge); never `gh pr merge`.
  assert.equal(h.calls.gh.length, 2);
  assert.ok(h.calls.gh[1].join(' ').includes('disablePullRequestAutoMerge'));
  assert.ok(h.calls.gh.every((a) => !(a[0] === 'pr' && a[1] === 'merge')));
  assert.equal(h.calls.readLive, 1);
  assert.ok(!h.logs.some((l) => l.startsWith('[enqueue off]')));
  assert.ok(h.logs.some((l) => /^T1 sweep: enqueue is ON/.test(l)));
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

// Flipping T1_ENQUEUE to 'on' arms auto-enqueue on the next sweep. That is a separate, reviewed (T2)
// commit, and it has to change this test in the same commit. (T1_NUDGE is gone: t/534 part A.)
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

// t/73 (TL p/12#274, after t/655): T1 auto-enqueue is ON. Every enqueue still goes through enqueuePR unchanged
// (vehicle check, approval at head, gate-file refusal). Turning it off again is a reviewed commit that changes this test.
test('enqueue-sweep.yml T1 ENQUEUE IS ON (t/73): T1_ENQUEUE is the literal \'on\', its flag is passed only when it is \'on\', and the nudge plumbing is gone', () => {
  const { code, step, env, run } = t1StepOfWorkflow();
  assert.equal(step[0], "      - name: T1 sweep (enqueues only when T1_ENQUEUE is 'on')");

  // The switch: a literal in the step's env, assigned once in the whole file, never an expression.
  assert.deepEqual(code.filter((l) => /T1_ENQUEUE\s*:/.test(l)).map((l) => l.trim()), ["T1_ENQUEUE: 'on'"]);
  // The whole env of the step.
  assert.deepEqual(env, [
    'GH_TOKEN: ${{ steps.app.outputs.token }}',
    "DRY_RUN: ${{ inputs.dry_run && '--dry-run' || '' }}",
    "T1_ENQUEUE: 'on'",
  ]);
  // The whole run block: the flag exists only behind its own test, and the sweep is called once.
  assert.deepEqual(run, [
    "ENQUEUE_FLAG=''",
    'if [ "$T1_ENQUEUE" = "on" ]; then ENQUEUE_FLAG=\'--enqueue\'; fi',
    'node operations/devops/t1-enqueue-sweep.mjs "${{ github.repository }}" $DRY_RUN $ENQUEUE_FLAG',
  ]);
  // Nowhere else in the workflow can the flag or the script appear.
  assert.equal(code.filter((l) => l.includes('--enqueue')).length, 1);
  assert.equal(code.filter((l) => l.includes('t1-enqueue-sweep.mjs')).length, 1);
  assert.equal(code.filter((l) => l.includes('ENQUEUE_FLAG=')).length, 2);
  // t/534 part A retired guard nudges (t/438 cancelled): no nudge switch, flag or dispatch input is left.
  assert.equal(code.filter((l) => /nudge|NUDGE/.test(l)).length, 0, code.filter((l) => /nudge|NUDGE/.test(l)).join('\n'));
  // The dispatch inputs: dry_run only. No dispatch input mentions enqueue.
  const inputsAt = code.indexOf('    inputs:');
  const inputNames = code.slice(inputsAt + 1, code.indexOf('permissions:')).filter((l) => /^      [a-z_]+:$/.test(l)).map((l) => l.trim());
  assert.deepEqual(inputNames, ['dry_run:']);
});

// The step's shell, really run: the node call is replaced by an echo of its arguments.
test('enqueue-sweep.yml T1 step shell: as shipped it passes no flag; only T1_ENQUEUE exactly \'on\' adds --enqueue', (t) => {
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
    const r = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, DRY_RUN: '', T1_ENQUEUE: 'off', ...env } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.slice(1, -1).split('][');
  };
  assert.deepEqual(args({}), ['o/r'], 'with T1_ENQUEUE off (the harness default): report-only');
  assert.deepEqual(args({ DRY_RUN: '--dry-run' }), ['o/r', '--dry-run']);
  assert.deepEqual(args({ T1_ENQUEUE: 'on' }), ['o/r', '--enqueue']);
  // Fails closed on anything other than exactly 'on'.
  for (const v of ['', 'ON', 'On', 'true', '1', 'yes', 'on ', ' on', 'off', "'on'"]) {
    assert.deepEqual(args({ T1_ENQUEUE: v }), ['o/r'], JSON.stringify(v));
  }
  assert.deepEqual(parseCliArgs(args({})), { repo: 'o/r', dryRun: false, enqueueEnabled: false, nudgeEnabled: false, nudgeOnlyPr: null });
});

test('shim: the approval is read only for T1 PRs; T0 PRs are not touched', async () => {
  const mocks = quiet();
  try {
    const { calls, deps } = harness({ listed: [pr({ number: 3, body: 'Tier: T0\nx' })], live: null });
    assert.deepEqual(await sweep('o/r', { enqueueEnabled: true, deps }), {});
    assert.deepEqual(calls.approval, []);
    assert.equal(calls.enqueue.length, 0);
  } finally { mocks.forEach((m) => m.mock.restore()); }
});
