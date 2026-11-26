// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/751 + t/752 (t/739, second incident PR): a PR with no Tier line is T1 (with a checked Dependabot
// exemption), and the Design gate is one helper used by the sweeps, enqueue-pr and merge-approval.
// Each arm runs through the predicate AND the caller that matters: merge-approval, the guard, and
// enqueue-pr. Shapes replayed: #5599 (empty body, no reviews), #5578 (no tier line, Quality
// approved), #5598 (Quality only, a Design-path change), #5508 (Dependabot plus a heal commit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPENDABOT_COMMIT_AUTHORS, dependabotExemption, evaluateT1ApprovalGuard, isVersionSpec, packageJsonPatchOk, pnpmLockPatchOk, requirementsPatchOk,
} from './t1-approval-guard-predicate.mjs';
import { evaluateGroup, evaluatePullRequest, ruleDesignGate, ruleT1Approval } from './merge-approval-verdict.mjs';
import { designGateVerdict } from './design-gate.mjs';
import { isUserFacingPath } from './design-review-scope.mjs';
import { attributionComment, enqueuePR, postAttributionComment } from './enqueue-pr.mjs';
import { approvalFromApiVerdict } from './t1-approval-at-head.mjs';
import { classifyEnqueueFailure } from './dependabot-enqueue-sweep.mjs';
import { selectT0Candidates } from './t0-enqueue-sweep.mjs';
import { REVIEWER_APP_REST_LOGIN } from './gate-file-change.mjs';

const APP = REVIEWER_APP_REST_LOGIN;
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const FULL = 'AI-Rosetta-Stone/ai-triad-research';
const PUSH = '2026-11-26T10:00:00Z';
const BEFORE = '2026-11-26T09:00:00Z';
const AFTER = '2026-11-26T11:00:00Z';
const PUSH_MS = Date.parse(PUSH);

const botCommit = (over = {}) => ({
  sha: 'c'.repeat(40), author: { login: 'dependabot[bot]' }, committer: { login: 'web-flow' },
  commit: { verification: { verified: true, reason: 'valid' } }, ...over,
});
const healCommit = () => ({
  sha: 'd'.repeat(40), author: null, committer: null,
  commit: { author: { name: 'dependabot-heal[bot]' }, verification: { verified: false, reason: 'unsigned' } },
});
const humanCommit = (over = {}) => botCommit({ sha: 'e'.repeat(40), author: { login: 'jpsnover' }, committer: { login: 'jpsnover' }, ...over });
const BUMP_PATCH = '@@ -5,3 +5,3 @@\n   "dependencies": {\n-    "left-pad": "^1.0.0",\n+    "left-pad": "^1.0.1",\n   }';
const pkg = (filename, patch = BUMP_PATCH, over = {}) => ({ filename, status: 'modified', patch, ...over });
const INTEG1 = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const INTEG2 = 'sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==';
const lockPatch = (...changed) => ['@@ -10,8 +10,8 @@', ' packages:', ...changed, ' snapshots:'].join('\n');
const LOCK_PATCH = lockPatch(
  '-  left-pad@1.0.0:', '+  left-pad@1.0.1:',
  '-    resolution: {integrity: ' + INTEG1 + '}', '+    resolution: {integrity: ' + INTEG2 + '}',
  '-      specifier: ^1.0.0', '+      specifier: ^1.0.1', '-      version: 1.0.0', '+      version: 1.0.1');
const lock = (patch = LOCK_PATCH, over = {}) => ({ filename: 'pnpm-lock.yaml', status: 'modified', patch, ...over });
const REQ_PATCH = '@@ -1,3 +1,3 @@\n requests==2.0.0\n-flask==2.0.0\n+flask==2.0.1';
const req = (filename = 'scripts/requirements.txt', patch = REQ_PATCH, over = {}) => ({ filename, status: 'modified', patch, ...over });
const BUMP_FILES = [pkg('taxonomy-editor/package.json'), lock()];
const depFacts = (commits, over = {}) => ({
  authorLogin: 'dependabot[bot]', headRepo: FULL, baseRepo: FULL, commits, commitsTotal: commits?.length, files: BUMP_FILES, filesTotal: BUMP_FILES.length, ...over,
});

const review = ({ body = 'Approved (Quality): fine', commit = HEAD, at = AFTER, state = 'APPROVED', id = 1 } = {}) => ({
  id, user: { login: APP }, state, body, commit_id: commit, submitted_at: at, author_association: 'NONE',
});
const appComment = (body, at) => ({ user: { login: APP }, body, created_at: at, updated_at: at });

function mpr(over = {}) {
  return {
    number: 9, headSha: HEAD, body: 'Tier: T1\n\nfeature', headRefName: 'renderer/t1-x',
    files: [{ filename: 'docs/readme.md' }], filesTruncated: false, reviews: [], comments: [], labels: [],
    headPushedAtMs: PUSH_MS, ...over,
  };
}
const TIER_CONFIG = { r1Paths: [], r1Globs: [], schemaDirPrefixes: [] };

// ── t/751: the exemption predicate ────────────────────────────────────────────────────────────
test('t/751 exemption: a clean Dependabot PR (every commit verified, bot author, web-flow) is exempt', () => {
  const r = dependabotExemption(depFacts([botCommit()]));
  assert.equal(r.exempt, true);
  assert.equal(r.commitCount, 1);
  assert.deepEqual([...DEPENDABOT_COMMIT_AUTHORS], ['dependabot[bot]']);
});

test('t/751 exemption: none for a human-authored PR on a dependabot/ branch (the branch name is not the author)', () => {
  const r = dependabotExemption(depFacts([botCommit()], { authorLogin: 'jpsnover' }));
  assert.equal(r.exempt, false);
  assert.match(r.reason, /the PR author is `jpsnover`/);
});

test('t/751 exemption: none with one human commit, one unverified commit, or a lookalike author', () => {
  assert.match(dependabotExemption(depFacts([botCommit(), humanCommit()])).reason, /by `jpsnover`, not an allowlisted bot/);
  assert.match(dependabotExemption(depFacts([botCommit({ commit: { verification: { verified: false, reason: 'unsigned' } } })])).reason, /not verified \(unsigned\)/);
  assert.equal(dependabotExemption(depFacts([botCommit({ author: { login: 'dependabot-helper[bot]' } })])).exempt, false);
});

