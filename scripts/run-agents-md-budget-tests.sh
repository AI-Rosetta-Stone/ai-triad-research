#!/usr/bin/env bash
# t/4323 (SO condition C1, e/337#2) — run the instruction-file budget checker's own test suite
# and fail CLOSED on an empty population, same discipline as operations/devops/run-merge-guard-tests.sh
# (t/3871): a `.test.mjs` wired into NO workflow is authoring-time evidence only, never re-checked on
# the next edit. This script is invoked from a CI step with NO `continue-on-error` — unlike the budget
# CHECK itself (warn-only business output), the TESTS PROVING the checker works must actually gate CI.
#
# Exit: 0 = suite green AND >= floor tests collected; non-zero otherwise.
# Usage: run-agents-md-budget-tests.sh [test-file]   (default: the suite next to this script)
set -u
here="$(cd "$(dirname "$0")" && pwd)"
suite="${1:-$here/check-agents-md-budget.test.mjs}"
tap="$(mktemp)"
trap 'rm -f "$tap"' EXIT

if [ ! -f "$suite" ]; then
  echo "::error::agents-md-budget test suite not found at $suite — failing safe (t/4323)"
  exit 1
fi

node --test \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=tap  --test-reporter-destination="$tap" \
  "$suite"
rc=$?

# Population floor, not `> 0` — an empty/missing suite still reports `# tests 1` to `node --test`
# (t/3871 finding). RATCHET: raise MIN in the same PR that adds tests to this suite.
MIN="${AGENTS_MD_BUDGET_MIN_TESTS:-8}"
n="$(grep -E '^# tests [0-9]+' "$tap" | tail -1 | awk '{print $3}')"
if [ -z "$n" ]; then
  echo "::error::agents-md-budget test suite emitted no TAP test count — failing safe (t/4323)"
  exit 1
fi
if [ "$n" -lt "$MIN" ]; then
  echo "::error::agents-md-budget test suite collected $n test(s), below the floor of $MIN — tests were dropped or not discovered; failing safe (t/4323). If the drop is intended, lower MIN in this script in the same PR."
  exit 1
fi
echo "agents-md-budget test suite: $n test(s) collected (floor $MIN), node --test exit $rc"
exit "$rc"
