// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4819: bounded retry for GitHub API calls made by workflows (PR gates + scheduled builds).
// t/236: Extended to handle rate-limit cascades — retry 403s with x-ratelimit-reset header.
//
// Policy:
//   - retry ONLY a 5xx, 429, or rate-limit 403 (with x-ratelimit-reset header);
//   - never retry permission 403s (no x-ratelimit-reset — they're real denials, fail fast);
//   - never retry anything else (404/422 are real answers, delaying won't help);
//   - for rate-limit errors (429 or 403 with x-ratelimit-reset), wait until reset time;
//   - for 5xx, use exponential backoff (base 2000ms, doubling per attempt);
//   - at most MAX_ATTEMPTS attempts;
//   - log a WARN for every retry actually taken;
//   - when retries run out, THROW. The caller's catch turns that into a failure.
//
// Trust: the workflows load this module from the default branch's live tip (git show), never
// from the PR tree, so a PR cannot weaken the retry policy in the same change it is judged by
// (same posture as tier-check-predicate.mjs). Keep it dependency-free: it is imported from a
// temp file, so a relative import would not resolve.

export const MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 2000;

/** HTTP status of an Octokit RequestError (or anything shaped like one), else null. */
export function statusOf(err) {
  if (!err || typeof err !== 'object') return null;
  const s = err.status ?? err.response?.status;
  const n = typeof s === 'string' ? Number(s) : s;
  return Number.isInteger(n) ? n : null;
}

/** Extract x-ratelimit-reset epoch seconds from error response headers, else null. */
export function rateLimitResetOf(err) {
  if (!err || typeof err !== 'object') return null;
  const reset = err.response?.headers?.['x-ratelimit-reset'];
  const n = typeof reset === 'string' ? Number(reset) : reset;
  return Number.isInteger(n) ? n : null;
}

/** True for a 429, a 5xx, or a rate-limit 403 (403 with x-ratelimit-reset header).
 * Permission 403s (no x-ratelimit-reset) are real denials and fail fast. */
export function isRetryableStatus(status, resetEpoch) {
  if (status === 429) return true;
  if (Number.isInteger(status) && status >= 500 && status <= 599) return true;
  if (status === 403 && Number.isInteger(resetEpoch)) return true; // rate-limit 403
  return false;
}

/** Delay before the retry that follows failed attempt `attempt` (1-based): base * 2^(attempt-1). */
export function backoffMs(attempt, baseDelayMs = DEFAULT_BASE_DELAY_MS) {
  return baseDelayMs * 2 ** (attempt - 1);
}

/**
 * Run `fn` (an async GitHub API call), retrying a 5xx, 429, or rate-limit 403 up to maxAttempts.
 * For rate-limit errors (429 or 403 with x-ratelimit-reset), waits until the reset time.
 * For 5xx, uses exponential backoff.
 * Permission 403s (no x-ratelimit-reset) fail fast — they're real denials, not transient.
 * Rethrows non-retryable errors immediately. When retries run out, throws an Error with the
 * call label, attempt count, last status, and original error as cause.
 */
export async function withGitHubRetry(label, fn, opts = {}) {
  const {
    warn = (m) => console.warn(m),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxAttempts = MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    prefix = 'github-retry',
  } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      const resetEpoch = rateLimitResetOf(err);
      if (!isRetryableStatus(status, resetEpoch)) throw err;
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
      // For rate-limit errors, wait until quota resets; for 5xx, use exponential backoff
      let delay;
      if ((status === 429 || status === 403) && Number.isInteger(resetEpoch)) {
        const nowEpoch = Math.floor(Date.now() / 1000);
        const delaySeconds = Math.max(1, resetEpoch - nowEpoch + 1); // +1s buffer
        delay = delaySeconds * 1000;
      } else {
        // 5xx: exponential backoff
        delay = backoffMs(attempt, baseDelayMs);
      }
      warn(`WARN ${prefix}: ${label} attempt ${attempt}/${maxAttempts} got HTTP ${status} (${msg}) -- retrying in ${Math.ceil(delay / 1000)}s`);
      await sleep(delay);
    }
  }
}