test('t/751 exemption: a verified commit AUTHORED as the bot but committed by a person is not exempt', () => {
  const r = dependabotExemption(depFacts([botCommit({ committer: { login: 'jpsnover' } })]));
  assert.equal(r.exempt, false);
  assert.match(r.reason, /committed by `jpsnover`, not GitHub's signer/);
});

test('t/751 exemption (#5508): a lockfile-healed PR is NOT exempt: the heal commit is unsigned with no login', () => {
  const r = dependabotExemption(depFacts([botCommit(), healCommit()]));
  assert.equal(r.exempt, false);
  assert.match(r.reason, /not verified \(unsigned\)/);
});

test('t/751 exemption fails closed: fork, empty, truncated, unreadable, no facts', () => {
  assert.equal(dependabotExemption(depFacts([botCommit()], { headRepo: 'someone/fork' })).exempt, false);
  assert.equal(dependabotExemption(depFacts([])).exempt, false);
  assert.equal(dependabotExemption(depFacts([botCommit()], { commitsTotal: 2 })).exempt, false);
  assert.equal(dependabotExemption(depFacts([botCommit()], { commitsTotal: 250 })).exempt, false);
  assert.equal(dependabotExemption(depFacts(null)).exempt, false);
  assert.equal(dependabotExemption(depFacts([botCommit()], { headRepo: null })).exempt, false);
  assert.equal(dependabotExemption(undefined).exempt, false);
});

// ── t/751: the guard ──────────────────────────────────────────────────────────────────────────
const guard = (over) => evaluateT1ApprovalGuard({
  body: '', headRefName: 'renderer/t1-x', headSha: HEAD, lastPushAt: '9999-12-31T23:59:59Z',
  approvalComments: [], botReviews: [], reviewerAppLogin: APP, ...over,
});
const botReview = (o = {}) => ({ state: 'APPROVED', submittedAt: AFTER, login: APP, body: 'Approved (Quality): ok', commitId: HEAD, ...o });

test('t/751 guard: #5599 shape (empty body, no reviews) is NOT a pass', () => {
  const r = guard({ body: '' });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no-post-push-approval');
  assert.match(r.tierNote, /^no Tier line: treated as T1/);
});

test('t/751 guard: a tier-less human PR passes only with a T1 reviewer approval at the head', () => {
  assert.equal(guard({ body: 'does a thing', botReviews: [botReview()] }).pass, true);
  assert.equal(guard({ body: 'does a thing', botReviews: [botReview({ body: 'Approved (Design): ok' })] }).pass, false);
});

test('t/751 guard: a clean Dependabot PR passes with no review; with a human commit it does not', () => {
  const ok = guard({ body: 'Bumps x from 1 to 2.', dependabot: depFacts([botCommit()]) });
  assert.equal(ok.pass, true);
  assert.equal(ok.reason, 'no-tier-dependabot-exempt');
  assert.equal(guard({ body: 'Bumps x.', dependabot: depFacts([botCommit(), humanCommit()]) }).pass, false);
});

test('t/751 guard: a declared T0 still passes; the exemption never applies to a declared tier', () => {
  assert.equal(guard({ body: 'Tier: T0\n' }).pass, true);
  assert.equal(guard({ body: 'Tier: T1\n', dependabot: depFacts([botCommit()]) }).pass, false);
});

// ── t/751: merge-approval rule B ──────────────────────────────────────────────────────────────
test('t/751 merge-approval: #5599 shape (empty body, zero reviews) is refused, and the text says why', () => {
  const r = ruleT1Approval(mpr({ body: '' }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /^no Tier line: treated as T1, no reviewer-App approval/);
});

test('t/751 merge-approval: #5578 shape (no Tier line, Quality approved at the head) passes, naming the review', () => {
  const r = ruleT1Approval(mpr({ body: 'mid-sentence body', reviews: [review({ id: 77 })] }));
  assert.equal(r.ok, true);
  assert.match(r.detail, /^no Tier line: treated as T1, approved by Quality \(review 77\)/);
});

test('t/751 merge-approval: a tier-less PR with only Design approval is refused', () => {
  assert.equal(ruleT1Approval(mpr({ body: '', reviews: [review({ body: 'Approved (Design): ok' })] })).ok, false);
});

test('t/751 merge-approval: a clean Dependabot PR passes with no review, text names the commit count', () => {
  const r = ruleT1Approval(mpr({ body: 'Bumps x.', headRefName: 'dependabot/npm_and_yarn/x', dependabot: depFacts([botCommit()]) }));
  assert.deepEqual(r, { ok: true, detail: 'no Tier line: Dependabot PR, exempt (1 verified commit)' });
});

test('t/751 merge-approval: a Dependabot PR with one human commit, or one unverified commit, is refused', () => {
  for (const commits of [[botCommit(), humanCommit()], [botCommit({ commit: { verification: { verified: false, reason: 'unsigned' } } })], [botCommit(), healCommit()]]) {
    const r = ruleT1Approval(mpr({ body: 'Bumps x.', headRefName: 'dependabot/npm_and_yarn/x', dependabot: depFacts(commits) }));
    assert.equal(r.ok, false);
    assert.match(r.detail, /no Tier line: treated as T1/);
  }
});

test('t/751 merge-approval: a human-authored PR on a dependabot/ branch gets no exemption', () => {
  const r = ruleT1Approval(mpr({ body: 'x', headRefName: 'dependabot/npm_and_yarn/x', dependabot: depFacts([botCommit()], { authorLogin: 'jpsnover' }) }));
  assert.equal(r.ok, false);
});

test('t/751 merge-approval: a Dependabot PR that was armed, then gained a non-bot commit at its head, is REFUSED in the merge group', () => {
  const clean = mpr({ number: 20, body: 'Bumps x.', headRefName: 'dependabot/npm_and_yarn/x', dependabot: depFacts([botCommit()]) });
  const pushed = { ...clean, dependabot: depFacts([botCommit(), humanCommit()]) };
  const scope = { ok: true, detail: 'installed' };
  assert.equal(evaluateGroup({ prs: [clean], tierConfig: TIER_CONFIG, scope }).conclusion, 'success');
  const v = evaluateGroup({ prs: [pushed], tierConfig: TIER_CONFIG, scope });
  assert.equal(v.conclusion, 'failure');
  assert.match(v.title, /BLOCKED #20 \(B\)/);
});

test('t/751 merge-approval: no Dependabot facts at all (an input the run could not read) never exempts', () => {
  assert.equal(ruleT1Approval(mpr({ body: 'Bumps x.' })).ok, false);
});

// ── t/751: enqueue-pr (approvalFromApiVerdict) ────────────────────────────────────────────────
const apiInputs = (over = {}) => ({
  pr: { body: '', head: { sha: HEAD, ref: 'renderer/x', repo: { full_name: FULL } }, base: { repo: { full_name: FULL } }, user: { login: 'jpsnover' }, commits: 1 },
  commits: [humanCommit()], comments: [], reviews: [], error: null, ...over,
});

test('t/751 enqueue-pr: no Tier line is refused outright, even with a Quality approval at the head', () => {
  const v = approvalFromApiVerdict({ tier: null, isDraft: false, headSha: HEAD, inputs: apiInputs({ reviews: [review()] }) });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'no_tier_line');
  assert.match(v.detail, /add `Tier: T0`, `T1` or `T2`/);
});

test('t/751 enqueue-pr: a clean Dependabot PR with no Tier line is allowed; with a human commit it is refused', () => {
  const dep = (commits) => apiInputs({
    pr: { body: 'Bumps x.', head: { sha: HEAD, ref: 'dependabot/x', repo: { full_name: FULL } }, base: { repo: { full_name: FULL } }, user: { login: 'dependabot[bot]' }, commits: commits.length, changed_files: 2 },
    commits, files: BUMP_FILES,
  });
  assert.equal(approvalFromApiVerdict({ tier: null, isDraft: false, headSha: HEAD, inputs: dep([botCommit()]) }).reason, 'dependabot_exempt');
  const refused = approvalFromApiVerdict({ tier: null, isDraft: false, headSha: HEAD, inputs: dep([botCommit(), humanCommit()]) });
  assert.equal(refused.allow, false);
  assert.equal(refused.reason, 'no_tier_line');
});

test('t/751 enqueue-pr: a declared tier is unaffected (T0 allowed; T1 with no approval still refused)', () => {
  assert.equal(approvalFromApiVerdict({ tier: 'T0', isDraft: false, headSha: HEAD, inputs: null }).allow, true);
  assert.equal(approvalFromApiVerdict({ tier: 'T1', isDraft: false, headSha: HEAD, inputs: apiInputs({ pr: { ...apiInputs().pr, body: 'Tier: T1' } }) }).reason, 'no_approval');
});

test('t/751 sweep: the Dependabot sweep reads enqueue-pr refusals no_tier_line and design_gate as policy (left unarmed, never retried)', () => {
  for (const reason of ['no_tier_line', 'design_gate']) {
    const err = new Error(`enqueue-pr: refusing to arm/enqueue #5 on o/r (${reason}).\n  Goal: x`);
    assert.deepEqual(classifyEnqueueFailure(err), { kind: 'policy', reason });
  }
});

// ── t/752: the path list ──────────────────────────────────────────────────────────────────────
test('t/752 paths: Design\'s gated list is user-facing, outside the renderer too', () => {
  for (const p of [
    'lib/debate/prompts.ts', 'lib/debate/prompts/synthesis.ts', 'lib/debate/argumentNetwork/prompts.ts', 'lib/debate/entrySummaries.ts',
    'lib/debate/factCheckFinding.ts', 'lib/debate/factCheckValidator.ts', 'lib/debate/synthesisOrder.ts', 'lib/debate/synthesisPipeline.ts',
    'lib/debate/synthesisPhases.ts', 'lib/debate/inquirySynthesis.ts', 'lib/debate/explorationSummary.ts', 'lib/debate/debateExport.ts',
    'lib/debate/formatters.ts', 'lib/debate/types/synthesis.ts',
    'taxonomy-editor/src/renderer/hooks/useDebateStore/shared/factCheckFormat.ts',
    'taxonomy-editor/src/renderer/hooks/useDebateStore/shared/prompts.ts',
    'taxonomy-editor/src/renderer/components/x/Thing.tsx',
  ]) assert.equal(isUserFacingPath(p), true, p);
});

test('t/752 paths: tests, generated files, exp-* results and context builders are exempt; unrelated files are not gated', () => {
  for (const p of [
    'lib/debate/synthesisOrder.test.ts', 'lib/debate/prompts/synthesis.test.ts', 'lib/debate/prompts/foo.generated.ts',
    'lib/debate/prompts/exp-1438-results/x.ts', 'lib/debate/prompts/context.ts', 'lib/debate/prompts/taxonomyContext.ts',
    'lib/debate/prompts/vocabularyContext.ts', 'lib/debate/prompts/embedTexts.ts',
    'lib/debate/exp-1069-batch.json', 'lib/debate/aiAdapter.ts', 'lib/debate/debateEngine/context.ts', 'operations/devops/enqueue-pr.mjs',
    'lib/debate/__tests__/synthesisOrder.ts',
  ]) assert.equal(isUserFacingPath(p), false, p);
});

// ── t/752: the helper's arms, once ────────────────────────────────────────────────────────────
const DESIGN_FILE = 'lib/debate/synthesisOrder.ts';
const gate = (over = {}) => designGateVerdict({
  files: [DESIGN_FILE], reviews: [], comments: [], reviewerAppLogin: APP, headSha: HEAD, pushedAtMs: PUSH_MS, ...over,
});
const rv = (body, o = {}) => ({ login: APP, state: 'APPROVED', body, commitId: HEAD, submittedAt: AFTER, ...o });
const cm = (body, at) => ({ login: APP, body, createdAt: at, updatedAt: at });

test('t/752 helper: not user-facing -> does not apply and passes; unreadable or truncated list applies and fails', () => {
  assert.deepEqual({ applies: gate({ files: ['docs/a.md'] }).applies, pass: gate({ files: ['docs/a.md'] }).pass }, { applies: false, pass: true });
  assert.equal(gate({ files: null }).pass, false);
  assert.equal(gate({ files: ['docs/a.md'], filesTruncated: true }).pass, false);
});

test('t/752 helper: Design review at the head passes; at an old head, none, or Quality only does not', () => {
  assert.equal(gate({ reviews: [rv('Approved (Design): ok')] }).pass, true);
  assert.equal(gate({ reviews: [rv('Approved (Design): ok', { commitId: OLD })] }).pass, false);
  assert.equal(gate({ reviews: [rv('Approved (Quality): ok')] }).pass, false);
  assert.match(gate().reason, /no Design verdict/);
});

test('t/752 helper: a Design comment counts only when after the head\'s push', () => {
  assert.equal(gate({ comments: [cm('Approved (Design): ok', BEFORE)] }).pass, false);
  assert.equal(gate({ comments: [cm('Approved (Design): ok', AFTER)] }).pass, true);
  // push time unknown: no comment counts, a head-bound review still does
  assert.equal(gate({ pushedAtMs: null, comments: [cm('Approved (Design): ok', AFTER)] }).pass, false);
  assert.equal(gate({ pushedAtMs: null, reviews: [rv('Approved (Design): ok')] }).pass, true);
});

test('t/752 helper: Design-exempt needs a reason; with one it passes', () => {
  assert.equal(gate({ reviews: [rv('Design-exempt (Design):')] }).pass, false);
  const ok = gate({ reviews: [rv('Design-exempt (Design): logic only, no string changes')] });
  assert.equal(ok.pass, true);
  assert.equal(ok.kind, 'exempt');
});

test('t/752 helper: a later Design changes-request blocks; a dismissed approval counts for nothing', () => {
  const reviews = [rv('Approved (Design): ok', { submittedAt: AFTER }), rv('Changes requested (Design): no', { state: 'CHANGES_REQUESTED', submittedAt: '2026-11-26T12:00:00Z' })];
  assert.equal(gate({ reviews }).pass, false);
  assert.equal(gate({ reviews: [rv('Approved (Design): ok', { state: 'DISMISSED' })] }).pass, false);
});

test('t/752 helper: the role is matched however it is spelled in case', () => {
  assert.equal(gate({ reviews: [rv('Approved (design): ok')] }).pass, true);
});

// ── t/752: merge-approval rule D (#5598 shape) ───────────────────────────────────────────────
test('t/752 merge-approval: #5598 shape (Quality only, a Design-path change) is REFUSED at T1, T2 and T0', () => {
  for (const body of ['Tier: T1\n', 'Tier: T2\n', 'Tier: T0\n']) {
    const pr = mpr({ body, files: [{ filename: DESIGN_FILE }], reviews: [review({ body: 'Approved (Quality): ok' })] });
    const r = evaluatePullRequest(pr, { tierConfig: TIER_CONFIG });
    assert.match(r.lines.join('\n'), /D design-gate: FAIL/, body);
    assert.equal(r.ok, false, body);
  }
});

test('t/752 merge-approval: the same PR with Quality and a Design review at the head passes every rule', () => {
  const pr = mpr({
    files: [{ filename: DESIGN_FILE }],
    reviews: [review({ body: 'Approved (Quality): ok' }), review({ body: 'Approved (Design): ok', id: 2 })],
  });
  const r = evaluatePullRequest(pr, { tierConfig: TIER_CONFIG });
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /D design-gate: PASS, user-facing \(lib\/debate\/synthesisOrder.ts\); Design approved/);
});

test('t/752 merge-approval: Design\'s approval alone is not a T1 review (rule B) and Quality\'s is not Design\'s (rule D)', () => {
  const designOnly = evaluatePullRequest(mpr({ files: [{ filename: DESIGN_FILE }], reviews: [review({ body: 'Approved (Design): ok' })] }), { tierConfig: TIER_CONFIG });
  assert.deepEqual(designOnly.failed, ['B']);
});

test('t/752 merge-approval: a renamed-away user-facing file and a cut-short file list both count', () => {
  assert.equal(ruleDesignGate(mpr({ files: [{ filename: 'docs/new.md', previous_filename: DESIGN_FILE }] })).ok, false);
  assert.equal(ruleDesignGate(mpr({ filesTruncated: true })).ok, false);
});

test('t/752 merge-approval: a Design comment before the push is refused, after the push is accepted (parity with the sweep)', () => {
  const files = [{ filename: DESIGN_FILE }];
  assert.equal(ruleDesignGate(mpr({ files, comments: [appComment('Approved (Design): ok', BEFORE)] })).ok, false);
  assert.equal(ruleDesignGate(mpr({ files, comments: [appComment('Approved (Design): ok', AFTER)] })).ok, true);
  assert.equal(ruleDesignGate(mpr({ files, headPushedAtMs: undefined, comments: [appComment('Approved (Design): ok', AFTER)] })).ok, false);
});

test('t/752 merge-approval: Design-exempt with an empty reason is refused', () => {
  assert.equal(ruleDesignGate(mpr({ files: [{ filename: DESIGN_FILE }], reviews: [review({ body: 'Design-exempt (Design):' })] })).ok, false);
});

// ── t/752: parity, the sweep and merge-approval and enqueue-pr give one verdict ───────────────
const PARITY_CASES = [
  { name: 'no verdict', reviews: [], comments: [], want: false },
  { name: 'Design review at head', reviews: [review({ body: 'Approved (Design): ok' })], comments: [], want: true },
  { name: 'Design review at an old head', reviews: [review({ body: 'Approved (Design): ok', commit: OLD })], comments: [], want: false },
  { name: 'Quality review only', reviews: [review({ body: 'Approved (Quality): ok' })], comments: [], want: false },
  { name: 'Design comment before the push', reviews: [], comments: [appComment('Approved (Design): ok', BEFORE)], want: false },
  { name: 'Design comment after the push', reviews: [], comments: [appComment('Approved (Design): ok', AFTER)], want: true },
  { name: 'Design-exempt with a reason', reviews: [review({ body: 'Design-exempt (Design): logic only' })], comments: [], want: true },
  { name: 'Design-exempt, empty reason', reviews: [review({ body: 'Design-exempt (Design):' })], comments: [], want: false },
  { name: 'Design changes requested after approval', reviews: [review({ body: 'Approved (Design): ok', at: AFTER }), review({ body: 'Changes requested (Design): no', state: 'CHANGES_REQUESTED', at: '2026-11-26T12:00:00Z', id: 2 })], comments: [], want: false },
];

// The sweep's shapes: reviews/comments in the predicate shape, contexts carry the push time.
const GQL_APP = 'ai-triad-reviewer-jpsnover'; // GraphQL login: no [bot] suffix
const sweepPr = (c) => ({
  number: 1, body: 'Tier: T0\n\nx', headRefOid: HEAD, baseRefName: 'main', isDraft: false, isInMergeQueue: false, mergeStateStatus: 'BLOCKED',
  author: 'jpsnover', labels: [], isCrossRepository: false, autoMergeRequest: null, files: [DESIGN_FILE],
  contexts: ['ci-gate', 'CodeQL Analysis', 'joint-gv-guard', 'consult-hold-guard'].map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: PUSH })),
  reviews: c.reviews.map((r) => ({ login: GQL_APP, state: r.state, body: r.body, commitId: r.commit_id, submittedAt: r.submitted_at })),
  comments: c.comments.map((m) => ({ login: GQL_APP, body: m.body, createdAt: m.created_at, updatedAt: m.updated_at })),
});

