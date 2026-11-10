// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4266 P1 (TL p/331#2585): pull_request_target migration coverage for t1-approval-guard.yml,
// mirroring tier-check-workflow.test.mjs's P1 arms -- these test the code the workflow actually
// executes, not a copy of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 't1-approval-guard.yml'), 'utf8');

function scriptCodeLines() {
  return workflow.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

test('P1: the PR trigger is pull_request_target, not pull_request (a PR can no longer disable evaluation by editing this file)', () => {
  assert.match(workflow, /^\s*pull_request_target:\s*\n\s*branches: \[main\]/m);
  assert.ok(!/^\s*pull_request:\s*\n\s*branches:/m.test(workflow), 'must not also trigger on plain pull_request');
});

test('P1: issue_comment and pull_request_review triggers are unaffected (no "target" variant exists for them)', () => {
  assert.match(workflow, /^\s*issue_comment:\s*\n\s*types: \[created, edited\]/m);
  assert.match(workflow, /^\s*pull_request_review:\s*\n\s*types: \[submitted\]/m);
});

test('P1: checkout never persists credentials, and the predicate is loaded only from the explicitly-fetched BASE tip', () => {
  assert.match(workflow, /persist-credentials:\s*false/);
  const code = scriptCodeLines();
  assert.match(code, /git show \$\{baseTipSha\}:operations\/devops\/t1-approval-guard-predicate\.mjs/,
    'the predicate must come from the base tip, fetched explicitly, never the checked-out PR tree');
  assert.ok(!code.includes('git diff') && !code.includes('git show ${headSha}') && !code.includes('git show ${pr.head'),
    'this job must never read any file from the head commit at all (it never needed to)');
});

test('ATTACK ARM (t/4266): fully decoupled from gate-self-health -- rewriting the self-test to always pass cannot touch the verdict', () => {
  assert.ok(!/needs:\s*\[[^\]]*gate-self-health/.test(workflow), 't1-approval-guard.yml\'s job must not declare a `needs:` on the self-test job');
  assert.ok(!/needs\.gate-self-health/.test(workflow), 'the step must not read gate-self-health\'s outcome');
  assert.ok(!scriptCodeLines().includes('node --test'), 't1-approval-guard.yml must never execute a test suite itself (moved to ci.yml, t/4266)');
});

// ── t/116 (a): the PR-side guard and ci.yml's merge_group arm feed the predicate IDENTICAL inputs ──
const ciYml = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

function mergeGroupJob() {
  const start = ciYml.indexOf('\n  t1-approval-guard:\n');
  assert.ok(start >= 0, 'ci.yml must still define the t1-approval-guard merge_group job');
  const rest = ciYml.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/);
  return next >= 0 ? rest.slice(0, next + 1) : rest;
}

// The one line that builds `name` in each workflow, whitespace-trimmed.
function lineDefining(text, re) {
  const hits = text.split('\n').map((l) => l.trim()).filter((l) => re.test(l) && !l.startsWith('//'));
  assert.equal(hits.length, 1, `expected exactly one line matching ${re}, got ${hits.length}`);
  return hits[0];
}

