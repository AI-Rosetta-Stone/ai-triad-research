#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# check-queued-push-guard.sh — refuse a push to a branch whose PR is in the merge queue or
# has auto-merge armed (t/4858).
#
# WHY: PR #4489 was pushed to while queued. The new commit reached GitHub 5 seconds AFTER the
# queue's own enqueue read the (then-current, now-stale) head, so the queue built and merged
# the OLD snapshot -- GitHub reported "merged", but the push's content never shipped, silently.
# Root AGENTS.md already says "never push to a queued PR" as a discipline rule; this makes it
# enforced instead of just documented.
#
# WHAT: for the PR associated with the branch being pushed, read its live
# isInMergeQueue/autoMergeRequest state via `gh pr view`. If either is set, REFUSE (exit 1)
# with the exact disarm/dequeue command, rather than letting the push through to race the
# queue. FAIL-OPEN on anything this can't determine (no gh, no network, no PR for the branch,
# not a PR branch at all) -- a broken guard must never block legitimate pushes to non-PR
# branches or ordinary work.
#
# Usage:
#   check-queued-push-guard.sh <branch>              the real check
#   check-queued-push-guard.sh --check <branch>      alias, same behavior (test harness clarity)
# ─────────────────────────────────────────────────────────────────────────────

BRANCH="$1"
if [ "$BRANCH" = "--check" ]; then BRANCH="$2"; fi
if [ -z "$BRANCH" ]; then
  echo "usage: check-queued-push-guard.sh <branch>" >&2
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "pre-push: WARN gh not found; skipping the queued-PR push guard (t/4858)." >&2
  exit 0
fi

# `gh pr view --json` has no isInMergeQueue/autoMergeRequest field (confirmed live, t/4858) --
# both only exist over GraphQL, same as enqueue-pr.mjs / live-pr-state.mjs already use.
PR_NUM=$(gh pr view "$BRANCH" --json number -q .number 2>/dev/null)
if [ -z "$PR_NUM" ]; then
  # No PR for this branch, or gh/network failed -- fail open. The consequence of a false
  # refuse (blocking an ordinary push) is worse than a false pass (the race this guard exists
  # to catch is rare and the detector in check-merge-head-drift.mjs is the backstop).
  exit 0
fi

QUERY='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue autoMergeRequest{enabledAt}}}}'
REPO_SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)
OWNER=${REPO_SLUG%%/*}
NAME=${REPO_SLUG##*/}
STATE=$(gh api graphql -f "query=$QUERY" -f "owner=$OWNER" -f "name=$NAME" -F "number=$PR_NUM" 2>/dev/null)
if [ -z "$STATE" ]; then
  exit 0
fi

IS_QUEUED=$(printf '%s' "$STATE" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0,'utf8')).data.repository.pullRequest.isInMergeQueue))" 2>/dev/null)
ARMED=$(printf '%s' "$STATE" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')).data.repository.pullRequest; process.stdout.write(d.autoMergeRequest ? 'true' : 'false')" 2>/dev/null)

if [ "$IS_QUEUED" = "true" ]; then
  echo "pre-push: ERROR PR #$PR_NUM for '$BRANCH' is in the merge queue right now (t/4858)." >&2
  echo "pre-push:   Pushing now races the queue: it may build and merge your OLD head while GitHub reports success." >&2
  echo "pre-push:   Fix: gh pr merge $PR_NUM --disable-auto   (disarm/dequeue), THEN push, THEN re-enqueue." >&2
  exit 1
fi
if [ "$ARMED" = "true" ]; then
  echo "pre-push: ERROR PR #$PR_NUM for '$BRANCH' has auto-merge armed and will enter the queue once checks pass (t/4858)." >&2
  echo "pre-push:   Pushing now can arm-then-queue your OLD head before this push's checks even start." >&2
  echo "pre-push:   Fix: gh pr merge $PR_NUM --disable-auto   (disarm), THEN push, THEN re-enqueue." >&2
  exit 1
fi

exit 0