for (const c of PARITY_CASES) {
  test(`t/752 parity: ${c.name} -> the sweep, merge-approval and the helper agree (${c.want ? 'passes' : 'refused'})`, () => {
    const NOW = Date.parse('2026-11-26T13:00:00Z');
    const { enqueue } = selectT0Candidates([sweepPr(c)], NOW);
    const sweepRefuses = enqueue.length === 0; // skipped: awaiting the Design gate, or Design's own changes-request
    const merge = ruleDesignGate(mpr({ files: [{ filename: DESIGN_FILE }], reviews: c.reviews, comments: c.comments }));
    const helper = designGateVerdict({
      files: [DESIGN_FILE], reviewerAppLogin: GQL_APP, headSha: HEAD, pushedAtMs: PUSH_MS,
      reviews: sweepPr(c).reviews, comments: sweepPr(c).comments,
    });
    assert.equal(!sweepRefuses, c.want, 'sweep');
    assert.equal(merge.ok, c.want, `merge-approval: ${merge.detail}`);
    assert.equal(helper.pass, c.want, 'helper');
  });
}

// ── enqueue-pr: the Design gate and the attribution comment, through the real enqueuePR ───────
const CURRENT = () => ({ ok: true, reason: 'current', mainSha: 'f'.repeat(40), paths: [] });
const VEHICLE_OK = async () => ({ allow: true, reason: 'train', vehicle: { kind: 'train' } });

