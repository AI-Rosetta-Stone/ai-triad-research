// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4939: converted from vitest (describe/it/expect from 'vitest') to node:test. The file
// imported `vitest`, which isn't installed at the repo root and has no CI wiring anywhere in
// .github/workflows -- `node --test` on this file failed outright before this change. Every
// pre-existing assertion is preserved verbatim; only the test-runner API changed.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_SCRIPTS, PR_FILES_API_CAP, gateFileChangeVerdict, isGateFile } from './gate-file-change.mjs';
import {
  classifyEnqueueOutcome, formatSilentMissWarning, classifyT1GuardForEnqueue, enqueuePR,
  fetchGuardRun, classifyGhApiError, pickAuthoritativeGuardRun, tierCheckDisagreesAt, approvalFromApiVerdict,
  holdLabelVerdict,
} from './enqueue-pr.mjs';
import { COMMENT_APPROVER_ALLOWLIST } from './t1-approval-at-head.mjs';

test('classifyEnqueueOutcome: is queued when both isInMergeQueue and mergeQueueEntry are present', () => {
  assert.deepEqual(classifyEnqueueOutcome({
    isInMergeQueue: true, mergeQueueEntry: { position: 1, state: 'QUEUED' }, autoMergeRequest: null,
  }), { state: 'queued' });
});

test('classifyEnqueueOutcome: is NOT queued when isInMergeQueue is true but mergeQueueEntry is null (t/4740#1 shape)', () => {
  assert.deepEqual(classifyEnqueueOutcome({ isInMergeQueue: true, mergeQueueEntry: null, autoMergeRequest: null }),
    { state: 'not_armed' });
});

test('classifyEnqueueOutcome: is NOT queued when isInMergeQueue is false, even with a stale mergeQueueEntry', () => {
  assert.deepEqual(classifyEnqueueOutcome({
    isInMergeQueue: false, mergeQueueEntry: { position: 1, state: 'QUEUED' }, autoMergeRequest: null,
  }), { state: 'not_armed' });
});

test('classifyEnqueueOutcome: is not_armed when all fields are null (the #4298 shape, TL p/331#2548)', () => {
  assert.deepEqual(classifyEnqueueOutcome({ isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null }),
    { state: 'not_armed' });
});

test('classifyEnqueueOutcome: is armed_waiting when autoMergeRequest is set but the PR has not entered the queue yet ' +
  '-- required checks still pending (t/4768, PR #4351 incident shape)', () => {
  assert.deepEqual(classifyEnqueueOutcome({
    isInMergeQueue: false,
    mergeQueueEntry: null,
    autoMergeRequest: { mergeMethod: 'MERGE', enabledAt: '2026-11-02T21:50:17Z', enabledBy: { login: 'jpsnover' } },
  }), { state: 'armed_waiting' });
});

// t/4889: data#79/#80. ai-triad-data has no merge queue and allow_auto_merge=false, so
// `gh pr merge --auto` merges at once and every queue field reads null afterwards.
const directMergeAfter = {
  state: 'MERGED', mergedAt: '2026-11-05T09:51:33Z', mergeCommit: { oid: 'f98b5f57' },
  isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null,
};

test('classifyEnqueueOutcome: is merged when the PR became MERGED during this run (direct merge, no queue)', () => {
  assert.deepEqual(classifyEnqueueOutcome(directMergeAfter, { before: { state: 'OPEN' } }), { state: 'merged' });
});

test('classifyEnqueueOutcome: is already_merged when the PR was MERGED before this run (TL t/4889#3)', () => {
  assert.deepEqual(classifyEnqueueOutcome(directMergeAfter, { before: { state: 'MERGED' } }), { state: 'already_merged' });
});

test('classifyEnqueueOutcome: is already_merged, never merged, when the prior state is unknown (does not claim the merge)', () => {
  assert.deepEqual(classifyEnqueueOutcome(directMergeAfter), { state: 'already_merged' });
});

test('classifyEnqueueOutcome: is still not_armed for an OPEN PR with null queue fields, so the fallback path is unchanged', () => {
  assert.deepEqual(classifyEnqueueOutcome(
    { state: 'OPEN', isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null },
    { before: { state: 'OPEN' } },
  ), { state: 'not_armed' });
});

test('classifyEnqueueOutcome: prefers queued over armed_waiting when the PR has genuinely entered the queue', () => {
  assert.deepEqual(classifyEnqueueOutcome({
    isInMergeQueue: true,
    mergeQueueEntry: { position: 1, state: 'QUEUED' },
    autoMergeRequest: { mergeMethod: 'SQUASH', enabledAt: '2026-11-02T21:50:17Z', enabledBy: { login: 'jpsnover' } },
  }), { state: 'queued' });
});

test('formatSilentMissWarning: names the PR, repo, CLI output and prior auto-merge state', () => {
  const msg = formatSilentMissWarning({
    repo: 'AI-Rosetta-Stone/ai-triad-research',
    prNumber: 4262,
    cliOutput: '! The merge strategy for main is set by the merge queue',
    priorAutoMergeRequest: { mergeMethod: 'MERGE', enabledAt: '2026-10-31T18:33:34Z', enabledBy: { login: 'app/github-actions' } },
  });

  assert.match(msg, /WARN:/);
  assert.match(msg, /#4262/);
  assert.match(msg, /AI-Rosetta-Stone\/ai-triad-research/);
  assert.match(msg, /merge strategy for main is set by the merge queue/);
  assert.match(msg, /MERGE/);
  assert.match(msg, /app\/github-actions/);
});

test('formatSilentMissWarning: handles a null prior auto-merge state without throwing', () => {
  const msg = formatSilentMissWarning({ repo: 'o/r', prNumber: 1, cliOutput: '', priorAutoMergeRequest: null });
  assert.match(msg, /null/);
});

// t/4939: the interim refusal, folding in Quality's 3 should-fixes (t/4939#2).
const GHA_SUCCESS = { status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } };
const GHA_FAILURE = { status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } };
const GHA_IN_PROGRESS = { status: 'in_progress', conclusion: null, app: { slug: 'github-actions' } };
const GHA_QUEUED = { status: 'queued', conclusion: null, app: { slug: 'github-actions' } };
const OTHER_APP_SUCCESS = { status: 'completed', conclusion: 'success', app: { slug: 'some-other-bot' } };

test('classifyT1GuardForEnqueue: T1 + guard failure -> refuse', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: GHA_FAILURE }),
    { allow: false, reason: 'guard_failure', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T1 + guard missing -> refuse (fail-closed)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: null }),
    { allow: false, reason: 'guard_missing', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T1 + guard in_progress -> refuse (fail-closed, the #4648 shape)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: GHA_IN_PROGRESS }),
    { allow: false, reason: 'guard_in_progress', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T1 + guard queued -> refuse (fail-closed)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: GHA_QUEUED }),
    { allow: false, reason: 'guard_queued', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T1 + guard success -> allow', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: GHA_SUCCESS }),
    { allow: true, reason: 'guard_success', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T0 + guard missing -> allow (no approval rule for T0)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T0', isDraft: false, guardRun: null }),
    { allow: true, reason: 'tier_exempt', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T2 + guard pending -> allow (T2 is gated by consult-hold elsewhere)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T2', isDraft: false, guardRun: GHA_IN_PROGRESS }),
    { allow: true, reason: 'tier_exempt', warn: null },
  );
});

test('classifyT1GuardForEnqueue: any tier + guard failure -> refuse, even T0/T2', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T0', isDraft: false, guardRun: GHA_FAILURE }),
    { allow: false, reason: 'guard_failure', warn: null },
  );
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T2', isDraft: false, guardRun: GHA_FAILURE }),
    { allow: false, reason: 'guard_failure', warn: null },
  );
});

