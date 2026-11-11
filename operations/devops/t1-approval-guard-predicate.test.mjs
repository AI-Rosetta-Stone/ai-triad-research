// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4247: #3343 and #3364 both auto-merged on 10-17 as T1 PRs with no `Approved (<role>):`
// comment. Both arms of "a T1 PR needs a post-push approval" proven here, one fault per site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateT1ApprovalGuard, ownerSlugFromBranch, latestRoleVerdicts as inlinedLatestRoleVerdicts } from './t1-approval-guard-predicate.mjs';
import { latestRoleVerdicts as sharedLatestRoleVerdicts } from './role-review-verdicts.mjs';
import { inlinedRegionFrom, currentRegionOf } from './sync-inlined-role-review-verdicts.mjs';
import { classifyMergeGroupApprovals } from './t1-approval-guard-merge-group-predicate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

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
  assert.equal(r.reason, 'changes-requested-outstanding');
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
  assert.equal(r.reason, 'changes-requested-outstanding');
  assert.deepEqual(r.blockers.map((b) => b.role), ['Design']);
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('BLOCKS: the SAME role on the same App account approves, then requests changes at the same head', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
    appReview('Changes requested (Quality): found a bug', T_2, { state: 'CHANGES_REQUESTED' }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-outstanding');
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('BLOCKS: a later APPROVED-state review for ANOTHER role does not clear an earlier role request (GitHub would overwrite it)', () => {
  const r = guard({ reviews: [
    appReview('Changes requested (Design): fix the layout', T_1, { state: 'CHANGES_REQUESTED' }),
    appReview('Approved (Quality): fine', T_2, { state: 'APPROVED' }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-outstanding');
  assert.deepEqual(r.blockers.map((b) => b.role), ['Design']);
});

test('BLOCKS: a legacy comment approval, then a reviewer-App changes-request review at the head', () => {
  const r = guard({
    comments: [{ body: 'Approved (Quality): fine', createdAt: T_1, login: HUMAN }],
    reviews: [appReview('Changes requested (Design): no', T_2)],
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-outstanding');
});

test('BLOCKS: a reviewer-App changes-request COMMENT after the push, despite an approval review', () => {
  const r = guard({
    reviews: [appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' })],
    comments: [{ body: '**Changes requested (Design), at bbbb**: no', createdAt: T_2, login: REVIEWER_LOGIN }],
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-outstanding');
});

test('BLOCKS: the PR owner role requesting changes still blocks (the self-check only stops self-APPROVAL)', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1),
    appReview('Changes requested (DevOps Lead): hold, I found an issue', T_2),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-outstanding');
});

test('BLOCKS: an App review with CHANGES_REQUESTED state but an unrecognized body (state may add a block, never an approval)', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
    appReview('see inline notes', T_2, { state: 'CHANGES_REQUESTED' }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-outstanding');
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

// ── TL p/12#58 (t/116#8): approvals are head-bound; a changes-request is STICKY across pushes ──

test('TL #1 BLOCKS: request changes (Design), push, ANOTHER role approves at the new head', () => {
  const r = guard({ reviews: [
    appReview('Changes requested (Design): fix', BEFORE_PUSH, { commitId: OLD_HEAD, state: 'CHANGES_REQUESTED' }),
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-outstanding');
  assert.deepEqual(r.blockers.map((b) => b.role), ['Design']);
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('TL #1 BLOCKS (human): a human requests changes, push, the App approves at the new head', () => {
  const r = guard({ reviews: [
    humanReview('CHANGES_REQUESTED', BEFORE_PUSH, { commitId: OLD_HEAD }),
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
  ] });
  assert.equal(r.pass, false);
  assert.deepEqual(r.blockers.map((b) => b.role), ['@jpsnover']);
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('TL #1 BLOCKS (comment): a pre-push App changes-request comment survives the push', () => {
  const r = guard({
    reviews: [appReview('Approved (Quality): fine', T_1)],
    comments: [{ body: 'Changes requested (Design): no', createdAt: BEFORE_PUSH, login: REVIEWER_LOGIN }],
  });
  assert.equal(r.pass, false);
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('TL #2 UNBLOCKS: request changes (Design), push, the SAME role approves at the new head', () => {
  const r = guard({ reviews: [
    appReview('Changes requested (Design): fix', BEFORE_PUSH, { commitId: OLD_HEAD, state: 'CHANGES_REQUESTED' }),
    appReview('Approved (Design): fixed', T_1, { state: 'APPROVED' }),
  ] });
  assert.equal(r.pass, true);
  assert.equal(r.approver.role, 'Design');
  assert.deepEqual(mergeGroup(r), { pass: true, failingNumbers: [] });
});

test('TL #2 UNBLOCKS (human): a human requests changes, push, the SAME human approves at the new head; the App approval stands', () => {
  const r = guard({ reviews: [
    humanReview('CHANGES_REQUESTED', BEFORE_PUSH, { commitId: OLD_HEAD }),
    humanReview('APPROVED', T_1),
    appReview('Approved (Quality): fine', T_2, { state: 'APPROVED' }),
  ] });
  assert.equal(r.pass, true);
  assert.deepEqual(mergeGroup(r), { pass: true, failingNumbers: [] });
});

test('TL #3 UNBLOCKS: a CHANGES_REQUESTED review that is then dismissed (App role, and human)', () => {
  for (const dismissed of [
    appReview('Changes requested (Design): fix', BEFORE_PUSH, { commitId: OLD_HEAD, state: 'DISMISSED' }),
    humanReview('DISMISSED', BEFORE_PUSH, { commitId: OLD_HEAD }),
  ]) {
    const r = guard({ reviews: [dismissed, appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' })] });
    assert.equal(r.pass, true, `dismissed ${dismissed.login} request should not block`);
    assert.deepEqual(mergeGroup(r), { pass: true, failingNumbers: [] });
  }
});

test('TL #4 BLOCKS: request changes, push, the SAME role re-reviews with ANOTHER changes-request at the new head', () => {
  const r = guard({ reviews: [
    appReview('Changes requested (Design): fix', BEFORE_PUSH, { commitId: OLD_HEAD, state: 'CHANGES_REQUESTED' }),
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
    appReview('Changes requested (Design): still wrong', T_2, { state: 'CHANGES_REQUESTED' }),
  ] });
  assert.equal(r.pass, false);
  assert.deepEqual(r.blockers.map((b) => b.role), ['Design']);
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('an approval at the OLD head clears that role request but cannot satisfy the gate after a push', () => {
  const r = guard({ reviews: [
    appReview('Changes requested (Design): fix', BEFORE_PUSH, { commitId: OLD_HEAD }),
    appReview('Approved (Design): fixed', '2026-10-17T17:30:00Z', { commitId: OLD_HEAD }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

test('OLD HEAD: an approval bound to an older head does not satisfy the gate, even if submitted after the push time', () => {
  const r = guard({ reviews: [appReview('Approved (Quality): fine', T_1, { commitId: OLD_HEAD, state: 'APPROVED' })] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
  assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
});

test('a plain COMMENTED human review or an exemption by the same role never clears a request across a push', () => {
  const human = guard({ reviews: [
    humanReview('CHANGES_REQUESTED', BEFORE_PUSH, { commitId: OLD_HEAD }),
    humanReview('COMMENTED', T_1, { body: 'looks better' }),
    appReview('Approved (Quality): fine', T_2),
  ] });
  assert.equal(human.pass, false);
  const role = guard({ reviews: [
    appReview('Changes requested (Design): fix', BEFORE_PUSH, { commitId: OLD_HEAD }),
    appReview('Design-exempt (Design): not a UI change', T_1),
    appReview('Approved (Quality): fine', T_2),
  ] });
  assert.equal(role.pass, false);
});

// ── Quality-TechLead (#4804 review): ties go to the block; every latch has a defined clear ──

test('TIE: an approval and a changes-request from the SAME role at the same timestamp -> blocked (both orders)', () => {
  const approve = appReview('Approved (Design): ok', T_1);
  const request = appReview('Changes requested (Design): no', T_1);
  for (const reviews of [[approve, request], [request, approve]]) {
    const r = guard({ reviews });
    assert.equal(r.pass, false);
    assert.equal(r.reason, 'changes-requested-outstanding');
    assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
  }
});

test('TIE: an APPROVED and a CHANGES_REQUESTED review from the SAME human at the same timestamp -> blocked (both orders)', () => {
  const approve = humanReview('APPROVED', T_2);
  const request = humanReview('CHANGES_REQUESTED', T_2);
  for (const humans of [[approve, request], [request, approve]]) {
    const r = guard({ reviews: [appReview('Approved (Quality): fine', T_1), ...humans] });
    assert.equal(r.pass, false);
    assert.deepEqual(r.blockers.map((b) => b.role), ['@jpsnover']);
    assert.deepEqual(mergeGroup(r), { pass: false, failingNumbers: [2] });
  }
});

test('CLEAR (unparseable latch): it survives a push and any later approval, and clears only when that review is dismissed', () => {
  const latched = guard({ reviews: [
    appReview('Changes requested -- see below', BEFORE_PUSH, { commitId: OLD_HEAD }),
    appReview('Approved (Design): fine', T_1),
    appReview('Approved (Quality): fine', T_2),
  ] });
  assert.equal(latched.pass, false);
  assert.equal(latched.blockers[0].role, '(unparseable)');
  const cleared = guard({ reviews: [
    appReview('Changes requested -- see below', BEFORE_PUSH, { commitId: OLD_HEAD, state: 'DISMISSED' }),
    appReview('Approved (Quality): fine', T_2),
  ] });
  assert.equal(cleared.pass, true);
});

test('CLEAR (unparseable latch, comment): it clears when the comment is edited into a parseable verdict or deleted', () => {
  const app = (body, extra = {}) => ({ body, createdAt: BEFORE_PUSH, login: REVIEWER_LOGIN, ...extra });
  const approval = appReview('Approved (Quality): fine', T_1);
  assert.equal(guard({ reviews: [approval], comments: [app('changes requested, see thread')] }).pass, false);
  assert.equal(guard({ reviews: [approval], comments: [app('Approved (Design): resolved', { updatedAt: T_2 })] }).pass, true);
  assert.equal(guard({ reviews: [approval], comments: [] }).pass, true);
});

test('CLEAR (App state-only latch): a role-less CHANGES_REQUESTED-state App review survives other approvals, and clears only on dismissal', () => {
  const latched = guard({ reviews: [
    appReview('see inline notes', BEFORE_PUSH, { commitId: OLD_HEAD, state: 'CHANGES_REQUESTED' }),
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
  ] });
  assert.equal(latched.pass, false);
  assert.equal(latched.blockers[0].role, '(unparseable)');
  const cleared = guard({ reviews: [
    appReview('see inline notes', BEFORE_PUSH, { commitId: OLD_HEAD, state: 'DISMISSED' }),
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
  ] });
  assert.equal(cleared.pass, true);
});

test('CLEAR (App state-only, role named in the body): it is that role block, so the same role re-approving clears it and another role does not', () => {
  const request = appReview('Approved (Design): actually no', T_1, { state: 'CHANGES_REQUESTED' });
  const other = guard({ reviews: [request, appReview('Approved (Quality): fine', T_2)] });
  assert.equal(other.pass, false);
  assert.deepEqual(other.blockers.map((b) => b.role), ['Design']);
  assert.equal(guard({ reviews: [request, appReview('Approved (Design): fixed', T_2)] }).pass, true);
});

test('dismissing ONE role-less latch does not clear a DIFFERENT role-less latch', () => {
  const r = guard({ reviews: [
    appReview('see inline notes', BEFORE_PUSH, { commitId: OLD_HEAD, state: 'DISMISSED' }),
    appReview('changes requested, more notes', T_1),
    appReview('Approved (Quality): fine', T_2),
  ] });
  assert.equal(r.pass, false);
});

test('BLOCKS: a HUMAN CHANGES_REQUESTED review at the head blocks an App approval', () => {
  const r = guard({ reviews: [
    appReview('Approved (Quality): fine', T_1, { state: 'APPROVED' }),
    humanReview('CHANGES_REQUESTED', T_2, { body: 'please hold this' }),
  ] });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'changes-requested-outstanding');
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
  assert.equal(r.reason, 'changes-requested-outstanding');
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

// ── t/200: the predicate must load ALONE (the pre-#4804 YAML copies only this file) ──
const predicatePath = path.join(here, 't1-approval-guard-predicate.mjs');

test('t/200 NO DRIFT: the inlined role-review-verdicts region is byte-identical to role-review-verdicts.mjs', () => {
  const region = currentRegionOf(readFileSync(predicatePath, 'utf8'));
  assert.notEqual(region, null, 'the BEGIN/END INLINED markers must be present in the predicate');
  assert.equal(region, inlinedRegionFrom(readFileSync(path.join(here, 'role-review-verdicts.mjs'), 'utf8')),
    'drift: run `node operations/devops/sync-inlined-role-review-verdicts.mjs` after editing role-review-verdicts.mjs');
});

test('t/200 SELF-CONTAINED: the predicate has no static or dynamic import of anything', () => {
  const code = readFileSync(predicatePath, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/^\s*import\s/m.test(code), 'no static import');
  assert.ok(!/\bimport\s*\(/.test(code), 'no dynamic import()');
  assert.ok(!/\brequire\s*\(/.test(code), 'no require()');
});

test('t/200 BEHAVIOUR-EQUAL: the inlined latestRoleVerdicts matches the shared one on the gate fixtures', () => {
  const input = {
    reviews: [
      { commitId: HEAD, state: 'APPROVED', submittedAt: AFTER_PUSH, login: REVIEWER_LOGIN, body: 'Approved (Quality): ok' },
      { commitId: OLD_HEAD, state: 'CHANGES_REQUESTED', submittedAt: BEFORE_PUSH, login: REVIEWER_LOGIN, body: 'Changes requested (Design): no' },
      { commitId: HEAD, state: 'CHANGES_REQUESTED', submittedAt: AFTER_PUSH, login: 'human', body: '' },
    ],
    comments: [{ body: '**Changes requested (Quality), at abc**', createdAt: AFTER_PUSH, login: REVIEWER_LOGIN }],
    reviewerAppLogin: REVIEWER_LOGIN, headSha: HEAD, lastPushAt: PUSH,
  };
  for (const mode of ['gate', undefined]) {
    assert.deepEqual([...inlinedLatestRoleVerdicts({ ...input, mode })], [...sharedLatestRoleVerdicts({ ...input, mode })]);
  }
});

test('t/200 ISOLATED LOAD: copied ALONE into an empty dir, the predicate imports and gives both verdicts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 't200-predicate-alone-'));
  try {
    const alone = path.join(dir, 't1-approval-guard-predicate.mjs');
    copyFileSync(predicatePath, alone);
    assert.deepEqual(readdirSync(dir), ['t1-approval-guard-predicate.mjs'], 'nothing else is next to it');
    const { evaluateT1ApprovalGuard: isolated } = await import(pathToFileURL(alone).href);
    const base = { body: 'Tier: T1', headRefName: 'devops/t200', headSha: HEAD, lastPushAt: PUSH, reviewerAppLogin: REVIEWER_LOGIN, approvalComments: [] };
    const approved = isolated({ ...base, botReviews: [{ commitId: HEAD, state: 'APPROVED', submittedAt: AFTER_PUSH, login: REVIEWER_LOGIN, body: 'Approved (Quality): ok' }] });
    assert.equal(approved.pass, true);
    assert.equal(approved.reason, 'approved-after-push');
    const blocked = isolated({ ...base, botReviews: [
      { commitId: HEAD, state: 'APPROVED', submittedAt: AFTER_PUSH, login: REVIEWER_LOGIN, body: 'Approved (Quality): ok' },
      { commitId: HEAD, state: 'CHANGES_REQUESTED', submittedAt: AFTER_PUSH, login: 'human', body: 'please fix' },
    ] });
    assert.equal(blocked.pass, false);
    assert.equal(blocked.reason, 'changes-requested-outstanding');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── t/311: one reviewer, two spellings (#5005: `Changes requested (Quality)` then
// `Approved (Quality-TechLead)`) must share ONE gate slot, so its own approval clears its hold ──
const LATER = new Date(Date.parse(AFTER_PUSH) + 60000).toISOString();
const t311Guard = (reviews, headRefName = 'devops/t308-x') => evaluateT1ApprovalGuard({
  body: 'Tier: T1', headRefName, lastPushAt: PUSH, headSha: HEAD, approvalComments: [], botReviews: reviews, reviewerAppLogin: REVIEWER_LOGIN,
});
const t311Review = (body, at, state = 'COMMENTED') => ({ commitId: HEAD, state, submittedAt: at, login: REVIEWER_LOGIN, body });

test('t/311: a hold as `Quality` is cleared by an approval as `Quality-TechLead` (the #5005 shape) -> pass', () => {
  const r = t311Guard([t311Review('Changes requested (Quality): fix it', AFTER_PUSH), t311Review('Approved (Quality-TechLead): fixed', LATER, 'APPROVED')]);
  assert.equal(r.pass, true);
  assert.equal(r.approver.role, 'Quality');
});

test('t/311: the reverse spellings, and `Quality (Tech Lead)` / `Quality-TL`, also share the slot', () => {
  for (const [hold, ok] of [['Quality-TechLead', 'Quality'], ['Quality', 'QualityTechLead'], ['Quality-TL', 'Quality']]) {
    const r = t311Guard([t311Review(`Changes requested (${hold}): x`, AFTER_PUSH), t311Review(`Approved (${ok}): y`, LATER, 'APPROVED')]);
    assert.equal(r.pass, true, `${hold} -> ${ok}`);
  }
});

test('FIRE ARM t/311: distinct roles never merge -- a Quality hold is NOT cleared by a Design (or Quality-Sage) approval', () => {
  for (const other of ['Design', 'Quality-Sage']) {
    const r = t311Guard([t311Review('Changes requested (Quality): x', AFTER_PUSH), t311Review(`Approved (${other}): y`, LATER, 'APPROVED')]);
    assert.equal(r.pass, false, other);
    assert.equal(r.reason, 'changes-requested-outstanding');
  }
});

test('FIRE ARM t/311: an alias cannot be used to self-approve -- `quality-techlead/` branch approved as `Quality` -> no approval', () => {
  const r = t311Guard([t311Review('Approved (Quality): mine', LATER, 'APPROVED')], 'quality-techlead/t311-x');
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});
