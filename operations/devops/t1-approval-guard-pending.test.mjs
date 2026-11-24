// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/534 (PI decision t/531 items 1 and 4): awaiting review reports PENDING, not failure, and the
// approval settles the SAME `t1-approval-guard` check run the push opened (#5392 left a red row
// beside a later green one). These arms run t1-approval-guard.yml's REAL github-script body against
// a stateful mocked GitHub API (check runs persist between runs, like on GitHub), so a sequence of
// events at one head can be replayed and the rows counted. One fault per decision site:
//   awaiting review -> pending; approved -> success; changes-requested -> failure;
//   cannot evaluate -> failure; not T1 -> success; stale approval after a push -> pending;
//   the update goes to OUR run (external_id), never ci.yml's same-named merge_group row;
//   a failed update falls back to a new run (the newest decides); and enqueue-pr.mjs's
//   classifier still refuses a pending head (guard_in_progress).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { classifyT1GuardForEnqueue, pickAuthoritativeGuardRun } from './t1-approval-at-head.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const WORKFLOW = path.join(root, '.github', 'workflows', 't1-approval-guard.yml');
const nodeRequire = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const PUSH = '2026-11-24T10:00:00Z';
const BEFORE_PUSH = '2026-11-24T09:00:00Z';
const AFTER = '2026-11-24T11:00:00Z';
const LATER = '2026-11-24T12:00:00Z';
const EXTERNAL_ID = 't1-approval-guard:api';

