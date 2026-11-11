# BEGIN guard-pr-read (t/369)
# CANONICAL COPY: operations/devops/guard-pr-read.sh. consult-hold-guard.yml and joint-gv-guard.yml
# inline this block (they have no checkout); operations/devops/guard-pr-read.test.mjs fails if a
# copy drifts. Reads the PR over REST (core pool), not `gh pr view` (GraphQL pool, exhausted at
# 14:11Z on 2026-11-11, t/318#8).
#   guard_read_pr <guard> <owner/repo> <pr-number> <what-a-real-block-is>
# On success sets PR_JSON to the pulls payload. On failure prints one ::error:: line and exits 1
# (fail closed: required gate). The failure classes have different remedies, so each is named:
#   - primary quota at 0: INFRA rate-limit line + step outputs infra/resets, at once. Never sleeps
#     to the reset (up to an hour); DevOps & Release's ci-infra-rerun (#4967) re-runs once after it.
#   - secondary limit (retry-after, any 429, or the "secondary rate limit" / "abuse detection"
#     body): waits retry-after (or 60s if absent, per GitHub's docs), capped at 90s;
#     longer, or still limited on attempt 3, it is the same INFRA line with pool=secondary.
#   - 5xx / no response: retried with 3/6/9s backoff.
#   - any other 4xx (token, permission, not found): fails at once; a re-run will not fix it.
# Header value, or empty. `|| true`: the callers run under set -euo pipefail, and an absent header
# (grep finds nothing) must read as empty, not end the step.
_guard_hdr() { { tr -d '\r' <"$1" | sed '/^$/q' | grep -i "^$2:" | head -n 1 | sed 's/^[^:]*:[[:space:]]*//'; } || true; }
_guard_infra_ratelimit() {
  local resets pool="${1:-core}"
  resets=$(date -u -d "@$2" +%Y-%m-%dT%H:%M:%SZ)
  echo "infra=rate-limit" >>"${GITHUB_OUTPUT:-/dev/null}"
  echo "resets=${resets}" >>"${GITHUB_OUTPUT:-/dev/null}"
  echo "::error::INFRA rate-limit: GitHub API quota exhausted (pool=${pool}), resets=${resets}; not a policy verdict, re-run after the reset"
  exit 1
}
guard_read_pr() {
  local guard="$1" repo="$2" pr="$3" what="$4"
  local out="${RUNNER_TEMP:-/tmp}/${guard}.resp" errf="${RUNNER_TEMP:-/tmp}/${guard}.err"
  local attempt status remaining reset retry_after wait last_err=""
  PR_JSON=""
  for attempt in 1 2 3; do
    if gh api -i "repos/${repo}/pulls/${pr}" >"$out" 2>"$errf"; then
      PR_JSON=$(tr -d '\r' <"$out" | sed '1,/^$/d')
      return 0
    fi
    last_err=$(head -c 400 "$errf" 2>/dev/null | tr '\n' ' ')
    status=$(tr -d '\r' <"$out" | sed -n '1s/^HTTP\/[0-9.]* \([0-9][0-9]*\).*/\1/p')
    if [ "$status" = 403 ] || [ "$status" = 429 ]; then
      remaining=$(_guard_hdr "$out" x-ratelimit-remaining)
      reset=$(_guard_hdr "$out" x-ratelimit-reset)
      if [ "$remaining" = 0 ] && [[ "$reset" =~ ^[0-9]+$ ]]; then
        _guard_infra_ratelimit "$(_guard_hdr "$out" x-ratelimit-resource | tr -cd 'a-z_')" "$reset"
      fi
      retry_after=$(_guard_hdr "$out" retry-after)
      # Secondary: retry-after, a 429 (always a rate limit), or GitHub's body text, old or new.
      if [ -n "$retry_after" ] || [ "$status" = 429 ] || grep -qiE 'secondary rate limit|abuse detection' "$out"; then
        wait=60
        if [[ "$retry_after" =~ ^[0-9]+$ ]]; then wait=$retry_after; fi
        if [ "$wait" -gt 90 ] || [ "$attempt" -eq 3 ]; then
          _guard_infra_ratelimit secondary "$(( $(date +%s) + wait ))"
        fi
        echo "::warning::${guard}: secondary rate limit on attempt ${attempt}/3 (HTTP ${status}) — retrying in ${wait}s"
        sleep "$wait"
        continue
      fi
    fi
    if [ -n "$status" ] && [ "$status" -lt 500 ]; then
      echo "::error::${guard}: could NOT read the PR (HTTP ${status}) — API failure, NOT ${what}. Last error: ${last_err}. A token/permission error will NOT recover on re-run: fix the workflow. (Failing closed — required gate.)"
      exit 1
    fi
    echo "::warning::${guard}: PR read attempt ${attempt}/3 failed (HTTP ${status:-none}) — ${last_err} — retrying in $((attempt * 3))s"
    sleep $((attempt * 3))
  done
  echo "::error::${guard}: could NOT read the PR after 3 attempts — API/INFRA failure, NOT ${what}. Last error: ${last_err}. A transient 5xx -> re-run this job. (Failing closed — required gate.)"
  exit 1
}
# END guard-pr-read
