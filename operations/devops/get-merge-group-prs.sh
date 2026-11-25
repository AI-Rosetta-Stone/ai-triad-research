#!/usr/bin/env bash
# t/4567 C2: enumerate every PR in a merge_group batch and fail closed on any
# enumeration problem -- zero PRs found, an API failure, or not being able to
# locate ourselves in the queue are all treated as "cannot prove this batch is
# safe," not as "no PRs to check."
#
# REWRITTEN after a live-fire finding: the original design resolved each
# commit in compare(base_sha...head_sha) to a PR via GET /commits/{sha}/pulls.
# That is broken for a SQUASH-method merge queue -- the merge-group's test
# commit is an EPHEMERAL squash commit whose only parent is the base tip, not
# a merge commit carrying the original PR commits as ancestors, so
# /commits/{sha}/pulls can't resolve it to anything (observed: "resolves to
# ZERO PRs" on a single-PR group that unquestionably had one). The repository's
# own mergeQueue object is the correct, documented source: it lists every
# queued entry with its position and PR directly, no commit resolution needed.
#
# Usage: get-merge-group-prs.sh <repo> <ref>
# <ref> must be github.ref (NOT github.event.merge_group.head_ref -- a live-fire
# finding proved that field resolves to a bare SHA, not the gh-readonly-queue ref
# string the GitHub docs' shape implies; github.ref is the one field confirmed to
# carry refs/heads/gh-readonly-queue/<branch>/pr-<N>-<sha> on a merge_group event).
# Prints a JSON array of {number, labels: [string...], headSha} to stdout on success --
# every entry at or before THIS entry's own queue position. headSha is read from
# PullRequest.headRefOid AS PART OF THIS SAME QUERY -- i.e. contemporaneous with
# detecting the group's failure, not a separately-fetched "current head" moments
# later (SO F1 finding, t/4567#33/e/375#2: a stale separate fetch could silently
# re-enqueue an unreviewed commit if a push raced in). NOTE: MergeQueueEntry.headCommit.oid
# is NOT the right field here -- it is the ephemeral merge-group TEST (squash) commit,
# not the PR's own branch head, and fails enqueuePullRequest's expectedHeadOid check
# with "expected head oid does not match the current head oid" (caught live-fire,
# F2 double-failure arm, now historical since F1/F2 were removed -- this script's
# headSha field is still used, purely for naming in the alert-only path's issue body).
# Optional 3rd arg <head_sha> = github.event.merge_group.head_sha (t/422#20a, SO t/422#41).
# When the batch's own entry is ABSENT from mergeQueue entries and head_sha is given, the
# batch was EJECTED from the queue (the t/422#20 cascade: entries drop when a sibling batch fails). The script
# then exits 3 with an "EJECTED" line, not 0: a non-success result that no required context
# can pass on. Exit 3 is never a pass; the callers' set -e turns it into a red check. Without
# head_sha, an absent entry still exits 1 as before. A neutral or skipped check would PASS
# required contexts (GitHub status-check docs), which is why this is not exit 0.
# Exits 1 (fail closed) on ANY other problem, with a legible ::error:: line.
set -euo pipefail

REPO="$1"
REF="$2"
HEAD_SHA="${3:-}"
EJECT_EXIT=3
OWNER="${REPO%/*}"
NAME="${REPO#*/}"

errfile="${RUNNER_TEMP:-/tmp}/get-merge-group-prs.err"

# ---- 1. identify THIS entry's own PR number AND the target branch from ref ----
# ref shape: refs/heads/gh-readonly-queue/<branch>/pr-<N>-<sha>
BRANCH=$(echo "$REF" | grep -oP 'gh-readonly-queue/\K[^/]+' || true)
SELF_PR_NUM=$(echo "$REF" | grep -oP 'gh-readonly-queue/[^/]+/pr-\K[0-9]+' || true)
if [ -z "$BRANCH" ] || [ -z "$SELF_PR_NUM" ]; then
  echo "::error::get-merge-group-prs: could not parse a branch/PR number out of ref '${REF}' -- expected refs/heads/gh-readonly-queue/<branch>/pr-<N>-<sha>. FAILING CLOSED." >&2
  exit 1
fi

