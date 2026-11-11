// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/371: my-prs.mjs decides PR ownership from ticket refs, then file owners. These pin the
// precedence that keeps another agent's PR (which cites your ticket for context) off your list.
// Run: node --test operations/devops/my-prs.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketRefs, majorityOwner, claim, prStatus, formatPr } from './my-prs.mjs';

const ME = 'me-id';
const mine = new Set([357, 369]);
const refsOf = (pr) => ticketRefs(pr);

test('ticketRefs: loose forms in title and branch, canonical t/N only in the body', () => {
  const r = ticketRefs({ title: 'data-mutations(t292): freeze', branch: 'fix/t369-guards', body: 'Tier: T1 sha 1af48073f, child of t/313 and see t/4567#19' });
  assert.deepEqual([...r.primary].sort((a, b) => a - b), [292, 369]);
  assert.deepEqual([...r.body].sort((a, b) => a - b), [313, 4567]);
  assert.equal(ticketRefs({ title: 'Tier: T1 hotfix' }).primary.size, 0, 'an upper-case tier tag is not a ticket');
});

test('a title/branch ticket of mine claims the PR', () => {
  const c = claim({ refs: refsOf({ title: 'fix(ci): x (t/357)', branch: 'fix/t357-x' }), myTickets: mine, fileOwners: null, agent: ME });
  assert.equal(c.owned, true);
  assert.match(c.why, /title\/branch cites t\/357/);
});

test("someone else's PR that cites my ticket only in its body is NOT mine (the #4967 case)", () => {
  const c = claim({ refs: refsOf({ title: 't/238: Rate-limit cascade fixes', body: 'context: t/369 and t/357' }), myTickets: mine, fileOwners: ['me-id', 'me-id'], agent: ME });
  assert.equal(c.owned, false);
  assert.equal(c.needsFiles, false, 'a PR naming its own ticket never falls through to file ownership');
});

test('with no title/branch ticket, a body ref of mine claims it; a body ref of someone else excludes it', () => {
  assert.equal(claim({ refs: refsOf({ title: 'fix: x', body: 'Ticket: t/369' }), myTickets: mine, fileOwners: null, agent: ME }).owned, true);
  const other = claim({ refs: refsOf({ title: 'fix: x', body: 'Ticket: t/100' }), myTickets: mine, fileOwners: null, agent: ME });
  assert.deepEqual([other.owned, other.needsFiles], [false, false]);
});

test('no ticket ref at all: asks for files, then the strict majority owner decides', () => {
  const refs = refsOf({ title: 'chore(deps-dev): bump jsdom', branch: 'dependabot/npm_and_yarn/jsdom-31' });
  assert.equal(claim({ refs, myTickets: mine, fileOwners: null, agent: ME }).needsFiles, true);
  const yes = claim({ refs, myTickets: mine, fileOwners: ['me-id', 'me-id', 'other'], agent: ME });
  assert.deepEqual([yes.owned, yes.why], [true, 'no ticket ref; owns 2/3 changed files']);
  assert.equal(claim({ refs, myTickets: mine, fileOwners: ['me-id', 'other'], agent: ME }).owned, false, 'half is not a majority');
  assert.equal(claim({ refs, myTickets: mine, fileOwners: ['other', 'other', 'me-id'], agent: ME }).owned, false);
});

test('majorityOwner: unowned files count in the denominator; empty is null', () => {
  assert.deepEqual(majorityOwner(['a', null, 'a']), { owner: 'a', count: 2, of: 3 });
  assert.equal(majorityOwner(['a', null]), null);
  assert.equal(majorityOwner([]), null);
});

test('prStatus: failing checks, role blocks at any head, approvals only at head, hold labels', () => {
  const head = 'abc';
  const s = prStatus({
    headRefOid: head, isInMergeQueue: false,
    labels: { nodes: [{ name: 'consult-hold' }, { name: 'bug' }] },
    commits: { nodes: [{ commit: { committedDate: '2026-11-11T10:00:00Z', statusCheckRollup: { contexts: { nodes: [
      { __typename: 'CheckRun', name: 'render-smoke', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'ci-gate', status: 'QUEUED', conclusion: null },
      { __typename: 'StatusContext', context: 'legacy', state: 'ERROR' },
    ] } } } }] },
    reviews: { nodes: [
      { author: { login: 'ai-triad-reviewer-jpsnover' }, body: 'Changes requested (Design): fix contrast', state: 'COMMENTED', submittedAt: '2026-11-11T09:00:00Z', commit: { oid: 'old' } },
      { author: { login: 'ai-triad-reviewer-jpsnover' }, body: 'Approved (Quality): fine', state: 'APPROVED', submittedAt: '2026-11-11T11:00:00Z', commit: { oid: head } },
      { author: { login: 'ai-triad-reviewer-jpsnover' }, body: 'Approved (Tech Lead): ok', state: 'APPROVED', submittedAt: '2026-11-11T09:30:00Z', commit: { oid: 'old' } },
    ] },
    comments: { nodes: [] },
  });
  assert.deepEqual(s.failing, ['legacy', 'render-smoke']);
  assert.equal(s.pending, 1);
  assert.deepEqual(s.blocks, ['changes requested (Design)'], 'a changes-request is sticky across pushes');
  assert.deepEqual(s.approvals, ['Quality'], 'an approval at an old head does not count');
  assert.deepEqual(s.holds, ['consult-hold']);
  const text = formatPr({ number: 7, draft: false, sha: 'abcdef0123', title: 'x', why: 'title/branch cites t/369', status: s });
  assert.match(text, /^#7  ready  abcdef012  x$/m);
  assert.match(text, /checks: FAILING legacy, render-smoke \(1 pending\)/);
  assert.match(text, /reviews: changes requested \(Design\); label consult-hold; approved at head: Quality/);
});
