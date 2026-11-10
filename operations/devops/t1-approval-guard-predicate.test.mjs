// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4247: #3343 and #3364 both auto-merged on 10-17 as T1 PRs with no `Approved (<role>):`
// comment. Both arms of "a T1 PR needs a post-push approval" proven here, one fault per site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateT1ApprovalGuard, ownerSlugFromBranch } from './t1-approval-guard-predicate.mjs';
import { classifyMergeGroupApprovals } from './t1-approval-guard-merge-group-predicate.mjs';

const PUSH = '2026-10-17T18:00:00Z';
const BEFORE_PUSH = '2026-10-17T17:00:00Z';
const AFTER_PUSH = '2026-10-17T18:30:00Z';
// t/116: a review counts only if it is bound to the current head SHA.
const HEAD = 'b'.repeat(40);
const OLD_HEAD = 'a'.repeat(40);

test('FIRE ARM: T1 PR with no approval comment at all -> fail', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1\n\nSome change.',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    approvalComments: [],
  });
  assert.equal(r.pass, false);
  assert.equal(r.tier, 'T1');
  assert.equal(r.reason, 'no-post-push-approval');
});

test('T1 PR with an Approved comment after the latest push -> pass', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    approvalComments: [{ body: 'Approved (Quality): looks good', createdAt: AFTER_PUSH }],
  });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'approved-after-push');
});

test('FIRE ARM: T1 PR approved, then a NEW push lands after the approval -> fail (the approval is stale)', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: AFTER_PUSH, // the push is now AFTER the approval comment below
    approvalComments: [{ body: 'Approved (Quality): looks good', createdAt: BEFORE_PUSH }],
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

test('a T0 PR is never checked, regardless of comments', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T0',
    headRefName: 'devops/anything',
    lastPushAt: PUSH,
    approvalComments: [],
  });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'not-t1');
});

test('a T2 PR is never checked by this gate (it has its own consult-hold mechanism)', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T2',
    headRefName: 'devops/anything',
    lastPushAt: PUSH,
    approvalComments: [],
  });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'not-t1');
});

test('a missing or malformed Tier line is never checked by this gate (tier-check.yml flags that separately)', () => {
  assert.equal(evaluateT1ApprovalGuard({ body: 'no tier line here', headRefName: 'x', lastPushAt: PUSH, approvalComments: [] }).pass, true);
  assert.equal(evaluateT1ApprovalGuard({ body: '', headRefName: 'x', lastPushAt: PUSH, approvalComments: [] }).pass, true);
});

test('an approval added by EDITING an older comment (updatedAt after the push, createdAt before) -> pass', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    approvalComments: [{ body: 'Approved (Quality): looks good', createdAt: BEFORE_PUSH, updatedAt: AFTER_PUSH }],
  });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'approved-after-push');
});

test('an OLD comment that was never edited to add approval text stays at its original (pre-push) time -> fail', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    approvalComments: [{ body: 'Approved (Quality): looks good', createdAt: BEFORE_PUSH }],
  });
  assert.equal(r.pass, false);
});

test('SELF-APPROVAL HEURISTIC: a comment "Approved (DevOps Lead):" on a devops/-branch PR is rejected as self-approval', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    approvalComments: [{ body: 'Approved (DevOps Lead): self-sign-off', createdAt: AFTER_PUSH }],
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

test('a genuine reviewer approval alongside a rejected self-approval still passes', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    approvalComments: [
      { body: 'Approved (DevOps Lead): self-sign-off', createdAt: AFTER_PUSH },
      { body: 'Approved (Quality): second review', createdAt: AFTER_PUSH },
    ],
  });
  assert.equal(r.pass, true);
  assert.equal(r.approver.role, 'Quality');
});

test('a non-approval comment (no "Approved (...):" prefix) is ignored, not mistaken for an approval', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    approvalComments: [{ body: 'Looks fine to me, approved I guess', createdAt: AFTER_PUSH }],
  });
  assert.equal(r.pass, false);
});

