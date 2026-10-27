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
# Usage: check-merge-queue-liveness.sh <repo> <branch> [no_checks_threshold_min]
# The third arg overrides the "(a) no checks started" minute threshold (default 15) --
# SO P1 (e/381#2): a live-fire arm run seconds after enqueue needs threshold=0 to prove
# anything about CHECK_COUNT at all, since AGE_MIN=0 would pass the default ">15" gate
# regardless of the real check state.
# Prints a JSON array of violations: [{number, kind: "no-checks-started"|"awaiting-checks-stale"|"queued-too-long", ageMinutes}]
# Exits 0 always (this check alerts, it never fails closed/open like the C2 enumeration script).
set -uo pipefail

REPO="$1"
BRANCH="$2"
NO_CHECKS_THRESHOLD_MIN="${3:-15}"
# `${3:-15}` only substitutes when $3 is UNSET, not when it's an empty string -- and a
# workflow_dispatch input left blank (or a schedule trigger, where the input context
# doesn't exist at all) both arrive here as an explicit empty string, not an absent arg.
if [ -z "$NO_CHECKS_THRESHOLD_MIN" ]; then
  NO_CHECKS_THRESHOLD_MIN=15
fi
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
      # Query per required context name, which the API answers directly without
      # needing to paginate through everything else on the commit.
      #
      # SO N1 (e/380#2, HIGH): `gh api ... -f check_name=X` is a POST (gh adds
      # parameters to the request body by default, which GitHub's REST API rejects for
      # a GET-only endpoint) -- every lookup 404s regardless of the real check state,
      # which the exit-code-check below then turned into CHECK_COUNT=0 for EVERY
      # entry, not just ones with no checks. Put the filter in the URL query string
      # instead, which keeps this a real GET.
      #
      # Live-fire finding (M2 real reproducer): `gh api` writes the HTTP error BODY to
      # stdout, not just stderr, on a non-2xx response. A genuine lookup failure (the
      # commit truly not found, an auth/rate-limit problem) must NOT read as count=0
      # ("healthy") -- that's indistinguishable from the exact silent-drop shape this
      # check exists to catch. Treat it as its own liveness-check-failed violation.
      LOOKUP_FAILED=false
      for ctx in "ci-gate" "CodeQL" "consult-hold-guard" "joint-gv-guard"; do
        encoded_ctx=$(printf '%s' "$ctx" | sed 's/ /%20/g')
        if ctx_count=$(gh api "repos/${REPO}/commits/${headSha}/check-runs?check_name=${encoded_ctx}" --jq '.total_count // 0' 2>/dev/null); then
          CHECK_COUNT=$((CHECK_COUNT + ctx_count))
        else
          LOOKUP_FAILED=true
        fi
      done
      if [ "$LOOKUP_FAILED" = true ]; then
        VIOLATIONS=$(echo "$VIOLATIONS" | jq --argjson n "$num" '. + [{number: $n, kind: "liveness-check-failed", ageMinutes: 0}]')
        continue
      fi
    fi

    # ---- (a) no check run started within the threshold ----
    if [ "$CHECK_COUNT" -eq 0 ] && [ "$AGE_MIN" -gt "$NO_CHECKS_THRESHOLD_MIN" ]; then
      VIOLATIONS=$(echo "$VIOLATIONS" | jq --argjson n "$num" --argjson age "$AGE_MIN" '. + [{number: $n, kind: "no-checks-started", ageMinutes: $age}]')
    # ---- (b) awaiting checks beyond the real worst-case suite time ----
    elif [ "$AGE_MIN" -gt 60 ]; then
      VIOLATIONS=$(echo "$VIOLATIONS" | jq --argjson n "$num" --argjson age "$AGE_MIN" '. + [{number: $n, kind: "awaiting-checks-stale", ageMinutes: $age}]')
    fi
  fi
done

echo "$VIOLATIONS"
