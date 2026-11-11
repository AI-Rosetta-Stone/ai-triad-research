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
#   *.ps1/.psm1/.psd1 anywhere: parse-only syntax check (Test-PowerShellSyntax.ps1, t/289).
#   *.py anywhere:    python -m py_compile (t/289).
# vitest related gets ABSOLUTE paths: taxonomy-editor's vitest root is src/renderer, and
# relative paths silently match no tests.
#
# BLOCKS (exit 1) when a check fails; when node_modules (root or any checked package)
# resolves outside this worktree via a symlink/junction (t/4816 -- pnpm through such a link
# writes into whatever it targets, not this worktree); and, since t/289, when TypeScript checks
# are due but cannot run: pnpm missing, or a package without node_modules (fresh worktree).
# Before t/289 those two failed open, and 7 of 9 worktrees behind one day's compile-broken PRs
# had no node_modules, so broken TypeScript reached CI (t/288#1). FAIL-OPEN with a WARN (exit 0)
# only when the guard itself cannot work: no repo root, no diff, no origin/main, and pwsh or
# python missing (their checks are skipped; CI still runs Pester and the Python tests).
#
# The TypeScript checks run on the WORKING TREE, which can differ from the pushed commit if you
# have uncommitted edits; the script warns when it does. The PowerShell and Python checks read
# the PUSHED blobs (git cat-file), so their verdict is exact whatever the working tree holds.
#
# Overrides (visible in the command): AITRIAD_PREPUSH=skip git push   or   git push --no-verify
#
# Usage:
#   pre-push-checks.sh <base-sha> <head-sha>    run the checks for base..head
#   pre-push-checks.sh --plan <path>...         print the checks for these repo paths (no run)
# ─────────────────────────────────────────────────────────────────────────────

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "pre-push: WARN cannot find repo root; skipping checks." >&2; exit 0; }
cd "$ROOT" || exit 0