function enqueueFake({ body, files, reviews = [], comments = [], commits = [humanCommit()], prAuthor = 'jpsnover', ref = 'renderer/t1-x', checkRuns = [{ started_at: PUSH }], commentFails = false }) {
  const calls = [];
  let graphql = 0;
  const fn = (args) => {
    calls.push(args);
    const joined = args.join(' ');
    const last = args[args.length - 1];
    if (joined.includes('{changed_files}')) return JSON.stringify({ changed_files: files.length });
    if (joined.includes('/files?per_page=100') && args.includes('--slurp')) return JSON.stringify([files.map((x) => (x === 'package.json' ? pkg(x) : { filename: x }))]); // t/776
    if (joined.includes('/files?per_page=100')) return files.map((f) => JSON.stringify([f, ''])).join('\n');
    if (joined.includes('pr view') && joined.includes('headRefOid,body,isDraft')) return JSON.stringify({ headRefOid: HEAD, body, isDraft: false, labels: [] });
    if (args.includes('--slurp')) {
      if (/\/pulls\/\d+\/commits\?/.test(last)) return JSON.stringify([commits]);
      if (/\/issues\/\d+\/comments\?/.test(last)) return JSON.stringify([comments]);
      if (/\/pulls\/\d+\/reviews\?/.test(last)) return JSON.stringify([reviews]);
      if (/check-runs/.test(last)) return JSON.stringify([{ check_runs: checkRuns }]);
    }
    if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(last)) {
      return JSON.stringify({ body, head: { sha: HEAD, ref, repo: { full_name: FULL } }, base: { repo: { full_name: FULL } }, user: { login: prAuthor }, commits: commits.length, changed_files: files.length });
    }
    if (joined.includes('check_name=tier-check')) return JSON.stringify({ check_runs: [] });
    if (args[0] === 'pr' && args[1] === 'comment') { if (commentFails) throw new Error('gh: HTTP 403'); return ''; }
    if (joined.includes('graphql')) {
      graphql += 1;
      const queued = graphql > 1;
      return JSON.stringify({ data: { repository: { pullRequest: {
        state: 'OPEN', mergedAt: null, mergeCommit: null, isInMergeQueue: queued, mergeQueueEntry: queued ? { position: 1, state: 'QUEUED' } : null,
        headRefOid: HEAD, mergeStateStatus: 'CLEAN', autoMergeRequest: null } } } });
    }
    if (args[0] === 'pr' && args[1] === 'merge') return 'ok';
    throw new Error(`unexpected gh call: ${joined}`);
  };
  fn.calls = calls;
  return fn;
}
const run = (gh, opts = {}) => enqueuePR('o/r', 42, { sleepMs: 0, currency: CURRENT, vehicle: VEHICLE_OK, gh, ...opts });
const merges = (gh) => gh.calls.filter((a) => a[0] === 'pr' && a[1] === 'merge').length;