test('classifyT1GuardForEnqueue: unparseable tier + guard missing -> refuse (treated as T1, fail-closed)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: null, isDraft: false, guardRun: null }),
    { allow: false, reason: 'guard_missing', warn: null },
  );
});

test('classifyT1GuardForEnqueue: unparseable tier + guard success -> allow (treated as T1, and T1 passes on success)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: null, isDraft: false, guardRun: GHA_SUCCESS }),
    { allow: true, reason: 'guard_success', warn: null },
  );
});

test('classifyT1GuardForEnqueue: draft is refused whatever the tier (should-fix 1) -- T1 draft', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: true, guardRun: GHA_SUCCESS }),
    { allow: false, reason: 'draft', warn: null },
  );
});

test('classifyT1GuardForEnqueue: draft is refused whatever the tier (should-fix 1) -- T0 draft (the #4648 shape)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T0', isDraft: true, guardRun: null }),
    { allow: false, reason: 'draft', warn: null },
  );
});

test('classifyT1GuardForEnqueue: a success run from a non-github-actions app is ignored -> missing-run refusal (should-fix 2)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: OTHER_APP_SUCCESS }),
    { allow: false, reason: 'guard_missing', warn: null },
  );
});

test('classifyT1GuardForEnqueue: T0 + tier-check disagrees -> still allowed, but warns (should-fix 3, WARN-only arm)', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T0', isDraft: false, guardRun: null, tierCheckDisagreesOnT0: true }),
    { allow: true, reason: 'tier_exempt', warn: "tier-check's completed run at this head disagrees with the declared Tier: T0 -- review manually; enqueue-pr does not block on this signal yet (t/4939 follow-up)." },
  );
});

test('classifyT1GuardForEnqueue: T0 + tier-check agrees (or wasn\'t consulted) -> allowed, no warn', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T0', isDraft: false, guardRun: null, tierCheckDisagreesOnT0: false }),
    { allow: true, reason: 'tier_exempt', warn: null },
  );
});

test('classifyT1GuardForEnqueue: tierCheckDisagreesOnT0 is only consulted for T0 -- a T1 PR never gets the warn', () => {
  assert.deepEqual(
    classifyT1GuardForEnqueue({ tier: 'T1', isDraft: false, guardRun: GHA_SUCCESS, tierCheckDisagreesOnT0: true }),
    { allow: true, reason: 'guard_success', warn: null },
  );
});

// t/4939 shim tests (Quality, p/780#25): proving the WIRING, not just the predicate. Moving
// the refusal check below `gh pr merge` in enqueuePR would keep every test above green --
// these three exist specifically to catch that class of regression. `gh` is injected via
// `enqueuePR`'s options so no real CLI call happens in a unit test.

const APP = 'ai-triad-reviewer-jpsnover[bot]';
const PUSHED = '2026-11-09T00:00:00Z';
const appReview = (over = {}) => ({
  state: 'APPROVED', body: 'Approved (Quality): read it.', submitted_at: '2026-11-09T01:00:00Z',
  commit_id: 'cafebabe', user: { login: APP }, ...over,
});
const sharedComment = (body, at = '2026-11-09T01:00:00Z', login = 'jpsnover') => ({ body, created_at: at, updated_at: at, user: { login } });
function approvalState(over = {}) {
  return {
    pr: { head: { sha: 'cafebabe', ref: 'devops/t1-change' }, body: 'Tier: T1\n\nsome PR body', created_at: '2026-11-08T00:00:00Z' },
    commits: [{ commit: { committer: { date: PUSHED } } }],
    comments: [],
    reviews: [appReview()],
    ...over,
  };
}

function fakeGhTracking() {
  const calls = [];
  // t/537: enqueuePR reads the PR's changed files before anything else. By default this fake
  // answers with one ordinary file, so the tests below exercise what they always did. A test sets
  // `fn.files` (a list of paths, or the string 'throw') and `fn.review` to exercise the gate-file check.
  const fn = (args) => {
    calls.push(args);
    const joined = args.join(' ');
    if (joined.includes('{changed_files}')) {
      if (fn.files === 'throw') throw new Error('gh: HTTP 502');
      return JSON.stringify({ changed_files: fn.changedFilesCount ?? fn.files.length });
    }
    if (joined.includes('/files?per_page=100')) return fn.files.map((f) => JSON.stringify([f, ''])).join('\n');
    if (/\/pulls\/\d+\/reviews\/\d+/.test(joined)) {
      if (!fn.review) throw new Error('gh: Not Found (HTTP 404)');
      return JSON.stringify(fn.review);
    }
    // t/534 part A: the approval reads (fetchApprovalInputs). Default: approved at the head by a
    // reviewer-App review, so every older test still exercises what it always did.
    const last = args[args.length - 1];
    if (args.includes('--slurp')) {
      if (fn.approvalError) throw new Error(fn.approvalError);
      const a = fn.approval;
      if (/\/pulls\/\d+\/commits\?/.test(last)) return JSON.stringify([a.commits]);
      if (/\/issues\/\d+\/comments\?/.test(last)) return JSON.stringify([a.comments]);
      if (/\/pulls\/\d+\/reviews\?/.test(last)) return JSON.stringify([a.reviews]);
    }
    if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(last)) {
      if (fn.approvalError) throw new Error(fn.approvalError);
      return JSON.stringify({ ...fn.approval.pr, commits: fn.prCommits ?? fn.approval.commits.length });
    }
    return fn.next(args);
  };
  fn.files = ['README.md'];
  fn.review = null;
  fn.approvalError = null;
  fn.approval = approvalState();
  fn.calls = calls;
  fn.next = () => { throw new Error('fakeGhTracking: no response configured for this call'); };
  return fn;
}

// t/556: every shim test runs as if the copy were origin/main's; the currency check itself is tested
// in running-copy-current.test.mjs and by the refusal test below.
// t/656: likewise every shim test runs as if the PR were on a landing vehicle; the vehicle check is
// tested in landing-vehicle.test.mjs and by the ordering tests there.
async function VEHICLE_OK() { return { allow: true, reason: 'train', vehicle: { kind: 'train' } }; }
function CURRENT() { return { ok: true, reason: 'current', mainSha: 'f'.repeat(40), paths: ['operations/devops/enqueue-pr.mjs'] }; }

test('t/556 shim: a stale running copy is refused BEFORE any gh call (no PR read, no guard read, no merge)', async () => {
  const fakeGh = fakeGhTracking();
  fakeGh.next = () => { throw new Error('no gh call may happen'); };
  for (const reason of ['differs', 'missing_on_main', 'fetch_failed', 'read_failed']) {
    const stale = () => ({ ok: false, reason, mainSha: 'f'.repeat(40), detail: 'operations/devops/enqueue-pr.mjs' });
    await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: stale, gh: fakeGh }), (err) => {
      assert.equal(err.reason, reason);
      assert.equal(err.name, 'ActionableError');
      assert.match(err.message, new RegExp(`refusing to run \\(${reason}\\)[\\s\\S]*Goal:[\\s\\S]*Problem:[\\s\\S]*Location:[\\s\\S]*Next steps:[\\s\\S]*\\.worktrees/main-tools`));
      return true;
    });
  }
  assert.equal(fakeGh.calls.length, 0);
  // A check that returns nothing is a refusal too (fail closed).
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: () => undefined, gh: fakeGh }), (err) => err.reason === 'no_result');
});