test('empty/undefined input never throws', () => {
  assert.doesNotThrow(() => evaluateT1ApprovalGuard({}));
  assert.equal(evaluateT1ApprovalGuard({}).pass, true);
});

// ── t/4096 Reviewer switch-over: a real bot APPROVED review also satisfies the gate ──
const REVIEWER_LOGIN = 'ai-triad-reviewer-jpsnover[bot]';

test('t/4096: a bot APPROVED review after the latest push, with an Approved(<role>) body -> pass', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    headSha: HEAD,
    approvalComments: [],
    botReviews: [{ commitId: HEAD, state: 'APPROVED', submittedAt: AFTER_PUSH, login: REVIEWER_LOGIN, body: 'Approved (Quality): looks good' }],
    reviewerAppLogin: REVIEWER_LOGIN,
  });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'approved-after-push');
  assert.equal(r.approver.role, 'Quality');
});

test('FIRE ARM: t/4096: a bot review on an OLDER head (before the latest push) -> fail (stale, same as a stale comment)', () => {
  // t/116: staleness is now head binding (commitId !== headSha), not submittedAt vs the push time.
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: AFTER_PUSH,
    headSha: HEAD,
    approvalComments: [],
    botReviews: [{ commitId: OLD_HEAD, state: 'APPROVED', submittedAt: BEFORE_PUSH, login: REVIEWER_LOGIN, body: 'Approved (Quality): looks good' }],
    reviewerAppLogin: REVIEWER_LOGIN,
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

test('FIRE ARM: t/4096: a bot review with state CHANGES_REQUESTED does not satisfy the gate, whatever its body says (t/116: it blocks)', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    headSha: HEAD,
    approvalComments: [],
    botReviews: [
      { commitId: HEAD, state: 'CHANGES_REQUESTED', submittedAt: AFTER_PUSH, login: REVIEWER_LOGIN, body: 'Approved (Quality): looks good' },
    ],
    reviewerAppLogin: REVIEWER_LOGIN,
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-at-head');
});

test('t/116 (deliberate change): a reviewer-App COMMENTED review whose body is "Approved (<role>):" counts -- the body is the verdict, as in a comment', () => {
  // Before t/116 the gate pre-filtered on state === APPROVED, so this failed. latestRoleVerdicts
  // never reads state for a role verdict (t/4952), and the same text as a comment always counted.
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    headSha: HEAD,
    approvalComments: [],
    botReviews: [
      { commitId: HEAD, state: 'COMMENTED', submittedAt: AFTER_PUSH, login: REVIEWER_LOGIN, body: 'Approved (Quality): looks good' },
    ],
    reviewerAppLogin: REVIEWER_LOGIN,
  });
  assert.equal(r.pass, true);
  assert.equal(r.approver.role, 'Quality');
});

test('t/4096: either form satisfies the gate during the transition -- a legacy comment still passes with no bot review present', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    headSha: HEAD,
    approvalComments: [{ body: 'Approved (Quality): looks good', createdAt: AFTER_PUSH }],
    botReviews: [],
    reviewerAppLogin: REVIEWER_LOGIN,
  });
  assert.equal(r.pass, true);
  assert.equal(r.approver.role, 'Quality');
});

// ── TL review fixes (PR #3487): the bot-review arm must not reopen self-approval ──

test('FIRE ARM (TL blocking 1): a bot review whose body names the AUTHOR\'s own owning role is rejected as self-approval', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    headSha: HEAD,
    approvalComments: [],
    botReviews: [{ commitId: HEAD, state: 'APPROVED', submittedAt: AFTER_PUSH, login: REVIEWER_LOGIN, body: 'Approved (DevOps Lead): self-sign-off via the App' }],
    reviewerAppLogin: REVIEWER_LOGIN,
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

test('a bot review naming a DIFFERENT role than the PR owner still passes despite sharing the jpsnover author identity', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    headSha: HEAD,
    approvalComments: [],
    botReviews: [{ commitId: HEAD, state: 'APPROVED', submittedAt: AFTER_PUSH, login: REVIEWER_LOGIN, body: 'Approved (Quality): genuine second reviewer' }],
    reviewerAppLogin: REVIEWER_LOGIN,
  });
  assert.equal(r.pass, true);
  assert.equal(r.approver.role, 'Quality');
});

