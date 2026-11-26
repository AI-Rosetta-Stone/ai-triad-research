// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/537: tests for the impure merge-approval fetch/post module, against an injected fake
// Octokit. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_PASSES, checkInstallationScope, postCheck, resolveMergeGroup, resolvePullRequestTarget, resolveReviewRelay,
  resolveTarget, runMergeApproval,
} from './merge-approval-run.mjs';
import { REVIEWER_APP_REST_LOGIN } from './gate-file-change.mjs';
import { parseSnapshots, pairDeltas } from './rate-limit-spend.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TIER_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'ci', 'tier-paths.json'), 'utf8'));
const OWNER = 'AI-Rosetta-Stone';
const REPO = 'ai-triad-research';
const FULL = `${OWNER}/${REPO}`;
const H = (c) => c.repeat(40);
const GROUP_SHA = H('9');
const BASE_SHA = H('0');

function httpError(status) {
  const e = new Error(`HTTP ${status}`);
  e.status = status;
  return e;
}

/**
 * A fake repo state and the two Octokit-shaped clients over it.
 *   prs: { [n]: { head, body, ref, base, state, files, reviews, comments, labels, changed_files } }
 */
function fakeWorld({ prs = {}, queue = null, installRepos = [FULL], fail = {}, onRead = null } = {}) {
  const posts = [];
  const calls = [];
  const maybeFail = (name) => { calls.push(name); if (fail[name]) throw fail[name]; };
  const prData = (n) => {
    const p = prs[n];
    if (!p) throw httpError(404);
    return {
      number: n, state: p.state ?? 'open', body: p.body ?? 'Tier: T0\n', base: { ref: p.base ?? 'main' },
      head: { sha: p.head, ref: p.ref ?? 'devops/x', repo: { full_name: FULL } },
      user: { login: p.author ?? 'jpsnover' }, commits: (p.commits ?? []).length,
      labels: (p.labels ?? []).map((name) => ({ name })),
      changed_files: p.changed_files ?? (p.files ?? [{ filename: 'docs/a.md' }]).length,
    };
  };
  const rest = {
    pulls: {
      get: async ({ pull_number }) => { maybeFail('pulls.get'); onRead?.('pulls.get', pull_number); return { data: prData(pull_number) }; },
      listFiles: Symbol('listFiles'), listReviews: Symbol('listReviews'), listCommits: Symbol('listCommits'),
    },
    issues: { listComments: Symbol('listComments') },
    repos: { listPullRequestsAssociatedWithCommit: Symbol('assoc') },
    checks: {
      listForRef: Symbol('listForRef'),
      create: async (args) => { maybeFail('checks.create'); posts.push(args); return { data: { id: posts.length } }; },
    },
  };
  const paginate = async (route, params) => {
    if (route === rest.pulls.listFiles) { maybeFail('listFiles'); return prs[params.pull_number].files ?? [{ filename: 'docs/a.md' }]; }
    if (route === rest.pulls.listCommits) { maybeFail('listCommits'); return prs[params.pull_number].commits ?? []; }
    if (route === rest.checks.listForRef) { maybeFail('listForRef'); const p = Object.values(prs).find((x) => x.head === params.ref); return p?.checkRuns ?? []; }
    if (route === rest.pulls.listReviews) { maybeFail('listReviews'); return prs[params.pull_number].reviews ?? []; }
    if (route === rest.issues.listComments) { maybeFail('listComments'); return prs[params.issue_number].comments ?? []; }
    if (route === rest.repos.listPullRequestsAssociatedWithCommit) {
      maybeFail('assoc');
      return Object.entries(prs).filter(([, p]) => p.head === params.commit_sha)
        .map(([n, p]) => ({ number: Number(n), state: p.state ?? 'open', head: { sha: p.head }, base: { ref: p.base ?? 'main' } }));
    }
    if (route === 'GET /installation/repositories') { maybeFail('installation'); return installRepos.map((full_name) => ({ full_name })); }
    throw new Error(`unexpected paginate ${String(route)}`);
  };
  const graphql = async () => { maybeFail('graphql'); return queue; };
  // t/566: the App token does every call. `github` (a GITHUB_TOKEN client) is a trap: any use of it
  // is recorded and throws, so every test also proves runMergeApproval never touches GITHUB_TOKEN.
  const appGithub = { rest, paginate, graphql };
  const github = new Proxy({}, { get(_t, k) { calls.push(`GITHUB_TOKEN:${String(k)}`); throw new Error('GITHUB_TOKEN client used (t/566 forbids it)'); } });
  return { github, appGithub, posts, calls };
}

