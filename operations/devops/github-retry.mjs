// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4819: bounded retry for GitHub API calls made by the PR-gate workflows (tier-check.yml,
// t1-approval-guard.yml). A single GitHub 503 made tier-check report a spurious CANNOT EVALUATE
// on #4450. Harmless while tier-check is advisory, but blocking once t/4103 promotes it.
//
// Policy:
//   - retry ONLY a 5xx or a 429 (transient, server-side or rate limit), and a RATE-LIMITED 403
//     (t/125: GitHub sends its primary and secondary rate limits as 403, with
//     x-ratelimit-remaining: 0 or a 'rate limit' message). A rate-limited 403 waits for the reset
//     when the reset is near; otherwise it fails at once, saying when to re-run;
//   - never retry anything else, including every other 4xx (a 404/403/422 is a real answer and
//     a retry would only delay the same failure);
//   - at most MAX_ATTEMPTS attempts, exponential backoff (base, 2*base, ...);
//   - log a WARN for every retry actually taken;
//   - when retries run out, THROW. The caller's catch turns that into CANNOT EVALUATE, so the gate
//     still fails closed. Nothing here ever turns an error into a value.
//
// Trust: the workflows load this module from the default branch's live tip (git show), never
// from the PR tree, so a PR cannot weaken the retry policy in the same change it is judged by
// (same posture as tier-check-predicate.mjs). Keep it dependency-free: it is imported from a
// temp file, so a relative import would not resolve.

export const MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 2000;
// A rate-limit reset within this window is waited for; a later reset fails at once (t/125).
// 30 s, not 180 s: the rate-limit probe step in tier-check.yml and t1-approval-guard.yml has
// timeout-minutes: 1 (a step timeout, not the job's). A longer wait could be cut mid-wait. Several
// rate-limited calls in one run can stack past that minute; the job then fails closed and the
// re-run is the recovery. Known limit, TL decision (t/236). No job timeouts are raised here.
export const MAX_RATE_WAIT_MS = 30000;

/** HTTP status of an Octokit RequestError (or anything shaped like one), else null. */
export function statusOf(err) {
  if (!err || typeof err !== 'object') return null;
  const s = err.status ?? err.response?.status;
  const n = typeof s === 'string' ? Number(s) : s;
  return Number.isInteger(n) ? n : null;
}

/** True only for a 429 or a 5xx. Everything else (other 4xx, no status at all) is final. */
export function isRetryableStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
}

/** Delay before the retry that follows failed attempt `attempt` (1-based): base * 2^(attempt-1). */
export function backoffMs(attempt, baseDelayMs = DEFAULT_BASE_DELAY_MS) {
  return baseDelayMs * 2 ** (attempt - 1);
}

/** Response header value (lower-cased keys, as Octokit reports them), or null. */
export function headerOf(err, name) {
  const h = err?.response?.headers ?? err?.headers;
  if (!h || typeof h !== 'object') return null;
  const v = h[name] ?? h[name.toLowerCase()];
  return v === undefined || v === null ? null : String(v);
}

/**
 * True for a GitHub rate limit (primary or secondary): a 403 or 429 whose quota header is 0, or, with
 * no quota header at all, whose message names a rate limit. A 403 with quota left (a header that is
 * not 0) is a real answer, even if its message mentions a rate limit (t/125).
 */
export function isRateLimited(err) {
  const status = statusOf(err);
  if (status !== 403 && status !== 429) return false;
  if (headerOf(err, 'x-ratelimit-remaining') === '0') return true;
  // A quota header that says there is quota left means this is not a quota hit, whatever the message.
  if (headerOf(err, 'x-ratelimit-remaining') !== null) return false;
  const msg = err && err.message ? String(err.message) : '';
  return /rate limit/i.test(msg);
}

/** Epoch ms of the rate-limit reset from `x-ratelimit-reset` (epoch seconds), or null. */
export function rateLimitResetMs(err) {
  const v = headerOf(err, 'x-ratelimit-reset');
  const secs = v === null ? NaN : Number(v);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
}

/** HH:MMZ (UTC) for an epoch-ms instant. */
function hhmmz(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
}

/**
 * Run `fn` (an async GitHub call), retrying a 5xx/429 up to `maxAttempts` attempts in total.
 * Rethrows a non-retryable error at once. When attempts run out, throws an Error whose message
 * names the call, the attempt count and the last status; `.status` and `.cause` carry the last
 * underlying error so callers that branch on status still can.
 */
export async function withGitHubRetry(label, fn, opts = {}) {
  const {
    warn = (m) => console.warn(m),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    maxAttempts = MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    prefix = 'github-retry',
    // t/562 (Lead p/233#71): the default stays MAX_RATE_WAIT_MS (30 s, t/236) for the probe-step
    // callers. A merge-group guard path, whose job timeout covers it, passes a longer wait (15 min)
    // and maxRateWaits: 1, so one call waits for one reset at most and a second limit fails closed.
    maxRateWaitMs = MAX_RATE_WAIT_MS,
    maxRateWaits = Infinity,
  } = opts;
  let rateWaits = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      if (isRateLimited(err)) {
        // t/125: wait for a near reset and retry once more; otherwise fail now, saying when to re-run.
        // Still fail-closed: the caller's catch turns the throw into CANNOT EVALUATE.
        const resetMs = rateLimitResetMs(err);
        const waitMs = resetMs === null ? null : resetMs - now();
        if (waitMs === null || waitMs > maxRateWaitMs || attempt >= maxAttempts || rateWaits >= maxRateWaits) {
          const when = resetMs === null ? 'after the API quota resets (reset time unknown)' : `after ${hhmmz(resetMs)}`;
          const limited = new Error(`${label}: RATE-LIMITED, re-run ${when}. GitHub API quota exhausted.`, { cause: err });
          limited.status = status;
          throw limited;
        }
        const wait = Math.max(0, waitMs) + 1000;
        warn(`WARN ${prefix}: ${label} attempt ${attempt}/${maxAttempts} hit a rate limit (HTTP ${status}) -- waiting ${wait}ms for the reset`);
        rateWaits += 1;
        await sleep(wait);
        continue;
      }
      if (!isRetryableStatus(status)) throw err;
      const msg = err && err.message ? err.message : String(err);
      if (attempt >= maxAttempts) {
        const final = new Error(
          `${label} failed after ${attempt} attempt(s), last status ${status}: ${msg}. ` +
          'GitHub kept returning a transient error; re-run the workflow once the API recovers.',
          { cause: err },
        );
        final.status = status;
        throw final;
      }
      const delay = backoffMs(attempt, baseDelayMs);
      warn(`WARN ${prefix}: ${label} attempt ${attempt}/${maxAttempts} got HTTP ${status} (${msg}) -- retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}
