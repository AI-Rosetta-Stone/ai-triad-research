// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4819: bounded retry for GitHub API calls made by the PR-gate workflows (tier-check.yml,
// t1-approval-guard.yml). A single GitHub 503 made tier-check report a spurious CANNOT EVALUATE
// on #4450. Harmless while tier-check is advisory, but blocking once t/4103 promotes it.
//
// Policy:
//   - retry ONLY a 5xx or a 429 (transient, server-side or rate limit);
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
    maxAttempts = MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    prefix = 'github-retry',
  } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
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
