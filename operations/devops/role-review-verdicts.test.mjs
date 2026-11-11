// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/role-review-verdicts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestRoleVerdicts } from './role-review-verdicts.mjs';

const APP = 'ai-triad-reviewer-jpsnover';
const HEAD = 'abc123';

test('#4686 fixture: same login, Design CHANGES_REQUESTED then Quality APPROVED one second later -- both roles tracked independently', () => {
  const reviews = [
    { body: 'Changes requested (Design): partial bulk-delete error path.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T14:30:00Z' },
    { body: 'Approved (Quality): looks good otherwise.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T14:30:01Z' },
  ];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('Design').kind, 'changes_requested');
  assert.equal(v.get('Quality').kind, 'approved');
});

test('a review not bound to the current head is ignored entirely', () => {
  const reviews = [{ body: 'Approved (Design): old head.', login: APP, commitId: 'OLD', submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.has('Design'), false);
});

test('Design-exempt with an empty reason does not register as a verdict', () => {
  const reviews = [{ body: 'Design-exempt (Design):', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.has('Design'), false);
});

test('Design-exempt with a real reason registers as kind "exempt"', () => {
  const reviews = [{ body: 'Design-exempt (Design): store-only fix, no visible change.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('Design').kind, 'exempt');
});

test('a later verdict for the same role overrides an earlier one, regardless of kind', () => {
  const reviews = [
    { body: 'Changes requested (Design): item 1.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' },
    { body: 'Approved (Design): fixed.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T11:00:00Z' },
  ];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('Design').kind, 'approved');
});

test('a comment counts only if its effective time is AFTER lastPushAt', () => {
  const pushAt = '2026-11-09T12:00:00Z';
  const early = [{ body: 'Approved (Design): x.', login: APP, createdAt: '2026-11-09T11:59:00Z' }];
  const late = [{ body: 'Approved (Design): x.', login: APP, createdAt: '2026-11-09T12:01:00Z' }];
  assert.equal(latestRoleVerdicts({ reviews: [], comments: early, reviewerAppLogin: APP, headSha: HEAD, lastPushAt: pushAt }).has('Design'), false);
  assert.equal(latestRoleVerdicts({ reviews: [], comments: late, reviewerAppLogin: APP, headSha: HEAD, lastPushAt: pushAt }).get('Design').kind, 'approved');
});

test('a comment\'s EFFECTIVE time uses updatedAt when present (an edited-in-place approval still counts)', () => {
  const pushAt = '2026-11-09T12:00:00Z';
  const comments = [{ body: 'Approved (Design): x.', login: APP, createdAt: '2026-11-09T11:00:00Z', updatedAt: '2026-11-09T12:30:00Z' }];
  const v = latestRoleVerdicts({ reviews: [], comments, reviewerAppLogin: APP, headSha: HEAD, lastPushAt: pushAt });
  assert.equal(v.get('Design').kind, 'approved');
});

test('a review or comment from a login other than reviewerAppLogin is ignored, even with a valid tag', () => {
  const reviews = [{ body: 'Approved (Design): x.', login: 'some-human', commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const comments = [{ body: 'Changes requested (Design): x.', login: 'another-bot', createdAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments, reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.size, 0);
});

test('text with no recognizable verdict tag is ignored (not mistaken for any verdict)', () => {
  const reviews = [{ body: 'Looks fine to me.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.size, 0);
});

test('reviewerAppLogin unset never matches anything (fails closed, not open)', () => {
  const reviews = [{ body: 'Approved (Design): x.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: '', headSha: HEAD, lastPushAt: null });
  assert.equal(v.size, 0);
});

test('reviews and comments interleave correctly into one per-role timeline', () => {
  const reviews = [{ body: 'Approved (Design): x.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const comments = [{ body: 'Changes requested (Design): actually no.', login: APP, createdAt: '2026-11-09T11:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments, reviewerAppLogin: APP, headSha: HEAD, lastPushAt: '2026-11-09T09:00:00Z' });
  assert.equal(v.get('Design').kind, 'changes_requested');
});

// Quality, p/780#46: the fail-OPEN gap. Real reviewer-App output was
// `**Changes requested (Quality), at <sha>...**` -- leading markdown bold, and a comma instead
// of a colon -- which the original strict grammar silently returned null for (read as "no
// verdict" instead of a block).
test('tolerates leading markdown bold/italic/underscore before the verdict word', () => {
  const reviews = [{ body: '**Changes requested (Quality), at abc123, re: the error path.**', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('Quality').kind, 'changes_requested');
  assert.equal(v.get('Quality').unparsed, false);
});

test('accepts a comma or a period after the role, not just a colon', () => {
  const commaBody = latestRoleVerdicts({
    reviews: [{ body: 'Approved (Quality), looks good.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }],
    comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null,
  });
  assert.equal(commaBody.get('Quality').kind, 'approved');
  const periodBody = latestRoleVerdicts({
    reviews: [{ body: 'Changes requested (Design). Fix the error path.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }],
    comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null,
  });
  assert.equal(periodBody.get('Design').kind, 'changes_requested');
});

test('plain colon grammar (Design\'s existing style) still parses, with unparsed=false', () => {
  const reviews = [{ body: 'Changes requested (Design): partial bulk-delete error path.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('Design').unparsed, false);
});

// Quality's ask #2: fail CLOSED (never silently drop) on a reviewer-App body that says "changes
// requested" but still doesn't match the grammar, as a backstop against a future formatting
// variant neither of us anticipated.
test('fail-closed backstop: "changes requested" text that still does not match the grammar registers as a block, marked unparsed', () => {
  const reviews = [{ body: 'changes requested for real this time, going to write up why separately', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('(unparseable)').kind, 'changes_requested');
  assert.equal(v.get('(unparseable)').unparsed, true);
});

test('fail-closed backstop: best-effort role extraction from a parenthesized group even when the grammar does not fully match', () => {
  const reviews = [{ body: 'Hey (Quality) here -- changes requested, will detail in a follow-up comment.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('Quality').kind, 'changes_requested');
  assert.equal(v.get('Quality').unparsed, true);
});

test('fail-closed backstop does not fire on unrelated text with no "changes requested" substring', () => {
  const reviews = [{ body: 'Looks fine, no concerns.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.size, 0);
});

// Quality nit 1 (p/780#48): the backstop originally scanned the WHOLE body, which could match
// "changes requested" or a parenthesized name deep in later, unrelated prose. Scoped to the
// first line only now.
test('nit 1: "changes requested" mentioned only on a LATER line of an otherwise-valid Approved body does not false-positive', () => {
  const reviews = [{
    body: 'Approved (Design): looks good.\nNo changes requested from Quality on this one.',
    login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z',
  }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('Design').kind, 'approved');
  assert.equal(v.has('(unparseable)'), false);
});

test('nit 1: a role name in parentheses on a LATER line does not get picked up by the backstop\'s role extraction', () => {
  const reviews = [{
    body: 'changes requested, details below\n(Quality) will confirm separately once fixed',
    login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z',
  }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  // The role-bearing parenthesis is on line 2, out of scope -- falls back to the sentinel, not 'Quality'.
  assert.equal(v.get('(unparseable)').kind, 'changes_requested');
  assert.equal(v.has('Quality'), false);
});

test('nit 1: the backstop still fires when "changes requested" AND the role are both on the first line (unchanged)', () => {
  const reviews = [{ body: 'changes requested (Quality) -- will detail below\nmore text here', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' }];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('Quality').kind, 'changes_requested');
  assert.equal(v.get('Quality').unparsed, true);
});

// Quality nit 2, CORRECTED (p/780#48 -> p/780#54): the first attempt at this nit made an
// unparseable block supersedable by ANY later entry, which reintroduced #4686's exact shape --
// a badly-formed block followed by an UNRELATED later approval would erase it and let the sweep
// enqueue the PR. Quality's actual ask was to DOCUMENT the latch, not remove it: it stays
// latched until a genuinely new push, deliberately, since the ambiguous entry's role is unknown
// and there is no safe way to tell "this specific block was resolved" from "something unrelated
// happened later."
test('nit 2 (corrected): an unparseable block is NOT cleared by a later, UNRELATED role approval -- still blocks (the #4686 shape)', () => {
  const reviews = [
    { body: 'changes requested for real this time, will detail separately', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' },
    { body: 'Approved (Design): fixed, re-reviewed.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T11:00:00Z' },
  ];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('(unparseable)').kind, 'changes_requested');
  assert.equal(v.get('Design').kind, 'approved'); // tracked independently -- does not clear the block
});

test('nit 2: an unparseable block is NOT cleared when nothing later exists -- still blocks', () => {
  const reviews = [
    { body: 'Approved (Design): fine.', login: APP, commitId: HEAD, submittedAt: '2026-11-09T09:00:00Z' },
    { body: 'changes requested for real this time, will detail separately', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' },
  ];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  assert.equal(v.get('(unparseable)').kind, 'changes_requested');
  assert.equal(v.get('Design').kind, 'approved'); // unaffected -- a different, real role key
});

test('nit 2: a later entry that is ITSELF unparseable overwrites the earlier one at the SAME key (ordinary Map behavior) -- still blocks', () => {
  const reviews = [
    { body: 'changes requested, round 1', login: APP, commitId: HEAD, submittedAt: '2026-11-09T10:00:00Z' },
    { body: 'changes requested, round 2, still vague', login: APP, commitId: HEAD, submittedAt: '2026-11-09T11:00:00Z' },
  ];
  const v = latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: null });
  // Both entries key on the SAME '(unparseable)' role, so the ordinary "latest per role" Map
  // overwrite applies (unrelated to the latch) -- still blocks, just reflecting round 2.
  assert.equal(v.get('(unparseable)').kind, 'changes_requested');
});

// ── mode: 'gate' (t/116, TL p/12#58 on t/116#8): head-bound approvals, sticky changes-requests ──
const OLD = 'old999';
const PUSH_AT = '2026-11-09T12:00:00Z';
const g = (reviews, comments = []) => latestRoleVerdicts({ reviews, comments, reviewerAppLogin: APP, headSha: HEAD, lastPushAt: PUSH_AT, mode: 'gate' });
const blocks = (m) => [...m.values()].filter((v) => v.kind === 'changes_requested').map((v) => v.role);

test('gate: DEFAULT mode is unchanged -- an old-head request is still dropped for existing callers (t0-enqueue-sweep)', () => {
  const reviews = [{ body: 'Changes requested (Design): no', login: APP, commitId: OLD, submittedAt: '2026-11-09T11:00:00Z' }];
  assert.equal(latestRoleVerdicts({ reviews, comments: [], reviewerAppLogin: APP, headSha: HEAD, lastPushAt: PUSH_AT }).size, 0);
  assert.deepEqual(blocks(g(reviews)), ['Design']);
});

test('gate: a request is sticky across a push; another role at the new head does not clear it, the same role does', () => {
  const request = { body: 'Changes requested (Design): no', login: APP, commitId: OLD, submittedAt: '2026-11-09T11:00:00Z' };
  assert.deepEqual(blocks(g([request, { body: 'Approved (Quality): ok', login: APP, commitId: HEAD, submittedAt: '2026-11-09T13:00:00Z' }])), ['Design']);
  const v = g([request, { body: 'Approved (Design): ok', login: APP, commitId: HEAD, submittedAt: '2026-11-09T13:00:00Z' }]);
  assert.deepEqual(blocks(v), []);
  assert.equal(v.get('design').atHead, true);
});

test('gate: approvals carry atHead (review commit === head; comment after the push)', () => {
  const v = g(
    [{ body: 'Approved (Quality): ok', login: APP, commitId: OLD, submittedAt: '2026-11-09T13:00:00Z' }],
    [{ body: 'Approved (Tech Lead): ok', login: 'jpsnover', createdAt: '2026-11-09T13:00:00Z' }],
  );
  assert.equal(v.get('quality').atHead, false);
  assert.equal(v.get('techlead').atHead, true);
});

test('gate: human reviews are per-login state slots; DISMISSED and the same login APPROVED clear, COMMENTED does not', () => {
  const req = { state: 'CHANGES_REQUESTED', login: 'alice', commitId: OLD, submittedAt: '2026-11-09T11:00:00Z' };
  assert.deepEqual(blocks(g([req])), ['@alice']);
  assert.deepEqual(blocks(g([req, { state: 'COMMENTED', login: 'alice', commitId: HEAD, submittedAt: '2026-11-09T13:00:00Z' }])), ['@alice']);
  assert.deepEqual(blocks(g([req, { state: 'APPROVED', login: 'bob', commitId: HEAD, submittedAt: '2026-11-09T13:00:00Z' }])), ['@alice']);
  assert.deepEqual(blocks(g([req, { state: 'APPROVED', login: 'alice', commitId: HEAD, submittedAt: '2026-11-09T13:00:00Z' }])), []);
  assert.deepEqual(blocks(g([{ ...req, state: 'DISMISSED' }])), []);
});

test('gate: a tie between an approval and a request in one slot goes to the request', () => {
  const at = '2026-11-09T13:00:00Z';
  const a = { body: 'Approved (Design): ok', login: APP, commitId: HEAD, submittedAt: at };
  const r = { body: 'Changes requested (Design): no', login: APP, commitId: HEAD, submittedAt: at };
  assert.deepEqual(blocks(g([a, r])), ['Design']);
  assert.deepEqual(blocks(g([r, a])), ['Design']);
});

test('gate: role-less latches get one slot each; dismissal removes only its own', () => {
  const v = g([
    { body: 'changes requested, see thread', login: APP, commitId: OLD, submittedAt: '2026-11-09T11:00:00Z', state: 'DISMISSED' },
    { body: 'notes', login: APP, commitId: HEAD, submittedAt: '2026-11-09T13:00:00Z', state: 'CHANGES_REQUESTED' },
    { body: 'Approved (Quality): ok', login: APP, commitId: HEAD, submittedAt: '2026-11-09T14:00:00Z' },
  ]);
  assert.deepEqual(blocks(v), ['(unparseable)']);
});

test('gate: loose "changes requested" text from a non-App comment is ignored; the strict grammar blocks', () => {
  assert.deepEqual(blocks(g([], [{ body: 'Addressed the changes requested (Design).', login: 'jpsnover', createdAt: '2026-11-09T13:00:00Z' }])), []);
  assert.deepEqual(blocks(g([], [{ body: 'Changes requested (Design): no', login: 'jpsnover', createdAt: '2026-11-09T11:00:00Z' }])), ['Design']);
});

// ── t/311: alias table ──
test('t/311 canonicalRole: known aliases map to Quality; unknown roles pass through unchanged', async () => {
  const { canonicalRole } = await import('./role-review-verdicts.mjs');
  for (const a of ['Quality-TechLead', 'QualityTechLead', 'Quality (Tech Lead', 'Quality TL', 'quality-techlead']) assert.equal(canonicalRole(a), 'Quality', a);
  for (const r of ['Design', 'Quality', 'Quality-Sage', 'Tech Lead', '(unparseable)']) assert.equal(canonicalRole(r), r, r);
});

test('t/311 default mode: a Quality-TechLead approval and a Quality hold resolve to ONE role, latest wins', () => {
  const v = latestRoleVerdicts({
    reviewerAppLogin: APP, headSha: 'h', lastPushAt: null, comments: [],
    reviews: [
      { body: 'Changes requested (Quality): x', login: APP, commitId: 'h', submittedAt: '2026-11-11T02:00:00Z' },
      { body: 'Approved (Quality-TechLead): y', login: APP, commitId: 'h', submittedAt: '2026-11-11T02:03:00Z' },
    ],
  });
  assert.deepEqual([...v.keys()], ['Quality']);
  assert.equal(v.get('Quality').kind, 'approved');
});

test('t/311: an unparseable hold still latches -- an aliased approval does not clear it', () => {
  const v = latestRoleVerdicts({
    reviewerAppLogin: APP, headSha: 'h', lastPushAt: null, comments: [], mode: 'gate',
    reviews: [
      { body: 'changes requested, see below', login: APP, commitId: 'h', submittedAt: '2026-11-11T02:00:00Z', state: 'COMMENTED' },
      { body: 'Approved (Quality-TechLead): y', login: APP, commitId: 'h', submittedAt: '2026-11-11T02:03:00Z', state: 'APPROVED' },
    ],
  });
  assert.ok([...v.values()].some((s) => s.kind === 'changes_requested' && s.role === '(unparseable)'));
});
