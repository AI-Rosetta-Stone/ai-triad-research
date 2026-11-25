// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4819: end-to-end arms for the GitHub retry in tier-check.yml and t1-approval-guard.yml.
// Each test extracts the workflow's REAL github-script body from the YAML and runs it against a
// mocked GitHub API, a mocked `git` (git show serves this checkout's files as the "base tip")
// and a zero-delay setTimeout. So these exercise the code the workflow actually executes: the
// base-tip helper loader, every retry() call site, and the CANNOT EVALUATE catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const nodeRequire = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/**
 * The `script: |` block of the workflow's github-script step, dedented. With `stepName`, the first
 * `script: |` after the step of that name (ci.yml has many); without it, the first in the file.
 */
function extractScript(workflowFile, stepName = null) {
  const lines = readFileSync(path.join(root, '.github', 'workflows', workflowFile), 'utf8').split('\n');
  const from = stepName ? lines.findIndex((l) => l.trim() === `- name: ${stepName}`) : 0;
  assert.ok(from >= 0, `${workflowFile}: no step named "${stepName}"`);
  const start = lines.findIndex((l, i) => i >= from && /^\s*script:\s*\|\s*$/.test(l));
  assert.ok(start >= 0, `${workflowFile}: no "script: |" block`);
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

function httpError(status) {
  const e = new Error(`HTTP ${status} from mocked GitHub`);
  e.status = status;
  return e;
}

/**
 * Runs a workflow script. `api` maps an endpoint name ('pulls.get', ...) to either a function
 * (params) => data, or an array of steps consumed in order (a number = throw that HTTP status,
 * anything else = return it as data; the last step repeats).
 */
async function runWorkflow(workflowFile, api, { helperOnBase = true, step = null, env = {} } = {}) {
  const calls = {};
  const args = {}; // endpoint name -> params of every call, in order
  const log = { info: [], warning: [], error: [], failed: [] };
  const sleeps = [];

  function endpoint(name) {
    const fn = async (params) => {
      calls[name] = (calls[name] || 0) + 1;
      (args[name] ??= []).push(params);
      const spec = api[name];
      if (spec === undefined) throw new Error(`test harness: unmocked endpoint ${name}`);
      if (typeof spec === 'function') return { data: spec(params) };
      const step = spec[Math.min(calls[name] - 1, spec.length - 1)];
      if (typeof step === 'number') throw httpError(step);
      if (step instanceof Error) throw step;
      return { data: step };
    };
    return fn;
  }
  const rest = {};
  for (const name of ['pulls.get', 'pulls.listFiles', 'pulls.listReviews', 'pulls.listCommits', 'repos.getContent',
    'issues.listComments', 'issues.createComment', 'issues.updateComment', 'checks.create']) {
    const [ns, m] = name.split('.');
    rest[ns] ??= {};
    rest[ns][m] = endpoint(name);
  }
  const github = { rest, paginate: async (method, params) => (await method(params)).data };

  const execSync = (cmd) => {
    if (/^git fetch origin /.test(cmd)) return '';
    if (/^git rev-parse FETCH_HEAD$/.test(cmd)) return 'basetip\n';
    const m = /^git show basetip:(\S+)$/.exec(cmd);
    if (m) {
      if (!helperOnBase && m[1] === 'operations/devops/github-retry.mjs') throw new Error(`fatal: path '${m[1]}' does not exist in 'basetip'`);
      return readFileSync(path.join(root, m[1]), 'utf8');
    }
    throw new Error(`test harness: unexpected execSync ${cmd}`);
  };
  const fakeRequire = (id) => (id === 'child_process' ? { execSync } : nodeRequire(id));
  const core = {
    info: (m) => log.info.push(m), warning: (m) => log.warning.push(m),
    error: (m) => log.error.push(m), setFailed: (m) => log.failed.push(m),
  };
  const context = {
    repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', runId: 1,
    payload: { pull_request: { number: 7, base: { ref: 'main' } }, repository: { default_branch: 'main' } },
  };
  const fakeSetTimeout = (fn, ms) => { sleeps.push(ms); fn(); return 0; };

  const prev = { GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE };
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  process.env.GITHUB_WORKSPACE = root;
  Object.assign(process.env, env);
  try {
    const script = extractScript(workflowFile, step);
    await new AsyncFunction('require', 'github', 'context', 'core', 'setTimeout', script)(fakeRequire, github, context, core, fakeSetTimeout);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return { calls, args, log, sleeps };
}

const PR = {
  number: 7, body: 'Tier: T0 (docs)', created_at: '2026-11-01T00:00:00Z', labels: [],
  head: { sha: 'headsha', ref: 'feature' }, base: { ref: 'main' },
};
const predicateB64 = Buffer.from(readFileSync(path.join(root, 'operations', 'devops', 'tier-check-predicate.mjs'), 'utf8')).toString('base64');

/** A healthy API for tier-check; override single endpoints per test. */
function tierCheckApi(overrides = {}) {
  return {
    'pulls.get': [PR],
    'repos.getContent': (p) => {
      if (p.path === 'operations/devops/tier-check-predicate.mjs') return { content: predicateB64, encoding: 'base64' };
      throw httpError(404);
    },
    'pulls.listFiles': [[{ filename: 'docs/notes.md', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }]],
    'issues.listComments': [[]],
    'pulls.listReviews': [[]],
    'pulls.listCommits': [[{ commit: { committer: { date: '2026-11-02T00:00:00Z' } } }]],
    'issues.createComment': [{}],
    'issues.updateComment': [{}],
    ...overrides,
  };
}

const retryWarns = (log, name) => log.warning.filter((w) => w.startsWith('WARN tier-check: ') && w.includes(`${name} attempt`));

// ---------------------------------------------------------------- tier-check.yml

test('tier-check CONTROL: a healthy API evaluates with no failure and no retry WARN', async () => {
  const { log, calls } = await runWorkflow('tier-check.yml', tierCheckApi());
  assert.deepEqual(log.failed, [], `unexpected failure: ${log.failed} ${log.error}`);
  assert.deepEqual(log.warning, []);
  assert.equal(calls['pulls.get'], 1);
  assert.ok(log.info.some((m) => m.startsWith('tier-check verdict: pass=')), 'a real verdict was produced');
});

test('tier-check PASS ARM: a 503 on pulls.get then success still evaluates, with one WARN and a backoff', async () => {
  const { log, calls, sleeps } = await runWorkflow('tier-check.yml', tierCheckApi({ 'pulls.get': [503, PR] }));
  assert.deepEqual(log.failed, [], `unexpected failure: ${log.failed}`);
  assert.equal(calls['pulls.get'], 2);
  const w = retryWarns(log, 'pulls.get');
  assert.equal(w.length, 1);
  assert.match(w[0], /attempt 1\/3 got HTTP 503/);
  assert.deepEqual(sleeps, [2000]);
  assert.ok(log.info.some((m) => m.startsWith('tier-check verdict: pass=')));
});

test('tier-check FAIL ARM: a persistent 503 everywhere fails closed with CANNOT EVALUATE after 3 attempts', async () => {
  const all503 = Object.fromEntries(Object.keys(tierCheckApi()).map((k) => [k, [503]]));
  const { log, calls, sleeps } = await runWorkflow('tier-check.yml', all503);
  assert.equal(calls['pulls.get'], 3, 'bounded: exactly 3 attempts');
  assert.equal(log.failed.length, 1);
  assert.match(log.failed[0], /^CANNOT EVALUATE: pulls\.get failed after 3 attempt\(s\), last status 503/);
  assert.equal(retryWarns(log, 'pulls.get').length, 2);
  assert.deepEqual(sleeps.slice(0, 2), [2000, 4000], 'exponential backoff');
  // The CANNOT EVALUATE comment could not be posted either (GitHub still down) -- logged, and it
  // did not prevent the setFailed above.
  assert.ok(log.error.some((m) => m.includes('could not post the CANNOT EVALUATE comment')));
});

test('tier-check: a 404 on pulls.get is NOT retried and fails closed at once', async () => {
  const { log, calls } = await runWorkflow('tier-check.yml', tierCheckApi({ 'pulls.get': [404] }));
  assert.equal(calls['pulls.get'], 1);
  assert.deepEqual(retryWarns(log, 'pulls.get'), []);
  assert.match(log.failed[0], /^CANNOT EVALUATE: HTTP 404/);
});

test('tier-check: a 429 is retried (on the paginated listFiles)', async () => {
  const files = [{ filename: 'docs/notes.md', status: 'modified' }];
  const { log, calls } = await runWorkflow('tier-check.yml', tierCheckApi({ 'pulls.listFiles': [429, files] }));
  assert.deepEqual(log.failed, []);
  assert.equal(calls['pulls.listFiles'], 2);
  assert.match(retryWarns(log, 'pulls.listFiles')[0], /got HTTP 429/);
});

test('tier-check: getContent 404 still reads as "absent at head" (no retry), but a persistent 503 fails closed', async () => {
  const ok = await runWorkflow('tier-check.yml', tierCheckApi());
  assert.deepEqual(retryWarns(ok.log, 'repos.getContent'), [], 'the predicate read succeeded; no other getContent was retried');
  const down = await runWorkflow('tier-check.yml', tierCheckApi({ 'repos.getContent': [503] }));
  assert.equal(down.calls['repos.getContent'], 3);
  assert.match(down.log.failed[0], /^CANNOT EVALUATE: repos\.getContent failed after 3 attempt/);
});

test('tier-check: every GitHub API call in the script goes through retry()', () => {
  const code = extractScript('tier-check.yml').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const bare = code.match(/await github\.[^\n]*/g) || [];
  assert.deepEqual(bare, [], 'no GitHub call may bypass retry()');
  assert.match(code, /git show \$\{helperSha\}:operations\/devops\/github-retry\.mjs/, 'helper comes from the fetched base tip');
});

test('tier-check bootstrap: helper absent from the base tip -> WARN, calls run unretried, still fails closed', async () => {
  const { log, calls } = await runWorkflow('tier-check.yml', tierCheckApi({ 'pulls.get': [503, PR] }), { helperOnBase: false });
  assert.ok(log.warning.some((w) => /retry helper not loadable .* NOT retried/.test(w)));
  assert.equal(calls['pulls.get'], 1);
  assert.match(log.failed[0], /^CANNOT EVALUATE: HTTP 503/);
});

// ---------------------------------------------------------------- t1-approval-guard.yml

function t1Api(overrides = {}) {
  return {
    'pulls.get': [PR],
    'pulls.listCommits': [[{ commit: { committer: { date: '2026-11-02T00:00:00Z' } } }]],
    'issues.listComments': [[]],
    'pulls.listReviews': [[]],
    'issues.createComment': [{}],
    'issues.updateComment': [{}],
    'checks.create': [{}],
    ...overrides,
  };
}

test('t1-approval-guard PASS ARM: a 503 then success evaluates (OK check run posted) with a WARN', async () => {
  const { log, calls } = await runWorkflow('t1-approval-guard.yml', t1Api({ 'pulls.listReviews': [503, []] }));
  assert.deepEqual(log.failed, [], `unexpected failure: ${log.failed}`);
  assert.equal(calls['pulls.listReviews'], 2);
  assert.ok(log.warning.some((w) => /^WARN t1-approval-guard: pulls\.listReviews attempt 1\/3 got HTTP 503/.test(w)));
  assert.equal(calls['checks.create'], 1);
});

test('t1-approval-guard FAIL ARM: a persistent 503 fails closed with CANNOT EVALUATE', async () => {
  const { log, calls } = await runWorkflow('t1-approval-guard.yml', t1Api({ 'pulls.listCommits': [503] }));
  assert.equal(calls['pulls.listCommits'], 3);
  assert.match(log.failed[0], /^t1-approval-guard: CANNOT EVALUATE — pulls\.listCommits failed after 3 attempt/);
});

test('t1-approval-guard: a 404 is no longer retried (the old inline loop retried every error)', async () => {
  const { log, calls } = await runWorkflow('t1-approval-guard.yml', t1Api({ 'pulls.get': [404] }));
  // run() once, plus the catch's own best-effort re-read for the neutral check run: 2 calls, 0 retries.
  assert.equal(calls['pulls.get'], 2);
  assert.ok(!log.warning.some((w) => w.includes('attempt 1/3')));
  assert.match(log.failed[0], /CANNOT EVALUATE — HTTP 404/);
});

test('t1-approval-guard: a 429 is retried', async () => {
  const { log, calls } = await runWorkflow('t1-approval-guard.yml', t1Api({ 'pulls.get': [429, PR] }));
  assert.deepEqual(log.failed, []);
  assert.equal(calls['pulls.get'], 2);
  assert.ok(log.warning.some((w) => /pulls\.get attempt 1\/3 got HTTP 429/.test(w)));
});

// ------------------------------------- CANNOT EVALUATE must fail closed (t/4819, TL p/12#44)
// GitHub counts a `neutral` check run as satisfying a required check, so a neutral CANNOT
// EVALUATE would let an outage that exhausts the retries PASS the gate.

test('t1-approval-guard FAIL-CLOSED: exhausted retries post a `failure` check run (GATE-UNREADABLE), never `neutral`', async () => {
  const { args, log } = await runWorkflow('t1-approval-guard.yml', t1Api({ 'pulls.listCommits': [503] }));
  const runs = args['checks.create'] || [];
  assert.equal(runs.length, 1, 'exactly one explicit check run, pinned to the head');
  assert.equal(runs[0].head_sha, 'headsha');
  assert.equal(runs[0].name, 't1-approval-guard');
  assert.equal(runs[0].conclusion, 'failure');
  assert.notEqual(runs[0].conclusion, 'neutral');
  assert.match(runs[0].output.title, /GATE-UNREADABLE \(CANNOT EVALUATE\)/);
  assert.match(runs[0].output.summary, /^GATE-UNREADABLE: .*\n.*not a pass/);
  assert.match(runs[0].output.summary, /pulls\.listCommits failed after 3 attempt/);
  assert.match(log.failed[0], /CANNOT EVALUATE/);
});

test('t1-approval-guard FAIL-CLOSED: a non-retryable crash (404) also concludes `failure`', async () => {
  // pulls.get works for the catch's re-read but run() dies on a 404 from listReviews.
  const { args } = await runWorkflow('t1-approval-guard.yml', t1Api({ 'pulls.listReviews': [404] }));
  assert.deepEqual((args['checks.create'] || []).map((r) => r.conclusion), ['failure']);
});

test('no code line in either gate workflow can conclude `neutral`', () => {
  for (const wf of ['t1-approval-guard.yml', 'tier-check.yml']) {
    const code = extractScript(wf).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.ok(!/['"`]neutral['"`]/.test(code), `${wf}: a 'neutral' conclusion would read as a pass on a required check`);
  }
});

test('tier-check posts no explicit check run: CANNOT EVALUATE is the job\'s own failure (setFailed)', async () => {
  const all503 = Object.fromEntries(Object.keys(tierCheckApi()).map((k) => [k, [503]]));
  const { calls, log } = await runWorkflow('tier-check.yml', all503);
  assert.equal(calls['checks.create'] ?? 0, 0);
  assert.equal(log.failed.length, 1);
  assert.match(log.failed[0], /^CANNOT EVALUATE: /);
});

// t/562 (Lead p/233#71): the merge-group guard paths pass the 15-min, one-wait rate-limit option, and
// their jobs' timeout-minutes cover it. A later edit that drops the option, or shrinks the timeout below
// the wait, fails here.
test('t/562: merge-approval and the ci.yml merge-group t1 guard pass maxRateWaitMs 15 min, maxRateWaits 1, with a 25-min job', () => {
  const wf = (f) => readFileSync(path.join(root, '.github', 'workflows', f), 'utf8').replace(/\r\n/g, '\n');
  const ma = wf('merge-approval.yml');
  assert.match(ma, /prefix: 'merge-approval', maxRateWaitMs: 15 \* 60 \* 1000, maxRateWaits: 1/);
  assert.match(ma, /name: merge-approval \(compute\)\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: 25\b/);
  const ci = wf('ci.yml');
  assert.match(ci, /prefix: 't1-approval-guard \(merge_group\)',[\s\S]{0,400}?maxRateWaitMs: 15 \* 60 \* 1000,\s*\n\s*maxRateWaits: 1,/);
  assert.match(ci, /timeout-minutes: 25 {2}# same budget as consult-hold-guard\/joint-gv-guard above \(t\/562/);
});

// ---------------------------------------------------------------- t/238: cl-path-check.yml and ci.yml shared-input coverage

/** A primary rate-limit 403 whose quota resets `inSecs` from now. */
function rateLimited403(inSecs = 10) {
  const e = httpError(403);
  e.message = 'API rate limit exceeded for installation';
  e.response = { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + inSecs) } };
  return e;
}
/** A permission 403 with quota left: a real denial. */
function permission403() {
  const e = httpError(403);
  e.message = 'Resource not accessible by integration';
  e.response = { headers: { 'x-ratelimit-remaining': '4321' } };
  return e;
}
const bareGithubCalls = (workflowFile, step) => {
  const code = extractScript(workflowFile, step).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  return code.match(/await github\.[^\n]*/g) || [];
};
const prefixedWarns = (log, prefix, name) => log.warning.filter((w) => w.startsWith(`WARN ${prefix}: `) && w.includes(`${name} attempt`));

function clPathApi(overrides = {}) {
  return {
    'pulls.get': [PR],
    'pulls.listFiles': [[{ filename: 'docs/notes.md', status: 'modified' }]],
    'issues.listComments': [[]],
    'issues.createComment': [{}],
    'issues.updateComment': [{}],
    ...overrides,
  };
}
const clVerdict = (log) => log.info.some((m) => m.startsWith('cl-path-check verdict:') || m.startsWith('cl-path-check: verdict skipped'));

test('t/238 cl-path-check: every GitHub API call goes through retry(), and the helper comes from the base tip', () => {
  assert.deepEqual(bareGithubCalls('cl-path-check.yml'), [], 'no GitHub call may bypass retry()');
  assert.match(extractScript('cl-path-check.yml'), /git show \$\{helperSha\}:operations\/devops\/github-retry\.mjs/);
});

test('t/238 cl-path-check CONTROL: a healthy API evaluates with no retry WARN', async () => {
  const { log, calls } = await runWorkflow('cl-path-check.yml', clPathApi());
  assert.deepEqual(log.failed, [], `unexpected failure: ${log.failed} ${log.error}`);
  assert.deepEqual(log.warning, []);
  assert.equal(calls['pulls.get'], 1);
  assert.ok(clVerdict(log), 'a verdict (or a bootstrap skip) was produced');
});

test('t/238 cl-path-check: a rate-limited 403 on pulls.get waits for the reset, then evaluates', async () => {
  const { log, calls, sleeps } = await runWorkflow('cl-path-check.yml', clPathApi({ 'pulls.get': [rateLimited403(10), PR] }));
  assert.deepEqual(log.failed, [], `unexpected failure: ${log.failed}`);
  assert.equal(calls['pulls.get'], 2);
  assert.match(prefixedWarns(log, 'cl-path-check', 'pulls.get')[0], /hit a rate limit \(HTTP 403\) -- waiting \d+ms for the reset/);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 0 && sleeps[0] <= 30000, `waited ${sleeps[0]}ms, capped by MAX_RATE_WAIT_MS`);
  assert.ok(clVerdict(log));
});

test('t/238 cl-path-check: a permission 403 is not retried and reads CANNOT EVALUATE', async () => {
  const { log, calls, sleeps } = await runWorkflow('cl-path-check.yml', clPathApi({ 'pulls.get': [permission403()] }));
  assert.equal(calls['pulls.get'], 1);
  assert.deepEqual(sleeps, []);
  assert.match(log.failed[0], /^CANNOT EVALUATE: Resource not accessible/);
});

test('t/238 cl-path-check: a persistent 503 fails closed after 3 attempts on the paginated listFiles', async () => {
  const { log, calls } = await runWorkflow('cl-path-check.yml', clPathApi({ 'pulls.listFiles': [503] }));
  assert.equal(calls['pulls.listFiles'], 3);
  assert.match(log.failed[0], /^CANNOT EVALUATE: pulls\.listFiles failed after 3 attempt/);
});

test('t/238 cl-path-check bootstrap: helper absent from the base tip -> WARN, calls run once', async () => {
  const { log, calls } = await runWorkflow('cl-path-check.yml', clPathApi({ 'pulls.get': [503, PR] }), { helperOnBase: false });
  assert.ok(log.warning.some((w) => /^WARN cl-path-check: retry helper not loadable .* NOT retried/.test(w)));
  assert.equal(calls['pulls.get'], 1);
  assert.match(log.failed[0], /^CANNOT EVALUATE: HTTP 503/);
});

const COVERAGE_STEP = 'Evaluate shared-input coverage';
const coverageEnv = { FILTER_OUTPUTS: JSON.stringify({}) };
function coverageApi(overrides = {}) {
  return {
    'pulls.listFiles': [[{ filename: 'docs/notes.md', status: 'modified' }]],
    'issues.listComments': [[]],
    'issues.createComment': [{}],
    'issues.updateComment': [{}],
    ...overrides,
  };
}
const coverageRan = (log) => log.info.some((m) => /^ci-shared-input-coverage: (\d+ under-covered|skipped \(bootstrap\))/.test(m));

test('t/238 ci-shared-input-coverage: every GitHub API call goes through retry(), and the helper comes from the base tip', () => {
  assert.deepEqual(bareGithubCalls('ci.yml', COVERAGE_STEP), [], 'no GitHub call may bypass retry()');
  assert.match(extractScript('ci.yml', COVERAGE_STEP), /git show \$\{helperSha\}:operations\/devops\/github-retry\.mjs/);
});

test('t/238 ci-shared-input-coverage CONTROL: a healthy API evaluates with no retry WARN', async () => {
  const { log, calls } = await runWorkflow('ci.yml', coverageApi(), { step: COVERAGE_STEP, env: coverageEnv });
  assert.deepEqual(log.warning, [], `unexpected warnings: ${log.warning}`);
  assert.equal(calls['pulls.listFiles'], 1);
  assert.ok(coverageRan(log));
});

test('t/238 ci-shared-input-coverage: a rate-limited 403 on listFiles waits for the reset, then evaluates', async () => {
  const files = [{ filename: 'docs/notes.md', status: 'modified' }];
  const { log, calls, sleeps } = await runWorkflow('ci.yml', coverageApi({ 'pulls.listFiles': [rateLimited403(5), files] }), { step: COVERAGE_STEP, env: coverageEnv });
  assert.equal(calls['pulls.listFiles'], 2);
  assert.match(prefixedWarns(log, 'ci-shared-input-coverage', 'pulls.listFiles')[0], /hit a rate limit \(HTTP 403\)/);
  assert.equal(sleeps.length, 1);
  assert.ok(coverageRan(log));
});

test('t/238 ci-shared-input-coverage: a permission 403 is not retried; the crash is a WARN (advisory), never a pass', async () => {
  const { log, calls, sleeps } = await runWorkflow('ci.yml', coverageApi({ 'pulls.listFiles': [permission403()] }), { step: COVERAGE_STEP, env: coverageEnv });
  assert.equal(calls['pulls.listFiles'], 1);
  assert.deepEqual(sleeps, []);
  assert.ok(log.warning.some((w) => w.startsWith('ci-shared-input-coverage CRASHED:')));
  assert.ok(!coverageRan(log), 'no coverage verdict after a crash');
});