function scriptBlock(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^\s*script:\s*\|\s*$/.test(l));
  assert.ok(start >= 0, 'no "script: |" block');
  const body = [];
  let indent = null;
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') { body.push(''); continue; }
    const ind = l.match(/^ */)[0].length;
    if (indent === null) indent = ind;
    if (ind < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

/** A GitHub stand-in whose check runs persist across runs of the script. */
function makeGitHub() {
  const state = {
    pr: { number: 7, body: 'Tier: T1\n\nA change.', head: HEAD, pushAt: PUSH },
    comments: [], reviews: [], checkRuns: [], nextId: 100, calls: [],
    failUpdate: false, failList: false,
  };
  let clock = 0;
  const stamp = () => new Date(Date.parse('2026-11-24T13:00:00Z') + 1000 * clock++).toISOString();
  const api = {
    'pulls.get': () => ({
      number: state.pr.number, body: state.pr.body, created_at: '2026-11-24T08:00:00Z',
      head: { sha: state.pr.head, ref: 'devops/t534-probe' }, base: { ref: 'main' },
    }),
    'pulls.listCommits': () => [{ commit: { committer: { date: state.pr.pushAt } } }],
    'issues.listComments': () => state.comments,
    'pulls.listReviews': () => state.reviews,
    'repos.listPullRequestsAssociatedWithCommit': (p) => (p.commit_sha === state.pr.head ? [{ number: state.pr.number, state: 'open', head: { sha: state.pr.head } }] : []),
    'issues.createComment': () => ({}),
    'issues.updateComment': () => ({}),
    'checks.listForRef': (p) => {
      if (state.failList) throw Object.assign(new Error('HTTP 404 listForRef'), { status: 404 });
      return state.checkRuns.filter((r) => r.head_sha === p.ref && r.name === p.check_name);
    },
    'checks.create': (p) => {
      const run = {
        id: state.nextId++, name: p.name, head_sha: p.head_sha, external_id: p.external_id ?? null,
        app: { slug: 'github-actions' }, started_at: stamp(), status: p.status,
        conclusion: p.status === 'completed' ? p.conclusion : null, output: p.output,
      };
      state.checkRuns.push(run);
      return run;
    },
    'checks.update': (p) => {
      if (state.failUpdate) throw Object.assign(new Error('HTTP 422 Unprocessable'), { status: 422 });
      const run = state.checkRuns.find((r) => r.id === p.check_run_id);
      assert.ok(run, `update of unknown check run ${p.check_run_id}`);
      run.status = p.status;
      run.conclusion = p.status === 'completed' ? p.conclusion : null;
      run.output = p.output;
      return run;
    },
  };
  const rest = {};
  for (const [name, fn] of Object.entries(api)) {
    const [ns, m] = name.split('.');
    rest[ns] ??= {};
    rest[ns][m] = async (params) => { state.calls.push(name); return { data: fn(params) }; };
  }
  const github = { rest, paginate: async (method, params) => (await method(params)).data };
  return { state, github };
}

async function runGuard(gh, { predicateText, payload } = {}) {
  const log = { info: [], warning: [], error: [], failed: [] };
  const execSync = (cmd) => {
    if (/^git fetch origin /.test(cmd)) return '';
    if (/^git rev-parse FETCH_HEAD$/.test(cmd)) return 'basetip\n';
    const m = cmd.match(/^git show basetip:operations\/devops\/([\w.-]+)$/);
    if (m) {
      if (m[1] === 't1-approval-guard-predicate.mjs' && predicateText !== undefined) return predicateText;
      return readFileSync(path.join(here, m[1]), 'utf8');
    }
    throw new Error(`test harness: unexpected command ${cmd}`);
  };
  const fakeRequire = (id) => (id === 'child_process' ? { execSync } : nodeRequire(id));
  const core = {
    info: (m) => log.info.push(m), warning: (m) => log.warning.push(m),
    error: (m) => log.error.push(m), setFailed: (m) => log.failed.push(m),
  };
  const context = {
    repo: { owner: 'o', repo: 'r' },
    payload: { ...(payload ?? { pull_request: { number: 7 } }), repository: { default_branch: 'main' } },
  };
  const prevWs = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = root;
  try {
    const script = scriptBlock(readFileSync(WORKFLOW, 'utf8'));
    await new AsyncFunction('require', 'github', 'context', 'core', 'setTimeout', script)(fakeRequire, gh.github, context, core, (fn) => { fn(); return 0; });
  } finally {
    if (prevWs === undefined) delete process.env.GITHUB_WORKSPACE; else process.env.GITHUB_WORKSPACE = prevWs;
  }
  return log;
}

const comment = (body, at) => ({ body, created_at: at, updated_at: at, user: { login: 'jpsnover' } });
const ours = (gh, head = HEAD) => gh.state.checkRuns.filter((r) => r.head_sha === head && r.external_id === EXTERNAL_ID);
// What enqueue-pr.mjs decides from the runs at the head (same pick as fetchGuardRun).
const enqueueVerdict = (gh, head = HEAD) => classifyT1GuardForEnqueue({
  tier: 'T1', isDraft: false,
  guardRun: pickAuthoritativeGuardRun(gh.state.checkRuns.filter((r) => r.head_sha === head && r.app?.slug === 'github-actions')),
});

test('t/534 AWAITING REVIEW: no approval -> one pending (in_progress) run, job not failed, enqueue refuses', async () => {
  const gh = makeGitHub();
  const log = await runGuard(gh);
  assert.deepEqual(log.error, [], log.error.join(' | '));
  assert.deepEqual(log.failed, [], 'the job must not fail while only awaiting review (#5392)');
  const runs = ours(gh);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'in_progress');
  assert.equal(runs[0].conclusion, null);
  assert.equal(runs[0].output.title, 't1-approval-guard: awaiting review');
  assert.deepEqual(enqueueVerdict(gh), { allow: false, reason: 'guard_in_progress', warn: null });
});

test('t/534 SAME ROW: the approval settles the pending run to success by update, no second run', async () => {
  const gh = makeGitHub();
  await runGuard(gh);
  const pendingId = ours(gh)[0].id;
  gh.state.comments.push(comment('Approved (Quality): looks right.', AFTER));
  const log = await runGuard(gh);
  assert.deepEqual(log.failed, []);
  const runs = ours(gh);
  assert.equal(runs.length, 1, 'the approval must not add a second t1-approval-guard row');
  assert.equal(runs[0].id, pendingId);
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].conclusion, 'success');
  assert.equal(runs[0].output.summary, 'approved after the latest push');
  assert.ok(gh.state.calls.includes('checks.update'));
  assert.deepEqual(enqueueVerdict(gh), { allow: true, reason: 'guard_success', warn: null });
});