# File lists in a plan line are TAB-separated, so a path containing spaces stays one argument
# (splitting an unquoted list on spaces broke such paths, and globbing could expand a path
# containing * or ?). The runner below splits on TAB only, with globbing off.
TAB=$(printf '\t')

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
  te_lint=""; te_ts=0; lib_lint=""; lib_ts=0; related=""; ps=""; py=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *.ps1|*.psm1|*.psd1) ps="$ps$TAB$f" ;;
      *.py) py="$py$TAB$f" ;;
    esac
    case "$f" in
      taxonomy-editor/src/*)
        is_lintable "$f" && te_lint="$te_lint$TAB${f#taxonomy-editor/}"
        is_ts "$f" && { te_ts=1; related="$related$TAB$ROOT/$f"; } ;;
      taxonomy-editor/*)
        is_ts "$f" && te_ts=1 ;;
      lib/*)
        is_lintable "$f" && lib_lint="$lib_lint$TAB${f#lib/}"
        is_ts "$f" && { lib_ts=1; related="$related$TAB$ROOT/$f"; } ;;
    esac
  done
  [ -n "$te_lint" ] && echo "taxonomy-editor|eslint|$te_lint"
  [ "$te_ts" = 1 ] && { echo "taxonomy-editor|tsc|tsconfig.json"; echo "taxonomy-editor|tsc|tsconfig.main.json"; }
  [ -n "$lib_lint" ] && echo "lib|eslint|$lib_lint"
  [ "$lib_ts" = 1 ] && { echo "lib|tsc|debate/tsconfig.json"; echo "lib|script|typecheck:brief-nodenext"; }
  [ -n "$related" ] && echo "taxonomy-editor|vitest-related|$related"
  [ -n "$ps" ] && echo "powershell|parse|$ps"
  [ -n "$py" ] && echo "python|py_compile|$py"
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

BLOCK_HINT="Visible override: AITRIAD_PREPUSH=skip git push"
# Test seam (tests/PrePushBlocking.Tests.ps1): lets the pwsh-missing arm run without stripping
# PATH, which on Linux runners also strips git (/usr/bin holds both). It is used ONLY for the
# presence test below; the check itself always runs the literal `pwsh`, so this variable can
# only skip the PowerShell check with a WARN (never fake an `ok`), which AITRIAD_PREPUSH=skip
# already does more broadly.
PWSH=${AITRIAD_PREPUSH_PWSH:-pwsh}

# TypeScript preconditions (t/289): if TypeScript checks are due and cannot run, BLOCK. Every
# missing package is reported at once, before any check runs, so one fix-up covers them all.
TS_PKGS=$(echo "$PLAN" | while IFS= read -r s; do
  case "$s" in powershell\|*|python\|*|'') ;; *) echo "${s%%|*}" ;; esac
done | sort -u)
if [ -n "$TS_PKGS" ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pre-push: BLOCKED pnpm not found, so TypeScript checks can't run. Install it (corepack enable), run: pnpm install --frozen-lockfile (in this worktree), then push again. $BLOCK_HINT" >&2
    exit 1
  fi
  # Root node_modules link check (t/4816), before any pnpm call: 2 of 3 real instances found
  # alongside t/4815 were root-level junctions, not per-package ones, and pnpm reads the root
  # workspace link store on every invocation regardless of which package's checks run.
  check_node_modules_link "$ROOT/node_modules" || exit 1
  MISSING=""
  for pkg in $TS_PKGS; do
    if [ ! -d "$ROOT/$pkg/node_modules" ]; then
      echo "pre-push: BLOCKED $pkg has no node_modules, so TypeScript checks can't run. Run: pnpm install --frozen-lockfile (in this worktree), then push again. $BLOCK_HINT" >&2
      MISSING=1
    else
      check_node_modules_link "$ROOT/$pkg/node_modules" || exit 1
    fi
  done
  [ -n "$MISSING" ] && exit 1
fi

# Uncommitted code anywhere under the checked packages (pushed files or not, tracked or
# untracked) makes a TypeScript failure unattributable: tsc and vitest check the whole tree, so
# another agent's half-edit in a shared checkout could fail them. Then those failures WARN
# instead of block. PowerShell/Python verdicts read the pushed blobs, so they always block.
DIRTY=""
if [ -n "$TS_PKGS" ]; then
  DIRTY=$(git status --porcelain --untracked-files=all -- taxonomy-editor lib 2>/dev/null |
    while IFS= read -r line; do is_lintable "${line#???}" && echo "$line"; done)
  [ -n "$DIRTY" ] && echo "pre-push: WARN the working tree has uncommitted code, so TypeScript failures below will warn, not block:
$(echo "$DIRTY" | head -5)" >&2
fi

# extract_pushed <dir> <file>... -> writes each file's PUSHED content ($HEAD) to <dir>/<file>.
# MSYS_NO_PATHCONV: Git Bash would otherwise rewrite the "<sha>:<path>" argument as a path.
extract_pushed() {
  dir=$1; shift
  for f in "$@"; do
    mkdir -p "$dir/$(dirname "$f")" &&
      MSYS_NO_PATHCONV=1 git cat-file blob "$HEAD:$f" > "$dir/$f" || return 1
  done
}

find_python() {
  for py in python3 python; do
    # The Windows Store "python" stub exists on PATH but cannot run code, so probe it.
    command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys' >/dev/null 2>&1 && { echo "$py"; return 0; }
  done
  return 1
}

# t/379: one `vitest related` at a time per MACHINE. Many agents push from one box; concurrent
# runs each start a full fork pool and starve one another ('Failed to start forks worker', 20
# unrelated files failing, 25-minute runs), so agents reached for AITRIAD_PREPUSH=skip. The lock
# is a directory (mkdir is atomic on Windows and Linux) holding "<pid> <epoch> <worktree>".
#   - Busy: wait, printing who holds it every 30s. Never fail for a busy lock: after
#     AITRIAD_PREPUSH_LOCK_WAIT seconds (default 1200) WARN and skip vitest; CI still runs it.
#   - Stale: the holder's pid is gone (kill -0; hooks all run under Git's one sh, so pids are
#     comparable), or the lock is older than AITRIAD_PREPUSH_LOCK_STALE seconds (default 2700):
#     WARN and take it over. Two waiters can both judge one lock stale in the same instant; the
#     cost of that race is one overlapping run, never a wrong verdict.
#   - Released on exit, interrupt or termination, only by its owner.
# Workers are capped at half the cores, so even an unlocked run (timeout) cannot take the box.
LOCK_DIR=${AITRIAD_PREPUSH_LOCK_DIR:-${LOCALAPPDATA:-${XDG_CACHE_HOME:-$HOME/.cache}}/aitriad/prepush.lock}
LOCK_WAIT=${AITRIAD_PREPUSH_LOCK_WAIT:-1200}
LOCK_STALE=${AITRIAD_PREPUSH_LOCK_STALE:-2700}
LOCK_OWNED=""
CORES=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)
VITEST_WORKERS=$(( CORES / 2 )); [ "$VITEST_WORKERS" -ge 1 ] || VITEST_WORKERS=1

release_vitest_lock() {
  [ -n "$LOCK_OWNED" ] || return 0
  case "$(cat "$LOCK_DIR/owner" 2>/dev/null)" in "$$ "*) rm -rf "$LOCK_DIR" ;; esac
  LOCK_OWNED=""
}
trap release_vitest_lock EXIT
trap 'release_vitest_lock; exit 130' INT
trap 'release_vitest_lock; exit 143' TERM HUP

# Returns 0 holding the lock, 1 after the wait timed out (caller skips vitest with a WARN).
acquire_vitest_lock() {
  mkdir -p "$(dirname "$LOCK_DIR")" 2>/dev/null
  t0=$(date +%s); next_note=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    now=$(date +%s); waited=$(( now - t0 ))
    holder=$(cat "$LOCK_DIR/owner" 2>/dev/null); hpid=${holder%% *}
    born=$(stat -c %Y "$LOCK_DIR" 2>/dev/null || echo "$now")
    if { [ -n "$hpid" ] && ! kill -0 "$hpid" 2>/dev/null; } || [ $(( now - born )) -gt "$LOCK_STALE" ]; then
      echo "pre-push: WARN removing a stale vitest lock (holder: ${holder:-unknown}, age $(( now - born ))s): its process is gone or it outlived ${LOCK_STALE}s." >&2
      rm -rf "$LOCK_DIR"
      continue
    fi
    if [ "$waited" -ge "$LOCK_WAIT" ]; then
      echo "pre-push: WARN waited ${waited}s for the machine-wide vitest lock (holder: ${holder:-unknown}); skipping vitest for this push so a busy lock never blocks it. CI runs the tests. Lock: $LOCK_DIR" >&2
      return 1
    fi
    if [ "$waited" -ge "$next_note" ]; then
      echo "pre-push: waiting for the machine-wide vitest lock (held by: ${holder:-starting}; waited ${waited}s, gives up at ${LOCK_WAIT}s)..." >&2
      next_note=$(( waited + 30 ))
    fi
    sleep 2
  done
  echo "$$ $(date +%s) $ROOT" >"$LOCK_DIR/owner"
  LOCK_OWNED=1
  waited=$(( $(date +%s) - t0 ))
  [ "$waited" -gt 0 ] && echo "pre-push: got the vitest lock after waiting ${waited}s." >&2
  return 0
}

echo "pre-push: running CI's fast checks on changed files (AITRIAD_PREPUSH=skip to bypass)..."
FAILED=""
EXACT_FAILED=""
OLDIFS=$IFS
IFS='
'
for step in $PLAN; do
  IFS=$OLDIFS
  pkg=${step%%|*}; rest=${step#*|}; kind=${rest%%|*}; arg=${rest#*|}
  # File lists become positional args: split on TAB only, globbing off, then "$@" below.
  set -f; IFS=$TAB; set -- $arg; IFS=$OLDIFS; set +f
  start=$(date +%s)
  exact=""; tmp=""
  case "$kind" in
    eslint)         label="$pkg: eslint (changed files)"; ( cd "$ROOT/$pkg" && pnpm exec eslint --no-warn-ignored "$@" ) ;;
    tsc)            label="$pkg: tsc -p $arg";            ( cd "$ROOT/$pkg" && pnpm exec tsc --noEmit -p "$arg" ) ;;
    script)         label="$pkg: pnpm run $arg";          ( cd "$ROOT/$pkg" && pnpm run --silent "$arg" ) ;;
    vitest-related)
      label="$pkg: vitest related (max ${VITEST_WORKERS} workers)"
      if ! acquire_vitest_lock; then
        IFS='
'
        continue
      fi
      ( cd "$ROOT/$pkg" && pnpm exec vitest related --run --passWithNoTests --pool=forks --maxWorkers="$VITEST_WORKERS" "$@" )
      rc=$?
      release_vitest_lock
      ( exit $rc ) ;;
    parse)
      label="PowerShell parse ($# file(s))"; exact=1
      if ! command -v "$PWSH" >/dev/null 2>&1; then
        echo "pre-push: WARN pwsh not found; skipping the PowerShell parse check (CI's Pester still loads these files)." >&2
        IFS='
'
        continue
      fi
      tmp=$(mktemp -d) && extract_pushed "$tmp" "$@" &&
        ( cd "$tmp" && pwsh -NoProfile -NonInteractive -File "$ROOT/operations/devops/Test-PowerShellSyntax.ps1" "$@" ) >&2 ;;
    py_compile)
      label="Python py_compile ($# file(s))"; exact=1
      if ! pybin=$(find_python); then
        echo "pre-push: WARN python not found; skipping the Python compile check (CI still runs the Python tests)." >&2
        IFS='
'
        continue
      fi
      # Compiled inside the scratch dir, so no __pycache__ lands in the worktree. -I (isolated):
      # without it the scratch dir is sys.path[0], so a pushed top-level file named like a stdlib
      # module (py_compile.py, importlib/...) would run instead of it and could fake a pass.
      tmp=$(mktemp -d) && extract_pushed "$tmp" "$@" &&
        ( cd "$tmp" && "$pybin" -I -m py_compile "$@" ) ;;
  esac
  rc=$?
  [ -n "$exact" ] && [ -n "$tmp" ] && rm -rf "$tmp" && tmp=""
  secs=$(( $(date +%s) - start ))
  if [ $rc -eq 0 ]; then echo "pre-push:   ok    $label (${secs}s)"
  elif [ -n "$exact" ]; then echo "pre-push:   FAIL  $label (${secs}s)"; EXACT_FAILED="$EXACT_FAILED
  - $label"
  else echo "pre-push:   FAIL  $label (${secs}s)"; FAILED="$FAILED
  - $label"; fi
  IFS='
'
done
IFS=$OLDIFS

if [ -n "$FAILED" ] && [ -n "$DIRTY" ]; then
  echo "
pre-push: WARN these TypeScript checks failed, but uncommitted code in the tree means the failure
may not be this push's. Not blocking them; CI will judge the pushed commit:$FAILED" >&2
  FAILED=""
fi
if [ -n "$FAILED$EXACT_FAILED" ]; then
  echo "
pre-push: BLOCKED. These checks fail locally and would fail CI:$FAILED$EXACT_FAILED

  Fix them and push again. Override only if you must: AITRIAD_PREPUSH=skip git push" >&2
  exit 1
fi
exit 0