const repoCtx = { owner: OWNER, repo: REPO };
const prCtx = (n, eventName = 'pull_request_target') => ({ eventName, repo: repoCtx, payload: { pull_request: { number: n, head: { sha: H('f') } } } });
const commentCtx = (n, isPr = true) => ({ eventName: 'issue_comment', repo: repoCtx, payload: { issue: { number: n, ...(isPr ? { pull_request: {} } : {}) } } });
const relayCtx = (over) => ({
  eventName: 'workflow_run', repo: repoCtx,
  payload: { workflow_run: { name: 'merge-approval-group-relay', event: 'merge_group', head_repository: { full_name: FULL }, head_branch: `gh-readonly-queue/main/pr-12-${BASE_SHA}`, head_sha: GROUP_SHA, ...over } },
});
const reviewCtx = (over) => ({
  eventName: 'workflow_run', repo: repoCtx,
  payload: { workflow_run: { name: 'merge-approval-review-relay', event: 'pull_request_review', head_repository: { full_name: FULL }, head_branch: 'devops/x', head_sha: H('a'), ...over } },
});
const queueOf = (nodes) => ({ repository: { mergeQueue: { entries: { totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes } } } });
const entry = (position, number, headRefOid, oid) => ({ position, headCommit: { oid }, pullRequest: { number, headRefOid } });
const appApproval = (commit, role = 'Quality') => ({ id: 5, user: { login: REVIEWER_APP_REST_LOGIN }, state: 'APPROVED', body: `Approved (${role}): ok`, commit_id: commit, submitted_at: '2026-11-20T10:00:00Z', author_association: 'NONE' });

// ---- resolvers ------------------------------------------------------------------------------

test('resolvePullRequestTarget: the head comes from a fresh pulls.get, not the payload', async () => {
  const w = fakeWorld({ prs: { 3: { head: H('a') } } });
  const r = await resolvePullRequestTarget(w.appGithub, prCtx(3));
  assert.deepEqual(r, { action: 'evaluate', kind: 'pr', prNumber: 3, headSha: H('a') });
});

test('resolvePullRequestTarget: skips a plain-issue comment, a closed PR, a non-main base', async () => {
  const w = fakeWorld({ prs: { 3: { head: H('a'), state: 'closed' }, 4: { head: H('b'), base: 'epic/x' } } });
  assert.equal((await resolvePullRequestTarget(w.appGithub, commentCtx(9, false))).action, 'skip');
  assert.equal((await resolvePullRequestTarget(w.appGithub, commentCtx(3))).action, 'skip');
  assert.equal((await resolvePullRequestTarget(w.appGithub, prCtx(4))).action, 'skip');
});

test('resolveMergeGroup: Security conditions, each one refuses (skip, no post)', async () => {
  const w = fakeWorld({ queue: queueOf([entry(1, 12, H('a'), GROUP_SHA)]) });
  const cases = [
    { event: 'push' }, { event: 'pull_request' },
    { head_repository: { full_name: 'evil/ai-triad-research' } }, { head_repository: null },
    { head_branch: 'gh-readonly-queue/main/pr-12-abc' }, { head_branch: `gh-readonly-queue/epic/pr-12-${BASE_SHA}` },
    { head_branch: `devops/gh-readonly-queue/main/pr-12-${BASE_SHA}` }, { head_branch: `gh-readonly-queue/main/pr-12-${BASE_SHA}x` },
    { name: 'something-else' },
  ];
  for (const c of cases) {
    const r = await resolveMergeGroup(w.appGithub, relayCtx(c));
    assert.equal(r.action, 'skip', JSON.stringify(c));
  }
  assert.equal(w.calls.includes('graphql'), false, 'nothing is read before the conditions pass');
});

