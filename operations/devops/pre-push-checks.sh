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
# BLOCKS (exit 1) only when a check fails. FAIL-OPEN with a WARN (exit 0) when it cannot
# run: pnpm missing, a package without node_modules (fresh worktree: run pnpm install),
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