const T1_PR_VIEW = JSON.stringify({ headRefOid: 'cafebabe', body: 'Tier: T1\n\nsome PR body', isDraft: false, labels: [] });

// Both refusal tests mock the FULL happy-path chain (graphql queue reads, pr merge) too, not
// just the calls up to the refusal. If the refusal check were ever moved below `gh pr merge`
// (Quality's own demonstration, p/780#25), these would stop rejecting at all -- `assert.rejects`
// would fail outright -- rather than accidentally "passing" by rejecting for an unrelated
// unmocked-call error. A naive version of these tests that omits the happy-path mocks and
// merely asserts `assert.rejects(...)` is vacuous: it also "passes" when the refusal is gone,
// because the call then hits some OTHER unmocked gh invocation and throws for the wrong reason.
function happyPathNext(prView) {
  let graphqlCalls = 0;
  return (args) => {
    const joined = args.join(' ');
    if (joined.includes('pr view') && joined.includes('headRefOid,body,isDraft')) return prView;
    if (joined.includes('graphql') && joined.includes('enablePullRequestAutoMerge')) {
      throw new Error('the GraphQL fallback mutation must never be called in the success path');
    }
    if (joined.includes('graphql')) {
      graphqlCalls += 1;
      const queued = graphqlCalls > 1;
      return JSON.stringify({ data: { repository: { pullRequest: {
        state: 'OPEN', mergedAt: null, mergeCommit: null,
        isInMergeQueue: queued, mergeQueueEntry: queued ? { position: 1, state: 'QUEUED' } : null,
        headRefOid: 'cafebabe', mergeStateStatus: 'CLEAN', autoMergeRequest: null,
      } } } });
    }
    if (args[0] === 'pr' && args[1] === 'merge') return '✓ Auto-merge enabled';
    return undefined; // let the caller's own next() handle check-runs and anything else
  };
}

// ── t/534 part A: enqueuePR decides from the API-read reviews and comments, never a check run ──
// Every test below mocks the full happy path (graphql queue reads, pr merge) AND a green
// `t1-approval-guard` check run, so a refusal can only come from the API-read approval, and a
// refusal that vanished would reach `gh pr merge`.

const checkRunReads = (fakeGh) => fakeGh.calls.filter((a) => a.join(' ').includes('check-runs') && a.join(' ').includes('t1-approval-guard')).length;
const mergeCalls = (fakeGh) => fakeGh.calls.filter((a) => a[0] === 'pr' && a[1] === 'merge').length;
// A FORGED green row: same name, same app slug, same external_id, approved summary.
const FORGED_GREEN = JSON.stringify({ check_runs: [{
  name: 't1-approval-guard', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' },
  external_id: 't1-approval-guard:api', started_at: '2026-11-09T05:00:00Z', output: { summary: 'approved after the latest push' },
}] });
function forgedRowFake(approval) {
  const fakeGh = fakeGhTracking();
  if (approval) fakeGh.approval = approval;
  const happy = happyPathNext(T1_PR_VIEW);
  fakeGh.next = (args) => {
    const joined = args.join(' ');
    if (joined.includes('check-runs') && joined.includes('t1-approval-guard')) return FORGED_GREEN;
    const r = happy(args);
    if (r !== undefined) return r;
    throw new Error(`unexpected gh call: ${joined}`);
  };
  return fakeGh;
}

test('t/534 A (Security t/534#5): a FORGED green t1-approval-guard check run does not get an unapproved T1 PR enqueued', async () => {
  const fakeGh = forgedRowFake(approvalState({ reviews: [] }));
  await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /refusing to arm\/enqueue.*\(no_approval\)/s);
  assert.equal(mergeCalls(fakeGh), 0);
  assert.equal(checkRunReads(fakeGh), 0, 'the check run is never read for the decision');
});

test('t/534 A: a forged green row does not override an outstanding changes-request either', async () => {
  const fakeGh = forgedRowFake(approvalState({
    reviews: [appReview(), appReview({ state: 'CHANGES_REQUESTED', body: 'Changes requested (Security): fix it.', submitted_at: '2026-11-09T02:00:00Z' })],
  }));
  await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /\(changes_requested\)/);
  assert.equal(mergeCalls(fakeGh), 0);
});

test('t/534 A (Security condition 1): an approval only from the shared jpsnover login (comment) is refused', async () => {
  const fakeGh = forgedRowFake(approvalState({ reviews: [], comments: [sharedComment('Approved (Quality): fine.')] }));
  await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /\(no_approval\)/);
  assert.equal(mergeCalls(fakeGh), 0);
});

// Lead t/534 (3): blocking comes only from the reviewer App and OWNER/MEMBER/COLLABORATOR reviews.
const humanReview = (association, over = {}) => ({
  state: 'CHANGES_REQUESTED', body: 'Please fix the edge case.', submitted_at: '2026-11-09T02:00:00Z',
  commit_id: 'cafebabe', user: { login: `user-${association.toLowerCase()}` }, author_association: association, ...over,
});

test('t/534 A (3): a CHANGES_REQUESTED review from an OWNER, MEMBER or COLLABORATOR account blocks', async () => {
  for (const assoc of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const fakeGh = forgedRowFake(approvalState({ reviews: [appReview(), humanReview(assoc)] }));
    await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /\(changes_requested\)/, assoc);
    assert.equal(mergeCalls(fakeGh), 0, assoc);
  }
});

test('t/534 A (3): a changes-request from a public account (review or comment), or a shared-login comment, does NOT block', async () => {
  for (const assoc of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR']) {
    const fakeGh = forgedRowFake(approvalState({ reviews: [appReview(), humanReview(assoc)] }));
    const result = await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh });
    assert.equal(result.state, 'queued', assoc);
  }
  const fakeGh = forgedRowFake(approvalState({ comments: [sharedComment('Changes requested (Quality): no.', '2026-11-09T02:00:00Z'), sharedComment('Changes requested (Security): no.', '2026-11-09T02:00:00Z', 'drive-by-account')] }));
  assert.equal((await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh })).state, 'queued');
});

test('t/534 A (3): a changes-request COMMENT from the reviewer App still blocks', async () => {
  const fakeGh = forgedRowFake(approvalState({ comments: [sharedComment('Changes requested (Security): fix it.', '2026-11-09T02:00:00Z', APP)] }));
  await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /\(changes_requested\)/);
  assert.equal(mergeCalls(fakeGh), 0);
});

test('t/534 A: an App review bound to an OLDER head is not an approval at this head', async () => {
  const fakeGh = forgedRowFake(approvalState({ reviews: [appReview({ commit_id: '0ldhead00' })] }));
  await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /\(no_approval\)/);
  assert.equal(mergeCalls(fakeGh), 0);
});