test('resolveMergeGroup: exactly one entry at the head SHA; it and every entry ahead are members', async () => {
  const w = fakeWorld({ queue: queueOf([entry(3, 14, H('c'), H('7')), entry(1, 10, H('a'), H('5')), entry(2, 12, H('b'), GROUP_SHA)]) });
  const r = await resolveMergeGroup(w.appGithub, relayCtx({}));
  assert.equal(r.action, 'evaluate');
  assert.equal(r.headSha, GROUP_SHA);
  assert.deepEqual(r.members.map((m) => m.number), [10, 12]);
});

test('resolveMergeGroup: 0 or 2 matching entries, or a PR mismatch with the branch, is a failure on the SHA', async () => {
  for (const nodes of [[entry(1, 12, H('a'), H('5'))], [entry(1, 12, H('a'), GROUP_SHA), entry(2, 13, H('b'), GROUP_SHA)], [entry(1, 99, H('a'), GROUP_SHA)]]) {
    const r = await resolveMergeGroup(fakeWorld({ queue: queueOf(nodes) }).appGithub, relayCtx({}));
    assert.equal(r.action, 'fail');
    assert.equal(r.headSha, GROUP_SHA);
  }
  const none = await resolveMergeGroup(fakeWorld({ queue: { repository: { mergeQueue: null } } }).appGithub, relayCtx({}));
  assert.equal(none.action, 'fail');
});

test('resolveReviewRelay: accepts only pull_request_review from this repo; resolves the PR from head_sha', async () => {
  const w = fakeWorld({ prs: { 5: { head: H('a') } } });
  assert.deepEqual(await resolveReviewRelay(w.appGithub, reviewCtx({})), { action: 'evaluate', kind: 'pr', prNumber: 5, headSha: H('a'), requireHead: H('a') });
  for (const c of [{ event: 'pull_request' }, { event: 'merge_group' }, { head_repository: { full_name: 'fork/x' } }, { name: 'other' }, { head_sha: 'zz' }]) {
    assert.equal((await resolveReviewRelay(w.appGithub, reviewCtx(c))).action, 'skip', JSON.stringify(c));
  }
});

test('resolveReviewRelay: no open PR at that head (it moved) skips without posting', async () => {
  const w = fakeWorld({ prs: { 5: { head: H('b') } } });
  const r = await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: reviewCtx({}), tierConfig: TIER_CONFIG });
  assert.match(r.skipped, /no open PR/);
  assert.equal(w.posts.length, 0);
});

test('resolveTarget: workflow_run from any other event is skipped', async () => {
  const w = fakeWorld();
  assert.equal((await resolveTarget(w.appGithub, relayCtx({ event: 'workflow_dispatch' }))).action, 'skip');
  assert.equal((await resolveTarget(w.appGithub, { eventName: 'push', repo: repoCtx, payload: {} })).action, 'skip');
});

// ---- scope + post ---------------------------------------------------------------------------

test('checkInstallationScope: exactly this repo, else failure; an API error is a failure', async () => {
  assert.equal((await checkInstallationScope(fakeWorld().appGithub)).ok, true);
  assert.equal((await checkInstallationScope(fakeWorld({ installRepos: [FULL, 'AI-Rosetta-Stone/ai-triad-data'] }).appGithub)).ok, false);
  assert.equal((await checkInstallationScope(fakeWorld({ installRepos: [] }).appGithub)).ok, false);
  const err = await checkInstallationScope(fakeWorld({ fail: { installation: httpError(500) } }).appGithub);
  assert.equal(err.ok, false);
  assert.match(err.detail, /could not list/);
});

test('postCheck: completed run named merge-approval on exactly the SHA; refuses neutral or a non-SHA', async () => {
  const w = fakeWorld();
  await postCheck(w.appGithub, { repo: repoCtx }, H('a'), { conclusion: 'success', title: 't', summary: 's' });
  assert.deepEqual(w.posts[0], { owner: OWNER, repo: REPO, name: 'merge-approval', head_sha: H('a'), status: 'completed', conclusion: 'success', output: { title: 't', summary: 's' } });
  await assert.rejects(postCheck(w.appGithub, { repo: repoCtx }, H('a'), { conclusion: 'neutral' }));
  await assert.rejects(postCheck(w.appGithub, { repo: repoCtx }, 'main', { conclusion: 'success' }));
});

