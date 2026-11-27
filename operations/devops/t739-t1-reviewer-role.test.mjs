// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Incident t/739 (fix t/736): a T1 PR (#5553) merged on `Approved (Design):` alone, because the T1
// approval predicate counted an approval from ANY role other than the branch owner's.
//
// These arms run the one predicate (evaluateT1ApprovalGuard) through each caller that decides:
//   guard     evaluateT1ApprovalGuard itself, as t1-approval-guard.yml calls it
//   required  merge-approval rule B (ruleT1Approval), the required check
//   enqueue   approvalFromApiVerdict, used by enqueue-pr.mjs and the T1 sweep
// so the three cannot disagree about who is a T1 reviewer.
//
// NOT covered here, on purpose: the Design gate for user-facing changes inside merge-approval and
// enqueue-pr (t/752), and a missing `Tier:` line counting as T1 (t/751).
// Run: node --test operations/devops/t739-t1-reviewer-role.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T1_REVIEWER_ROLES, isT1ReviewerRole, evaluateT1ApprovalGuard } from './t1-approval-guard-predicate.mjs';
import { evaluatePullRequest, ruleT1Approval } from './merge-approval-verdict.mjs';
import { approvalFromApiVerdict, FAR_FUTURE_PUSH } from './t1-approval-at-head.mjs';
import { REVIEWER_APP_REST_LOGIN as APP } from './gate-file-change.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const BRANCH = 'renderer/t739-x'; // an owner slug that matches none of the sample roles below
const T1 = 'Tier: T1\n\nfeature';
const T2 = 'Tier: T2\n\nbig change';

let nextId = 100;
/** A review in the REST shape (what merge-approval and enqueue-pr read). */
function review(body, { login = APP, state = 'APPROVED', commit = HEAD, at = '2026-11-26T00:10:00Z', assoc = 'NONE', id = nextId++ } = {}) {
  return { id, user: { login }, state, body, commit_id: commit, submitted_at: at, author_association: assoc };
}
function comment(body, { login = APP, at = '2026-11-26T00:10:00Z' } = {}) {
  return { user: { login }, body, created_at: at, updated_at: at };
}

/** The three callers' verdicts for one PR. Each is { ok, text }. */
function verdicts({ body = T1, headRefName = BRANCH, reviews = [], comments = [] }) {
  const tier = /^Tier:\s*(T[012])/i.exec(body)?.[1] ?? null;
  const g = evaluateT1ApprovalGuard({
    body: body.replace(/^Tier:\s*T2/i, 'Tier: T1'), headRefName, headSha: HEAD, lastPushAt: FAR_FUTURE_PUSH, reviewerAppLogin: APP,
    approvalComments: comments.filter((c) => c.user.login === APP).map((c) => ({ body: c.body, createdAt: c.created_at, updatedAt: c.updated_at, login: c.user.login })),
    botReviews: reviews.filter((r) => r.user.login === APP || ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(r.author_association))
      .map((r) => ({ state: r.state, submittedAt: r.submitted_at, login: r.user.login, body: r.body, commitId: r.commit_id })),
  });
  const b = ruleT1Approval({ number: 1, headSha: HEAD, body, headRefName, files: [], filesTruncated: false, reviews, comments, lastPushAt: null, labels: [] });
  const e = approvalFromApiVerdict({
    tier, isDraft: false, headSha: HEAD,
    inputs: { pr: { body, head: { ref: headRefName, sha: HEAD } }, commits: [], comments, reviews, error: null },
  });
  return {
    guard: { ok: g.pass, text: `${g.reason} ${g.summary ?? ''} ${JSON.stringify(g.rejected ?? g.blockers ?? g.approver ?? '')}`, raw: g },
    required: { ok: b.ok, text: b.detail },
    enqueue: { ok: e.allow, text: `${e.reason} ${e.detail ?? ''}`, raw: e },
  };
}
function assertAll(v, ok, label) {
  for (const k of ['guard', 'required', 'enqueue']) assert.equal(v[k].ok, ok, `${label}: ${k} should ${ok ? 'pass' : 'refuse'} (${v[k].text})`);
}

// ── the list ──

test('T1_REVIEWER_ROLES is exported, frozen, and is exactly Quality, Tech Lead, Security', () => {
  assert.deepEqual([...T1_REVIEWER_ROLES], ['Quality', 'Tech Lead', 'Security']);
  assert.ok(Object.isFrozen(T1_REVIEWER_ROLES));
});

