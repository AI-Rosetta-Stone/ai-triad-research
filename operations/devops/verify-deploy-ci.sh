#!/usr/bin/env bash
# t/591 (DeployAzure, t/579 hotfix incident 2026-11-25; TL p/45#207): the deploy preflight's
# "Verify container-relevant CI passed for this commit", extracted from deploy-azure.yml so it can be
# tested with a shimmed `gh` (operations/devops/test-verify-deploy-ci.sh).
#
# WHAT CHANGED from the inline step, and why:
#   1. CI is judged by ANY completed run on the deploy SHA (or its nearest ancestor that has CI runs,
#      accepted ONLY when every file changed since it is in ci.yml's paths-ignore) whose test-container
#      job is success (or skipped, from a push to main only: t/599), AND whose event is TRUSTED: a push to main or epic/**, merge_group, or
#      workflow_dispatch. Not by recency: in the incident
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
# t/754: container.yml's ci-gate runs this script too. Its messages say what to re-run.
RERUN_WHAT="${VERIFY_RERUN_WHAT:-the deploy}"
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
        block "cannot verify CI (an API read failed: ${err}; and the rate_limit probe was unreadable, so a wait cannot be bounded). This is not a CI failure; re-run ${RERUN_WHAT}."
      fi
      remaining="${rl% *}"; reset="${rl#* }"
      if [ "$remaining" -eq 0 ]; then
        wait_s=$(( reset + 5 - $(_now) )); [ "$wait_s" -lt 0 ] && wait_s=0
        if [ "$WAITED" -eq 0 ] && [ "$wait_s" -le "$RL_MAX_WAIT_S" ]; then
          echo >&2 "::warning::WARN verify-deploy-ci: GitHub API rate limit exhausted (resets $(_iso "$reset")); waiting ${wait_s}s for the rate-limit reset, then retrying once (t/591)."
          _sleep "$wait_s"; WAITED=1; continue
        fi
        block "cannot verify CI (rate limit, resets at $(_iso "$reset")). This is not a CI failure; re-run ${RERUN_WHAT} after the reset."
      fi
      if ! grep -qiE 'rate limit|HTTP 429' "$ERRF" 2>/dev/null; then
        block "cannot verify CI (the API refused a read with quota left: ${err}). This is not a CI failure."
      fi
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 3 ]; then
      block "cannot verify CI (API error after 3 attempts: ${err}). This is not a CI failure; re-run ${RERUN_WHAT}."
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