# ---- 2. query the queue's own entry list (fail closed on exhaustion) ----
# t/562 (2026-11-24 queue stall 22:35-23:46Z): the GITHUB_TOKEN installation's GraphQL pool hit
# 5000/5000 and the old 3+6+9 s retries could not outlast the hourly window, so every merge-group
# guard failed closed and the queue head blocked everything behind it. Errors are now classified:
#   - PRIMARY RATE LIMIT ('rate limit' text, or HTTP 403/429, with the GraphQL pool at remaining 0
#     per `gh api rate_limit`, which does not count against the limit): if the reset is within
#     RL_MAX_WAIT_S (900 s = 15 min), WARN, sleep until reset + 5 s and retry ONCE. A reset further
#     away, a second rate limit, or an unreadable rate_limit probe FAILS CLOSED with the reset time.
#   - a secondary limit, a 429 with quota left, a 5xx or a network error: today's short backoff
#     (3, 6 s; 3 attempts in all).
#   - any other HTTP 4xx (a permission 403, a 404): fails closed at once. Retrying a real answer
#     only delays it.
# RL_SLEEP and RL_NOW override sleep and the clock for tests only.
QUERY='query($owner:String!,$repo:String!,$branch:String!){repository(owner:$owner,name:$repo){mergeQueue(branch:$branch){entries(first:100){nodes{position pullRequest{number headRefOid labels(first:50){nodes{name}}}}}}}}'
RL_MAX_WAIT_S="${RL_MAX_WAIT_S:-900}"
_rl_sleep() { ${RL_SLEEP:-sleep} "$1"; }
_rl_now() { if [ -n "${RL_NOW:-}" ]; then echo "$RL_NOW"; else date +%s; fi; }
_rl_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "epoch $1"; }
ENTRIES_JSON=""
last_err=""
short_attempts=0
waited=0
while :; do
  if ENTRIES_JSON=$(gh api graphql -f query="$QUERY" -f owner="$OWNER" -f repo="$NAME" -f branch="$BRANCH" --jq '.data.repository.mergeQueue.entries.nodes' 2>"$errfile"); then
    break
  fi
  ENTRIES_JSON=""
  last_err=$(head -c 400 "$errfile" 2>/dev/null | tr '\n' ' ')

  if grep -qiE 'rate limit|HTTP 403|HTTP 429' "$errfile" 2>/dev/null; then
    if ! rl=$(gh api rate_limit --jq '.resources.graphql | "\(.remaining) \(.reset)"' 2>/dev/null) \
       || ! [[ "$rl" =~ ^[0-9]+\ [0-9]+$ ]]; then
      echo "::error::get-merge-group-prs: the mergeQueue query failed (${last_err}) and the rate_limit probe could not be read, so a rate-limit wait cannot be bounded. FAILING CLOSED (cannot enumerate the group)." >&2
      exit 1
    fi
    remaining="${rl% *}"
    reset="${rl#* }"
    if [ "$remaining" -eq 0 ]; then
      wait_s=$(( reset + 5 - $(_rl_now) ))
      [ "$wait_s" -lt 0 ] && wait_s=0
      if [ "$waited" -eq 0 ] && [ "$wait_s" -le "$RL_MAX_WAIT_S" ]; then
        echo "::warning::WARN get-merge-group-prs: GraphQL rate limit exhausted (resets $(_rl_iso "$reset")); waiting ${wait_s}s for the rate-limit reset, then retrying once (t/562)." >&2
        _rl_sleep "$wait_s"
        waited=1
        continue
      fi
      if [ "$waited" -eq 1 ]; then
        why="still rate-limited after waiting for the reset"
      else
        why="the reset is ${wait_s}s away, more than the ${RL_MAX_WAIT_S}s this guard waits"
      fi
      echo "::error::get-merge-group-prs: INFRA rate-limit: GitHub GraphQL quota exhausted, resets $(_rl_iso "$reset"); ${why}. Not a policy verdict: re-run the failed jobs after the reset. FAILING CLOSED (cannot enumerate the group)." >&2
      exit 1
    fi
    # Quota left: a secondary limit or a 429 backs off briefly; a plain 403 is a real answer.
    if ! grep -qiE 'rate limit|HTTP 429' "$errfile" 2>/dev/null; then
      echo "::error::get-merge-group-prs: the mergeQueue query was refused (${last_err}) with GraphQL quota left (${remaining}), so this is not a rate limit. FAILING CLOSED at once (cannot enumerate the group)." >&2
      exit 1
    fi
  elif grep -qE 'HTTP 4[0-9][0-9]' "$errfile" 2>/dev/null; then
    echo "::error::get-merge-group-prs: the mergeQueue query was refused (${last_err}). A 4xx is a real answer, not retried. FAILING CLOSED (cannot enumerate the group)." >&2
    exit 1
  fi

  short_attempts=$((short_attempts + 1))
  if [ "$short_attempts" -ge 3 ]; then
    echo "::error::get-merge-group-prs: could NOT read mergeQueue entries for ${BRANCH} after 3 attempts -- API/INFRA failure or no queue configured. Last error: ${last_err}. FAILING CLOSED (cannot enumerate the group)." >&2
    exit 1
  fi
  echo "::warning::get-merge-group-prs: mergeQueue query attempt ${short_attempts}/3 failed -- ${last_err} -- retrying in $((short_attempts * 3))s" >&2
  _rl_sleep $((short_attempts * 3))