test('t/534 A: self-approval by the branch owner role is refused', async () => {
  const fakeGh = forgedRowFake(approvalState({ reviews: [appReview({ body: 'Approved (DevOps): mine.' })] }));
  await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /refusing to arm\/enqueue/);
  assert.equal(mergeCalls(fakeGh), 0);
});

test('t/534 A (Security condition 2): a failed API read is refused with a WARN, and gh pr merge is never invoked', async () => {
  const fakeGh = forgedRowFake();
  fakeGh.approvalError = 'gh: HTTP 502';
  const warnMock = mock.method(console, 'warn', () => {});
  try {
    await assert.rejects(() => enqueuePR('o/r', 9, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /could not verify the approval at cafebabe[\s\S]*HTTP 502/);
    assert.ok(warnMock.mock.calls.some((c) => /WARN: enqueue-pr could not read the reviews/.test(String(c.arguments[0]))));
  } finally {
    warnMock.mock.restore();
  }
  assert.equal(mergeCalls(fakeGh), 0);
});

test('t/534 A (Security condition 2): a head that moved between the PR view and the API read is refused', async () => {
  const fakeGh = forgedRowFake(approvalState({ pr: { head: { sha: 'feedface', ref: 'devops/t1-change' }, body: 'Tier: T1', created_at: PUSHED } }));
  const warnMock = mock.method(console, 'warn', () => {});
  try {
    await assert.rejects(() => enqueuePR('o/r', 9, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /head moved: expected cafebabe, the API reads feedface/);
  } finally { warnMock.mock.restore(); }
  assert.equal(mergeCalls(fakeGh), 0);
});

test('t/534 A (Security condition 2): a commit list the API may have cut short is refused', async () => {
  const fakeGh = forgedRowFake();
  fakeGh.prCommits = 3; // the PR reports more commits than the list returned
  const warnMock = mock.method(console, 'warn', () => {});
  try {
    await assert.rejects(() => enqueuePR('o/r', 9, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /commit list may be cut short \(listed 1, the PR reports 3/);
  } finally { warnMock.mock.restore(); }
  assert.equal(mergeCalls(fakeGh), 0);
});

test('t/534 A: positive control -- a reviewer-App approval bound to the head DOES reach gh pr merge, without reading any check run', async () => {
  const fakeGh = forgedRowFake();
  const result = await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh });
  assert.equal(result.state, 'queued');
  assert.equal(mergeCalls(fakeGh), 1);
  assert.equal(checkRunReads(fakeGh), 0);
});

// Lead t/534 (1): the real forgery path. lastPushAt used to be the head commit's committer date, which
// the PR author sets. An App approval comment posted at 01:00 for an OLD head; the author then pushes
// new code whose commit is back-dated to 00:00 (git commit --date). The old code read the comment as
// "after the push" and enqueued the new, unreviewed head. Comments never approve now.
test('t/534 A (1): BACKDATED PUSH -- an old App approval comment does not approve a new head whose commit is back-dated', async () => {
  const fakeGh = forgedRowFake(approvalState({
    reviews: [appReview({ commit_id: '0ldhead00', submitted_at: '2026-11-09T01:00:00Z' })], // the real approval, on the old head
    comments: [sharedComment('Approved (Quality): fine.', '2026-11-09T01:00:00Z', APP)],    // its comment form
    commits: [{ commit: { committer: { date: '2026-11-09T00:00:00Z' } } }],                // new head, back-dated before both
  }));
  await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /\(no_approval\)/);
  assert.equal(mergeCalls(fakeGh), 0);
});

test('t/534 A (1): an App approval COMMENT alone never approves, whatever its time', async () => {
  for (const at of ['2026-11-09T01:00:00Z', '2099-01-01T00:00:00Z']) {
    const fakeGh = forgedRowFake(approvalState({ reviews: [], comments: [sharedComment('Approved (Quality): fine.', at, APP)] }));
    await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /\(no_approval\)/, at);
  }
});

// Lead t/534 (2): T2 needs the same reviewer-App review as T1 (TL ruling; merge-approval does it).
const T2_VIEW = JSON.stringify({ headRefOid: 'cafebabe', body: 'Tier: T2\n\nA consult-gated change.', isDraft: false, labels: [] });
function t2Fake(approval) {
  const fakeGh = forgedRowFake(approval);
  fakeGh.approval.pr = { ...fakeGh.approval.pr, body: 'Tier: T2\n\nA consult-gated change.' };
  const happy = happyPathNext(T2_VIEW);
  fakeGh.next = (args) => {
    const joined = args.join(' ');
    if (joined.includes('check-runs')) return FORGED_GREEN;
    const r = happy(args);
    if (r !== undefined) return r;
    throw new Error(`unexpected gh call: ${joined}`);
  };
  return fakeGh;
}

test('t/534 A (2): a T2 PR with no reviewer-App review at the head is refused (no longer exempt)', async () => {
  const fakeGh = t2Fake(approvalState({ reviews: [] }));
  await assert.rejects(() => enqueuePR('o/r', 7, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /\(no_approval\)/);
  assert.equal(mergeCalls(fakeGh), 0);
});

test('t/534 A (2): a T2 PR with a reviewer-App review at the head proceeds', async () => {
  const fakeGh = t2Fake(approvalState());
  assert.equal((await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh })).state, 'queued');
});

test('t/534 A: a T0 PR reads no approval data at all (exempt, unchanged)', async () => {
  const fakeGh = forgedRowFake();
  fakeGh.approvalError = 'must not be read';
  const happy = happyPathNext(JSON.stringify({ headRefOid: 'cafebabe', body: 'Tier: T0\n\nbody', isDraft: false, labels: [] }));
  fakeGh.next = (args) => {
    const joined = args.join(' ');
    if (joined.includes('check-runs') && joined.includes('tier-check')) return JSON.stringify({ check_runs: [] });
    const r = happy(args);
    if (r !== undefined) return r;
    throw new Error(`unexpected gh call: ${joined}`);
  };
  const result = await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh });
  assert.equal(result.state, 'queued');
  assert.equal(fakeGh.calls.filter((a) => a.includes('--slurp')).length, 0);
});

test('t/534 A: an undeclared tier is evaluated as T1 (fail closed): no approval -> refused', async () => {
  const fakeGh = forgedRowFake(approvalState({ reviews: [] }));
  const happy = happyPathNext(JSON.stringify({ headRefOid: 'cafebabe', body: 'no tier line', isDraft: false, labels: [] }));
  fakeGh.next = (args) => {
    const joined = args.join(' ');
    if (joined.includes('check-runs')) return FORGED_GREEN;
    const r = happy(args);
    if (r !== undefined) return r;
    throw new Error(`unexpected gh call: ${joined}`);
  };
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /\(no_tier_line\)/); // t/751: refused outright, not only for want of an approval
  assert.equal(mergeCalls(fakeGh), 0);
});

