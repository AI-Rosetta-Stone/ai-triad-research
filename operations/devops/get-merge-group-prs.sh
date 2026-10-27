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
# Usage: get-merge-group-prs.sh <repo> <branch> <head_ref>
# Prints a JSON array of {number, labels: [string...]} to stdout on success --
# every entry at or before THIS entry's own queue position.
# Exits 1 (fail closed) on ANY problem, with a legible ::error:: line.
set -euo pipefail

REPO="$1"
BRANCH="$2"
HEAD_REF="$3"
OWNER="${REPO%/*}"
NAME="${REPO#*/}"

errfile="${RUNNER_TEMP:-/tmp}/get-merge-group-prs.err"

# ---- 1. identify THIS entry's own PR number from head_ref ----
# head_ref shape: refs/heads/gh-readonly-queue/<branch>/pr-<N>-<sha>, N is this
# entry's own PR number.
SELF_PR_NUM=$(echo "$HEAD_REF" | grep -oP 'gh-readonly-queue/[^/]+/pr-\K[0-9]+' || true)
if [ -z "$SELF_PR_NUM" ]; then
  echo "::error::get-merge-group-prs: could not parse a PR number out of head_ref '${HEAD_REF}' -- expected gh-readonly-queue/<branch>/pr-<N>-<sha>. FAILING CLOSED." >&2
  exit 1
fi

# ---- 2. query the queue's own entry list (retry 3x, fail closed on exhaustion) ----
QUERY='query($owner:String!,$repo:String!,$branch:String!){repository(owner:$owner,name:$repo){mergeQueue(branch:$branch){entries(first:100){nodes{position pullRequest{number labels(first:50){nodes{name}}}}}}}}'
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
RESULT=$(echo "$ENTRIES_JSON" | jq --argjson pos "$SELF_POSITION" '[.[] | select(.position <= $pos) | {number: .pullRequest.number, labels: [.pullRequest.labels.nodes[].name]}]')
RESULT_COUNT=$(echo "$RESULT" | jq 'length')
if [ "$RESULT_COUNT" -eq 0 ]; then
  echo "::error::get-merge-group-prs: resolved ZERO PRs at or before position ${SELF_POSITION} -- cannot prove this batch is safe. FAILING CLOSED." >&2
  exit 1
fi

echo "$RESULT"