test('t/751 enqueue-pr (#5599 shape): an empty-body PR with no reviews is refused and nothing is armed', async () => {
  const gh = enqueueFake({ body: '', files: ['docs/a.md'] });
  await assert.rejects(() => run(gh), /\(no_tier_line\)/);
  assert.equal(merges(gh), 0);
});

test('t/751 enqueue-pr (#5578 shape): a tier-less PR is refused even with Quality\'s approval at the head', async () => {
  const gh = enqueueFake({ body: 'mid-sentence', files: ['docs/a.md'], reviews: [review()] });
  await assert.rejects(() => run(gh), /\(no_tier_line\)/);
  assert.equal(merges(gh), 0);
});

test('t/751 enqueue-pr: a clean Dependabot PR is enqueued; the same PR with a human commit is refused', async () => {
  const dep = { body: 'Bumps x.', files: ['package.json'], prAuthor: 'dependabot[bot]', ref: 'dependabot/npm_and_yarn/x' };
  const ok = enqueueFake({ ...dep, commits: [botCommit()] });
  assert.equal((await run(ok)).state, 'queued');
  assert.equal(merges(ok), 1);
  const bad = enqueueFake({ ...dep, commits: [botCommit(), humanCommit()] });
  await assert.rejects(() => run(bad), /\(no_tier_line\)/);
  assert.equal(merges(bad), 0);
});

test('t/752 enqueue-pr (#5598 shape): a T1 Design-path change with Quality only is refused (design_gate), T0 too', async () => {
  for (const body of ['Tier: T1\n\nx', 'Tier: T0\n\nx']) {
    const gh = enqueueFake({ body, files: [DESIGN_FILE], reviews: [review({ body: 'Approved (Quality): ok' })] });
    await assert.rejects(() => run(gh), /\(design_gate\)/, body);
    assert.equal(merges(gh), 0, body);
  }
});

test('t/752 enqueue-pr: with a Design review at the head it is enqueued; a Design comment before the push is not enough', async () => {
  const ok = enqueueFake({ body: 'Tier: T1\n\nx', files: [DESIGN_FILE], reviews: [review({ body: 'Approved (Quality): ok' }), review({ body: 'Approved (Design): ok', id: 2 })] });
  assert.equal((await run(ok)).state, 'queued');
  const stale = enqueueFake({ body: 'Tier: T0\n\nx', files: [DESIGN_FILE], comments: [appComment('Approved (Design): ok', BEFORE)] });
  await assert.rejects(() => run(stale), /\(design_gate\)/);
  const fresh = enqueueFake({ body: 'Tier: T0\n\nx', files: [DESIGN_FILE], comments: [appComment('Approved (Design): ok', AFTER)] });
  assert.equal((await run(fresh)).state, 'queued');
});

test('t/752 enqueue-pr: a PR with no user-facing file reads no Design inputs and is not gated', async () => {
  const gh = enqueueFake({ body: 'Tier: T0\n\nx', files: ['docs/a.md'] });
  assert.equal((await run(gh)).state, 'queued');
  assert.equal(gh.calls.filter((a) => a.join(' ').includes('/check-runs?per_page=100')).length, 0);
});