test('t/534 A pure: approvalFromApiVerdict fails closed on missing or malformed inputs, and never throws', () => {
  const base = { tier: 'T1', isDraft: false, headSha: 'cafebabe' };
  assert.equal(approvalFromApiVerdict({ ...base, inputs: undefined }).reason, 'approval_lookup_error');
  assert.equal(approvalFromApiVerdict({ ...base, inputs: { error: new Error('x') } }).reason, 'approval_lookup_error');
  assert.equal(approvalFromApiVerdict({ ...base, inputs: { pr: null, commits: [], comments: [], reviews: [] } }).reason, 'approval_lookup_error');
  assert.equal(approvalFromApiVerdict({ ...base, inputs: approvalState(), evaluate: () => { throw new Error('boom'); } }).reason, 'approval_cannot_evaluate');
  assert.equal(approvalFromApiVerdict({ ...base, isDraft: true, inputs: approvalState() }).reason, 'draft');
  assert.equal(approvalFromApiVerdict({ ...base, inputs: approvalState() }).reason, 'approved_at_head');
});

test('t/534 A: COMMENT_APPROVER_ALLOWLIST holds the reviewer App only, never the shared login', () => {
  assert.deepEqual([...COMMENT_APPROVER_ALLOWLIST], [APP]);
  assert.ok(!COMMENT_APPROVER_ALLOWLIST.includes('jpsnover'));
});

// t/4939 live incident (#4694 enqueue refusal, 2026-11-09): ci.yml also has a job named
// `t1-approval-guard`, co-located for the merge_group queue re-check, which legitimately
// SKIPS on every normal pull_request event (its `if:` only matches merge_group). That skip
// shares the exact check-run name with the real PR-side gate (`t1-approval-guard.yml`). Picking
// "latest by started_at" is a timing race: ci.yml is a large, slow, many-job workflow that often
// finishes its meaningless skip AFTER the single-job standalone gate finishes its real success --
// shadowing a genuine approval purely by luck of the clock.
test('pickAuthoritativeGuardRun: a later SKIPPED run never shadows an earlier real success (the #4694 race)', () => {
  const runs = [
    { status: 'completed', conclusion: 'success', started_at: '2026-11-09T17:08:58Z' },
    { status: 'completed', conclusion: 'skipped', started_at: '2026-11-09T17:14:43Z' },  // later, but meaningless
  ];
  assert.equal(pickAuthoritativeGuardRun(runs).conclusion, 'success');
});

test('pickAuthoritativeGuardRun: a later SKIPPED run never shadows an earlier FAILURE either (fail-closed, not fail-open)', () => {
  const runs = [
    { status: 'completed', conclusion: 'failure', started_at: '2026-11-09T17:08:58Z' },
    { status: 'completed', conclusion: 'skipped', started_at: '2026-11-09T17:14:43Z' },
  ];
  assert.equal(pickAuthoritativeGuardRun(runs).conclusion, 'failure');
});

test('pickAuthoritativeGuardRun: among several non-skipped runs, the latest still wins (unchanged prior behavior)', () => {
  const runs = [
    { status: 'completed', conclusion: 'failure', started_at: '2026-11-09T17:00:00Z' },
    { status: 'completed', conclusion: 'success', started_at: '2026-11-09T17:08:58Z' },  // latest real evaluation
    { status: 'completed', conclusion: 'skipped', started_at: '2026-11-09T17:14:43Z' },
  ];
  assert.equal(pickAuthoritativeGuardRun(runs).conclusion, 'success');
});

test('pickAuthoritativeGuardRun: all runs skipped -> falls back to the latest skip (still correctly fail-closed)', () => {
  const runs = [
    { status: 'completed', conclusion: 'skipped', started_at: '2026-11-09T17:00:00Z' },
    { status: 'completed', conclusion: 'skipped', started_at: '2026-11-09T17:14:43Z' },
  ];
  const r = pickAuthoritativeGuardRun(runs);
  assert.equal(r.conclusion, 'skipped');
  assert.equal(r.started_at, '2026-11-09T17:14:43Z');
});

test('pickAuthoritativeGuardRun: empty/null input returns null', () => {
  assert.equal(pickAuthoritativeGuardRun([]), null);
  assert.equal(pickAuthoritativeGuardRun(null), null);
  assert.equal(pickAuthoritativeGuardRun(undefined), null);
});

test('fetchGuardRun: a later ci.yml merge_group skip does not shadow an earlier t1-approval-guard.yml success (live #4694 shape), real argv still has -X GET', () => {
  const calls = [];
  const fakeGh = (args) => {
    calls.push(args);
    const joined = args.join(' ');
    if (joined.includes('check-runs') && joined.includes('t1-approval-guard')) {
      return JSON.stringify({ check_runs: [
        // The REAL gate (t1-approval-guard.yml), finished first.
        { status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-09T17:08:58Z' },
        // ci.yml's co-located merge_group-only job, finished later on this ordinary PR run,
        // legitimately skipped since github.event_name != 'merge_group'.
        { status: 'completed', conclusion: 'skipped', app: { slug: 'github-actions' }, started_at: '2026-11-09T17:14:43Z' },
      ] });
    }
    throw new Error(`unexpected gh call: ${joined}`);
  };
  const result = fetchGuardRun('o/r', 'abc123', fakeGh);
  assert.equal(result.lookupError, false);
  assert.equal(result.run.conclusion, 'success');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('-X'), 'argv must include -X GET, not just -F (t/4939 regression)');
  assert.ok(calls[0].includes('GET'), 'argv must include -X GET, not just -F (t/4939 regression)');
});

// t/4939 live incident (Lead, p/648#361): `enqueue-pr.mjs:154`/`:167` passed `-F check_name=X`
// with no `-X GET` -- any `-F`/`-f` flag makes `gh api` default to POST, which 404s a GET-only
// route. Every prior test mocked `ghFn` without checking the ARGV it was called with, so this
// shipped silently and blocked every T1 enqueue (fail-closed, but still blocked real work).

