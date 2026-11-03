#!/bin/sh
# sweep-landed-worktrees.sh — remove linked worktrees whose PR has landed.
#
# WHY: land-from-worktree step 8 (`git worktree remove`) is a manual step that agents skip after
# their PR merges, so merged worktrees accumulate (509 at last count). This sweep automates it.
#
# A worktree is removed ONLY when ALL of:
#   - it is not the main checkout, not locked, and its working tree is clean (`git worktree remove`
#     without --force also refuses dirty trees — defence in depth);
#   - its branch has a PR whose state is MERGED (gh pr view <branch>);
#   - its HEAD is the PR's merged head SHA, OR HEAD is already an ancestor of origin/main
#     (so no commit exists that never reached main).
# The local branch is deleted under the same test (`git branch -d` semantics via the same SHA check).
# Remote branches are NOT touched here: repo setting delete_branch_on_merge handles new merges.
#
# Usage: sh operations/devops/sweep-landed-worktrees.sh [--dry-run]
# Non-blocking by design when run from .githooks/post-merge (background, errors logged, never fails
# the merge). Every removal is logged to stdout with its reason.

DRY=0
[ "$1" = "--dry-run" ] && DRY=1

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$ROOT" || exit 0

if ! command -v gh >/dev/null 2>&1; then
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
  case "$path" in */ai-triad-research) continue ;; esac   # main checkout
  [ -n "$locked" ] && continue
  [ -z "$ref" ] && continue                                  # detached: no PR branch
  branch=${ref#refs/heads/}
  [ -d "$path" ] || continue
  dirty=$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$dirty" != "0" ] && continue
  pr=$(gh pr view "$branch" --json state,headRefOid -q '.state + " " + .headRefOid' 2>/dev/null)
  case "$pr" in MERGED*) ;; *) continue ;; esac
  merged_oid=${pr#MERGED }
  head=$(git -C "$path" rev-parse HEAD 2>/dev/null)
  if [ "$head" = "$merged_oid" ] || git -C "$path" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    if [ "$DRY" = 1 ]; then
      echo "sweep-landed-worktrees: WOULD remove $path ($branch, PR MERGED)"
    else
      if git worktree remove "$path" 2>/dev/null; then
        echo "sweep-landed-worktrees: removed $path ($branch, PR MERGED)"
        git branch -D "$branch" >/dev/null 2>&1 && echo "sweep-landed-worktrees: deleted local branch $branch"
      else
        echo "sweep-landed-worktrees: WARN could not remove $path; left in place" >&2
      fi
    fi
  else
    echo "sweep-landed-worktrees: skip $path ($branch): HEAD $head is neither PR head $merged_oid nor on origin/main" >&2
  fi
done
exit 0