test('isT1ReviewerRole: listed roles and their known spellings count; Design and near-misses do not', () => {
  for (const r of ['Quality', 'quality', 'Tech Lead', 'TechLead', 'Tech-Lead', 'Security', 'Quality-TechLead', 'Quality TL']) assert.equal(isT1ReviewerRole(r), true, r);
  for (const r of ['Design', 'design', 'Design Lead', 'Quality Design', 'Security Design', 'DevOps Lead', 'DevOps', 'Second-Opinion', 'Release Captain', 'Tech', 'Lead', '', null, undefined]) {
    assert.equal(isT1ReviewerRole(r), false, String(r));
  }
});

// ── the incident ──

test('REPLAY #5553: its real body and its one review (Approved (Design) at the head) are refused everywhere', () => {
  const v = verdicts({
    body: 'Tier: T1\n\nRenderer area train for 2026-11-28 (t/567, t/655, `docs/pr-landing.md`). Owner: Rosetta Stone.',
    headRefName: 'train/renderer-20261128',
    reviews: [review('Approved (Design): #5553 at `5b687fa80` (renderer train 11-28). This is the formal review', { id: 6066872601, at: '2026-11-26T00:22:59Z' })],
  });
  assertAll(v, false, '#5553');
  assert.match(v.required.text, /T1, no reviewer-App approval review at aaaaaaaaa from a T1 reviewer role \(Quality, Tech Lead, Security\)/);
  assert.match(v.required.text, /approvals seen that do not count: Design \(not a T1 reviewer role\)/);
  assert.deepEqual(v.guard.raw.rejected.map((r) => [r.role, r.why]), [['Design', 'not_a_t1_reviewer_role']]);
  assert.equal(v.guard.raw.reason, 'no-post-push-approval', 'the top-level reason is unchanged, so the guard still shows "awaiting review"');
  assert.match(v.guard.raw.summary, /Approvals seen that do not count: Design \(not a T1 reviewer role\)/);
  assert.equal(v.enqueue.raw.reason, 'no_approval');
});

test('Design-only on a T1 is refused', () => {
  assertAll(verdicts({ reviews: [review('Approved (Design): looks right')] }), false, 'Design-only T1');
});

test('Design-only on a T2 is refused (T2 needs the same approval; guard arm skipped, it only reads T1)', () => {
  const v = verdicts({ body: T2, reviews: [review('Approved (Design): looks right')] });
  assert.equal(v.required.ok, false, v.required.text);
  assert.match(v.required.text, /^T2, no reviewer-App approval review/);
  assert.equal(v.enqueue.ok, false, v.enqueue.text);
});

// ── who counts ──

test('Quality-only on a T1 passes, and the required check names the role and the review id', () => {
  const v = verdicts({ reviews: [review('Approved (Quality): fine', { id: 4242 })] });
  assertAll(v, true, 'Quality-only T1');
  assert.equal(v.required.text, 'T1, approved by Quality (review 4242) at aaaaaaaaa');
  assert.equal(v.enqueue.raw.approver.role, 'Quality');
});

test('Tech Lead and Security each count, and so does a Quality alias', () => {
  for (const [body, role] of [['Approved (Tech Lead): ok', 'Tech Lead'], ['Approved (Security): ok', 'Security'], ['Approved (Quality-TechLead): ok', 'Quality']]) {
    const v = verdicts({ reviews: [review(body)] });
    assertAll(v, true, body);
    assert.equal(v.guard.raw.approver.role, role);
  }
});

test('Design plus Quality passes, and the approval counted is Quality, never Design', () => {
  const v = verdicts({ reviews: [review('Approved (Design): ok', { at: '2026-11-26T00:05:00Z' }), review('Approved (Quality): ok', { id: 77, at: '2026-11-26T00:09:00Z' })] });
  assertAll(v, true, 'Design + Quality');
  assert.equal(v.required.text, 'T1, approved by Quality (review 77) at aaaaaaaaa');
});