test('t/752 enqueue-pr: unreadable Design inputs refuse (fail closed)', async () => {
  const gh = enqueueFake({ body: 'Tier: T0\n\nx', files: [DESIGN_FILE] });
  const flaky = (args) => { if (args.join(' ').includes('/check-runs?per_page=100')) throw new Error('gh: HTTP 502'); return gh(args); };
  flaky.calls = gh.calls;
  await assert.rejects(() => run(flaky), /\(design_gate\)[\s\S]*could not be read/);
  assert.equal(merges(gh), 0);
});

// ── enqueue-pr: the --by attribution comment ──────────────────────────────────────────────────
test('t/739 enqueue-pr --by: posts one comment on the PR naming who ran it, after the arm is read back', async () => {
  const gh = enqueueFake({ body: 'Tier: T0\n\nx', files: ['docs/a.md'] });
  await run(gh, { by: 'd6bbb177-724b-466d-8382-67dd16bb3bb9' });
  const posted = gh.calls.filter((a) => a[0] === 'pr' && a[1] === 'comment');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].slice(0, 5), ['pr', 'comment', '42', '-R', 'o/r']);
  assert.match(posted[0][6], /^enqueue-pr: run by d6bbb177-724b-466d-8382-67dd16bb3bb9 at \d{4}-\d\d-\d\dT[\d:.]+Z on head aaaaaaaaa \(queued\)\.$/);
  const order = gh.calls.map((a) => (a[0] === 'pr' ? a[1] : a[0]));
  assert.ok(order.lastIndexOf('comment') > order.lastIndexOf('merge'), 'the comment follows the arm');
});

test('t/739 enqueue-pr: without --by no comment is posted (the sweeps run as the bot)', async () => {
  const gh = enqueueFake({ body: 'Tier: T0\n\nx', files: ['docs/a.md'] });
  await run(gh);
  assert.equal(gh.calls.filter((a) => a[0] === 'pr' && a[1] === 'comment').length, 0);
});

test('t/739 enqueue-pr --by: a refused enqueue posts nothing; a failing comment WARNs and never undoes the enqueue', async () => {
  const refused = enqueueFake({ body: '', files: ['docs/a.md'] });
  await assert.rejects(() => run(refused, { by: 'x' }), /no_tier_line/);
  assert.equal(refused.calls.filter((a) => a[1] === 'comment').length, 0);
  const failing = enqueueFake({ body: 'Tier: T0\n\nx', files: ['docs/a.md'], commentFails: true });
  assert.equal((await run(failing, { by: 'x' })).state, 'queued');
});

test('t/739 attributionComment: null without --by, one line with it', () => {
  assert.equal(attributionComment({ by: '  ', headSha: HEAD, state: 'queued' }), null);
  assert.equal(attributionComment({ by: null, headSha: HEAD, state: 'queued' }), null);
  assert.equal(postAttributionComment('o/r', 1, { by: null, headSha: HEAD, state: 'queued' }, () => { throw new Error('must not be called'); }), false);
  assert.ok(!attributionComment({ by: 'abc', headSha: HEAD, state: 'queued', at: 'T' }).includes('\n'));
});

// ── t/776: the exemption also needs every changed path to be a manifest or lockfile ──

test('t/776 exemption: a forged-author verified commit that touches source is not exempt', () => {
  const r = dependabotExemption(depFacts([botCommit()], { files: [pkg('package.json'), { filename: 'taxonomy-editor/src/server/authGates.ts' }], filesTotal: 2 }));
  assert.equal(r.exempt, false);
  assert.match(r.reason, /authGates.ts.*not a package manifest or lockfile/);
});

test('t/776 exemption: a manifest-and-lockfile-only PR still passes (npm and pip)', () => {
  assert.equal(dependabotExemption(depFacts([botCommit()])).exempt, true);
  const pip = { files: [req('scripts/requirements.txt'), req('scripts/requirements-dev.txt')], filesTotal: 2 };
  assert.equal(dependabotExemption(depFacts([botCommit()], pip)).exempt, true);
});

test('t/776 exemption: a Dockerfile, a workflow, a rename out of a manifest, or a traversal path is not exempt', () => {
  for (const files of [
    [{ filename: 'taxonomy-editor/Dockerfile' }],
    [{ filename: '.github/workflows/ci.yml' }],
    [pkg('package.json', BUMP_PATCH, { previous_filename: 'lib/evil.mjs' })],
    [{ filename: '../package.json' }],
    [{ filename: '/package.json' }],
    [{ filename: 'package.json.bak' }],
  ]) {
    assert.equal(dependabotExemption(depFacts([botCommit()], { files, filesTotal: files.length })).exempt, false, JSON.stringify(files));
  }
});

test('t/776 exemption: an unreadable, empty or cut-short file list fails closed', () => {
  assert.equal(dependabotExemption(depFacts([botCommit()], { files: undefined })).exempt, false);
  assert.equal(dependabotExemption(depFacts([botCommit()], { files: [] , filesTotal: 0 })).exempt, false);
  assert.equal(dependabotExemption(depFacts([botCommit()], { filesTotal: 3 })).exempt, false);
  assert.equal(dependabotExemption(depFacts([botCommit()], { filesTotal: undefined })).exempt, false);
  const many = Array.from({ length: 3000 }, (_, i) => ({ filename: `p${i}/package.json` }));
  assert.equal(dependabotExemption(depFacts([botCommit()], { files: many, filesTotal: 3000 })).exempt, false);
});

// ── t/776 (Security p/131#99): package.json content check ──

const patchOf = (removed, added) => ['@@ -5,3 +5,3 @@', ...removed.map((l) => `-    ${l}`), ...added.map((l) => `+    ${l}`)].join('\n');
const exemptWith = (file) => dependabotExemption(depFacts([botCommit()], { files: [file], filesTotal: 1 }));

test('t/776 package.json: version-only changes pass (caret, tilde, range, prerelease), at the root and taxonomy-editor', () => {
  for (const [a, b] of [['"x": "^1.0.0",', '"x": "^1.0.1",'], ['"x": "~2.3.4"', '"x": "~2.3.5"'], ['"x": ">=1 <2"', '"x": ">=1 <3"'], ['"x": "1.2.3-beta.1"', '"x": "1.2.3"'], ['"version": "1.0.0",', '"version": "1.0.1",']]) {
    for (const path of ['package.json', 'taxonomy-editor/package.json']) {
      assert.equal(exemptWith(pkg(path, patchOf([a], [b]))).exempt, true, `${path} ${a}`);
    }
  }
});