// ---- the whole run --------------------------------------------------------------------------

test('run: a clean PR gets success on its head, and the re-read confirms it (one post)', async () => {
  const w = fakeWorld({ prs: { 3: { head: H('a') } } });
  const r = await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(3), tierConfig: TIER_CONFIG });
  assert.deepEqual(r.posted, [{ headSha: H('a'), conclusion: 'success' }]);
  assert.match(w.posts[0].output.summary, /Installation scope: OK/);
});

test('run: an unapproved T1 PR gets failure', async () => {
  const w = fakeWorld({ prs: { 3: { head: H('a'), body: 'Tier: T1\n' } } });
  await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: commentCtx(3), tierConfig: TIER_CONFIG });
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].conclusion, 'failure');
  assert.match(w.posts[0].output.summary, /B t1-approval: FAIL/);
});

test('run: a sibling PR at the same head with a weaker body cannot make the head pass', async () => {
  // #3 is T1 and unapproved; #4 points at the same commit and says T0.
  const w = fakeWorld({ prs: { 3: { head: H('a'), body: 'Tier: T1\n' }, 4: { head: H('a'), body: 'Tier: T0\n' } } });
  await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(4), tierConfig: TIER_CONFIG });
  assert.equal(w.posts.at(-1).conclusion, 'failure');
  assert.match(w.posts.at(-1).output.summary, /#3 at aaaaaaaaa: FAIL/);
});

test('run: a wrong installation scope fails a clean PR', async () => {
  const w = fakeWorld({ prs: { 3: { head: H('a') } }, installRepos: [FULL, 'x/y'] });
  await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(3), tierConfig: TIER_CONFIG });
  assert.equal(w.posts[0].conclusion, 'failure');
  assert.match(w.posts[0].output.summary, /Installation scope: FAIL/);
});

test('run: a truncated file list (listed != changed_files) fails', async () => {
  const w = fakeWorld({ prs: { 3: { head: H('a'), changed_files: 5 } } });
  await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(3), tierConfig: TIER_CONFIG });
  assert.equal(w.posts[0].conclusion, 'failure');
});

test('run: an API error after the head is known posts failure on that head and throws', async () => {
  const w = fakeWorld({ prs: { 3: { head: H('a') } }, fail: { listReviews: httpError(502) } });
  await assert.rejects(runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(3), tierConfig: TIER_CONFIG }), /502/);
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].head_sha, H('a'));
  assert.equal(w.posts[0].conclusion, 'failure');
  assert.match(w.posts[0].output.title, /CANNOT EVALUATE/);
});

test('run: an API error before any SHA is known throws and posts nothing', async () => {
  const w = fakeWorld({ prs: { 3: { head: H('a') } }, fail: { 'pulls.get': httpError(500) } });
  await assert.rejects(runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(3), tierConfig: TIER_CONFIG }));
  assert.equal(w.posts.length, 0);
});

test('run: if the failure post itself fails, the original error still throws', async () => {
  const w = fakeWorld({ prs: { 3: { head: H('a') } }, fail: { listFiles: httpError(500), 'checks.create': httpError(500) } });
  await assert.rejects(runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(3), tierConfig: TIER_CONFIG }), /HTTP 500/);
});

test('run: an approval dismissed between the post and the re-read is re-posted as failure (race)', async () => {
  const prs = { 3: { head: H('a'), body: 'Tier: T1\n', reviews: [appApproval(H('a'))] } };
  let reads = 0;
  const w = fakeWorld({
    prs,
    onRead: (name) => {
      if (name !== 'pulls.get') return;
      reads += 1;
      // Each fetch calls pulls.get twice; the 3rd call is the start of the re-read after the post.
      if (reads === 3) prs[3].reviews = [{ ...appApproval(H('a')), state: 'DISMISSED' }];
    },
  });
  // The first pulls.get is the resolver's own; shift so the dismissal lands after the first post.
  reads = -1;
  const r = await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(3), tierConfig: TIER_CONFIG });
  assert.deepEqual(r.posted.map((p) => p.conclusion), ['success', 'failure']);
});

