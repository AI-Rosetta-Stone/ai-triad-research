#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# pre-push-checks.sh — run CI's fast TypeScript checks on the files a push changes.
#
# WHY: 21% of PR-stage CI runs failed (79/377, 2026-10-29..11-02), and in all but 2
# the failure was real, not a flake: the PR's own vitest tests (test-electron, 69 of
# the 79), tsc errors (renderer-tsc, 24) or lint (e.g. max-lines). Each miss costs a
# 12-minute CI run plus a fix-up push. These checks take about 1-2 minutes locally.
#
# WHAT, per package touched by the push (changed = merge-base(origin/main)..pushed sha):
#   taxonomy-editor/  eslint on changed src files, tsc -p tsconfig.json and
#                     tsc -p tsconfig.main.json (the test-electron + renderer-tsc type
#                     checks), vitest related on the changed files.
#   lib/              eslint on changed files, tsc -p debate/tsconfig.json and
#                     typecheck:brief-nodenext (the lib-lint checks); lib tests run from
#                     taxonomy-editor's vitest config, so changed lib files also go to
#                     vitest related there.
# vitest related gets ABSOLUTE paths: taxonomy-editor's vitest root is src/renderer, and
# relative paths silently match no tests.
#
# BLOCKS (exit 1) when a check fails, or when node_modules (root or any checked package)
# resolves outside this worktree via a symlink/junction (t/4816 -- pnpm through such a link
# writes into whatever it targets, not this worktree). FAIL-OPEN with a WARN (exit 0) when it
# cannot run: pnpm missing, a package without node_modules (fresh worktree: run pnpm install),
# no origin/main to diff against. A broken guard must never block legitimate work.
#
# Checks run on the WORKING TREE, which can differ from the pushed commit if you have
# uncommitted edits; the script warns when it does.
#
# Overrides (visible in the command): AITRIAD_PREPUSH=skip git push   or   git push --no-verify
#
# Usage:
#   pre-push-checks.sh <base-sha> <head-sha>    run the checks for base..head
#   pre-push-checks.sh --plan <path>...         print the checks for these repo paths (no run)
# ─────────────────────────────────────────────────────────────────────────────

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "pre-push: WARN cannot find repo root; skipping checks." >&2; exit 0; }
cd "$ROOT" || exit 0

is_ts() { case "$1" in *.ts|*.tsx|*.mts|*.cts) return 0 ;; esac; return 1; }
is_lintable() { case "$1" in *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs) return 0 ;; esac; return 1; }

