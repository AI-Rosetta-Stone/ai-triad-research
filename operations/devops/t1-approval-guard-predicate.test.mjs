// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4247: #3343 and #3364 both auto-merged on 10-17 as T1 PRs with no `Approved (<role>):`
// comment. Both arms of "a T1 PR needs a post-push approval" proven here, one fault per site.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateT1ApprovalGuard } from './t1-approval-guard-predicate.mjs';

const PUSH = '2026-10-17T18:00:00Z';
const BEFORE_PUSH = '2026-10-17T17:00:00Z';
const AFTER_PUSH = '2026-10-17T18:30:00Z';

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

test('t/4096: a bot APPROVED review after the latest push -> pass, no comment needed', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    approvalComments: [],
    botReviews: [{ state: 'APPROVED', submittedAt: AFTER_PUSH, login: 'ai-triad-reviewer-jpsnover[bot]' }],
  });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'approved-after-push');
  assert.equal(r.approver.role, 'ai-triad-reviewer-jpsnover[bot]');
});

test('FIRE ARM: t/4096: a bot review that predates the latest push -> fail (stale, same as a stale comment)', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: AFTER_PUSH,
    approvalComments: [],
    botReviews: [{ state: 'APPROVED', submittedAt: BEFORE_PUSH, login: 'ai-triad-reviewer-jpsnover[bot]' }],
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

test('FIRE ARM: t/4096: a bot review with state COMMENTED or CHANGES_REQUESTED does not satisfy the gate', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    approvalComments: [],
    botReviews: [
      { state: 'COMMENTED', submittedAt: AFTER_PUSH, login: 'ai-triad-reviewer-jpsnover[bot]' },
      { state: 'CHANGES_REQUESTED', submittedAt: AFTER_PUSH, login: 'ai-triad-reviewer-jpsnover[bot]' },
    ],
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
});

test('t/4096: either form satisfies the gate during the transition -- a legacy comment still passes with no bot review present', () => {
  const r = evaluateT1ApprovalGuard({
    body: 'Tier: T1',
    headRefName: 'devops/t4247-t1-approval-guard',
    lastPushAt: PUSH,
    approvalComments: [{ body: 'Approved (Quality): looks good', createdAt: AFTER_PUSH }],
    botReviews: [],
  });
  assert.equal(r.pass, true);
  assert.equal(r.approver.role, 'Quality');
});
