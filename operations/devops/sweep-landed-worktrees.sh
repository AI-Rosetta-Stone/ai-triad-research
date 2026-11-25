#!/bin/sh
# sweep-landed-worktrees.sh — remove linked worktrees whose branch has landed.
#
# WHY: land-from-worktree step 8 (`git worktree remove`) is a manual step that agents skip after
# their PR merges, so merged worktrees accumulate (509 at last count). This sweep automates it.
# PI rule (t/9, p/4#32, 2026-11-25): remove your worktree when its PR merges. TL (p/12#242): enforce it
# for a worktree whose branch has merged AND whose tree is clean; WARN and skip otherwise; never force.
#
# A worktree is removed ONLY when ALL of:
#   - it is not the main checkout, not locked, and has a branch (detached worktrees are left alone);
#   - its branch has MERGED: its PR's state is MERGED, and HEAD is that PR's head SHA or an ancestor of it
#     (so every local commit is in the merged PR). A PR is required, and HEAD-on-origin/main is NOT
#     enough: a fresh worktree cut from main, or a reused branch name reset to main, must never be swept;
#   - its working tree is clean: no modified, staged or untracked (non-ignored) files. A merged worktree
#     that is NOT clean is skipped with a WARN naming it and the counts, so its owner can act; it is
#     never removed with --force, and `git worktree remove` without --force refuses dirty trees anyway;
#   - no file in it (outside node_modules and .git) was modified in the last 2 hours, so an agent
#     mid-work is never swept (Security p/278#9).
# Every removal, WARN and skip is logged with its reason. A failed git read or file scan removes nothing.
# The local branch is deleted under the same test. Remote branches are NOT touched here: the repo
# setting delete_branch_on_merge handles new merges.
#
# Usage: sh operations/devops/sweep-landed-worktrees.sh [--dry-run]
# Non-blocking by design (errors logged, exit 0). Every removal, WARN and skip is logged with its reason.
# Test seams: SWEEP_GH overrides the gh command; SWEEP_RECENT_MINUTES overrides the 120-minute idle window (operations/devops/sweep-landed-worktrees.test.mjs).

DRY=0
[ "$1" = "--dry-run" ] && DRY=1
GH=${SWEEP_GH:-gh}
RECENT_MIN=${SWEEP_RECENT_MINUTES:-120}   # Security p/278#9: no file modified in the last 2 hours

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$ROOT" || exit 0
MAIN_ROOT=$(cd "$(git rev-parse --git-common-dir)/.." 2>/dev/null && pwd -P)

if ! command -v "$GH" >/dev/null 2>&1; then
  echo "sweep-landed-worktrees: WARN gh not found; skipping sweep (no PR state available)" >&2
  exit 0
fi

git fetch --quiet origin 2>/dev/null

git worktree list --porcelain | awk '
  /^worktree /{p=substr($0,10)}
  /^branch /{b[p]=substr($0,8)}
  /^locked/{l[p]=1}
  /^$/{ if (p!="") print p "\t" b[p] "\t" (l[p]?"locked":""); p=""; }
  END{ if (p!="") print p "\t" b[p] "\t" (l[p]?"locked":"") }' |
while IFS="$(printf '	')" read -r path ref locked; do
  [ "$(cd "$path" 2>/dev/null && pwd -P)" = "$MAIN_ROOT" ] && continue   # the shared checkout: never
  skip() { echo "sweep-landed-worktrees: skip $path${branch:+ ($branch)}: $1" >&2; }
  branch=""
  [ -n "$locked" ] && { skip "locked"; continue; }
  [ -z "$ref" ] && { skip "detached (no branch)"; continue; }
  branch=${ref#refs/heads/}
  [ -d "$path" ] || { skip "folder missing"; continue; }
  head=$(git -C "$path" rev-parse HEAD 2>/dev/null) || { skip "git read failed (rev-parse HEAD); fail closed"; continue; }

  # 1. Has the branch merged? A MERGED PR is required: "HEAD on origin/main" alone would also match a
  #    worktree an agent has just created from main and not yet committed to, which must never be swept.
  pr=$("$GH" pr view "$branch" --json state,headRefOid -q '.state + " " + .headRefOid' 2>/dev/null)
  case "$pr" in
    MERGED*) ;;
    "") skip "no PR (or gh read failed)"; continue ;;
    *) skip "PR ${pr%% *}, not merged"; continue ;;
  esac
  merged_oid=${pr#MERGED }
  if [ "$head" = "$merged_oid" ]; then merged="PR MERGED at its head"
  # HEAD behind the PR head (an ancestor of it): every local commit is in the merged PR. Not "HEAD on
  # origin/main": with squash merges a branch's own commits never reach main, so that test mostly matched a
  # REUSED branch name reset to main, which an old merged PR then wrongly vouched for (Quality p/119#112).
  # A PR head object missing locally fails the test, so nothing is removed (fail closed).
  elif git -C "$path" merge-base --is-ancestor HEAD "$merged_oid" 2>/dev/null; then merged="PR MERGED, HEAD within the PR"
  else
    skip "HEAD $head is neither the PR head $merged_oid nor behind it (a commit not in the merged PR, or a reused branch name)"
    continue
  fi

  # 2. Merged: is the tree clean? (modified/staged, and untracked non-ignored files, counted apart.)
  #    A failed read is never read as clean (Security p/278#9 condition 4: fail closed).
  st=$(git -C "$path" status --porcelain --untracked-files=no 2>/dev/null) || { skip "git read failed (status); fail closed"; continue; }
  ut=$(git -C "$path" ls-files --others --exclude-standard 2>/dev/null) || { skip "git read failed (ls-files); fail closed"; continue; }
  modified=$(printf '%s' "$st" | grep -c . | tr -d ' ')
  untracked=$(printf '%s' "$ut" | grep -c . | tr -d ' ')
  if [ "$modified" != "0" ] || [ "$untracked" != "0" ]; then
    echo "sweep-landed-worktrees: WARN $path ($branch) has merged ($merged) but is not clean: $modified modified/staged, $untracked untracked. Left in place; commit (and push) or discard the changes, never git stash (the stash list is shared across worktrees), then it is removed on the next sweep." >&2
    continue
  fi

  # 3. Merged and clean: was any file touched recently? An agent mid-work must never be swept
  #    (Security p/278#9 condition 1). node_modules and .git are not work; a failed scan is fail closed.
  recent=$(find "$path" \( -name node_modules -o -name .git \) -prune -o -type f -mmin "-$RECENT_MIN" -print -quit 2>/dev/null) \
    || { skip "file-age scan failed; fail closed"; continue; }
  [ -n "$recent" ] && { skip "a file was modified in the last $RECENT_MIN minutes ($recent)"; continue; }

  # 4. Merged, clean and idle: remove (never --force) and delete the local branch (never a remote one).
  if [ "$DRY" = 1 ]; then
    echo "sweep-landed-worktrees: WOULD remove $path ($branch, $merged)"
  elif git worktree remove "$path" 2>/dev/null; then
    echo "sweep-landed-worktrees: removed $path ($branch, $merged)"
    git branch -D "$branch" >/dev/null 2>&1 && echo "sweep-landed-worktrees: deleted local branch $branch"
  else
    echo "sweep-landed-worktrees: WARN could not remove $path; left in place" >&2
  fi
done
exit 0
