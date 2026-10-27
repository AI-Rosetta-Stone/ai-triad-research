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
# Exits 1 (fail closed) on ANY problem, with a legible ::error:: line.
set -euo pipefail

REPO="$1"
REF="$2"
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

# ---- 2. query the queue's own entry list (retry 3x, fail closed on exhaustion) ----
QUERY='query($owner:String!,$repo:String!,$branch:String!){repository(owner:$owner,name:$repo){mergeQueue(branch:$branch){entries(first:100){nodes{position pullRequest{number headRefOid labels(first:50){nodes{name}}}}}}}}'
ENTRIES_JSON=""
last_err=""
for attempt in 1 2 3; do
  if ENTRIES_JSON=$(gh api graphql -f query="$QUERY" -f owner="$OWNER" -f repo="$NAME" -f branch="$BRANCH" --jq '.data.repository.mergeQueue.entries.nodes' 2>"$errfile"); then
    break
  fi
  ENTRIES_JSON=""
  last_err=$(head -c 400 "$errfile" 2>/dev/null | tr '\n' ' ')
  echo "::warning::get-merge-group-prs: mergeQueue query attempt ${attempt}/3 failed -- ${last_err} -- retrying in $((attempt * 3))s" >&2
  sleep $((attempt * 3))
done
if [ -z "$ENTRIES_JSON" ] || [ "$ENTRIES_JSON" = "null" ]; then
  echo "::error::get-merge-group-prs: could NOT read mergeQueue entries for ${BRANCH} after 3 attempts -- API/INFRA failure or no queue configured. Last error: ${last_err}. FAILING CLOSED (cannot enumerate the group)." >&2
  exit 1
fi

ENTRY_COUNT=$(echo "$ENTRIES_JSON" | jq 'length')
if [ "$ENTRY_COUNT" -eq 0 ]; then
  echo "::error::get-merge-group-prs: mergeQueue entries for ${BRANCH} is EMPTY -- cannot be a valid merge_group event. FAILING CLOSED." >&2
  exit 1
fi

# ---- 3. find our own position, fail closed if we can't locate ourselves ----
SELF_POSITION=$(echo "$ENTRIES_JSON" | jq -r --argjson n "$SELF_PR_NUM" '[.[] | select(.pullRequest.number == $n)] | .[0].position // "null"')
if [ "$SELF_POSITION" = "null" ] || [ -z "$SELF_POSITION" ]; then
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