test('fetchGuardRun: the real argv passed to ghFn includes -X GET (t/4939 regression guard)', () => {
  const calls = [];
  const fakeGh = (args) => {
    calls.push(args);
    return JSON.stringify({ check_runs: [
      { status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-09T00:00:00Z' },
    ] });
  };
  const result = fetchGuardRun('o/r', 'abc123', fakeGh);
  assert.equal(calls.length, 1);
  const xIndex = calls[0].indexOf('-X');
  assert.notEqual(xIndex, -1, `expected -X in argv, got: ${JSON.stringify(calls[0])}`);
  assert.equal(calls[0][xIndex + 1], 'GET', `expected -X GET, got: ${JSON.stringify(calls[0])}`);
  assert.equal(result.run?.conclusion, 'success');
});

// t/4950: tierCheckDisagreesAt used to `catch { return false; }`, so a failed lookup read exactly
// like "tier-check agrees". It now WARNs and marks the result as a lookup error (still
// non-blocking), mirroring fetchGuardRun's { run, lookupError, error } shape.

function tierCheckRun(conclusion, startedAt = '2026-11-09T00:00:00Z') {
  return { status: 'completed', conclusion, app: { slug: 'github-actions' }, started_at: startedAt };
}

test('tierCheckDisagreesAt: the real argv passed to ghFn includes -X GET (t/4939 regression guard)', () => {
  const calls = [];
  const fakeGh = (args) => { calls.push(args); return JSON.stringify({ check_runs: [tierCheckRun('success')] }); };
  tierCheckDisagreesAt('o/r', 'abc123', fakeGh);
  assert.equal(calls.length, 1);
  const xIndex = calls[0].indexOf('-X');
  assert.notEqual(xIndex, -1, `expected -X in argv, got: ${JSON.stringify(calls[0])}`);
  assert.equal(calls[0][xIndex + 1], 'GET', `expected -X GET, got: ${JSON.stringify(calls[0])}`);
  assert.ok(calls[0].includes('check_name=tier-check'));
});

test('tierCheckDisagreesAt: a thrown lookup WARNs (naming repo, SHA and error) and is marked lookupError, not agreement', () => {
  const boom = new Error('HTTP 502: simulated outage');
  const warnMock = mock.method(console, 'warn', () => {});
  let result;
  try {
    result = tierCheckDisagreesAt('o/r', 'deadbeef', () => { throw boom; });
    assert.equal(warnMock.mock.calls.length, 1);
    const msg = String(warnMock.mock.calls[0].arguments[0]);
    assert.match(msg, /^WARN: /);
    assert.match(msg, /o\/r/);
    assert.match(msg, /deadbeef/);
    assert.match(msg, /simulated outage/);
  } finally {
    warnMock.mock.restore();
  }
  assert.equal(result.lookupError, true);
  assert.equal(result.disagrees, false);
  assert.equal(result.error, boom);
});

test('tierCheckDisagreesAt: unparseable JSON is also a WARNed lookupError', () => {
  const warnMock = mock.method(console, 'warn', () => {});
  let result;
  try {
    result = tierCheckDisagreesAt('o/r', 'deadbeef', () => 'not json');
    assert.equal(warnMock.mock.calls.length, 1);
  } finally {
    warnMock.mock.restore();
  }
  assert.equal(result.lookupError, true);
  assert.equal(result.disagrees, false);
});

test('tierCheckDisagreesAt: a failure conclusion -> disagrees, no lookupError, no WARN', () => {
  const warnMock = mock.method(console, 'warn', () => {});
  let result;
  try {
    result = tierCheckDisagreesAt('o/r', 'abc', () => JSON.stringify({ check_runs: [tierCheckRun('failure')] }));
    assert.equal(warnMock.mock.calls.length, 0);
  } finally {
    warnMock.mock.restore();
  }
  assert.deepEqual(result, { disagrees: true, lookupError: false });
});

test('tierCheckDisagreesAt: a success conclusion -> agrees, no lookupError, no WARN', () => {
  const warnMock = mock.method(console, 'warn', () => {});
  let result;
  try {
    result = tierCheckDisagreesAt('o/r', 'abc', () => JSON.stringify({ check_runs: [tierCheckRun('success')] }));
    assert.equal(warnMock.mock.calls.length, 0);
  } finally {
    warnMock.mock.restore();
  }
  assert.deepEqual(result, { disagrees: false, lookupError: false });
});

test('tierCheckDisagreesAt: the latest completed github-actions run wins (older failure, newer success -> agrees)', () => {
  const result = tierCheckDisagreesAt('o/r', 'abc', () => JSON.stringify({ check_runs: [
    tierCheckRun('failure', '2026-11-09T00:00:00Z'),
    tierCheckRun('success', '2026-11-09T01:00:00Z'),
    { ...tierCheckRun('failure', '2026-11-09T02:00:00Z'), app: { slug: 'some-other-app' } },
  ] }));
  assert.deepEqual(result, { disagrees: false, lookupError: false });
});

test('enqueuePR shim: a T0 PR whose tier-check lookup fails still proceeds (non-blocking) but WARNs about tier-check', async () => {
  const fakeGh = fakeGhTracking();
  const happy = happyPathNext(JSON.stringify({ headRefOid: 'cafebabe', body: 'Tier: T0\n\nbody', isDraft: false, labels: [] }));
  fakeGh.next = (args) => {
    const joined = args.join(' ');
    if (joined.includes('check-runs') && joined.includes('t1-approval-guard')) return JSON.stringify({ check_runs: [] });
    if (joined.includes('check-runs') && joined.includes('tier-check')) throw new Error('simulated tier-check API failure');
    const r = happy(args);
    if (r !== undefined) return r;
    throw new Error(`unexpected gh call: ${joined}`);
  };
  const warnMock = mock.method(console, 'warn', () => {});
  let result;
  try {
    result = await enqueuePR('o/r', 11, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh });
    assert.ok(warnMock.mock.calls.some((c) => /WARN: .*tier-check.*simulated tier-check API failure/.test(String(c.arguments[0]))));
  } finally {
    warnMock.mock.restore();
  }
  assert.equal(result.state, 'queued');
  assert.equal(fakeGh.calls.filter((a) => a[0] === 'pr' && a[1] === 'merge').length, 1);
});

test('classifyGhApiError: a 404 is not_found (fail, not skip -- TL, p/648#363)', () => {
  assert.equal(classifyGhApiError(new Error('gh: Not Found (HTTP 404)')), 'not_found');
});

test('classifyGhApiError: a 5xx is server_error (skip, not fail -- a GitHub blip must never red the gate)', () => {
  assert.equal(classifyGhApiError({ stderr: 'HTTP 503 Service Unavailable' }), 'server_error');
  assert.equal(classifyGhApiError({ stderr: 'HTTP 500 Internal Server Error' }), 'server_error');
});

test('classifyGhApiError: a network failure is network_error (skip, not fail)', () => {
  assert.equal(classifyGhApiError(new Error('could not resolve host: api.github.com')), 'network_error');
  assert.equal(classifyGhApiError(new Error('connect ECONNREFUSED 140.82.112.6:443')), 'network_error');
});

test('classifyGhApiError: anything else (including an unparseable response shape) is unknown (fail)', () => {
  assert.equal(classifyGhApiError(new Error('Unexpected token W in JSON at position 0')), 'unknown');
  assert.equal(classifyGhApiError(undefined), 'unknown');
});

// LIVE, read-only (TL ask, p/648#362/#363): exercises the REAL `gh` binary against a fixed,
// known commit -- #4675's own HEAD sha (never its squash-merge commit, which carries no
// check-run of its own -- checks run against the PR's head, not the synthetic merge commit) --
// to prove the actual invocation (not a mock) returns a run, not a 404. Skips (never fails)
// when no token is available, or on a transient network/5xx; only a 404 or an unparseable
// shape fails, since that is exactly the class of regression this incident was.
test('fetchGuardRun: LIVE call against a fixed known commit (#4675 head SHA) returns a real run', (t) => {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    t.skip('GH_TOKEN/GITHUB_TOKEN not set in this environment -- skipping the live gh api call');
    return;
  }
  const KNOWN_SHA = 'f505537d90ca7cd3e0aa79dccb23aaea1cb0db90'; // #4675's own head SHA (t/4939), NOT its merge commit d0b4ee2b8
  // Quality nit (p/780#35): prefer the runner-provided slug (GITHUB_REPOSITORY, set by Actions)
  // over the hard-coded one, given the org move (e/293) -- falls back to the hard-coded slug
  // when run locally, where that env var isn't set.
  const REPO = process.env.GITHUB_REPOSITORY || 'AI-Rosetta-Stone/ai-triad-research';
  const result = fetchGuardRun(REPO, KNOWN_SHA);
  if (result.lookupError) {
    const cls = classifyGhApiError(result.error);
    if (cls === 'network_error' || cls === 'server_error') {
      t.skip(`transient (${cls}), not a regression: ${result.error?.message ?? result.error}`);
      return;
    }
    assert.fail(`fetchGuardRun failed with a non-transient error (${cls}): ${result.error?.message ?? result.error}`);
  }
  assert.ok(result.run, 'expected a real t1-approval-guard run on the known commit, got none');
  assert.equal(result.run.app?.slug, 'github-actions');
});