test('run: a head that keeps changing ends in a failure post after MAX_PASSES', async () => {
  const prs = { 3: { head: H('a') } };
  let n = 0;
  const heads = ['1', '2', '3', '4', '5', '6', '7', '8'];
  const w = fakeWorld({ prs });
  const origPaginate = w.appGithub.paginate;
  w.appGithub.paginate = async (route, params) => {
    // Move the head once per evaluation (on its comments read, between the two pulls.get calls' window is avoided).
    if (route === w.appGithub.rest.repos.listPullRequestsAssociatedWithCommit) {
      const res = await origPaginate(route, params);
      prs[3].head = H(heads[n++]);
      return res.length ? res : [];
    }
    return origPaginate(route, params);
  };
  await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(3), tierConfig: TIER_CONFIG });
  assert.equal(w.posts.length, MAX_PASSES + 1);
  assert.equal(w.posts.at(-1).conclusion, 'failure');
  assert.match(w.posts.at(-1).output.summary, /kept changing/);
});

test('run: review relay whose PR head moved after resolution skips without posting', async () => {
  const prs = { 5: { head: H('a') } };
  const w = fakeWorld({ prs });
  const origPaginate = w.appGithub.paginate;
  w.appGithub.paginate = async (route, params) => {
    const res = await origPaginate(route, params);
    if (route === w.appGithub.rest.repos.listPullRequestsAssociatedWithCommit && prs[5].head === H('a')) prs[5].head = H('b');
    return res;
  };
  const r = await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: reviewCtx({}), tierConfig: TIER_CONFIG });
  assert.match(r.skipped, /head moved/);
  assert.equal(w.posts.length, 0);
});

test('run: merge group evaluates the queued PR and every entry ahead, posts on the group SHA', async () => {
  const w = fakeWorld({
    prs: { 10: { head: H('a') }, 12: { head: H('b'), body: 'Tier: T1\n', reviews: [appApproval(H('b'))] } },
    queue: queueOf([entry(1, 10, H('a'), H('5')), entry(2, 12, H('b'), GROUP_SHA)]),
  });
  await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: relayCtx({}), tierConfig: TIER_CONFIG });
  assert.equal(w.posts.length, 1, 'a group is posted once');
  assert.equal(w.posts[0].head_sha, GROUP_SHA);
  assert.equal(w.posts[0].conclusion, 'success', w.posts[0].output.summary);
  assert.match(w.posts[0].output.summary, /#10, #12/);
});

test('run: merge group fails when an entry ahead fails its rules', async () => {
  const w = fakeWorld({
    prs: { 10: { head: H('a'), files: [{ filename: '.github/workflows/ci.yml' }] }, 12: { head: H('b') } },
    queue: queueOf([entry(1, 10, H('a'), H('5')), entry(2, 12, H('b'), GROUP_SHA)]),
  });
  await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: relayCtx({}), tierConfig: TIER_CONFIG });
  assert.equal(w.posts[0].conclusion, 'failure');
  assert.match(w.posts[0].output.title, /#10 \(A\)/);
});

test('run: merge group fails when a PR head no longer matches its queue entry', async () => {
  const w = fakeWorld({ prs: { 12: { head: H('c') } }, queue: queueOf([entry(1, 12, H('b'), GROUP_SHA)]) });
  await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: relayCtx({}), tierConfig: TIER_CONFIG });
  assert.equal(w.posts[0].conclusion, 'failure');
});

test('run: merge group with no matching entry posts failure on the group SHA', async () => {
  const w = fakeWorld({ queue: queueOf([]) });
  await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: relayCtx({}), tierConfig: TIER_CONFIG });
  assert.equal(w.posts[0].head_sha, GROUP_SHA);
  assert.equal(w.posts[0].conclusion, 'failure');
});

test('run: a GraphQL error on a merge group posts failure on the group SHA and throws', async () => {
  const w = fakeWorld({ fail: { graphql: httpError(502) } });
  await assert.rejects(runMergeApproval({ github: w.github, appGithub: w.appGithub, context: relayCtx({}), tierConfig: TIER_CONFIG }));
  // Security's conditions held, so the group SHA is known: the crash still posts failure on it.
  assert.equal(w.posts.length, 1);
  assert.equal(w.posts[0].head_sha, GROUP_SHA);
  assert.equal(w.posts[0].conclusion, 'failure');
});