test('t/776 package.json: a scripts edit is refused (a script body is not a version spec)', () => {
  const r = exemptWith(pkg('package.json', patchOf(['"build": "tsc",'], ['"build": "node evil.js",'])));
  assert.equal(r.exempt, false);
  assert.match(r.reason, /not a version spec/);
  assert.equal(exemptWith(pkg('package.json', patchOf(['"postinstall": "1.0.0"'], ['"postinstall": "1.0.1"']))).exempt, true, 'a version-shaped value is harmless whatever the key');
  assert.equal(exemptWith(pkg('package.json', patchOf(['"scripts": "1.0.0"'], ['"scripts": "1.0.1"']))).exempt, false, 'the scripts key itself');
});

test('t/776 package.json: an added dependency (or script) is refused; so is a removed one or a changed key name', () => {
  assert.match(exemptWith(pkg('package.json', patchOf([], ['"evil-pkg": "^1.0.0",']))).reason, /adds or removes a key/);
  assert.equal(exemptWith(pkg('package.json', patchOf(['"x": "^1.0.0",'], []))).exempt, false);
  assert.equal(exemptWith(pkg('package.json', patchOf(['"x": "^1.0.0",'], ['"evil": "^1.0.0",']))).exempt, false);
  assert.equal(exemptWith(pkg('package.json', patchOf(['"x": "^1.0.0"'], ['"x": "^1.0.1",', '"y": "^1.0.0"']))).exempt, false);
});

test('t/776 package.json: a nested package.json outside the root and taxonomy-editor is refused, even with a clean patch', () => {
  for (const path of ['operations/devops/package.json', '.github/package.json', 'lib/debate/package.json', 'taxonomy-editor/src/package.json']) {
    assert.equal(exemptWith(pkg(path)).exempt, false, path);
  }
});

test('t/776 package.json: no patch, a non-modified status, or a non-pair line fails closed', () => {
  assert.equal(exemptWith(pkg('package.json', undefined, { patch: undefined })).exempt, false);
  assert.equal(exemptWith(pkg('package.json', '')).exempt, false);
  assert.equal(exemptWith(pkg('package.json', BUMP_PATCH, { status: 'added' })).exempt, false);
  assert.equal(exemptWith(pkg('package.json', BUMP_PATCH, { status: 'renamed' })).exempt, false);
  assert.equal(exemptWith(pkg('package.json', patchOf(['"a": {'], ['"a": {', '"evil": "1.0.0"']))).exempt, false);
});

// ── t/776 (CodeQL js/redos on the first VERSION_SPEC): the check is linear, and a forged patch cannot stall the guard ──

test('t/776 isVersionSpec: the accepted and refused shapes', () => {
  for (const ok of ['^1.2.3', '~1.2', '>=1 <2', '>=1.0.0 <2.0.0', '1.2.3-beta.1', '1.2.3 - 2.0.0', '1.x || 2.x', '^1.0.0 || ^2.0.0', 'v1.2.3', '0.0.0-0']) {
    assert.equal(isVersionSpec(ok), true, ok);
  }
  for (const bad of ['', ' ', 'tsc', 'node evil.js', 'file:../x', 'https://x/y.tgz', 'git+ssh://x', '^', '||', '1 ||', '|| 1', 'latest', '*']) {
    assert.equal(isVersionSpec(bad), false, JSON.stringify(bad));
  }
  assert.equal(isVersionSpec(undefined), false);
  // t/796 (SO): a bare `-` is valid only between two version tokens.
  for (const bad of ['-', '1.0.0 -', '- 1.0.0', '1.0.0 - - 2.0.0', '1.0.0 - || 2.0.0', '- || 1', '1 || -']) {
    assert.equal(isVersionSpec(bad), false, JSON.stringify(bad));
  }
  assert.equal(isVersionSpec('1.0.0 - 2.0.0'), true);
  assert.equal(isVersionSpec('1.0.0 - 2.0.0 || 3.0.0 - 4.0.0'), true);
  assert.equal(isVersionSpec('1'.repeat(201)), false, 'over the length cap');
  assert.equal(isVersionSpec('1'.repeat(200)), true, 'at the length cap');
});

test('t/776 isVersionSpec: 5000-char adversarial strings (the CodeQL shapes) return in under 50 ms, refused by the length cap', () => {
  const shapes = ['0' + '-0'.repeat(2500), '0 <0' + '-0 <0'.repeat(1000), '0' + ' -0'.repeat(1700), '0' + '||0'.repeat(1700), ' '.repeat(5000) + '0', '0' + '-'.repeat(5000) + '!'];
  for (const s of shapes) {
    const t0 = process.hrtime.bigint();
    const r = isVersionSpec(s);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r, false, `${s.slice(0, 20)}... (${s.length} chars) is refused`);
    assert.ok(ms < 50, `${s.slice(0, 20)}... took ${ms} ms`);
  }
});

test('t/776 isVersionSpec: adversarial strings just under the cap are linear too', () => {
  for (const s of ['0' + '-0'.repeat(99), '0 <0' + '-0 <0'.repeat(39) + '!', '0' + '-'.repeat(190) + '!']) {
    const t0 = process.hrtime.bigint();
    isVersionSpec(s);
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 50, s.slice(0, 20));
  }
});

test('t/776 packageJsonPatchOk: adversarial patch lines are decided in under 50 ms (long version values and a trailing run refused; a long indentation is just indentation)', () => {
  const lines = ['  "x": "' + '0' + '-0'.repeat(2500) + '",', '  "x": "' + '0 <0' + '-0 <0'.repeat(1000) + '",', ' '.repeat(5000) + '"x": "1.0.0"', '  "x": "1.0.0"' + ' '.repeat(5000) + '!'];
  for (const l of lines) {
    const t0 = process.hrtime.bigint();
    const r = packageJsonPatchOk({ status: 'modified', patch: `@@ -1 +1 @@\n-${l}\n+${l}` });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.ok, l.startsWith(' '.repeat(5000)), `${l.slice(0, 20)}...`);
    assert.ok(ms < 50, `${l.slice(0, 20)}... took ${ms} ms`);
  }
});

// ── t/796: pnpm-lock.yaml and requirements*.txt content checks ──

const exemptFile = (file) => dependabotExemption(depFacts([botCommit()], { files: [file], filesTotal: 1 }));

test('t/796 pnpm-lock: a version bump of an existing package passes (header, integrity, specifier, version, a registry tarball)', () => {
  assert.equal(exemptFile(lock()).exempt, true);
  const tarball = lockPatch('-  left-pad@1.0.0:', '+  left-pad@1.0.1:', '+    resolution: {integrity: ' + INTEG2 + ', tarball: https://registry.npmjs.org/left-pad/-/left-pad-1.0.1.tgz}');
  assert.equal(exemptFile(lock(tarball)).exempt, true);
  const scoped = lockPatch("-  '@babel/core@7.0.0':", "+  '@babel/core@7.0.1':", '-      ms: 2.1.2', '+      ms: 2.1.3', "-  'react-dom@18.2.0(react@18.2.0)':", "+  'react-dom@18.2.1(react@18.2.1)':");
  assert.equal(exemptFile(lock(scoped)).exempt, true, 'scoped names, snapshot dependency lines and peer-suffixed headers are version changes of existing names');
});