test('t/534 CHANGES REQUESTED: failure, job failed (unchanged), and it updates the same row', async () => {
  const gh = makeGitHub();
  await runGuard(gh);
  gh.state.comments.push(comment('Changes requested (Quality): fix the thing.', AFTER));
  const log = await runGuard(gh);
  assert.equal(log.failed.length, 1);
  assert.match(log.failed[0], /outstanding changes-request/);
  const runs = ours(gh);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].conclusion, 'failure');
  assert.deepEqual(enqueueVerdict(gh), { allow: false, reason: 'guard_failure', warn: null });
});

test('t/534 CANNOT EVALUATE: a predicate that cannot load -> failure, job failed, never pending or success', async () => {
  const gh = makeGitHub();
  const log = await runGuard(gh, { predicateText: 'export function evaluateT1ApprovalGuard() { throw new Error("boom"); }' });
  assert.equal(log.failed.length, 1);
  assert.match(log.failed[0], /CANNOT EVALUATE/);
  const runs = ours(gh);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].conclusion, 'failure');
  assert.match(runs[0].output.title, /CANNOT EVALUATE/);
});

test('t/534 NOT T1: success, job not failed (unchanged)', async () => {
  const gh = makeGitHub();
  gh.state.pr.body = 'Tier: T0\n\nA typo.';
  const log = await runGuard(gh);
  assert.deepEqual(log.failed, []);
  assert.equal(ours(gh)[0].conclusion, 'success');
  assert.equal(ours(gh)[0].output.summary, 'not a T1 PR');
});

test('t/534 STALE APPROVAL: an approval from before the latest push is awaiting review again (pending)', async () => {
  const gh = makeGitHub();
  gh.state.comments.push(comment('Approved (Quality): looks right.', BEFORE_PUSH));
  const log = await runGuard(gh);
  assert.deepEqual(log.failed, []);
  assert.equal(ours(gh)[0].status, 'in_progress');
  assert.deepEqual(enqueueVerdict(gh), { allow: false, reason: 'guard_in_progress', warn: null });
});

test('t/538: a comment of only lower-case "approved" (t/437#9) is not an approval -- the head stays pending', async () => {
  for (const body of ['approved', 'Approved', 'approved (Quality): ok', 'LGTM, approved']) {
    const gh = makeGitHub();
    gh.state.comments.push(comment(body, AFTER));
    const log = await runGuard(gh);
    assert.deepEqual(log.failed, [], body);
    assert.equal(ours(gh)[0].status, 'in_progress', `"${body}" must not settle the check to success`);
    assert.deepEqual(enqueueVerdict(gh), { allow: false, reason: 'guard_in_progress', warn: null }, body);
  }
});

test('t/534 NEW HEAD: a push opens a new pending row on the new head; the old head\'s row is not touched', async () => {
  const gh = makeGitHub();
  gh.state.comments.push(comment('Approved (Quality): looks right.', AFTER));
  await runGuard(gh);
  assert.equal(ours(gh, HEAD)[0].conclusion, 'success');
  gh.state.pr.head = HEAD2;
  gh.state.pr.pushAt = LATER;
  await runGuard(gh);
  assert.equal(ours(gh, HEAD)[0].conclusion, 'success');
  assert.equal(ours(gh, HEAD2).length, 1);
  assert.equal(ours(gh, HEAD2)[0].status, 'in_progress');
  assert.deepEqual(enqueueVerdict(gh, HEAD2), { allow: false, reason: 'guard_in_progress', warn: null });
});

