# Runbook: GitHub API Refusal (403) and Circuit Breaker Open

Covers the two alerts added in t/4202 — observability for the 10-13 outage, where the primary
rate-limit alerts (`rate-limit-exhaustion.md`) didn't distinguish a 403 refusal (secondary rate
limit / abuse detection) or the circuit breaker opening from an ordinary 429.

## `alert-github-api-refused`

**Trigger:** `alert-github-api-refused` fires (a 403 response from the GitHub API — distinct from
the 429s covered by `rate-limit-exhaustion.md`)

### Symptoms
- Structured logs show `github-api-refused-403` (Pino, `log.github.warn`) with `retryAfterSec`,
  `remaining`, `limit`, `resetAt` and `apiMessage` fields
- Flight recorder shows a `github.api.refused` event, message "Refused by GitHub API (403)"
- A single refusal with a valid `Retry-After` retries once automatically (capped at 60s); a
  refusal with no `Retry-After`, or past the retry budget, fails the call

### Steps
1. **Pull the refusal detail from Log Analytics:**
   ```kusto
   ContainerAppConsoleLogs_CL
   | where Log_s has "github-api-refused-403"
   | project TimeGenerated, Log_s
   | order by TimeGenerated desc
   | take 20
   ```
2. **Check which limit is involved:** a 403 with a GitHub abuse-detection message in `apiMessage`
   (e.g. "You have exceeded a secondary rate limit") is NOT the same as a primary rate-limit 429 —
   don't apply `rate-limit-exhaustion.md`'s steps here.
3. **Check for a burst pattern:** secondary rate limits are usually triggered by request
   concurrency/burst rate, not raw volume — look for a tight cluster of GitHub API calls just
   before the first refusal (`github.api.request` events, same window).
4. **If it's a genuine abuse-detection false positive** (e.g. a legitimate burst from a sync job):
   consider whether the burst can be spread out, or whether GitHub support needs to be contacted
   if it recurs.
5. **If `retryAfterSec` was present:** the single automatic retry already ran — check whether it
   succeeded (a second `github-api-refused-403` within the same request means it didn't).

## `alert-github-circuit-open`

**Trigger:** `alert-github-circuit-open` fires (the circuit breaker opened — matches the
`circuit-breaker-open` string in console logs, the proven marker from the 10-13 outage: 31,747
hits during the outage window vs. 0 in a clean window)

### Symptoms
- Structured logs show `circuit-breaker-open-transition: closed → open` (Pino, `log.github.warn`,
  with `consecutiveFailures`)
- App serves from cache only — all live GitHub API calls are short-circuited
- `/health` returns `storage.fallbackActive: true` (same symptom as `github-outage.md` — the
  circuit opening IS the mechanism behind that runbook's trigger)

### Steps
1. **Confirm the open transition and its cause:**
   ```kusto
   ContainerAppConsoleLogs_CL
   | where Log_s has "circuit-breaker-open" or Log_s has "github-api-refused-403"
   | project TimeGenerated, Log_s
   | order by TimeGenerated asc
   ```
   Look for the refusal/rate-limit events immediately preceding the open transition — the circuit
   opens after a run of consecutive failures, so the preceding events usually name the root cause
   (403 refusal, 429 exhaustion, or a genuine GitHub outage).
2. **Follow `github-outage.md` from step 2 onward** — once the circuit is open, the recovery
   mechanism (adaptive half-open probing, auto-resume) is identical regardless of what caused the
   failures that opened it.
3. **No manual intervention needed to close the circuit** — it auto-probes and recovers. Only
   intervene if `consecutiveFailures` keeps climbing after probing should have succeeded (checked
   via `githubstatus.com` — if GitHub itself is healthy and failures persist, that points to a
   local credential/network issue, not an upstream outage).

## Prevention
- `handleGithubRefusal()` (`githubRestClient.ts`) centralizes 403 handling so both the Pino log
  line and the retry decision stay in one place — any future refusal-handling change should land
  there, not as a second ad-hoc branch.
- Both alerts' `evaluationFrequency`/`windowSize` are tuned for the $30/month Azure budget
  (PT15M refusal, PT5M circuit-open) — don't tighten them without checking the cost margin.
  Circuit-open stays at PT5M even under cost pressure: since #3266 an open circuit returns
  503 on hosted saves, so it is a user-facing outage signal (t/4248, SO C1).