test('t/796 pnpm-lock: a resolution re-pointed to another host, a git or directory resolution, or one with no integrity is refused', () => {
  for (const bad of [
    '+    resolution: {integrity: ' + INTEG2 + ', tarball: https://evil.example/left-pad-1.0.1.tgz}',
    '+    resolution: {integrity: ' + INTEG2 + ', tarball: http://registry.npmjs.org/left-pad/-/left-pad-1.0.1.tgz}',
    '+    resolution: {integrity: ' + INTEG2 + ', tarball: https://registry.npmjs.org.evil.example/x.tgz}',
    '+    resolution: {tarball: https://registry.npmjs.org/left-pad/-/left-pad-1.0.1.tgz}',
    '+    resolution: {type: git, repo: https://github.com/x/y, commit: abcdef}',
    '+    resolution: {directory: ../local, type: directory}',
    '+    resolution: {integrity: not-a-hash}',
  ]) {
    const r = exemptFile(lock(lockPatch('-  left-pad@1.0.0:', '+  left-pad@1.0.1:', bad)));
    assert.equal(r.exempt, false, bad);
    assert.match(r.reason, /resolution/, bad);
  }
});

test('t/796 pnpm-lock: an added package, and a version that points off the registry, are refused', () => {
  assert.match(exemptFile(lock(lockPatch('+  evil-pkg@1.0.0:', '+    resolution: {integrity: ' + INTEG2 + '}'))).reason, /adds the package `evil-pkg`/);
  assert.equal(exemptFile(lock(lockPatch('-  left-pad@1.0.0:', '+  left-pad@1.0.1:', '+      version: link:../evil'))).exempt, false);
  assert.equal(exemptFile(lock(lockPatch('-  left-pad@1.0.0:', '+  left-pad@1.0.1:', '+      version: github:x/y'))).exempt, false);
  assert.equal(exemptFile(lock(lockPatch('-  left-pad@1.0.0:', '+  left-pad@1.0.1:', '+    hooks: {postinstall: node evil.js}'))).exempt, false, 'an unknown key is refused');
  assert.equal(exemptFile(lock(lockPatch('+  lockfileVersion: 9.0'))).exempt, false);
});

test('t/796 pnpm-lock: no patch, a non-modified status, an empty patch or an over-long line fails closed', () => {
  assert.equal(exemptFile(lock(undefined, { patch: undefined })).exempt, false);
  assert.equal(exemptFile(lock('')).exempt, false);
  assert.equal(exemptFile(lock(LOCK_PATCH, { status: 'added' })).exempt, false);
  assert.equal(exemptFile(lock('@@ -1 +1 @@\n context only')).exempt, false);
  assert.equal(exemptFile(lock(lockPatch('-  left-pad@1.0.0:', '+  left-pad@1.0.1:', '+    deprecated: ' + 'x'.repeat(700)))).exempt, false);
});

test('t/796 requirements: a pin bump of an existing name passes, with hash lines', () => {
  assert.equal(exemptFile(req()).exempt, true);
  const hashed = '@@ -1,4 +1,4 @@\n-flask==2.0.0 \\\n-    --hash=sha256:' + 'a'.repeat(64) + '\n+flask==2.0.1 \\\n+    --hash=sha256:' + 'b'.repeat(64);
  assert.equal(exemptFile(req('scripts/requirements.txt', hashed)).exempt, true);
});

test('t/796 requirements: an index URL, a URL or VCS requirement, a new name, and an unpinned line are refused', () => {
  for (const [name, patch] of [
    ['--index-url', '@@ -1 +1,2 @@\n flask==2.0.0\n+--index-url https://evil.example/simple'],
    ['--extra-index-url', '@@ -1 +1,2 @@\n flask==2.0.0\n+--extra-index-url https://evil.example/simple'],
    ['-i', '@@ -1 +1,2 @@\n flask==2.0.0\n+-i https://evil.example/simple'],
    ['url requirement', '@@ -1 +1 @@\n-flask==2.0.0\n+flask @ https://evil.example/flask.tar.gz'],
    ['vcs requirement', '@@ -1 +1 @@\n-flask==2.0.0\n+git+https://github.com/x/flask.git#egg=flask'],
    ['new name', '@@ -1 +1,2 @@\n flask==2.0.0\n+evilpkg==1.0.0'],
    ['unpinned', '@@ -1 +1 @@\n-flask==2.0.0\n+flask>=2.0.0'],
    ['-r include', '@@ -1 +1,2 @@\n flask==2.0.0\n+-r other.txt'],
  ]) {
    const r = exemptFile(req('scripts/requirements.txt', patch));
    assert.equal(r.exempt, false, name);
  }
  assert.match(exemptFile(req('scripts/requirements.txt', '@@ -1 +1,2 @@\n flask==2.0.0\n+evilpkg==1.0.0')).reason, /adds the package `evilpkg`/);
  assert.equal(exemptFile(req('scripts/requirements.txt', undefined, { patch: undefined })).exempt, false, 'no patch fails closed');
});

test('t/796: lockfile and requirements checks decide adversarial long lines in under 50 ms', () => {
  const longs = [
    lockPatch('+  ' + 'a'.repeat(5000) + '@1.0.0:'),
    lockPatch('+    resolution: {' + 'integrity: x, '.repeat(400) + '}'),
    lockPatch('-  left-pad@1.0.0:', '+  left-pad@1.0.1:', '+      version: ' + '1 '.repeat(2500)),
    lockPatch('+' + ' '.repeat(5000) + 'x'),
  ];
  for (const p of longs) {
    const t0 = process.hrtime.bigint();
    const r = pnpmLockPatchOk({ status: 'modified', patch: p });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.ok, false);
    assert.ok(ms < 50, `pnpm-lock took ${ms} ms`);
  }
  for (const p of ['@@ -1 +1 @@\n+' + 'a'.repeat(5000) + '==1', '@@ -1 +1 @@\n+flask==' + '1'.repeat(5000), '@@ -1 +1 @@\n+flask==1 ;' + ' '.repeat(5000) + 'x']) {
    const t0 = process.hrtime.bigint();
    const r = requirementsPatchOk({ status: 'modified', patch: p });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.ok, false);
    assert.ok(ms < 50, `requirements took ${ms} ms`);
  }
});
