#!/usr/bin/env bash
# Static token-contrast ratchet gate (t/2264).
# Catches text reversed out over a tokenized fill that is light in some themes —
# the defect class jsdom/vitest is structurally blind to (applies no stylesheet).
#
# Ceiling stored in quality-gates.json → contrast_ceilings["taxonomy-editor/scripts/check-contrast.mjs"].
# Same pattern as check-renderer-tsc.sh: start at the pre-existing baseline,
# ratchet down. Every new violation is a hard failure immediately.
#
# Unlike check-camp-contrast.mjs (which hardcodes a token snapshot and only checks
# the direction that passes), this reads styles.css as the live source of truth.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$REPO_ROOT/quality-gates.json"
CEILING=$(node -e "const p=require('path').resolve(process.argv[1]);console.log(require(p).contrast_ceilings['taxonomy-editor/scripts/check-contrast.mjs'])" "$CONFIG")

if [ -z "$CEILING" ] || [ "$CEILING" = "undefined" ]; then
  echo "ERROR: contrast_ceilings[taxonomy-editor/scripts/check-contrast.mjs] not found in quality-gates.json"
  exit 1
fi

cd "$REPO_ROOT/taxonomy-editor"

# t/111: the gate's own tests run first, so CI exercises them (they ran nowhere before): the
# checker's detection self-test and the verdict predicate's both-arms tests.
SELFTEST_LOG=$(mktemp)
if ! node --test scripts/check-contrast.test.mjs scripts/contrast-gate.test.mjs >"$SELFTEST_LOG" 2>&1; then
  cat "$SELFTEST_LOG"
  rm -f "$SELFTEST_LOG"
  echo "GATE UNREADABLE: the contrast checker's self-tests failed (above). Fix them before trusting the count."
  exit 1
fi
rm -f "$SELFTEST_LOG"

# t/111: stdout only (stderr kept apart, never parsed), and the checker's real exit code. The
# verdict, including every way the output can be unreadable, is contrast-gate.mjs's job; it
# fails closed. The old `2>&1 || true` plus `[ "" -gt N ]` fell through to OK on a truncated payload.
OUT=$(mktemp)
ERR=$(mktemp)
trap 'rm -f "$OUT" "$ERR"' EXIT
node scripts/check-contrast.mjs --json >"$OUT" 2>"$ERR"
CHECKER_EXIT=$?

if ! node scripts/contrast-gate.mjs "$OUT" "$CHECKER_EXIT" "$CEILING"; then
  if [ -s "$ERR" ]; then
    echo "--- check-contrast.mjs stderr ---"
    cat "$ERR"
  fi
  node scripts/check-contrast.mjs 2>&1 || true
  exit 1
fi
