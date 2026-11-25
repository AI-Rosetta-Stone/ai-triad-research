// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4819: unit tests for the shared GitHub retry helper. The end-to-end arms (the real
// tier-check.yml / t1-approval-guard.yml scripts run against a mocked API) live in
// github-retry-workflow.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTEMPTS, MAX_RATE_WAIT_MS, backoffMs, isRateLimited, isRetryableStatus, rateLimitResetMs, statusOf, withGitHubRetry,
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

// ── t/125: rate-limited 403 (GitHub sends primary and secondary limits as 403) ──

const NOW_MS = Date.parse('2026-11-15T00:00:00Z');
const rlError = (remaining, resetSecs, message = 'API rate limit exceeded for installation') => {
  const e = new Error(message);
  e.status = 403;
  e.response = { headers: { 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': String(resetSecs) } };
  return e;
};
const quiet = { warn: () => {}, now: () => NOW_MS };

test('t/125: isRateLimited reads the 403 quota header or a rate-limit message; a plain 403 is not', () => {
  assert.equal(isRateLimited(rlError('0', 0)), true);
  assert.equal(isRateLimited(httpError(403, 'API rate limit exceeded')), true, 'a message-only rate limit, with no quota header');
  assert.equal(isRateLimited(rlError('4999', NOW_MS / 1000 + 60, 'Rate limit feature is not enabled on this repository')), false, 'a non-quota 403 that mentions a rate limit: quota left, so not a quota hit');
  assert.equal(isRateLimited(httpError(403, 'Resource not accessible by integration')), false);
  assert.equal(isRateLimited(httpError(404, 'API rate limit exceeded')), false, 'only 403 and 429 are rate-limited');
});

test('t/125: a rate-limited 403 with a reset 20 s away waits for the reset, then retries and succeeds', async () => {
  const waits = [];
  let calls = 0;
  const fn = async () => { calls++; if (calls === 1) throw rlError('0', NOW_MS / 1000 + 20); return 'ok'; };
  const out = await withGitHubRetry('label', fn, { ...quiet, sleep: async (ms) => waits.push(ms) });
  assert.equal(out, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [21000], 'waits the 20 s to the reset plus 1 s');
});

test('t/125: a rate-limited 403 whose reset is beyond the 30 s wait fails at once, naming the re-run time', async () => {
  let calls = 0;
  const reset = NOW_MS / 1000 + 3600; // an hour away (beyond the 30 s cap)
  const fn = async () => { calls++; throw rlError('0', reset); };
  await assert.rejects(
    withGitHubRetry('tier-check: pulls.get', fn, { ...quiet, sleep: async () => { throw new Error('must not sleep'); } }),
    (err) => {
      assert.match(err.message, /RATE-LIMITED, re-run after \d{2}:\d{2}Z/);
      assert.equal(err.status, 403, 'the status is kept for callers that branch on it');
      return true;
    },
  );
  assert.equal(calls, 1, 'no retry when the reset is beyond the wait window');
  assert.ok(MAX_RATE_WAIT_MS <= 30000, 'the wait stays inside the 1-minute gate job budget');
});

test('t/125: a rate limit with no reset header fails closed at once (reset time unknown)', async () => {
  let calls = 0;
  const fn = async () => { calls++; throw httpError(403, 'You have exceeded a secondary rate limit'); };
  await assert.rejects(withGitHubRetry('label', fn, quiet), (err) => /RATE-LIMITED, re-run after the API quota resets/.test(err.message));
  assert.equal(calls, 1);
});

test('t/125: a plain 403 stays final (one call, the original error)', async () => {
  let calls = 0;
  const err = httpError(403, 'Resource not accessible by integration');
  await assert.rejects(withGitHubRetry('label', async () => { calls++; throw err; }, quiet), (e) => e === err);
  assert.equal(calls, 1);
});

test('t/125: a 404 stays final (one call)', async () => {
  let calls = 0;
  await assert.rejects(withGitHubRetry('label', async () => { calls++; throw httpError(404, 'Not Found'); }, quiet));
  assert.equal(calls, 1);
});

test('t/125: the reset epoch is read from x-ratelimit-reset (seconds to ms)', () => {
  assert.equal(rateLimitResetMs(rlError('0', 1700000000)), 1700000000000);
  assert.equal(rateLimitResetMs(httpError(403, 'x')), null);
});

// ── t/562 (Lead p/233#71): maxRateWaitMs / maxRateWaits for the merge-group guard paths ──
const FIFTEEN_MIN = 15 * 60 * 1000;

test('t/562: the default wait is unchanged -- a reset 10 min away still fails at once without the option', async () => {
  let calls = 0;
  const fn = async () => { calls++; throw rlError('0', NOW_MS / 1000 + 600); };
  await assert.rejects(withGitHubRetry('label', fn, { ...quiet, sleep: async () => { throw new Error('must not sleep'); } }), /RATE-LIMITED/);
  assert.equal(calls, 1);
});

test('t/562: maxRateWaitMs 15 min -- a reset 10 min away is waited for, then the call succeeds', async () => {
  const waits = [];
  let calls = 0;
  const fn = async () => { calls++; if (calls === 1) throw rlError('0', NOW_MS / 1000 + 600); return 'ok'; };
  const out = await withGitHubRetry('pulls.get #1', fn, { ...quiet, maxRateWaitMs: FIFTEEN_MIN, maxRateWaits: 1, sleep: async (ms) => waits.push(ms) });
  assert.equal(out, 'ok');
  assert.deepEqual(waits, [601000], 'waits the 600 s to the reset plus 1 s');
});

test('t/562: maxRateWaits 1 -- a second rate limit after the wait fails closed, naming the re-run time', async () => {
  const waits = [];
  let calls = 0;
  const fn = async () => { calls++; throw rlError('0', NOW_MS / 1000 + 600); };
  await assert.rejects(
    withGitHubRetry('pulls.get #1', fn, { ...quiet, maxRateWaitMs: FIFTEEN_MIN, maxRateWaits: 1, sleep: async (ms) => waits.push(ms) }),
    /RATE-LIMITED, re-run after \d{2}:\d{2}Z/,
  );
  assert.equal(calls, 2, 'one wait, one retry');
  assert.equal(waits.length, 1);
});

test('t/562: maxRateWaitMs 15 min -- a reset 40 min away still fails at once', async () => {
  let calls = 0;
  const fn = async () => { calls++; throw rlError('0', NOW_MS / 1000 + 2400); };
  await assert.rejects(withGitHubRetry('label', fn, { ...quiet, maxRateWaitMs: FIFTEEN_MIN, maxRateWaits: 1, sleep: async () => { throw new Error('must not sleep'); } }), /RATE-LIMITED/);
  assert.equal(calls, 1);
});
