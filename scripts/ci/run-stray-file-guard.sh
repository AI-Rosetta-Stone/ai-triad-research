#!/usr/bin/env bash
set -euo pipefail

# t/4665 (TL, p/331#2547): extracted from stray-file-guard.yml so the fail-open behavior is
# unit-testable (run-stray-file-guard.test.mjs). A PR branched before
# scripts/ci/stray-file-guard.mjs existed on main has no copy of it on the PR head -- sourcing
# it from the base ref (which always has it, post-#4260) instead fixes that. If the base ref
# somehow still lacks it, fail OPEN with a WARN: this guard is warn-only, so a missing script
# must never itself turn a PR red.

BASE_REF="$1"

# .mjs suffix required (Sage p/26#362, TL p/331#2549): the guard script is an ES module
# (import/export). An extensionless mktemp path makes Node 20's loader throw
# ERR_UNKNOWN_FILE_EXTENSION regardless of content -- this isn't about the PR's own files.
GUARD_SCRIPT="$(mktemp --suffix=.mjs)"
trap 'rm -f "$GUARD_SCRIPT"' EXIT

if git show "origin/${BASE_REF}:scripts/ci/stray-file-guard.mjs" > "$GUARD_SCRIPT" 2>/dev/null; then
  git diff --name-only --diff-filter=ACMR "origin/${BASE_REF}...HEAD" | node "$GUARD_SCRIPT" --from-stdin
else
  echo "::warning::stray-file-guard.mjs not found on origin/${BASE_REF} -- skipping the guard for this run (warn-only, t/4665)."
fi