test('t/534 OWN ROW ONLY: a same-named run without our external_id (ci.yml merge_group job) is never updated', async () => {
  const gh = makeGitHub();
  gh.state.checkRuns.push({ id: 1, name: 't1-approval-guard', head_sha: HEAD, external_id: null, app: { slug: 'github-actions' }, started_at: '2026-11-24T12:59:00Z', status: 'completed', conclusion: 'skipped', output: {} });
  await runGuard(gh);
  const foreign = gh.state.checkRuns.find((r) => r.id === 1);
  assert.equal(foreign.conclusion, 'skipped', 'the merge_group job row must not be rewritten');
  assert.equal(ours(gh).length, 1);
  assert.equal(ours(gh)[0].status, 'in_progress');
});

test('t/534 FALLBACK: if the update is refused, a new run is created with a WARN, and the newest decides', async () => {
  const gh = makeGitHub();
  await runGuard(gh);
  gh.state.failUpdate = true;
  gh.state.comments.push(comment('Approved (Quality): looks right.', AFTER));
  const log = await runGuard(gh);
  assert.ok(log.warning.some((w) => /could not update check run \d+/.test(w)), log.warning.join(' | '));
  assert.equal(ours(gh).length, 2);
  assert.deepEqual(enqueueVerdict(gh), { allow: true, reason: 'guard_success', warn: null });
});

test('t/534 FALLBACK: if listing the head\'s runs fails, a new run is created with a WARN (never no row)', async () => {
  const gh = makeGitHub();
  gh.state.failList = true;
  const log = await runGuard(gh);
  assert.ok(log.warning.some((w) => /could not list this head's check runs/.test(w)));
  assert.equal(ours(gh).length, 1);
  assert.equal(ours(gh)[0].status, 'in_progress');
});

test('t/534 NOT LOOSENED: enqueue-pr.mjs refuses an in_progress or queued guard run for T1 and unknown tiers', () => {
  for (const status of ['in_progress', 'queued']) {
    for (const tier of ['T1', undefined, 'T9']) {
      const v = classifyT1GuardForEnqueue({ tier, isDraft: false, guardRun: { status, conclusion: null, app: { slug: 'github-actions' } } });
      assert.equal(v.allow, false, `${status} ${tier}`);
      assert.equal(v.reason, `guard_${status}`);
    }
  }
});

// ── t/534 part B: reviews arrive as workflow_run from the permission-less relay (runs from main) ──
const relayRun = (prs, headSha = HEAD) => ({ workflow_run: { name: 't1-approval-review-relay', event: 'pull_request_review', head_sha: headSha, pull_requests: prs } });

test('t/534 B: a workflow_run from the relay (same-repo PR in pull_requests) settles the same row on approval', async () => {
  const gh = makeGitHub();
  await runGuard(gh); // the push opened the pending row
  gh.state.comments.push(comment('Approved (Quality): looks right.', AFTER));
  const log = await runGuard(gh, { payload: relayRun([{ number: 7, head: { sha: HEAD } }]) });
  assert.deepEqual(log.failed, []);
  assert.equal(ours(gh).length, 1);
  assert.equal(ours(gh)[0].conclusion, 'success');
});

test('t/534 B: a workflow_run with no pull_requests (fork) finds the open PR by the relay head_sha', async () => {
  const gh = makeGitHub();
  const log = await runGuard(gh, { payload: relayRun([]) });
  assert.deepEqual(log.failed, []);
  assert.ok(gh.state.calls.includes('repos.listPullRequestsAssociatedWithCommit'));
  assert.equal(ours(gh)[0].status, 'in_progress');
});

test('t/534 B: a workflow_run whose head is no open PR posts nothing and does not fail', async () => {
  const gh = makeGitHub();
  const log = await runGuard(gh, { payload: relayRun([], 'e'.repeat(40)) });
  assert.deepEqual(log.failed, []);
  assert.equal(gh.state.checkRuns.length, 0);
  assert.ok(log.info.some((m) => /not a PR event/.test(m)));
});