test('t/116 PARITY: both arms call evaluateT1ApprovalGuard with the same arguments, including headSha', () => {
  const re = /evaluateT1ApprovalGuard\(\{/;
  const prSide = lineDefining(workflow, re).replace(/^const result = /, '');
  const mgSide = lineDefining(mergeGroupJob(), re).replace(/^const result = /, '');
  assert.equal(mgSide, prSide);
  assert.match(prSide, /headSha: pr\.head\.sha/);
});

test('t/116 PARITY: both arms map reviews and comments identically (every review, with commitId and login)', () => {
  for (const re of [/^const botReviews = /, /^const approvalComments = /]) {
    assert.equal(lineDefining(mergeGroupJob(), re), lineDefining(workflow, re));
  }
  const reviews = lineDefining(workflow, /^const botReviews = /);
  assert.match(reviews, /commitId: r\.commit_id/);
  assert.ok(!/type === 'Bot'/.test(reviews), 'human reviews must reach the predicate so their changes-requests block (t/116#3)');
  assert.match(lineDefining(workflow, /^const approvalComments = /), /login: c\.user\?\.login/);
});

test('t/116: both arms put role-review-verdicts.mjs from the BASE tip next to the predicate (unused since t/200, which made the predicate self-contained; kept, harmless)', () => {
  assert.match(scriptCodeLines(), /git show \$\{baseTipSha\}:operations\/devops\/role-review-verdicts\.mjs/);
  const mg = mergeGroupJob();
  const verdictsAt = mg.indexOf("loadFromBase('operations/devops/role-review-verdicts.mjs')");
  const predicateAt = mg.indexOf("loadFromBase('operations/devops/t1-approval-guard-predicate.mjs')");
  assert.ok(verdictsAt >= 0 && predicateAt > verdictsAt, 'ci.yml must load role-review-verdicts.mjs before importing the predicate');
});

test('t/116 (TL rule from #4771): CANNOT EVALUATE posts failure, never neutral, on either arm', () => {
  assert.ok(!/['"`]neutral['"`]/.test(scriptCodeLines()), 't1-approval-guard.yml must not post a neutral conclusion');
  assert.match(scriptCodeLines(), /postCheckRun\(pr\.head\.sha, 'failure', 't1-approval-guard: [^']*CANNOT EVALUATE[^']*'/);
  assert.ok(!/['"`]neutral['"`]/.test(mergeGroupJob()), 'the merge_group arm must not post a neutral conclusion');
});

// ── t/200: a branch cut before #4804 runs the OLD t1-approval-guard.yml on pull_request_review ──
// GitHub sources a pull_request_review run's workflow from the PR side, so a pre-#4804 branch runs
// the old YAML, which copies ONLY the predicate from main's tip into an empty temp dir and imports
// it. These arms run that old YAML's REAL github-script body (fixture below, byte-identical to the
// pre-#4804 file) against a mocked GitHub API and a mocked `git` whose `git show basetip:<path>`
// serves THIS checkout's files as main's tip. Anything else the script asks git for throws, so a
// predicate that still needs role-review-verdicts.mjs next to it crashes exactly as on GitHub.
const OLD_YAML_FIXTURE = path.join(here, 'fixtures', 't1-approval-guard.pre-4804.yml.fixture');
const PRE_4804_BLOB = '2f8c52bf8ad3e62133d0cbf58e6ce78556aebd50'; // git rev-parse ae871a8df~1:.github/workflows/t1-approval-guard.yml
const nodeRequire = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const REVIEWER_APP = 'ai-triad-reviewer-jpsnover[bot]';
const OLD_HEAD_SHA = 'f'.repeat(40);
const OLD_PUSH = '2026-11-09T10:00:00Z';
const OLD_AFTER = '2026-11-09T11:00:00Z';
const OLD_LATER = '2026-11-09T12:00:00Z';

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

async function runOldYaml({ comments = [], reviews = [], predicateText } = {}) {
  const log = { info: [], warning: [], error: [], failed: [] };
  const checks = [];
  const verdictComments = [];
  const api = {
    'pulls.get': () => ({
      number: 7, body: 'Tier: T1\n\nA change.', created_at: '2026-11-08T00:00:00Z',
      head: { sha: OLD_HEAD_SHA, ref: 'devops/t200-old-branch' }, base: { ref: 'main' },
    }),
    'pulls.listCommits': () => [{ commit: { committer: { date: OLD_PUSH } } }],
    'issues.listComments': () => comments,
    'pulls.listReviews': () => reviews,
    'issues.createComment': (p) => { verdictComments.push(p.body); return {}; },
    'issues.updateComment': (p) => { verdictComments.push(p.body); return {}; },
    'checks.create': (p) => { checks.push(p); return {}; },
  };
  const rest = {};
  for (const [name, fn] of Object.entries(api)) {
    const [ns, m] = name.split('.');
    rest[ns] ??= {};
    rest[ns][m] = async (params) => ({ data: fn(params) });
  }
  const github = { rest, paginate: async (method, params) => (await method(params)).data };
  const execSync = (cmd) => {
    if (/^git fetch origin /.test(cmd)) return '';
    if (/^git rev-parse FETCH_HEAD$/.test(cmd)) return 'basetip\n';
    if (cmd === 'git show basetip:operations/devops/t1-approval-guard-predicate.mjs') {
      return predicateText ?? readFileSync(path.join(here, 't1-approval-guard-predicate.mjs'), 'utf8');
    }
    if (cmd === 'git show basetip:operations/devops/github-retry.mjs') return readFileSync(path.join(here, 'github-retry.mjs'), 'utf8');
    throw new Error(`test harness: the old YAML never runs this: ${cmd}`);
  };
  const fakeRequire = (id) => (id === 'child_process' ? { execSync } : nodeRequire(id));
  const core = {
    info: (m) => log.info.push(m), warning: (m) => log.warning.push(m),
    error: (m) => log.error.push(m), setFailed: (m) => log.failed.push(m),
  };
  const context = {
    repo: { owner: 'o', repo: 'r' },
    payload: { pull_request: { number: 7 }, repository: { default_branch: 'main' } },
  };
  const prevWs = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = root;
  try {
    const script = scriptBlock(readFileSync(OLD_YAML_FIXTURE, 'utf8'));
    await new AsyncFunction('require', 'github', 'context', 'core', 'setTimeout', script)(fakeRequire, github, context, core, (fn) => { fn(); return 0; });
  } finally {
    if (prevWs === undefined) delete process.env.GITHUB_WORKSPACE; else process.env.GITHUB_WORKSPACE = prevWs;
  }
  return { log, checks, verdictComments };
}

const ghComment = (body, at, login = 'jpsnover') => ({ body, created_at: at, updated_at: at, user: { login } });
const ghBotReview = (state, body, at) => ({ state, body, submitted_at: at, commit_id: OLD_HEAD_SHA, user: { login: REVIEWER_APP, type: 'Bot' } });

test('t/200 PROVENANCE: the fixture is byte-identical to the pre-#4804 t1-approval-guard.yml', () => {
  const text = readFileSync(OLD_YAML_FIXTURE, 'utf8').replace(/\r\n/g, '\n');
  const bytes = Buffer.from(text, 'utf8');
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob, PRE_4804_BLOB);
  assert.ok(!/role-review-verdicts/.test(text), 'the old YAML copies only the predicate');
});

test('t/200 PASS ARM (old YAML): a post-push Approved (<role>): comment -> success check, no crash', async () => {
  const { log, checks } = await runOldYaml({ comments: [ghComment('Approved (Quality): looks right.', OLD_AFTER)] });
  assert.deepEqual(log.error, [], `crashed: ${log.error.join(' | ')}`);
  assert.deepEqual(log.failed, []);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].conclusion, 'success');
  assert.equal(checks[0].head_sha, OLD_HEAD_SHA);
});

test('t/200 FAIL ARM (old YAML): a later Changes requested (<role>): comment blocks despite the approval', async () => {
  const { log, checks } = await runOldYaml({ comments: [
    ghComment('Approved (Quality): looks right.', OLD_AFTER),
    ghComment('Changes requested (Design): fix the colour.', OLD_LATER),
  ] });
  assert.deepEqual(log.error, [], `crashed: ${log.error.join(' | ')}`);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].conclusion, 'failure');
  assert.ok(log.info.some((m) => m.includes('reason=changes-requested-outstanding')), log.info.join(' | '));
  assert.equal(log.failed.length, 1);
});

test('t/200 FAIL ARM (old YAML): a reviewer-App CHANGES_REQUESTED review fails (closed), never passes', async () => {
  const { log, checks } = await runOldYaml({
    comments: [ghComment('Approved (Quality): looks right.', OLD_AFTER)],
    reviews: [ghBotReview('CHANGES_REQUESTED', 'Changes requested (Design): fix the colour.', OLD_LATER)],
  });
  assert.deepEqual(log.error, [], `crashed: ${log.error.join(' | ')}`);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].conclusion, 'failure');
  // The old YAML passes no headSha, so #4804's explicit fail-closed reason applies, unchanged.
  assert.ok(log.info.some((m) => m.includes('pass=false') && m.includes('reason=missing-head-sha')), log.info.join(' | '));
});

