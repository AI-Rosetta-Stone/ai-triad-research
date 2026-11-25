#!/usr/bin/env bash
# t/591 (DeployAzure, t/579 hotfix incident 2026-11-25; TL p/45#207): the deploy preflight's
# "Verify container-relevant CI passed for this commit", extracted from deploy-azure.yml so it can be
# tested with a shimmed `gh` (operations/devops/test-verify-deploy-ci.sh).
#
# WHAT CHANGED from the inline step, and why:
#   1. CI is judged by ANY completed run on the deploy SHA (or its nearest ancestor that has CI runs,
#      the docs-only walk, unchanged) whose test-container job is success or skipped, AND whose event
#      is TRUSTED: a push to main, merge_group, or workflow_dispatch. Not by recency: in the incident
#      the newest run was a QUEUED pull_request run from an accidental PR on the hotfix branch, and it
#      displaced a green workflow_dispatch run. A pull_request run never counts, green or not.
#      No green trusted run -> if a trusted run is still queued or in progress, wait for the newest one
#      and judge it; otherwise FAIL CLOSED, listing the runs seen.
#   2. API errors are never "CI failed". A primary rate limit (an HTTP 403/429 or 'rate limit' text,
#      with the core pool at remaining 0 per `gh api rate_limit`, which does not count against the
#      limit) waits for the reset ONCE if it is within RL_MAX_WAIT_S, then retries; otherwise it fails
#      with "cannot verify CI (rate limit, resets at ...)". Any other API failure fails with "cannot
#      verify CI (API error: ...)" after a short backoff. Either way: exit 1, deploy blocked, honest text.
#      RL_MAX_WAIT_S is 600 (10 min): the preflight job's 15-minute timeout is deliberate (SO C2,
#      t/4194: it holds the workflow-wide concurrency slot), so the wait must fit inside it.
#
# Inputs (env): DEPLOY_SHA (hex, validated upstream by the resolve_digest step), GH_REPO (owner/name).
# Test-only overrides: RL_SLEEP (command used instead of sleep), RL_NOW (epoch seconds),
# RL_MAX_WAIT_S, and RUN_WATCH (command used instead of `gh run watch`).
# Exit 0 = container-relevant CI passed; exit 1 = blocked (with a ::error:: line saying why).
set -uo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
: "${GH_REPO:?GH_REPO is required}"
RL_MAX_WAIT_S="${RL_MAX_WAIT_S:-600}"
_sleep() { ${RL_SLEEP:-sleep} "$1"; }
_now() { if [ -n "${RL_NOW:-}" ]; then echo "$RL_NOW"; else date +%s; fi; }
_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "epoch $1"; }
WAITED=0
ERRF="${RUNNER_TEMP:-/tmp}/verify-deploy-ci.$$.err"

# Messages go to STDERR: api() runs inside $(...), where stdout is the captured data. Callers do
# `x=$(api ...) || exit 1`, so a block() inside api() ends the whole script, not just the subshell.
block() { echo "::error::$1" >&2; exit 1; }

# api ARGS... : `gh api ARGS`, with the rate-limit wait and a short backoff. Prints stdout on success;
# on a final failure it BLOCKS the deploy with "cannot verify CI", never "CI failed".
api() {
  local attempt=0 out err rl remaining reset wait_s
  while :; do
    if out=$(gh api "$@" 2>"$ERRF"); then printf '%s' "$out"; return 0; fi
    err=$(head -c 300 "$ERRF" 2>/dev/null | tr '\n' ' ')
    if grep -qiE 'rate limit|HTTP 403|HTTP 429' "$ERRF" 2>/dev/null; then
      if ! rl=$(gh api rate_limit --jq '.resources.core | "\(.remaining) \(.reset)"' 2>/dev/null) || ! [[ "$rl" =~ ^[0-9]+\ [0-9]+$ ]]; then
        block "cannot verify CI (an API read failed: ${err}; and the rate_limit probe was unreadable, so a wait cannot be bounded). This is not a CI failure; re-run the deploy."
      fi
      remaining="${rl% *}"; reset="${rl#* }"
      if [ "$remaining" -eq 0 ]; then
        wait_s=$(( reset + 5 - $(_now) )); [ "$wait_s" -lt 0 ] && wait_s=0
        if [ "$WAITED" -eq 0 ] && [ "$wait_s" -le "$RL_MAX_WAIT_S" ]; then
          echo >&2 "::warning::WARN verify-deploy-ci: GitHub API rate limit exhausted (resets $(_iso "$reset")); waiting ${wait_s}s for the rate-limit reset, then retrying once (t/591)."
          _sleep "$wait_s"; WAITED=1; continue
        fi
        block "cannot verify CI (rate limit, resets at $(_iso "$reset")). This is not a CI failure; re-run the deploy after the reset."
      fi
      if ! grep -qiE 'rate limit|HTTP 429' "$ERRF" 2>/dev/null; then
        block "cannot verify CI (the API refused a read with quota left: ${err}). This is not a CI failure."
      fi
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 3 ]; then
      block "cannot verify CI (API error after 3 attempts: ${err}). This is not a CI failure; re-run the deploy."
    fi
    echo >&2 "::warning::verify-deploy-ci: API read attempt ${attempt}/3 failed (${err}); retrying in $((attempt * 3))s."
    _sleep $((attempt * 3))
  done
}

