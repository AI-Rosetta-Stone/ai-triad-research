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
#   - its branch has MERGED: its PR's state is MERGED, and HEAD is that PR's merged head SHA or already an
#     ancestor of origin/main (so no commit exists that never reached main). A PR is required: a fresh
#     worktree cut from main with no commits yet is also "on origin/main" and must never be swept;
#   - its working tree is clean: no modified, staged or untracked (non-ignored) files. A merged worktree
#     that is NOT clean is skipped with a WARN naming it and the counts, so its owner can act; it is
#     never removed with --force, and `git worktree remove` without --force refuses dirty trees anyway.
# The local branch is deleted under the same test. Remote branches are NOT touched here: the repo
# setting delete_branch_on_merge handles new merges.
#
# Usage: sh operations/devops/sweep-landed-worktrees.sh [--dry-run]
# Non-blocking by design (errors logged, exit 0). Every removal, WARN and skip is logged with its reason.
# Test seam: SWEEP_GH overrides the gh command (operations/devops/sweep-landed-worktrees.test.mjs).

DRY=0
[ "$1" = "--dry-run" ] && DRY=1
GH=${SWEEP_GH:-gh}

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
while IFS="$(printf '\t')" read -r path ref locked; do
  [ "$(cd "$path" 2>/dev/null && pwd -P)" = "$MAIN_ROOT" ] && continue   # main checkout
  [ -n "$locked" ] && continue
  [ -z "$ref" ] && continue                                              # detached: no branch
  branch=${ref#refs/heads/}
  [ -d "$path" ] || continue
  head=$(git -C "$path" rev-parse HEAD 2>/dev/null) || continue

  # 1. Has the branch merged? A MERGED PR is required: "HEAD on origin/main" alone would also match a
  #    worktree an agent has just created from main and not yet committed to, which must never be swept.
  pr=$("$GH" pr view "$branch" --json state,headRefOid -q '.state + " " + .headRefOid' 2>/dev/null)
  case "$pr" in MERGED*) ;; *) continue ;; esac                           # no merged PR: nothing to do
  merged_oid=${pr#MERGED }
  if [ "$head" = "$merged_oid" ]; then merged="PR MERGED at its head"
  elif git -C "$path" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then merged="PR MERGED, HEAD on origin/main"
  else
    echo "sweep-landed-worktrees: skip $path ($branch): HEAD $head is neither PR head $merged_oid nor on origin/main" >&2
    continue
  fi

  # 2. Merged: is the tree clean? (modified/staged, and untracked non-ignored files, counted apart)
  modified=$(git -C "$path" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')
  untracked=$(git -C "$path" ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
  if [ "$modified" != "0" ] || [ "$untracked" != "0" ]; then
    echo "sweep-landed-worktrees: WARN $path ($branch) has merged ($merged) but is not clean: $modified modified/staged, $untracked untracked. Left in place; commit, stash or discard, then it is removed on the next sweep." >&2
    continue
  fi

  # 3. Merged and clean: remove (never --force) and delete the local branch.
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
