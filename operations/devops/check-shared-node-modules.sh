#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# check-shared-node-modules.sh — detect a shared checkout's node_modules link that
# resolves into a worktree, or dangles (t/4815/t/4817).
#
# WHY: a worktree's node_modules can get junctioned/symlinked INTO the shared checkout
# (or vice versa) by hand or by an old habit, and `pnpm install` reports "Already up to
# date" against the corrupted tree -- the tooling itself is blind to it. t/4815: this went
# undetected until another agent hit MODULE_NOT_FOUND downstream. t/4816 guards pnpm
# invocations in a WORKTREE from reading OUT through such a link; this script instead scans
# the SHARED checkout itself so the corruption is caught where it happens, not downstream.
#
# SCANS: the shared checkout's own node_modules (root + every direct child directory's, i.e.
# depth 2 -- covers every current and future workspace package without needing to parse
# pnpm-workspace.yaml). For each one that exists and is a symlink/junction:
#   - resolves into .worktrees/  -> OFFENDER (the t/4815 shape)
#   - target does not exist      -> OFFENDER (dangling)
#   - anything else              -> fine (unusual, but not this class)
# A real directory is never flagged.
#
# WARN-ONLY (exit 1 on a finding, never destructive): prints each offender and the repair
# command. Wiring (both required by t/4817's AC): /land-from-worktree step 8 (cleanup) and
# /devops-health-checks (routine agent check).
#
# Usage:
#   check-shared-node-modules.sh [root]   defaults to the shared checkout root (git toplevel)
#   check-shared-node-modules.sh --check-link <path>   test-only: exercise one path directly
# ─────────────────────────────────────────────────────────────────────────────

# check_one_link <node_modules path> -> prints "OFFENDER|<path>|<reason>|<target>" and
# returns 1 if it's a symlink/junction resolving into .worktrees/ or dangling; 0 otherwise
# (including: not a symlink at all, e.g. a real directory, or absent).
check_one_link() {
  nm="$1"
  [ -e "$nm" ] || [ -L "$nm" ] || return 0
  [ -L "$nm" ] || return 0   # a real directory is never flagged, even if -e without -L false (not possible together, but explicit)
  real=$(cd "$nm" 2>/dev/null && pwd -P)
  if [ -z "$real" ]; then
    echo "OFFENDER|$nm|dangling (target does not exist)|$(readlink "$nm" 2>/dev/null || echo '?')"
    return 1
  fi
  case "$real" in
    */.worktrees/*|*/.worktrees)
      echo "OFFENDER|$nm|resolves into a worktree (t/4815 shape)|$real"
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

if [ "$1" = "--check-link" ]; then
  shift
  check_one_link "$1"
  exit $?
fi

ROOT=${1:-$(git rev-parse --show-toplevel 2>/dev/null)}
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
  echo "check-shared-node-modules: WARN cannot resolve a repo root; skipping." >&2
  exit 0
fi

FOUND=0
check_and_report() {
  OUT=$(check_one_link "$1")
  rc=$?
  if [ "$rc" != "0" ]; then
    FOUND=1
    nm_path=${OUT#OFFENDER|}; nm_path=${nm_path%%|*}
    rest=${OUT#OFFENDER|*|}; reason=${rest%%|*}; target=${rest#*|}
    echo "check-shared-node-modules: OFFENDER $nm_path -- $reason (target: $target)"
  fi
}

check_and_report "$ROOT/node_modules"
for pkg_nm in "$ROOT"/*/node_modules; do
  [ -d "$pkg_nm" ] || [ -L "$pkg_nm" ] || continue
  check_and_report "$pkg_nm"
done

if [ "$FOUND" = "1" ]; then
  echo "check-shared-node-modules: repair each offender with:" >&2
  echo "  mv <pkg>/node_modules <pkg>/node_modules.bak-\$(date +%s) && (cd <pkg> && pnpm install --frozen-lockfile --prefer-offline)" >&2
  exit 1
fi

echo "check-shared-node-modules: clean -- no node_modules link resolves into a worktree or dangles."
exit 0