test('wiring (Security p/131#58): the /recheck-guards arm runs only for OWNER, MEMBER or COLLABORATOR commenters', () => {
  const yml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'merge-approval.yml'), 'utf8');
  const m = /\n    if: >-\n([\s\S]*?)\n    steps:/.exec(yml);
  assert.ok(m, 'the compute job has a job-level if: block');
  const cond = m[1].replace(/\s+/g, ' ');
  // Exactly one /recheck-guards clause, and it is ANDed with the association allowlist in the same group.
  assert.equal((cond.match(/\/recheck-guards/g) || []).length, 1, 'one /recheck-guards clause');
  assert.match(cond, /\(contains\(github\.event\.comment\.body, '\/recheck-guards'\) && contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.comment\.author_association\)\)/);
  // No other comment arm admits arbitrary commenters: the only other comment arm is the reviewer App by login.
  const commentArm = /github\.event_name == 'issue_comment'([\s\S]*?)\) \|\| \(github\.event_name == 'workflow_run'/.exec(cond);
  assert.ok(commentArm, 'the issue_comment arm is delimited');
  assert.match(commentArm[1], /github\.event\.comment\.user\.login == 'ai-triad-reviewer-jpsnover\[bot\]'/);
  assert.doesNotMatch(commentArm[1].replace(/\(contains\(github\.event\.comment\.body, '\/recheck-guards'\) && contains\(fromJSON\([^)]*\), github\.event\.comment\.author_association\)\)/, ''), /contains\(github\.event\.comment\.body/);
});

// ── t/566 (Security p/131#63): App-token reads fail closed, never fall back to GITHUB_TOKEN ──
for (const [name, err] of [['pulls.get', httpError(403)], ['listReviews', httpError(502)], ['listComments', httpError(404)]]) {
  test(`t/566: a failing App-token read (${name}) posts failure and makes no GITHUB_TOKEN call`, async () => {
    const w = fakeWorld({ prs: { 3: { head: H('c') } }, fail: { [name]: err } });
    await assert.rejects(runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(3), tierConfig: TIER_CONFIG }));
    assert.ok(w.calls.includes(name), `the App read ${name} was attempted`);
    assert.deepEqual(w.calls.filter((c) => c.startsWith('GITHUB_TOKEN:')), [], 'no GITHUB_TOKEN call at all');
    const failures = w.posts.filter((p) => p.conclusion === 'failure');
    assert.ok(failures.length >= 1 || name === 'pulls.get', 'a failure check run is posted once the SHA is known');
    assert.ok(w.posts.every((p) => p.conclusion !== 'success'), 'never success');
  });
}

test('t/566: the happy path makes every read through the App token (no GITHUB_TOKEN call)', async () => {
  const w = fakeWorld({ prs: { 3: { head: H('c') } } });
  await runMergeApproval({ github: w.github, appGithub: w.appGithub, context: prCtx(3), tierConfig: TIER_CONFIG });
  assert.ok(w.calls.includes('pulls.get') && w.calls.includes('listFiles') && w.calls.includes('listReviews') && w.calls.includes('listComments'));
  assert.deepEqual(w.calls.filter((c) => c.startsWith('GITHUB_TOKEN:')), []);
  assert.ok(w.posts.length >= 1);
});

test('t/566: runMergeApproval takes no GITHUB_TOKEN client (signature)', () => {
  const src = fs.readFileSync(new URL('./merge-approval-run.mjs', import.meta.url), 'utf8');
  assert.match(src, /export async function runMergeApproval\(\{ appGithub, context, tierConfig, retry = noRetry, log = \(\) => \{\} \}\)/);
});