# Trusted events (Lead t/591): a push to main or to an epic/** integration branch (ci.yml runs on push
# to [main, 'epic/**']), merge_group, workflow_dispatch. CI on the exact SHA from an epic push is the
# same evidence as a dispatch on a branch: both run that branch's own ci.yml, an exposure the dispatch
# route already accepts. pull_request runs are never trusted.
trusted() { # event head_branch
  case "$1" in
    merge_group|workflow_dispatch) return 0 ;;
    push) [ "$2" = "main" ] || [[ "$2" == epic/* ]] ;;
    *) return 1 ;;
  esac
}

# Does test-container's result count as green? (t/599, SO p/273#4 and #6) `success` from any trusted event.
# `skipped` (ci.yml's paths filter found no container-relevant change) ONLY from a push to main: a
# workflow_dispatch, merge_group or epic/** run judges with ITS OWN ref's ci.yml, whose filter could differ
# from main's, so its skip proves nothing about the image.
counts_green() { # status event head_branch
  [ "$1" = "success" ] && return 0
  [ "$1" = "skipped" ] && [ "$2" = "push" ] && [ "$3" = "main" ]
}

# ci.yml's `on.push.paths-ignore`: a push that changes ONLY these paths runs no CI. One list, pinned to
# ci.yml by test-verify-deploy-ci.sh (it fails if the two ever differ).
CI_PATHS_IGNORE=('**.md' 'docs/**' 'deploy/azure/runbooks/**')
# A GitHub Actions glob as a regex: `**` matches across '/', `*` within one segment.
glob_re() {
  local g="$1" re="" i c
  for ((i = 0; i < ${#g}; i++)); do
    c="${g:i:1}"
    if [ "$c" = "*" ] && [ "${g:i+1:1}" = "*" ]; then re+=".*"; i=$((i + 1))
    elif [ "$c" = "*" ]; then re+="[^/]*"
    elif [[ "$c" =~ [.+?^\$\(\)\[\]\{\}\|\\] ]]; then re+="\\$c"
    else re+="$c"; fi
  done
  printf '^%s$' "$re"
}
ignored_by_ci() { # path
  local g; for g in "${CI_PATHS_IGNORE[@]}"; do [[ "$1" =~ $(glob_re "$g") ]] && return 0; done; return 1
}
# GitHub's compare API lists at most 300 files; at the cap the list may be cut short.
COMPARE_FILE_CAP=300

# t/754: container.yml passes a dispatch input, which may be a short SHA (the runs API's head_sha
# filter needs all 40 characters). The expansion goes through api(), so a rate limit here is
# "cannot verify CI" too, not "cannot resolve the SHA".
[[ "$DEPLOY_SHA" =~ ^[0-9a-fA-F]{7,40}$ ]] || block "'${DEPLOY_SHA}' is not a commit SHA (7 to 40 hex characters)."
if [ "${#DEPLOY_SHA}" -lt 40 ]; then
  FULL_SHA=$(api "repos/${GH_REPO}/commits/${DEPLOY_SHA}" --jq '.sha') || exit 1
  [[ "$FULL_SHA" =~ ^[0-9a-f]{40}$ ]] || block "cannot verify CI (expanding the short SHA '${DEPLOY_SHA}' returned '${FULL_SHA:0:60}', not a commit SHA). This is not a CI failure."
  echo "Expanded short SHA ${DEPLOY_SHA} to ${FULL_SHA}"
  DEPLOY_SHA="$FULL_SHA"
fi

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
if [ "$JUDGED" != "$DEPLOY_SHA" ]; then
  # t/591 (DeployAzure t/591#5, Lead p/233#124): an ancestor's CI stands in ONLY when every file changed
  # since it is one ci.yml ignores, i.e. CI skipped those commits on purpose. A commit where CI simply
  # did not run (a hotfix push that started no CI) must not pass on its parent's green.
  # First line: the file count; then one path per line. A rename also lists its previous_filename, and
  # both names must be ignored: renaming lib/x.ts to docs/x.ts removes code from the image (Lead p/233#126).
  CMP=$(api "repos/${GH_REPO}/compare/${JUDGED}...${DEPLOY_SHA}" --jq '(.files | length | tostring), (.files[] | .filename, (.previous_filename // empty))') || exit 1
  NFILES=$(printf '%s\n' "$CMP" | head -n 1)
  [[ "$NFILES" =~ ^[0-9]+$ ]] || block "cannot verify CI (the compare of ${JUDGED}...${DEPLOY_SHA} returned no file count). This is not a CI failure."
  if [ "$NFILES" -ge "$COMPARE_FILE_CAP" ]; then
    block "cannot verify CI (the compare of ${JUDGED}...${DEPLOY_SHA} lists ${NFILES} files, GitHub's cap, so it may be cut short and cannot prove the commits are docs-only). Dispatch ci.yml on a branch whose head is ${DEPLOY_SHA}, then re-run ${RERUN_WHAT}."
  fi
  CODE=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    ignored_by_ci "$f" || CODE="${CODE} ${f}"
  done < <(printf '%s\n' "$CMP" | tail -n +2)
  if [ -n "$CODE" ]; then
    block "no CI on ${DEPLOY_SHA}: the commits since ${JUDGED} (which has CI) change files CI does not ignore:$(printf '%s' "$CODE" | cut -c1-300). Dispatch ci.yml on a branch whose head is ${DEPLOY_SHA}, then re-run ${RERUN_WHAT}."
  fi
  echo "Commit ${DEPLOY_SHA} has no CI run, and the ${NFILES} file(s) changed since ${JUDGED} are all ignored by ci.yml (docs-only). Judging ancestor ${JUDGED}."
fi

SEEN=""; WAIT_ID=""; WAIT_EVENT=""; WAIT_BRANCH=""
# '|' and not a tab: tab is whitespace to `read`, so an empty conclusion would shift the columns.
while IFS='|' read -r id event status conclusion branch; do
  [ -n "$id" ] || continue
  SEEN="${SEEN} ${id}:${event}:${status}:${conclusion:-none}"
  trusted "$event" "$branch" || continue
  if [ "$status" = "completed" ]; then
    st=$(container_status "$id") || exit 1
    if counts_green "$st" "$event" "$branch"; then
      echo "  test-container: ${st} in CI run ${id} (${event}${branch:+ on ${branch}})"
      echo "Container-relevant CI passed for this commit"
      exit 0
    fi
    if [ "$st" = "skipped" ]; then
      echo "  test-container: skipped in CI run ${id} (${event}${branch:+ on ${branch}}), not counted: only a push to main's skip proves the image is unchanged (t/599)."
    fi
  elif [ -z "$WAIT_ID" ]; then
    WAIT_ID="$id"; WAIT_EVENT="$event"; WAIT_BRANCH="$branch"   # runs are listed newest first
  fi
done <<< "$RUNS"

if [ -n "$WAIT_ID" ]; then
  echo "No completed green trusted CI run yet; CI run ${WAIT_ID} is still running. Waiting for it..."
  ${RUN_WATCH:-gh run watch} "$WAIT_ID" >/dev/null 2>&1 || true
  st=$(container_status "$WAIT_ID") || exit 1
  if counts_green "$st" "$WAIT_EVENT" "$WAIT_BRANCH"; then
    echo "  test-container: ${st} in CI run ${WAIT_ID}"
    echo "Container-relevant CI passed for this commit"
    exit 0
  fi
  block "CI run ${WAIT_ID} (${WAIT_EVENT}${WAIT_BRANCH:+ on ${WAIT_BRANCH}}) finished with test-container '${st:-not found}'$( [ "$st" = "skipped" ] && echo ", and only a push to main's skip counts (t/599)" ). Container-relevant CI must pass before deploying."
fi

block "No completed green CI run (test-container success from a trusted event: push to main or epic/**, merge_group, workflow_dispatch; or skipped from a push to main) on ${JUDGED}. Runs seen:${SEEN}. Pull-request runs never count. Fix: dispatch ci.yml on a branch whose head is ${JUDGED} (or fix the failing run), then re-run ${RERUN_WHAT}."
