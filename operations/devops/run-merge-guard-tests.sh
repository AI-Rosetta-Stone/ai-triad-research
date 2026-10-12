#!/usr/bin/env bash
# t/3871 — run the merge-guard predicate suite and fail CLOSED on an empty population.
#
# Why a script and not an inline `run:`: so the exact same logic CI runs can be proven locally on
# all three arms (green / red / zero-collected) — the "tested code == running code" property whose
# absence produced the t/3695 bug class (the predicate was 13/13-tested while the code that RAN it
# was never tested).
#
# Exit: 0 = suite green AND >0 tests collected; non-zero otherwise.
# Usage: run-merge-guard-tests.sh [test-file]   (default: the predicate suite next to this script)
set -u
here="$(cd "$(dirname "$0")" && pwd)"
suite="${1:-$here/merge-guard-predicate.test.mjs}"
tap="$(mktemp)"
trap 'rm -f "$tap"' EXIT

if [ ! -f "$suite" ]; then
  echo "::error::merge-guard predicate suite not found at $suite — failing safe (t/3871)"
  exit 1
fi

# Two reporters: human-readable spec to stdout, TAP to a file we can count from.
node --test \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=tap  --test-reporter-destination="$tap" \
  "$suite"
rc=$?

# Population assertion (t/3819 Finding 2 / zero-collected class) — a FLOOR, not `> 0`.
# Measured while building this (t/3871): `node --test` on a file with NO tests exits 0 and reports
# `# tests 1` (the file itself counts as a test), so a `> 0` check PASSES an empty suite — the exact
# silent-zero trap. A floor at the known count catches that AND a refactor that quietly drops tests.
# RATCHET — and it DRIFTS if you don't move it (TL p/331#1816; same failure as Verify-Config's
# hardcoded "7 files" while running 8): when you ADD tests to merge-guard-predicate.test.mjs, RAISE
# MIN to the new count in the same PR. A floor left at an old count silently tolerates losing every
# test added since. Lowering MIN is a deliberate, reviewed diff (workflow-lint ALLOW_IF_EXPECTED
# pattern). The env override is for local arm-testing only.
MIN="${MERGE_GUARD_MIN_TESTS:-84}"
n="$(grep -E '^# tests [0-9]+' "$tap" | tail -1 | awk '{print $3}')"
if [ -z "$n" ]; then
  echo "::error::merge-guard predicate suite emitted no TAP test count — failing safe (t/3871)"
  exit 1
fi
if [ "$n" -lt "$MIN" ]; then
  echo "::error::merge-guard predicate suite collected $n test(s), below the floor of $MIN — tests were dropped or not discovered; failing safe (t/3871). If the drop is intended, lower MIN in this script in the same PR."
  exit 1
fi
echo "merge-guard predicate suite: $n test(s) collected (floor $MIN), node --test exit $rc"
exit "$rc"