// t/73: expectedHeadOid pins the enqueue to the head the caller verified.
const guardSuccessNext = (prView) => {
  const happy = happyPathNext(prView);
  return (args) => {
    const joined = args.join(' ');
    if (joined.includes('check-runs') && joined.includes('t1-approval-guard')) {
      return JSON.stringify({ check_runs: [
        { status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, started_at: '2026-11-09T00:00:00Z' },
      ] });
    }
    const r = happy(args);
    if (r !== undefined) return r;
    throw new Error(`unexpected gh call: ${joined}`);
  };
};

test('enqueuePR shim (t/73): expectedHeadOid that no longer matches the head is refused before any guard read or gh pr merge', async () => {
  const fakeGh = fakeGhTracking();
  fakeGh.next = guardSuccessNext(T1_PR_VIEW);
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh, expectedHeadOid: 'deadbeef' }), /head moved from deadbeef to cafebabe/);
  assert.equal(fakeGh.calls.filter((a) => a[0] === 'pr' && a[1] === 'merge').length, 0);
  assert.equal(fakeGh.calls.filter((a) => a.join(' ').includes('check-runs')).length, 0);
});

test('enqueuePR shim (t/73): a matching expectedHeadOid proceeds and pins --match-head-commit to it', async () => {
  const fakeGh = fakeGhTracking();
  fakeGh.next = guardSuccessNext(T1_PR_VIEW);
  await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh, expectedHeadOid: 'cafebabe' });
  const merges = fakeGh.calls.filter((a) => a[0] === 'pr' && a[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0].slice(-2), ['--match-head-commit', 'cafebabe']);
});

// ── t/537: gate-file changes need a named Tech Lead or Security review at the head ──────────────
// Every shim test below gives the PR a GREEN guard and the full happy path, so the only thing that
// can refuse is the gate-file check, and a refusal that vanished would reach `gh pr merge`.

const merges = (fakeGh) => fakeGh.calls.filter((a) => a[0] === 'pr' && a[1] === 'merge').length;
const guardReads = (fakeGh) => fakeGh.calls.filter((a) => a.join(' ').includes('check-runs')).length;
const tlReview = (over = {}) => ({
  id: 77, user: { login: 'ai-triad-reviewer-jpsnover[bot]' }, state: 'APPROVED', commit_id: 'cafebabe',
  body: 'Approved (Tech Lead): workflow diff read.', ...over,
});
function gateFake(prView, files, review = null) {
  const fakeGh = fakeGhTracking();
  fakeGh.next = guardSuccessNext(prView);
  fakeGh.files = files;
  fakeGh.review = review;
  return fakeGh;
}
const T0_VIEW = JSON.stringify({ headRefOid: 'cafebabe', body: 'Tier: T0\n\nbody', isDraft: false, labels: [] });

test('t/537 shim: a T1 PR with a green guard that changes a workflow is refused before any guard read or merge', async () => {
  const fakeGh = gateFake(T1_PR_VIEW, ['README.md', '.github/workflows/ci.yml']);
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /gate_files_no_override[\s\S]*\.github\/workflows\/ci\.yml/);
  assert.equal(merges(fakeGh), 0);
  assert.equal(guardReads(fakeGh), 0);
});

test('t/537 shim: the refusal applies to T0 too, and to a gate script', async () => {
  const fakeGh = gateFake(T0_VIEW, ['operations/devops/t1-approval-at-head.mjs']);
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /gate_files_no_override/);
  assert.equal(merges(fakeGh), 0);
});

test('t/537 shim: an unreadable change list is refused (fail closed), with a WARN', async () => {
  const fakeGh = gateFake(T1_PR_VIEW, 'throw');
  const warn = mock.method(console, 'warn', () => {});
  try {
    await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /files_unreadable/);
    assert.ok(warn.mock.calls.some((c) => /could not read the changed files/.test(String(c.arguments[0]))));
  } finally { warn.mock.restore(); }
  assert.equal(merges(fakeGh), 0);
});

test('t/537 shim: a change list shorter than the PR reports is refused (possibly cut short)', async () => {
  const fakeGh = gateFake(T1_PR_VIEW, ['README.md']);
  fakeGh.changedFilesCount = 2;
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /files_unreadable[\s\S]*listed 1 changed file\(s\) but the PR reports 2/);
  assert.equal(merges(fakeGh), 0);
});

test('t/537 shim: a named Tech Lead review at the head releases it, is logged, and the PR reaches gh pr merge', async () => {
  const fakeGh = gateFake(T1_PR_VIEW, ['.github/workflows/ci.yml'], tlReview());
  const log = mock.method(console, 'log', () => {});
  let line;
  try {
    const result = await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh, gateChangeReviewId: '77', by: 'lead-id' });
    assert.equal(result.ok, true);
    line = log.mock.calls.map((c) => String(c.arguments[0])).find((l) => l.startsWith('GATE-CHANGE-OVERRIDE'));
  } finally { log.mock.restore(); }
  assert.equal(merges(fakeGh), 1);
  assert.match(line, /repo=o\/r pr=42 head=cafebabe review=77 approver="Tech Lead" by=lead-id .*files=\.github\/workflows\/ci\.yml/);
});

test('t/537 shim: a Security review releases it too', async () => {
  const fakeGh = gateFake(T1_PR_VIEW, ['.github/workflows/ci.yml'], tlReview({ body: 'Approved (Security): read.' }));
  const log = mock.method(console, 'log', () => {});
  try {
    await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh, gateChangeReviewId: '77', by: 'lead-id' });
  } finally { log.mock.restore(); }
  assert.equal(merges(fakeGh), 1);
});

for (const [name, review, re] of [
  ['bound to an older head', tlReview({ commit_id: '0ldhead00' }), /override_invalid[\s\S]*not the current head/],
  ['from another account', tlReview({ user: { login: 'jpsnover' } }), /override_invalid[\s\S]*not the reviewer App/],
  ['dismissed', tlReview({ state: 'DISMISSED' }), /override_invalid[\s\S]*not APPROVED/],
  ['by a role that may not release it', tlReview({ body: 'Approved (Quality): fine.' }), /override_invalid[\s\S]*does not start with/],
  ['with the role only mentioned later in the body', tlReview({ body: 'Looks fine. Approved (Tech Lead): yes' }), /override_invalid/],
  ['that cannot be read', null, /override_unreadable/],
]) {
  test(`t/537 shim: a named review ${name} does not release it`, async () => {
    const fakeGh = gateFake(T1_PR_VIEW, ['.github/workflows/ci.yml'], review);
    const warn = mock.method(console, 'warn', () => {});
    try {
      await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh, gateChangeReviewId: '77', by: 'lead-id' }), re);
    } finally { warn.mock.restore(); }
    assert.equal(merges(fakeGh), 0);
  });
}

test('t/537 shim: a valid override without --by is refused', async () => {
  const fakeGh = gateFake(T1_PR_VIEW, ['.github/workflows/ci.yml'], tlReview());
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh, gateChangeReviewId: '77' }), /override_without_by/);
  assert.equal(merges(fakeGh), 0);
});