test('t/200 (#4804 semantics, unchanged): the old YAML cannot bind a reviewer-App APPROVED review to the head -> failure, never a pass', async () => {
  const review = ghBotReview('APPROVED', 'Approved (Quality): looks right.', OLD_AFTER);
  const { log, checks } = await runOldYaml({ reviews: [review] });
  assert.deepEqual(log.error, [], `crashed: ${log.error.join(' | ')}`);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].conclusion, 'failure');
  assert.ok(log.info.some((m) => m.includes('reason=missing-head-sha')), log.info.join(' | '));

  // TL p/12#100: the verdict object the old YAML gets keeps reason `missing-head-sha` and carries a
  // summary naming the self-serve fix. The inputs are built with the old YAML's own mapping
  // (bot reviews only, no commit_id, comments without login, and no headSha).
  const { evaluateT1ApprovalGuard } = await import('./t1-approval-guard-predicate.mjs');
  const result = evaluateT1ApprovalGuard({
    body: 'Tier: T1\n\nA change.', headRefName: 'devops/t200-old-branch', lastPushAt: OLD_PUSH, approvalComments: [],
    botReviews: [review].filter((r) => r.user?.type === 'Bot').map((r) => ({ state: r.state, submittedAt: r.submitted_at, login: r.user?.login, body: r.body })),
    reviewerAppLogin: REVIEWER_APP,
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'missing-head-sha', 'the machine-readable reason is unchanged');
  assert.match(result.summary, /predates #4804/);
  assert.match(result.summary, /post any PR comment or rebase onto main/);
  assert.match(result.summary, /re-run the guard on main's workflow/);
});

test('t/200 FAILURE PATH (old YAML): a predicate whose logic cannot load -> CANNOT EVALUATE failure, never a pass', async () => {
  // This predicate WOULD pass every PR if it loaded, but its import has nothing to resolve to in
  // the old YAML's temp dir: exactly the pre-t/200 crash. The verdict must be failure, not success.
  const unloadable = [
    "import { latestRoleVerdicts } from './role-review-verdicts.mjs';",
    "export function evaluateT1ApprovalGuard() { return { pass: true, tier: 'T1', reason: String(typeof latestRoleVerdicts) }; }",
  ].join('\n');
  const { log, checks, verdictComments } = await runOldYaml({
    comments: [ghComment('Approved (Quality): looks right.', OLD_AFTER)], predicateText: unloadable,
  });
  assert.ok(log.error.some((m) => m.includes('ERR_MODULE_NOT_FOUND') || m.includes('role-review-verdicts.mjs')), log.error.join(' | '));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].conclusion, 'failure');
  assert.match(checks[0].output.title, /CANNOT EVALUATE/);
  assert.equal(log.failed.length, 1);
  assert.match(log.failed[0], /CANNOT EVALUATE/);
  assert.ok(verdictComments.some((b) => b.includes('CANNOT EVALUATE')));
});