# test-container's conclusion (or status) in a run: success | skipped | failure | in_progress | "".
container_status() {
  api --paginate "repos/${GH_REPO}/actions/runs/$1/jobs?per_page=100" \
    --jq '.jobs[] | select(.name == "test-container") | .conclusion // .status'
}

trusted() { # event head_branch
  case "$1" in
    merge_group|workflow_dispatch) return 0 ;;
    push) [ "$2" = "main" ] ;;
    *) return 1 ;;
  esac
}

echo "Checking CI status for ${DEPLOY_SHA}..."
# Docs-only pushes to main are skipped by ci.yml paths-ignore, so the commit may have no CI run. Walk
# back up to 10 commits to the first one that HAS CI runs (docs-only commits cannot change the image).
COMMITS=$(api "repos/${GH_REPO}/commits?sha=${DEPLOY_SHA}&per_page=10" --jq '.[].sha') || exit 1
JUDGED=""; RUNS=""
for COMMIT in $COMMITS; do
  RUNS=$(api "repos/${GH_REPO}/actions/workflows/ci.yml/runs?head_sha=${COMMIT}&per_page=100" \
    --jq '.workflow_runs[] | [.id, .event, .status, (.conclusion // ""), (.head_branch // "")] | map(tostring) | join("|")') || exit 1
  if [ -n "$RUNS" ]; then JUDGED="$COMMIT"; break; fi
done
[ -n "$JUDGED" ] || block "No CI run found for commit ${DEPLOY_SHA} or recent ancestors. CI must run before deploying."
[ "$JUDGED" = "$DEPLOY_SHA" ] || echo "Commit ${DEPLOY_SHA} has no CI run (docs-only skip). Judging ancestor ${JUDGED}."

SEEN=""; WAIT_ID=""
# '|' and not a tab: tab is whitespace to `read`, so an empty conclusion would shift the columns.
while IFS='|' read -r id event status conclusion branch; do
  [ -n "$id" ] || continue
  SEEN="${SEEN} ${id}:${event}:${status}:${conclusion:-none}"
  trusted "$event" "$branch" || continue
  if [ "$status" = "completed" ]; then
    st=$(container_status "$id") || exit 1
    if [ "$st" = "success" ] || [ "$st" = "skipped" ]; then
      echo "  test-container: ${st} in CI run ${id} (${event}${branch:+ on ${branch}})"
      echo "Container-relevant CI passed for this commit"
      exit 0
    fi
  elif [ -z "$WAIT_ID" ]; then
    WAIT_ID="$id"   # runs are listed newest first
  fi
done <<< "$RUNS"

if [ -n "$WAIT_ID" ]; then
  echo "No completed green trusted CI run yet; CI run ${WAIT_ID} is still running. Waiting for it..."
  ${RUN_WATCH:-gh run watch} "$WAIT_ID" >/dev/null 2>&1 || true
  st=$(container_status "$WAIT_ID") || exit 1
  if [ "$st" = "success" ] || [ "$st" = "skipped" ]; then
    echo "  test-container: ${st} in CI run ${WAIT_ID}"
    echo "Container-relevant CI passed for this commit"
    exit 0
  fi
  block "CI run ${WAIT_ID} finished with test-container '${st:-not found}'. Container-relevant CI must pass before deploying."
fi

block "No completed green CI run (test-container success or skipped) from a trusted event (push to main, merge_group, workflow_dispatch) on ${JUDGED}. Runs seen:${SEEN}. Pull-request runs never count. Deploy blocked."