test('t/537 shim: a review id that is not a number is never sent to the API', async () => {
  const fakeGh = gateFake(T1_PR_VIEW, ['.github/workflows/ci.yml'], tlReview());
  const warn = mock.method(console, 'warn', () => {});
  try {
    await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh, gateChangeReviewId: '77/../../x', by: 'lead-id' }), /override_unreadable/);
  } finally { warn.mock.restore(); }
  assert.equal(fakeGh.calls.filter((a) => a.join(' ').includes('/reviews/')).length, 0);
});

test('t/537 shim: a PR with no gate files proceeds as before', async () => {
  const fakeGh = gateFake(T1_PR_VIEW, ['taxonomy-editor/src/a.ts']);
  const result = await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh });
  assert.equal(result.ok, true);
  assert.equal(merges(fakeGh), 1);
});

test('t/537 pure: isGateFile covers workflows, composite actions and the gate scripts, and nothing else', () => {
  for (const p of ['.github/workflows/ci.yml', '.github/workflows/sub/x.yaml', '.github/actions/setup/action.yml', '.github/ci/required-contexts.json', 'operations/devops/t0-enqueue-sweep.mjs', 'operations/devops/infra-rearm-sweep.mjs', ...GATE_SCRIPTS, './.github/workflows/a.yml', '.github\\workflows\\a.yml']) {
    assert.equal(isGateFile(p), true, p);
  }
  for (const p of ['README.md', 'docs/.github/workflows/ci.yml', '.github/dependabot.yml', '.github/cicd/x.json', 'operations/devops/gh-budget.mjs', 'operations/devops/t0-enqueue-sweep.test.mjs', 'operations/devops/enqueue-pr.test.mjs', '', null, undefined]) {
    assert.equal(isGateFile(p), false, String(p));
  }
});

test('t/537 pure: a renamed workflow counts under its old name, and the API cap is unreadable', () => {
  const base = { headSha: 'cafebabe', override: null };
  const renamed = gateFileChangeVerdict({ ...base, files: { paths: ['docs/moved.yml', '.github/workflows/old.yml'], listedCount: 1, expectedCount: 1 } });
  assert.equal(renamed.reason, 'gate_files_no_override');
  const capped = gateFileChangeVerdict({ ...base, files: { paths: Array.from({ length: PR_FILES_API_CAP }, (_, i) => `f${i}`), listedCount: PR_FILES_API_CAP, expectedCount: PR_FILES_API_CAP } });
  assert.equal(capped.reason, 'files_unreadable');
  assert.equal(gateFileChangeVerdict({ ...base, files: { paths: null } }).reason, 'files_unreadable');
  assert.equal(gateFileChangeVerdict({ ...base, files: undefined }).reason, 'files_unreadable');
});

// ── t/132: the `no-auto-enqueue` label refuses unless --override-hold ──
// Each shim test runs on the full happy path (gateFake: non-gate files, green guard, approved T1),
// so a refusal can only come from the label, and a removed refusal would reach `gh pr merge`.
const labelledView = (labels) => JSON.stringify({ headRefOid: 'cafebabe', body: 'Tier: T1\n\nsome PR body', isDraft: false, labels });
const fileReads = (fakeGh) => fakeGh.calls.filter((a) => a.join(' ').includes('/files')).length;

test('t/132 pure: holdLabelVerdict refuses the label, allows it with the override (WARN), and fails closed on unreadable labels', () => {
  assert.deepEqual(holdLabelVerdict({ labels: [] }), { allow: true, reason: 'no_hold_label' });
  assert.deepEqual(holdLabelVerdict({ labels: [{ name: 'stuck-pr-alert-owner' }] }), { allow: true, reason: 'no_hold_label' });
  assert.deepEqual(holdLabelVerdict({ labels: [{ name: 'no-auto-enqueue' }] }), { allow: false, reason: 'no_auto_enqueue' });
  assert.deepEqual(holdLabelVerdict({ labels: ['no-auto-enqueue'] }), { allow: false, reason: 'no_auto_enqueue' });
  const over = holdLabelVerdict({ labels: [{ name: 'no-auto-enqueue' }], overrideHold: true });
  assert.equal(over.allow, true);
  assert.equal(over.reason, 'hold_overridden');
  assert.match(over.warn, /no-auto-enqueue.*--override-hold/);
  for (const bad of [undefined, null, 'no-auto-enqueue', {}]) {
    assert.deepEqual(holdLabelVerdict({ labels: bad, overrideHold: true }), { allow: false, reason: 'labels_unreadable' }, String(bad));
  }
  // A near-miss name is not the hold label.
  assert.equal(holdLabelVerdict({ labels: [{ name: 'no-auto-enqueue-later' }] }).allow, true);
});

test('t/132 shim: a labelled PR is refused before any file read or merge', async () => {
  const fakeGh = gateFake(labelledView([{ name: 'no-auto-enqueue' }]), ['taxonomy-editor/src/a.ts']);
  await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh }), /refusing to arm\/enqueue #42 on o\/r \(no_auto_enqueue\)[\s\S]*--override-hold/);
  assert.equal(merges(fakeGh), 0);
  assert.equal(fileReads(fakeGh), 0);
});

test('t/132 shim: --override-hold arms a labelled PR and WARNs', async () => {
  const fakeGh = gateFake(labelledView([{ name: 'no-auto-enqueue' }]), ['taxonomy-editor/src/a.ts']);
  const warn = mock.method(console, 'warn', () => {});
  let result;
  try {
    result = await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh, overrideHold: true });
    assert.ok(warn.mock.calls.some((c) => /WARN: .*no-auto-enqueue.*--override-hold.*#42 on o\/r, head cafebabe/.test(String(c.arguments[0]))));
  } finally { warn.mock.restore(); }
  assert.equal(result.ok, true);
  assert.equal(merges(fakeGh), 1);
});

test('t/132 shim: the override does not bypass the approval check that follows', async () => {
  const fakeGh = gateFake(labelledView([{ name: 'no-auto-enqueue' }]), ['taxonomy-editor/src/a.ts']);
  fakeGh.approval = approvalState({ reviews: [] });
  const warn = mock.method(console, 'warn', () => {});
  try {
    await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh, overrideHold: true }), /\(no_approval\)/);
  } finally { warn.mock.restore(); }
  assert.equal(merges(fakeGh), 0);
});

test('t/132 shim: unreadable labels refuse with a WARN, even with --override-hold', async () => {
  const fakeGh = gateFake(JSON.stringify({ headRefOid: 'cafebabe', body: 'Tier: T1\n\nbody', isDraft: false }), ['taxonomy-editor/src/a.ts']);
  const warn = mock.method(console, 'warn', () => {});
  try {
    await assert.rejects(() => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh, overrideHold: true }), /\(labels_unreadable\)/);
    assert.ok(warn.mock.calls.some((c) => /WARN: enqueue-pr could not read the labels of #42/.test(String(c.arguments[0]))));
  } finally { warn.mock.restore(); }
  assert.equal(merges(fakeGh), 0);
});

test('t/132 shim: an unrelated label proceeds as before', async () => {
  const fakeGh = gateFake(labelledView([{ name: 'stuck-pr-alert-owner' }]), ['taxonomy-editor/src/a.ts']);
  const result = await enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh: fakeGh });
  assert.equal(result.ok, true);
  assert.equal(merges(fakeGh), 1);
});