# check_node_modules_link <node_modules dir> -> 0 if absent or resolves inside $ROOT, 1 if it
# resolves outside (symlink/junction to another checkout). A pnpm invocation through such a
# link writes through it into whatever it targets -- t/4815 was a worktree's node_modules
# junctioned to the shared checkout's, so `pnpm exec` in the worktree rewrote shared links.
#
# Both sides are re-resolved via `pwd -P` (not compared against $ROOT directly): git
# rev-parse's path style (e.g. C:/Users/...) can differ from pwd -P's (e.g. /c/Users/...
# under Git Bash) for the SAME directory, which falsely flagged a real, non-linked directory
# as "outside" when compared against $ROOT as-is (t/4816).
check_node_modules_link() {
  nm="$1"
  [ -d "$nm" ] || return 0
  real=$(cd "$nm" 2>/dev/null && pwd -P) || return 0
  rootreal=$(cd "$ROOT" 2>/dev/null && pwd -P) || return 0
  case "$real" in
    "$rootreal"/*|"$rootreal") return 0 ;;
    *)
      echo "pre-push: ERROR $nm resolves to '$real', outside this worktree root '$ROOT' (symlink/junction?)." >&2
      echo "pre-push:   Running pnpm here would write through the link into whatever it points at (t/4815)." >&2
      echo "pre-push:   Fix: remove the link and run 'pnpm install' directly inside this worktree." >&2
      return 1
      ;;
  esac
}

# plan_for <file list on stdin> -> prints one check per line: "<pkg>|<kind>|<arg>"
plan_for() {
  te_lint=""; te_ts=0; lib_lint=""; lib_ts=0; related=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      taxonomy-editor/src/*)
        is_lintable "$f" && te_lint="$te_lint ${f#taxonomy-editor/}"
        is_ts "$f" && { te_ts=1; related="$related $ROOT/$f"; } ;;
      taxonomy-editor/*)
        is_ts "$f" && te_ts=1 ;;
      lib/*)
        is_lintable "$f" && lib_lint="$lib_lint ${f#lib/}"
        is_ts "$f" && { lib_ts=1; related="$related $ROOT/$f"; } ;;
    esac
  done
  [ -n "$te_lint" ] && echo "taxonomy-editor|eslint|$te_lint"
  [ "$te_ts" = 1 ] && { echo "taxonomy-editor|tsc|tsconfig.json"; echo "taxonomy-editor|tsc|tsconfig.main.json"; }
  [ -n "$lib_lint" ] && echo "lib|eslint|$lib_lint"
  [ "$lib_ts" = 1 ] && { echo "lib|tsc|debate/tsconfig.json"; echo "lib|script|typecheck:brief-nodenext"; }
  [ -n "$related" ] && echo "taxonomy-editor|vitest-related|$related"
  return 0
}

if [ "$1" = "--plan" ]; then
  shift
  for f in "$@"; do echo "$f"; done | plan_for
  exit 0
fi

# Test-only entry point for check_node_modules_link (t/4816): exercises the guard without a
# full base/head run, so a scratch junction/symlink can be asserted refused or passed directly.
if [ "$1" = "--check-link" ]; then
  check_node_modules_link "$2"
  exit $?
fi

BASE=$1; HEAD=$2
if [ -z "$BASE" ] || [ -z "$HEAD" ]; then
  echo "usage: pre-push-checks.sh <base-sha> <head-sha> | --plan <path>..." >&2; exit 0
fi

CHANGED=$(git diff --name-only --diff-filter=ACMR "$BASE" "$HEAD" 2>/dev/null) || {
  echo "pre-push: WARN could not diff $BASE..$HEAD; skipping checks." >&2; exit 0; }
PLAN=$(echo "$CHANGED" | plan_for)
[ -z "$PLAN" ] && exit 0

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pre-push: WARN pnpm not found; skipping TypeScript checks (CI will still run them)." >&2; exit 0
fi

# Root node_modules link check (t/4816), before any pnpm call: 2 of 3 real instances found
# alongside t/4815 were root-level junctions, not per-package ones, and pnpm reads the root
# workspace link store on every invocation regardless of which package's checks run.
check_node_modules_link "$ROOT/node_modules" || exit 1

# Uncommitted code anywhere under the checked packages (pushed files or not, tracked or
# untracked) makes a failure unattributable: tsc and vitest check the whole tree, so another
# agent's half-edit in a shared checkout could fail them. Then failures WARN instead of block.
DIRTY=$(git status --porcelain --untracked-files=all -- taxonomy-editor lib 2>/dev/null |
  while IFS= read -r line; do is_lintable "${line#???}" && echo "$line"; done)
[ -n "$DIRTY" ] && echo "pre-push: WARN the working tree has uncommitted code, so failures below will warn, not block:
$(echo "$DIRTY" | head -5)" >&2

echo "pre-push: running CI's fast checks on changed TypeScript (AITRIAD_PREPUSH=skip to bypass)..."
FAILED=""
WARNED=""
OLDIFS=$IFS
IFS='
'
for step in $PLAN; do
  IFS=$OLDIFS
  pkg=${step%%|*}; rest=${step#*|}; kind=${rest%%|*}; arg=${rest#*|}
  if [ ! -d "$ROOT/$pkg/node_modules" ]; then
    case " $WARNED " in *" $pkg "*) ;; *)
      echo "pre-push: WARN $pkg/node_modules missing (fresh worktree?): skipping its checks. Run 'pnpm install' in $pkg to enable them." >&2
      WARNED="$WARNED $pkg" ;;
    esac
    IFS='
'
    continue
  fi
  check_node_modules_link "$ROOT/$pkg/node_modules" || exit 1
  start=$(date +%s)
  case "$kind" in
    eslint)         label="$pkg: eslint (changed files)"; ( cd "$ROOT/$pkg" && pnpm exec eslint --no-warn-ignored $arg ) ;;
    tsc)            label="$pkg: tsc -p $arg";            ( cd "$ROOT/$pkg" && pnpm exec tsc --noEmit -p "$arg" ) ;;
    script)         label="$pkg: pnpm run $arg";          ( cd "$ROOT/$pkg" && pnpm run --silent "$arg" ) ;;
    vitest-related) label="$pkg: vitest related";         ( cd "$ROOT/$pkg" && pnpm exec vitest related --run --passWithNoTests $arg ) ;;
  esac
  rc=$?
  secs=$(( $(date +%s) - start ))
  if [ $rc -eq 0 ]; then echo "pre-push:   ok    $label (${secs}s)"
  else echo "pre-push:   FAIL  $label (${secs}s)"; FAILED="$FAILED
  - $label"; fi
  IFS='
'
done
IFS=$OLDIFS

if [ -n "$FAILED" ] && [ -n "$DIRTY" ]; then
  echo "
pre-push: WARN these checks failed, but uncommitted code in the tree means the failure may not
be this push's. Not blocking; CI will judge the pushed commit:$FAILED" >&2
  exit 0
fi
if [ -n "$FAILED" ]; then
  echo "
pre-push: BLOCKED. These checks fail locally and would fail CI:$FAILED

  Fix them and push again. Override only if you must: AITRIAD_PREPUSH=skip git push" >&2
  exit 1
fi
exit 0
