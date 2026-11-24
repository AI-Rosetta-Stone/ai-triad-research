#!/usr/bin/env bash
# vitest-retry-report.sh -- surface tests that passed only on a retry.
#
# test-electron-vitest runs vitest with --retry=1 in CI, so one flaky test no longer
# turns an unrelated PR or a merge-queue batch red. A retry must not hide the flake,
# though: vitest's default reporter marks a retried test with "(retry xN)" on its own
# line, among several thousand others. This script lifts those lines into ::warning::
# annotations so they show on the run page.
#
# Usage: vitest-retry-report.sh <vitest-log>
# Warn-only: always exits 0. A missing log is itself reported, never silently skipped.

log="${1:-}"
if [ -z "$log" ] || [ ! -f "$log" ]; then
  echo "::warning title=vitest retry report::no vitest log at '${log}', so tests that passed only on retry cannot be listed"
  exit 0
fi

# Strip ANSI colour codes, keep lines carrying the retry marker, then keep the passing ones.
# A test that failed on every attempt also carries the marker, but it has failed the job already.
flaky="$(sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '\(retry x[0-9]+\)' | grep -F '✓' || true)"

if [ -z "$flaky" ]; then
  echo "vitest retry report: 0 tests passed only on retry"
  exit 0
fi

count="$(printf '%s\n' "$flaky" | wc -l | tr -d ' ')"
echo "vitest retry report: $count test(s) passed only on retry (flaky; fix them, the retry is not a fix)"
printf '%s\n' "$flaky" | while IFS= read -r line; do
  name="$(printf '%s' "$line" | sed 's/^[[:space:]]*//')"
  echo "::warning title=vitest flaky test (passed only on retry)::$name"
done
exit 0