done
if [ -z "$ENTRIES_JSON" ] || [ "$ENTRIES_JSON" = "null" ]; then
  echo "::error::get-merge-group-prs: could NOT read mergeQueue entries for ${BRANCH} -- the query returned no entry list (no queue configured?). FAILING CLOSED (cannot enumerate the group)." >&2
  exit 1
fi

ENTRY_COUNT=$(echo "$ENTRIES_JSON" | jq 'length')
if [ "$ENTRY_COUNT" -eq 0 ]; then
  if [ -n "$HEAD_SHA" ]; then
    echo "::error::get-merge-group-prs: EJECTED -- PR #${SELF_PR_NUM} at merge_group head ${HEAD_SHA}: mergeQueue entries for ${BRANCH} is EMPTY, so this batch's entry was removed from the queue. Exit ${EJECT_EXIT} (non-success, not a pass); the sweep must not re-queue it." >&2
    exit "$EJECT_EXIT"
  fi
  echo "::error::get-merge-group-prs: mergeQueue entries for ${BRANCH} is EMPTY -- cannot be a valid merge_group event. FAILING CLOSED." >&2
  exit 1
fi

# ---- 3. find our own position, fail closed if we can't locate ourselves ----
SELF_POSITION=$(echo "$ENTRIES_JSON" | jq -r --argjson n "$SELF_PR_NUM" '[.[] | select(.pullRequest.number == $n)] | .[0].position // "null"')
if [ "$SELF_POSITION" = "null" ] || [ -z "$SELF_POSITION" ]; then
  if [ -n "$HEAD_SHA" ]; then
    echo "::error::get-merge-group-prs: EJECTED -- PR #${SELF_PR_NUM} at merge_group head ${HEAD_SHA} is not in mergeQueue entries for ${BRANCH}, so this batch's entry was removed from the queue. Exit ${EJECT_EXIT} (non-success, not a pass); the sweep must not re-queue it." >&2
    exit "$EJECT_EXIT"
  fi
  echo "::error::get-merge-group-prs: PR #${SELF_PR_NUM} (this entry, per head_ref) was not found in mergeQueue entries -- cannot locate ourselves in the queue. FAILING CLOSED." >&2
  exit 1
fi

# ---- 4. every entry at or before our own position is in THIS batch ----
RESULT=$(echo "$ENTRIES_JSON" | jq --argjson pos "$SELF_POSITION" '[.[] | select(.position <= $pos) | {number: .pullRequest.number, labels: [.pullRequest.labels.nodes[].name], headSha: .pullRequest.headRefOid}]')
RESULT_COUNT=$(echo "$RESULT" | jq 'length')
if [ "$RESULT_COUNT" -eq 0 ]; then
  echo "::error::get-merge-group-prs: resolved ZERO PRs at or before position ${SELF_POSITION} -- cannot prove this batch is safe. FAILING CLOSED." >&2
  exit 1
fi

# ---- 5. [SO F4] count must equal position -- positions are 1-based and contiguous,
# so a complete, unpaginated result at or before position N has exactly N entries. A
# mismatch (a dropped entry from paging or a partial API response) is otherwise
# invisible: the batch would look "safe" with fewer entries than it actually has.
if [ "$RESULT_COUNT" -ne "$SELF_POSITION" ]; then
  echo "::error::get-merge-group-prs: resolved ${RESULT_COUNT} PR(s) but self position is ${SELF_POSITION} -- expected them equal (1-based, contiguous). An entry was likely dropped (paging/partial response). FAILING CLOSED." >&2
  exit 1
fi

echo "$RESULT"