test("the branch owner's own role does not count even when it is a listed role; another listed role does", () => {
  const own = verdicts({ headRefName: 'quality/t1-x', reviews: [review('Approved (Quality): my own change')] });
  assertAll(own, false, 'owner self-approval');
  assert.deepEqual(own.guard.raw.rejected.map((r) => [r.role, r.why]), [['Quality', 'branch_owner_role']]);
  assert.match(own.required.text, /Quality \(the branch owner's own role\)/);
  assertAll(verdicts({ headRefName: 'quality-techlead/t1-x', reviews: [review('Approved (Quality-TechLead): mine')] }), false, 'owner self-approval through an alias');
  assertAll(verdicts({ headRefName: 'quality/t1-x', reviews: [review('Approved (Quality): mine'), review('Approved (Tech Lead): second reader')] }), true, 'owner + Tech Lead');
});

test('an unlisted role name does not count, whatever it is called', () => {
  for (const role of ['Release Captain', 'DevOps Lead', 'Second-Opinion', 'Design Quality', 'Quality Reviewer', 'Securitas']) {
    const v = verdicts({ reviews: [review(`Approved (${role}): ok`)] });
    assertAll(v, false, role);
    assert.match(v.required.text, /not a T1 reviewer role/);
  }
});

// ── where the role is read from ──

test('the role is read only from a reviewer-App REVIEW at the head: a comment, another login and another head never count', () => {
  // (guard arm not asserted for the comment case: the guard workflow passes the real push time.)
  const asComment = verdicts({ comments: [comment('Approved (Quality): fine')] });
  assert.equal(asComment.required.ok, false, asComment.required.text);
  assert.equal(asComment.enqueue.ok, false, asComment.enqueue.text);
  assert.match(asComment.required.text, /no reviewer-App approval review seen at this head/);
  assertAll(verdicts({ reviews: [review('Approved (Quality): fine', { login: 'someone-else', assoc: 'COLLABORATOR' })] }), false, 'a write-level human quoting the form');
  assertAll(verdicts({ reviews: [review('Approved (Quality): fine', { login: 'drive-by', assoc: 'NONE' })] }), false, 'a drive-by account');
  assertAll(verdicts({ reviews: [review('Approved (Quality): fine', { commit: OLD })] }), false, 'an approval at an older head');
  assertAll(verdicts({ reviews: [review('LGTM. Approved (Quality): fine')] }), false, 'the tag is not the body prefix');
});

// ── a changes-request still blocks (t/736#3 item 9) ──

test('Changes requested (Quality) at the head blocks even with Approved (Tech Lead), until Quality approves at that head', () => {
  const tl = review('Approved (Tech Lead): fine by me', { at: '2026-11-26T00:05:00Z' });
  const cr = review('Changes requested (Quality): the empty state is wrong', { state: 'CHANGES_REQUESTED', at: '2026-11-26T00:06:00Z' });
  const blocked = verdicts({ reviews: [tl, cr] });
  assertAll(blocked, false, 'Quality objects');
  assert.match(blocked.required.text, /^T1, changes-request outstanding from Quality/);
  assert.equal(blocked.enqueue.raw.reason, 'changes_requested');
  // The order does not matter: the request stands even when the other role approves after it.
  assertAll(verdicts({ reviews: [cr, review('Approved (Tech Lead): fine by me', { at: '2026-11-26T00:07:00Z' })] }), false, 'Tech Lead approves after the request');
  // Quality approving at this head clears its own request.
  assertAll(verdicts({ reviews: [tl, cr, review('Approved (Quality): fixed', { at: '2026-11-26T00:08:00Z' })] }), true, 'Quality approves at the head');
});

test('Changes requested (Design) blocks even with Approved (Quality); Design re-approving clears it, and Quality is still the approval counted', () => {
  const q = review('Approved (Quality): fine', { id: 9, at: '2026-11-26T00:05:00Z' });
  const cr = review('Changes requested (Design): contrast fails', { state: 'CHANGES_REQUESTED', at: '2026-11-26T00:06:00Z' });
  const blocked = verdicts({ reviews: [q, cr] });
  assertAll(blocked, false, 'Design objects');
  assert.match(blocked.required.text, /^T1, changes-request outstanding from Design/);
  const cleared = verdicts({ reviews: [q, cr, review('Approved (Design): fixed', { at: '2026-11-26T00:08:00Z' })] });
  assertAll(cleared, true, 'Design clears its own request');
  assert.equal(cleared.required.text, 'T1, approved by Quality (review 9) at aaaaaaaaa');
  // Design clearing its own request never supplies the T1 approval.
  assertAll(verdicts({ reviews: [cr, review('Approved (Design): fixed', { at: '2026-11-26T00:08:00Z' })] }), false, 'Design alone after its own request');
});

// ── the whole required check ──

test('merge-approval as a whole: #5553-shaped input is FAIL on rule B; the same PR with Quality is PASS', () => {
  const base = { number: 5553, headSha: HEAD, body: T1, headRefName: 'train/renderer-20261128', scriptsGatePaths: [], files: [{ filename: 'docs/readme.md' }], filesTruncated: false, comments: [], lastPushAt: null, labels: [] };
  const tierConfig = { r1Paths: [], r1Globs: [], schemaDirPrefixes: [] };
  const bad = evaluatePullRequest({ ...base, reviews: [review('Approved (Design): ok')] }, { tierConfig });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failed, ['B']);
  const good = evaluatePullRequest({ ...base, reviews: [review('Approved (Design): ok'), review('Approved (Quality): ok')] }, { tierConfig });
  assert.equal(good.ok, true, good.lines.join('\n'));
});
