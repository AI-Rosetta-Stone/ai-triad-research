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

/** The `script: |` block of the workflow's single github-script step, dedented. */
function extractScript(workflowFile) {
  const lines = readFileSync(path.join(root, '.github', 'workflows', workflowFile), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^\s*script:\s*\|\s*$/.test(l));
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
async function runWorkflow(workflowFile, api, { helperOnBase = true } = {}) {
  const calls = {};
  const log = { info: [], warning: [], error: [], failed: [] };
  const sleeps = [];

  function endpoint(name) {
    const fn = async (params) => {
      calls[name] = (calls[name] || 0) + 1;
      const spec = api[name];
      if (spec === undefined) throw new Error(`test harness: unmocked endpoint ${name}`);
      if (typeof spec === 'function') return { data: spec(params) };
      const step = spec[Math.min(calls[name] - 1, spec.length - 1)];
      if (typeof step === 'number') throw httpError(step);
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
    payload: { pull_request: { number: 7 }, repository: { default_branch: 'main' } },
  };
  const fakeSetTimeout = (fn, ms) => { sleeps.push(ms); fn(); return 0; };

  const prevWs = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = root;
  try {
    const script = extractScript(workflowFile);
    await new AsyncFunction('require', 'github', 'context', 'core', 'setTimeout', script)(fakeRequire, github, context, core, fakeSetTimeout);
  } finally {
    if (prevWs === undefined) delete process.env.GITHUB_WORKSPACE; else process.env.GITHUB_WORKSPACE = prevWs;
  }
  return { calls, log, sleeps };
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
