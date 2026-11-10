// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4819: unit tests for the shared GitHub retry helper. The end-to-end arms (the real
// tier-check.yml / t1-approval-guard.yml scripts run against a mocked API) live in
// github-retry-workflow.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTEMPTS, backoffMs, isRetryableStatus, statusOf, withGitHubRetry,
} from './github-retry.mjs';

function httpError(status, message = `HTTP ${status}`) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** fn that throws each status in `script` in turn (a non-number entry is returned as the value). */
function scripted(...script) {
  const calls = { n: 0 };
  const fn = async () => {
    const step = script[Math.min(calls.n, script.length - 1)];
    calls.n++;
    if (typeof step === 'number') throw httpError(step);
    return step;
  };
  return { fn, calls };
}

function harness() {
  const warns = [];
  const sleeps = [];
  return {
    warns, sleeps,
    opts: { warn: (m) => warns.push(m), sleep: async (ms) => { sleeps.push(ms); }, prefix: 'test', baseDelayMs: 100 },
  };
}

test('classifier: 429 and every 5xx are retryable; other 4xx, 2xx-ish and missing status are not', () => {
  for (const s of [429, 500, 502, 503, 504, 599]) assert.equal(isRetryableStatus(s), true, `${s}`);
  for (const s of [400, 401, 403, 404, 409, 422, 499, 600, 200, null, undefined, NaN]) assert.equal(isRetryableStatus(s), false, `${s}`);
});

test('statusOf reads .status, then .response.status, and tolerates junk', () => {
  assert.equal(statusOf(httpError(503)), 503);
  assert.equal(statusOf({ response: { status: 502 } }), 502);
  assert.equal(statusOf({ status: '429' }), 429);
  assert.equal(statusOf(new Error('no status')), null);
  assert.equal(statusOf(null), null);
});

test('backoff is exponential: base, 2*base, 4*base', () => {
  assert.deepEqual([1, 2, 3].map((a) => backoffMs(a, 100)), [100, 200, 400]);
});

test('PASS ARM: a 503 followed by success returns the value and logs exactly one WARN', async () => {
  const h = harness();
  const { fn, calls } = scripted(503, { data: 'ok' });
  const v = await withGitHubRetry('pulls.get', fn, h.opts);
  assert.deepEqual(v, { data: 'ok' });
  assert.equal(calls.n, 2);
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0], /^WARN test: pulls\.get attempt 1\/3 got HTTP 503/);
  assert.deepEqual(h.sleeps, [100]);
});

test('FAIL ARM: a persistent 503 throws after MAX_ATTEMPTS attempts, carrying status and cause', async () => {
  const h = harness();
  const { fn, calls } = scripted(503);
  await assert.rejects(withGitHubRetry('pulls.get', fn, h.opts), (err) => {
    assert.match(err.message, /^pulls\.get failed after 3 attempt\(s\), last status 503/);
    assert.equal(err.status, 503);
    assert.equal(err.cause.status, 503);
    return true;
  });
  assert.equal(MAX_ATTEMPTS, 3);
  assert.equal(calls.n, 3);
  assert.equal(h.warns.length, 2, 'a WARN per retry TAKEN (2), not per failure (3)');
  assert.deepEqual(h.sleeps, [100, 200]);
});

test('a 404 is not retried: one call, no WARN, no sleep, the original error rethrown', async () => {
  const h = harness();
  const { fn, calls } = scripted(404);
  await assert.rejects(withGitHubRetry('repos.getContent', fn, h.opts), (err) => err.status === 404 && err.message === 'HTTP 404');
  assert.equal(calls.n, 1);
  assert.deepEqual(h.warns, []);
  assert.deepEqual(h.sleeps, []);
});

test('other 4xx (401, 403, 422) and a status-less error are not retried either', async () => {
  for (const s of [401, 403, 422]) {
    const h = harness();
    const { fn, calls } = scripted(s);
    await assert.rejects(withGitHubRetry('x', fn, h.opts));
    assert.equal(calls.n, 1, `${s} must not be retried`);
  }
  const h = harness();
  let n = 0;
  await assert.rejects(withGitHubRetry('x', async () => { n++; throw new TypeError('boom'); }, h.opts), TypeError);
  assert.equal(n, 1);
});

test('a 429 is retried', async () => {
  const h = harness();
  const { fn, calls } = scripted(429, 'ok');
  assert.equal(await withGitHubRetry('issues.listComments', fn, h.opts), 'ok');
  assert.equal(calls.n, 2);
  assert.match(h.warns[0], /attempt 1\/3 got HTTP 429/);
});

test('a 503 then a 404 stops at the 404 (no retry of the 4xx)', async () => {
  const h = harness();
  const { fn, calls } = scripted(503, 404);
  await assert.rejects(withGitHubRetry('x', fn, h.opts), (err) => err.status === 404);
  assert.equal(calls.n, 2);
});