test('FIRE ARM (TL blocking 2): an APPROVED review from a login OTHER than the configured reviewer App does not satisfy the gate', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    headSha: HEAD,
    approvalComments: [],
    botReviews: [{ commitId: HEAD, state: 'APPROVED', submittedAt: AFTER_PUSH, login: 'ai-triad-maintainer-jpsnover[bot]', body: 'Approved (Quality): looks good' }],
    reviewerAppLogin: REVIEWER_LOGIN,
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

test('FIRE ARM (TL blocking 2): a human APPROVED review (no bot login at all) does not satisfy the gate', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    headSha: HEAD,
    approvalComments: [],
    botReviews: [{ commitId: HEAD, state: 'APPROVED', submittedAt: AFTER_PUSH, login: 'jpsnover', body: 'Approved (Quality): looks good' }],
    reviewerAppLogin: REVIEWER_LOGIN,
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

test('a bot review with an APPROVED state but no "Approved (<role>):" body text does not satisfy the gate', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    headSha: HEAD,
    approvalComments: [],
    botReviews: [{ commitId: HEAD, state: 'APPROVED', submittedAt: AFTER_PUSH, login: REVIEWER_LOGIN, body: 'lgtm' }],
    reviewerAppLogin: REVIEWER_LOGIN,
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

// t/4351: ownerSlugFromBranch exported for pr-triage.yml's CI-green nudge reuse (the author-App
// switch-over makes pr.user.login a bot handle, no longer a notifiable human).
test('ownerSlugFromBranch: derives the leading path segment, lowercased, letters only', () => {
  assert.equal(ownerSlugFromBranch('devops/t4351-author-identity'), 'devops');
  assert.equal(ownerSlugFromBranch('DevOps/t4247-t1-approval-guard'), 'devops');
});

test('ownerSlugFromBranch: no slash, empty, or null all resolve safely without throwing', () => {
  assert.equal(ownerSlugFromBranch('main'), 'main');
  assert.equal(ownerSlugFromBranch(''), '');
  assert.equal(ownerSlugFromBranch(null), '');
  assert.equal(ownerSlugFromBranch(undefined), '');
});

// ── t/116 (a) (TL t/116#3): role verdicts at the head, and ANY outstanding changes-request blocks ──
// Gate-signal-integrity: every case runs the REAL predicate; the merge_group arm's cases feed the
// same per-PR results through the real classifyMergeGroupApprovals, exactly as ci.yml does.

const T1 = 'Tier: T1';
const BRANCH = 'devops/t116-guard';
const T_1 = '2026-10-17T18:10:00Z';
const T_2 = '2026-10-17T18:20:00Z';
const T_3 = '2026-10-17T18:40:00Z';
const HUMAN = 'jpsnover';

function appReview(body, submittedAt, extra = {}) {
  return { commitId: HEAD, state: 'COMMENTED', submittedAt, login: REVIEWER_LOGIN, body, ...extra };
}
function humanReview(state, submittedAt, extra = {}) {
  return { commitId: HEAD, state, submittedAt, login: HUMAN, body: '', ...extra };
}
function guard({ reviews = [], comments = [], headSha = HEAD, headRefName = BRANCH } = {}) {
  return evaluateT1ApprovalGuard({
    body: T1, headRefName, headSha, lastPushAt: PUSH,
    approvalComments: comments, botReviews: reviews, reviewerAppLogin: REVIEWER_LOGIN,
  });
}
// The merge_group arm: one batch with an unrelated, cleanly approved PR alongside this one.
function mergeGroup(result) {
  const clean = guard({ reviews: [appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' })] });
  assert.equal(clean.pass, true, 'fixture: the companion PR must pass on its own');
  return classifyMergeGroupApprovals([{ number: 1, result: clean }, { number: 2, result }]);
}

test('BLOCKS (#4686 shape): Approved (Quality) then Changes requested (Design) at the same head, same App account', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
    appReview('Changes requested (Design): fix the layout', T_2, { state: 'CHANGES_REQUESTED' }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-at-head');
  assert.deepEqual(r.blockers.map((b) => b.role), ['Design']);
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('BLOCKS: the SAME role on the same App account approves, then requests changes at the same head', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
    appReview('Changes requested (Quality): found a bug', T_2, { state: 'CHANGES_REQUESTED' }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-at-head');
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('BLOCKS: a later APPROVED-state review for ANOTHER role does not clear an earlier role request (GitHub would overwrite it)', () => {
  const r = guard({ reviews: [
    appReview('Changes requested (Design): fix the layout', T_1, { state: 'CHANGES_REQUESTED' }),
    appReview('Approved (Quality): fine', T_2, { state: 'APPROVED' }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-at-head');
  assert.deepEqual(r.blockers.map((b) => b.role), ['Design']);
});

test('BLOCKS: a legacy comment approval, then a reviewer-App changes-request review at the head', () => {
  const r = guard({
    comments: [{ body: 'Approved (Quality): fine', createdAt: T_1, login: HUMAN }],
    reviews: [appReview('Changes requested (Design): no', T_2)],
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-at-head');
});

test('BLOCKS: a reviewer-App changes-request COMMENT after the push, despite an approval review', () => {
  const r = guard({
    reviews: [appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' })],
    comments: [{ body: '**Changes requested (Design), at bbbb**: no', createdAt: T_2, login: REVIEWER_LOGIN }],
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-at-head');
});

test('BLOCKS: the PR owner role requesting changes still blocks (the self-check only stops self-APPROVAL)', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1),
    appReview('Changes requested (DevOps Lead): hold, I found an issue', T_2),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-at-head');
});

test('BLOCKS: an App review with CHANGES_REQUESTED state but an unrecognized body (state may add a block, never an approval)', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
    appReview('see inline notes', T_2, { state: 'CHANGES_REQUESTED' }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-at-head');
});

test('BLOCKS: an unparseable App changes-request latches; a later approval by some role does not clear it', () => {
  const r = guard({ reviews: [
    appReview('Changes requested -- see below', T_1),
    appReview('Approved (Quality): fine', T_2, { state: 'APPROVED' }),
  ] });
  assert.equal(r.pass, false);
  assert.deepEqual(r.blockers.map((b) => b.role), ['(unparseable)']);
});

test('UNBLOCKS: Changes requested (Design), then the SAME role re-approves at the same head -> pass', () => {
  const r = guard({ reviews: [
    appReview('Changes requested (Design): fix the layout', T_1, { state: 'CHANGES_REQUESTED' }),
    appReview('Approved (Design): fixed, thanks', T_2, { state: 'APPROVED' }),
  ] });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'approved-after-push');
  assert.equal(r.approver.role, 'Design');
  assert.deepEqual(mergeGroup(r), { pass: true, failingNumbers: [] });
});

test('UNBLOCKS across sources: an App review changes-request, then the same role legacy approval comment later', () => {
  const r = guard({
    reviews: [appReview('Changes requested (Quality): no', T_1)],
    comments: [{ body: 'Approved (Quality): fixed', createdAt: T_2, login: HUMAN }],
  });
  assert.equal(r.pass, true);
  assert.equal(r.approver.role, 'Quality');
});

test('OLD HEAD IGNORED: a changes-request bound to an older head does not block an approval at the current head', () => {
  const r = guard({ reviews: [
    appReview('Changes requested (Design): fix', BEFORE_PUSH, { commitId: OLD_HEAD, state: 'CHANGES_REQUESTED' }),
    humanReview('CHANGES_REQUESTED', BEFORE_PUSH, { commitId: OLD_HEAD }),
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
  ] });
  assert.equal(r.pass, true);
  assert.deepEqual(mergeGroup(r), { pass: true, failingNumbers: [] });
});

test('OLD HEAD IGNORED: an approval bound to an older head does not satisfy the gate, even if submitted after the push time', () => {
  const r = guard({ reviews: [appReview('Approved (Quality): fine', T_1, { commitId: OLD_HEAD, state: 'APPROVED' })] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('OLD HEAD IGNORED: an App changes-request comment from before the latest push does not block', () => {
  const r = guard({
    reviews: [appReview('Approved (Quality): fine', T_1)],
    comments: [{ body: 'Changes requested (Design): no', createdAt: BEFORE_PUSH, login: REVIEWER_LOGIN }],
  });
  assert.equal(r.pass, true);
});

test('BLOCKS: a HUMAN CHANGES_REQUESTED review at the head blocks an App approval', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
    humanReview('CHANGES_REQUESTED', T_2, { body: 'please hold this' }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-at-head');
  assert.deepEqual(r.blockers.map((b) => b.role), ['@jpsnover']);
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('BLOCKS: a human request posted BEFORE the App approval still blocks (an approval by someone else never clears it)', () => {
  const r = guard({ reviews: [
    humanReview('CHANGES_REQUESTED', T_1),
    appReview('Approved (Quality): fine', T_2, { state: 'APPROVED' }),
  ] });
  assert.equal(r.pass, false);
});

test('BLOCKS: a later COMMENTED review by the same human does not clear that human request (GitHub semantics)', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
    humanReview('CHANGES_REQUESTED', T_2),
    humanReview('COMMENTED', T_3, { body: 'one more thought' }),
  ] });
  assert.equal(r.pass, false);
});

test('UNBLOCKS: the same human approves (or the request is dismissed) after requesting changes -> the App approval stands', () => {
  for (const clearing of ['APPROVED', 'DISMISSED']) {
    const r = guard({ reviews: [
      appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
      humanReview('CHANGES_REQUESTED', T_2),
      humanReview(clearing, T_3),
    ] });
    assert.equal(r.pass, true, `${clearing} should clear the human's own request`);
  }
});

test('a human APPROVED review alone still does not satisfy the gate (TL blocking 2, PR #3487)', () => {
  const r = guard({ reviews: [humanReview('APPROVED', T_1, { body: 'Approved (Quality): lgtm' })] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

test('a human request is not cleared by ANOTHER human approval', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1),
    humanReview('CHANGES_REQUESTED', T_2),
    humanReview('APPROVED', T_3, { login: 'someone-else' }),
  ] });
  assert.equal(r.pass, false);
});

test('a strict "Changes requested (<role>):" COMMENT from the shared human login blocks', () => {
  const r = guard({
    reviews: [appReview('Approved (Quality): fine', T_1)],
    comments: [{ body: 'Changes requested (Tech Lead): not yet', createdAt: T_2, login: HUMAN }],
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-at-head');
});

test('status chatter on the shared login that merely MENTIONS "changes requested" does not latch a block', () => {
  const r = guard({
    reviews: [appReview('Approved (Quality): fine', T_1)],
    comments: [{ body: 'Addressed the changes requested (Design) in the last push.', createdAt: T_2, login: HUMAN }],
  });
  assert.equal(r.pass, true);
});

test('FAIL CLOSED: reviews present but no headSha -> missing-head-sha, never a silent pass', () => {
  const r = guard({ headSha: null, reviews: [appReview('Approved (Quality): fine', T_1)] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'missing-head-sha');
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});
