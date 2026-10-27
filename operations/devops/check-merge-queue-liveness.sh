#!/usr/bin/env bash
# t/4567 C5 (TL ruling t/4567#37-39): the time-based backstop for a merge-queue entry that
# silently drops or stalls, for whatever cause D1's dequeue-event alert doesn't catch
# (e.g. a required context that never reports at all, so there's no dequeue event yet).
#
# Three conditions, in order of urgency (SO e/376#2, adopted):
#   (a) no merge_group check run has started for an entry within 15 minutes -- a check-run
#       count of 0 is exactly the GITHUB_TOKEN-enqueue failure shape (t/4567#37): nothing
#       ever got requested, so nothing will ever complete either.
#   (b) AWAITING_CHECKS for more than 60 minutes -- a real suite worst-case is ~25-30min,
#       so this means a check started but never finished and GitHub's own timeout hasn't
#       fired yet (or is itself unreliable).
#   (c) queued (any state) for more than 2 hours -- the final, broadest backstop.
#
# NOTE: AWAITING_CHECKS alone is NOT a violation condition by itself -- every healthy
# group sits there for the ~25-30min suite runtime. Only (a) and (b) layer time
# thresholds onto it.
#
# Usage: check-merge-queue-liveness.sh <repo> <branch>
# Prints a JSON array of violations: [{number, kind: "no-checks-started"|"awaiting-checks-stale"|"queued-too-long", ageMinutes}]
# Exits 0 always (this check alerts, it never fails closed/open like the C2 enumeration script).
set -uo pipefail

REPO="$1"
BRANCH="$2"
OWNER="${REPO%/*}"
NAME="${REPO#*/}"

# t/4567 SO L3 (e/377#2): a GraphQL failure must never go silently red under `set -e` --
# a liveness check that can fail invisibly is the exact silent-drop class this whole
# mechanism exists to catch. Emit a distinct violation instead of dying.
QUERY='query($owner:String!,$repo:String!,$branch:String!){repository(owner:$owner,name:$repo){mergeQueue(branch:$branch){entries(first:100){nodes{position state enqueuedAt headCommit{oid} pullRequest{number}}}}}}'
if ! ENTRIES_JSON=$(gh api graphql -f query="$QUERY" -f owner="$OWNER" -f repo="$NAME" -f branch="$BRANCH" --jq '.data.repository.mergeQueue.entries.nodes // []' 2>&1); then
  echo '[{"kind": "liveness-check-failed", "number": 0, "ageMinutes": 0}]'
  exit 0
fi

NOW_EPOCH=$(date -u +%s)
VIOLATIONS="[]"

ENTRY_COUNT=$(echo "$ENTRIES_JSON" | jq 'length')
for i in $(seq 0 $((ENTRY_COUNT - 1))); do
  entry=$(echo "$ENTRIES_JSON" | jq ".[$i]")
  num=$(echo "$entry" | jq -r '.pullRequest.number')
  state=$(echo "$entry" | jq -r '.state')
  enqueuedAt=$(echo "$entry" | jq -r '.enqueuedAt')
  headSha=$(echo "$entry" | jq -r '.headCommit.oid // empty')

  # SO minor finding (e/378#2): an unparseable enqueuedAt must not go silently red under
  # set -u -- treat it as its own violation rather than letting the whole script die on
  # one bad entry.
  if ! ENQ_EPOCH=$(date -u -d "$enqueuedAt" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$enqueuedAt" +%s 2>/dev/null); then
    VIOLATIONS=$(echo "$VIOLATIONS" | jq --argjson n "${num:-0}" '. + [{number: $n, kind: "liveness-check-failed", ageMinutes: 0}]')
    continue
  fi
  AGE_MIN=$(( (NOW_EPOCH - ENQ_EPOCH) / 60 ))

  # ---- (c) queued too long, any state -- the broadest backstop, checked first ----
  if [ "$AGE_MIN" -gt 120 ]; then
    VIOLATIONS=$(echo "$VIOLATIONS" | jq --argjson n "$num" --argjson age "$AGE_MIN" '. + [{number: $n, kind: "queued-too-long", ageMinutes: $age}]')
    continue
  fi

  if [ "$state" = "AWAITING_CHECKS" ]; then
    CHECK_COUNT=0
    if [ -n "$headSha" ]; then
      # t/4567 SO L2 (e/377#2): count only the REQUIRED contexts, not every check run on
      # the commit. `noop` has no branch/event filter and fires on every push including
      # the merge-group test commit (confirmed t/4567#36), so counting all check runs
      # would always show >0 even in the exact GITHUB_TOKEN-failure shape this condition
      # exists to catch -- the condition could never fire.
      #
      # SO M1 (e/378#2): the check-runs API paginates at 30 per page, and ci.yml has
      # ~42 jobs/matrix legs -- a single unfiltered call can put ci-gate on page 2,
      # reading as 0 and falsely tripping "no checks started" on every healthy group.
      # Query per required context name via ?check_name=, which the API answers
      # directly without needing to paginate through everything else on the commit.
      # Live-fire finding (M2 real reproducer): `gh api` writes the HTTP error BODY to
      # stdout, not just stderr, on a non-2xx response (a 404 here, since the ephemeral
      # merge-group test commit may not exist as a real commit object yet). The old
      # `2>/dev/null || echo 0` pattern didn't help -- `ctx_count` captured the error
      # JSON with "0" appended after it (stdout from the failed call, then echo 0 on
      # top), and `$((CHECK_COUNT + ctx_count))` died on that garbage. Check the exit
      # code explicitly and discard ALL output (not just stderr) on failure.
      for ctx in "ci-gate" "CodeQL" "consult-hold-guard" "joint-gv-guard"; do
        if ctx_count=$(gh api "repos/${REPO}/commits/${headSha}/check-runs" -f check_name="$ctx" --jq '.total_count // 0' 2>/dev/null); then
          CHECK_COUNT=$((CHECK_COUNT + ctx_count))
        fi
      done
    fi

    # ---- (a) no check run started within 15 minutes ----
    if [ "$CHECK_COUNT" -eq 0 ] && [ "$AGE_MIN" -gt 15 ]; then
      VIOLATIONS=$(echo "$VIOLATIONS" | jq --argjson n "$num" --argjson age "$AGE_MIN" '. + [{number: $n, kind: "no-checks-started", ageMinutes: $age}]')
    # ---- (b) awaiting checks beyond the real worst-case suite time ----
    elif [ "$AGE_MIN" -gt 60 ]; then
      VIOLATIONS=$(echo "$VIOLATIONS" | jq --argjson n "$num" --argjson age "$AGE_MIN" '. + [{number: $n, kind: "awaiting-checks-stale", ageMinutes: $age}]')
    fi
  fi
done

echo "$VIOLATIONS"