test('t/566 wiring: no diagnostic step; runMergeApproval gets only appGithub; the App token is only in the Evaluate step; GITHUB_TOKEN is contents: read', () => {
  const yml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'merge-approval.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(yml, /Probe App-token read access/);
  assert.match(yml, /runMergeApproval\(\{ appGithub, context, tierConfig, retry, log: /);
  assert.doesNotMatch(yml, /runMergeApproval\(\{ github,/);
  assert.equal((yml.match(/steps\.app\.outputs\.token/g) || []).length, 1, 'the App token is referenced once (the Evaluate step env)');
  assert.match(yml, /- name: Evaluate and post merge-approval[\s\S]*?APP_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}/);
  assert.match(yml, /    permissions:\n      contents: read {2}# the checkout only/);
  assert.doesNotMatch(yml, /pull-requests: read/);
});

// ── t/563 (Lead p/233#187): the App-pool snapshot around the evaluation ─────────────────────────
// The function is taken from the workflow's own script and run with fakes, so the test exercises the
// shipped code, not a copy.
function appSnapshotFromWorkflow() {
  const yml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'merge-approval.yml'), 'utf8').replace(/\r\n/g, '\n');
  const m = /\n {12}const appSnapshot = (async \(gh, kind\) => \{[\s\S]*?\n {12}\});\n/.exec(yml);
  assert.ok(m, 'the Evaluate script defines appSnapshot');
  return { src: m[1], yml };
}
function runSnapshot(gh, kind) {
  const lines = [];
  const warnings = [];
  const fakeCore = { info: (l) => lines.push(l), warning: (l) => warnings.push(l) };
  const fakeProcess = { env: { GITHUB_WORKFLOW: 'merge-approval', GITHUB_JOB: 'compute' } };
  const fn = new Function('core', 'process', `return (${appSnapshotFromWorkflow().src});`)(fakeCore, fakeProcess);
  return fn(gh, kind).then(() => ({ lines, warnings }));
}
const rl = (core, graphql) => ({ rest: { rateLimit: { get: async () => ({ data: { resources: { core, graphql } } }) } } });

test('t/563: the App snapshot lines pair in rate-limit-spend as the merge-approval App quota (never GITHUB_TOKEN)', async () => {
  const reset = 1795612800;
  const s = await runSnapshot(rl({ used: 100, remaining: 4900, limit: 5000, reset }, { used: 40, remaining: 4960, limit: 5000, reset: reset + 60 }), 'start');
  const e = await runSnapshot(rl({ used: 130, remaining: 4870, limit: 5000, reset }, { used: 75, remaining: 4925, limit: 5000, reset: reset + 60 }), 'end');
  assert.deepEqual([s.warnings, e.warnings], [[], []]);
  assert.match(s.lines[0], /^t\/563 rate-limit-start: pool=merge-approval-app workflow=merge-approval job=compute core used=100 reset=\d\d:\d\d:\d\dZ graphql used=40 graphql_reset=\d+$/);
  const entries = parseSnapshots([s.lines[0], e.lines[0]].join('\n'));
  assert.equal(entries.length, 1);
  assert.match(entries[0].workflow, /merge-approval \[merge-approval-app quota, not GITHUB_TOKEN\]/);
  const [d] = pairDeltas(entries);
  assert.deepEqual([d.core, d.gql], [30, 35]);
});

test('t/563: the App snapshot never throws and never fails the evaluation; its WARN stays on one line', async () => {
  for (const gh of [
    { rest: { rateLimit: { get: async () => { throw new Error('HTTP 502\n::add-mask::x'); } } } },
    rl({ used: 'x', remaining: 1, limit: 1, reset: 1 }, { used: 1, remaining: 1, limit: 1, reset: 1 }),
  ]) {
    const r = await runSnapshot(gh, 'start');
    assert.deepEqual(r.lines, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /^t\/563: could not read the merge-approval App's rate_limit \(/);
    assert.doesNotMatch(r.warnings[0], /[\r\n]/);
  }
});

test('t/563 wiring: the snapshot reads the App client, before the evaluation and in a finally after it', () => {
  const { yml } = appSnapshotFromWorkflow();
  const script = /- name: Evaluate and post merge-approval[\s\S]*$/.exec(yml)[0];
  const iStart = script.indexOf("await appSnapshot(appGithub, 'start');");
  const iRun = script.indexOf('await runMergeApproval(');
  const iEnd = script.indexOf("await appSnapshot(appGithub, 'end');");
  assert.ok(iStart > 0 && iRun > iStart && iEnd > iRun, 'start, evaluation, end, in that order');
  assert.match(script.slice(iRun, iEnd), /\} finally \{\s*$/, 'the end snapshot is in a finally');
  assert.doesNotMatch(script, /appSnapshot\(github,/, 'never the GITHUB_TOKEN client');
});
