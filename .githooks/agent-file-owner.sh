#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# agent-file-owner.sh — answer "which repo owns this AGENTS.md?" in one command,
# and fail when the answer is ambiguous or missing (t/2080).
#
# WHY: this project spans three repos with different rules — the public code repo
# (`git`), the private Orca overlay (`git --git-dir=.orca-git`), and the SSH data
# repo. `AGENTS.md` was tracked in the first two with NO coordination between
# them, so "which repo does this file belong to" had to be answered per file,
# from memory, at commit time. Two concrete failures that produced:
#   • root `AGENTS.md` was tracked in BOTH repos and silently DIVERGED — the
#     overlay carried a stale pre-refactor revision behind main's current one,
#     surviving at least one hand-reconcile (overlay 6675678, t/2066).
#   • two role files (`…/components/chat/AGENTS.md`, `…/components/settings/`)
#     were tracked in NEITHER repo — ignored by main, never `add -f`d into the
#     overlay. They existed in exactly one place on one machine, one
#     `git clean -xfd` from unrecoverable. Recovered at overlay 01d782f.
# The second case is the important one: the answer set is not {main, overlay} but
# {main, overlay, NEITHER}, and NEITHER is invisible to both repos' `status`.
#
# THE RULE this enforces (stated as a predicate, not a per-file convention):
#   An AGENTS.md is MAIN-repo-tracked iff a PUBLIC-repo consumer needs it
#   without the overlay. Everything else is OVERLAY-tracked. Never both.
# Today that predicate yields exactly the two paths in MAIN_OWNED below.
#
# USAGE:
#   sh .githooks/agent-file-owner.sh --path <file>   # → main | overlay | NEITHER
#   sh .githooks/agent-file-owner.sh --audit         # → exit 1 on any violation
#
# EXIT CODES: 0 = clean, 1 = violation found (audit), 2 = internal error.
# Callers that must not block on a broken guard should treat ONLY 1 as fatal.
# ─────────────────────────────────────────────────────────────────────────────

set -u

# ── Gate configuration, co-located at point of use (t/1589) ──────────────────
# The complete set of AGENTS.md the MAIN repo tracks. Adding a path here is a
# deliberate act: it publishes that file to the public repo. The matching
# re-exclusions live in `.orca-gitignore` — the two lists must stay disjoint,
# which is what check 1 below enforces.
#
#   AGENTS.md                            — root project instructions; a public
#                                          contributor cloning only the code repo
#                                          needs these to build and test.
#   operations/devops/azure/AGENTS.md    — Azure deploy/runbook detail, referenced
#                                          by name from the root file; a dangling
#                                          reference in the public repo is worse
#                                          than the content being public.
MAIN_OWNED='AGENTS.md
operations/devops/azure/AGENTS.md'

# Normalise via cd+pwd: raw --show-toplevel returns C:/... when invoked from a
# git hook on Windows, but /c/... when run directly. ogit's -C flag then sees a
# different working set than a direct run, producing spurious double-tracked /
# neither-tracked failures that block every commit on the shared checkout.
# Same idiom pre-commit already applies to git-dir / git-common-dir (t/2112).
root=$(cd "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null && pwd) || {
  echo "agent-file-owner: not inside a git work tree" >&2; exit 2; }

overlay_dir="$root/.orca-git"

# The overlay is a PRIVATE repo and is absent from any public/CI checkout. When it
# is missing we cannot see the overlay's tracking set, so checks 1 and 2 are
# skipped and only the main-side allowlist check runs. This is a real coverage
# limitation, stated here rather than assumed: CI can catch "main tracks something
# it shouldn't", but only a developer checkout can catch double-tracked/NEITHER.
have_overlay=0
[ -d "$overlay_dir" ] && have_overlay=1

ogit() { GIT_INDEX_FILE="$overlay_dir/index" git --git-dir="$overlay_dir" --work-tree="$root" -C "$root" "$@"; }

main_tracked()    { git -C "$root" ls-files -- '*AGENTS.md' 'AGENTS.md' 2>/dev/null | sort -u; }
overlay_tracked() { [ "$have_overlay" -eq 1 ] || return 0
                    ogit ls-files -- '*AGENTS.md' 'AGENTS.md' 2>/dev/null | sort -u; }

# Prune the expensive/irrelevant trees. `.claude` and `.worktrees` both hold
# linked worktrees, whose AGENTS.md are checkouts of the same tracked paths —
# walking them double-counts and false-positives as tracked-by-neither at their
# nested paths (t/2080 recurrence: fleet uses BOTH worktree roots). Adding a
# third worktree location must be reflected here.
on_disk() {
  ( cd "$root" && find . \
      \( -name node_modules -o -name .git -o -name .orca-git -o -name .claude -o -name .worktrees \
         -o -name dist -o -name build -o -name out \) -prune \
      -o -name AGENTS.md -print 2>/dev/null ) | sed 's|^\./||' | sort -u
}

# ── --path <file> ────────────────────────────────────────────────────────────
mode_path() {
  rel=$1
  # Normalize an absolute or ./-prefixed path to repo-relative.
  case "$rel" in
    "$root"/*) rel=${rel#"$root"/} ;;
    ./*)       rel=${rel#./} ;;
  esac

  # Ask each repo about THIS path, not the AGENTS.md-only lists the audit uses: the overlay also
  # tracks non-AGENTS files (.orca/, .interweave/), which those lists made read as NEITHER (t/245).
  in_main=0;    git -C "$root" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 && in_main=1
  in_overlay=0
  [ "$have_overlay" -eq 1 ] && ogit ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 && in_overlay=1

  if [ "$in_main" -eq 1 ] && [ "$in_overlay" -eq 1 ]; then
    echo "BOTH  ← violation: double-tracked, run --audit"; return 1
  fi
  [ "$in_main" -eq 1 ]    && { echo "main"; return 0; }
  [ "$in_overlay" -eq 1 ] && { echo "overlay"; return 0; }
  # Nested-git-repo exclusion (t/2548): a file whose directory belongs to a
  # DIFFERENT git repo (e.g. .local-data/ai-triad-data — the sibling data repo
  # cloned inside the tree) is that repo's to track, not this project's.
  if [ -e "$root/$rel" ]; then
    case "$rel" in */*) fdir="$root/${rel%/*}" ;; *) fdir="$root" ;; esac
    # Normalise the same way as $root — a raw --show-toplevel returns C:/...
    # while $root is /c/..., so an un-normalised compare never matches and
    # classifies EVERY file as external, silently emptying the audit.
    ftop=$(cd "$(git -C "$fdir" rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null && pwd) || ftop=$root
    if [ "$ftop" != "$root" ]; then
      echo "external (nested git repo at ${ftop#"$root"/} — tracked there, not by this project)"
      return 0
    fi
  fi
  if [ "$have_overlay" -eq 0 ]; then
    echo "NEITHER (overlay absent — cannot distinguish overlay from untracked)"
    return 0
  fi
  echo "NEITHER  ← violation: backed up nowhere, run --audit"; return 1
}

# ── --audit ──────────────────────────────────────────────────────────────────
mode_audit() {
  rc=0
  mt=$(main_tracked)
  ot=$(overlay_tracked)

  # Check 1 — double-tracked. Must be empty: the two tracking sets are disjoint
  # by construction (main .gitignore allowlist ∩ .orca-gitignore re-exclusions).
  if [ "$have_overlay" -eq 1 ]; then
    both=$(printf '%s\n' "$mt" "$ot" | grep -v '^$' | sort | uniq -d)
    if [ -n "$both" ]; then
      echo "✖ DOUBLE-TRACKED in both the code repo and the overlay:" >&2
      printf '%s\n' "$both" | sed 's/^/    /' >&2
      printf '%s\n' "$both" | while IFS= read -r f; do
        [ -n "$f" ] || continue
        # --verify -q is required: plain `rev-parse` ECHOES an unresolvable arg to
        # stdout instead of failing quietly, which garbles this line for a file
        # that is staged but not yet in HEAD.
        mb=$(git -C "$root" rev-parse --verify -q "HEAD:$f" 2>/dev/null) || mb='(not in HEAD)'
        ob=$(ogit rev-parse --verify -q "HEAD:$f" 2>/dev/null) || ob='(not in HEAD)'
        [ "$mb" = "$ob" ] || echo "    └─ and they have DIVERGED: main $mb vs overlay $ob" >&2
      done
      echo "  Fix: pick one home per the predicate in this file's header, then" >&2
      echo "       'git rm --cached' it from the other repo." >&2
      rc=1
    fi
  fi

  # Check 2 — tracked by NEITHER repo. This is the unrecoverable one.
  if [ "$have_overlay" -eq 1 ]; then
    orphans=$(printf '%s\n' "$(on_disk)" | grep -v '^$' | while IFS= read -r f; do
      printf '%s\n' "$mt" | grep -qxF -- "$f" && continue
      printf '%s\n' "$ot" | grep -qxF -- "$f" && continue
      # Nested-git-repo exclusion (t/2548): skip files owned by a different git
      # repo nested in the tree (e.g. .local-data/ai-triad-data — the sibling
      # data repo clone); that repo, not this one, is their backing store. A
      # genuine orphan's directory resolves to THIS root and still fires.
      case "$f" in */*) fdir="$root/${f%/*}" ;; *) fdir="$root" ;; esac
      # Normalise to match $root's form (see the paired site above).
      ftop=$(cd "$(git -C "$fdir" rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null && pwd) || ftop=$root
      [ "$ftop" != "$root" ] && continue
      echo "$f"
    done)
    if [ -n "$orphans" ]; then
      echo "✖ TRACKED BY NEITHER REPO — these exist only on this machine:" >&2
      printf '%s\n' "$orphans" | sed 's/^/    /' >&2
      echo "  Fix (overlay is the default home for role instructions):" >&2
      echo "    git --git-dir=.orca-git --work-tree=. add -f <path>" >&2
      echo "  A new nested AGENTS.md needs '-f' — the overlay whitelist alone" >&2
      echo "  does not stage it, which is exactly how the t/2080 pair was lost." >&2
      rc=1
    fi
  fi

  # Check 3 — main tracks exactly MAIN_OWNED, no more and no less.
  extra=$(printf '%s\n' "$mt" | grep -v '^$' | while IFS= read -r f; do
    printf '%s\n' "$MAIN_OWNED" | grep -qxF -- "$f" || echo "$f"
  done)
  if [ -n "$extra" ]; then
    echo "✖ The CODE repo tracks an AGENTS.md outside its allowlist:" >&2
    printf '%s\n' "$extra" | sed 's/^/    /' >&2
    echo "  Role instructions belong in the overlay. If this file genuinely must" >&2
    echo "  be public, add it to MAIN_OWNED here AND re-exclude it in" >&2
    echo "  .orca-gitignore — both, or it becomes double-tracked." >&2
    rc=1
  fi

  missing=$(printf '%s\n' "$MAIN_OWNED" | while IFS= read -r f; do
    [ -n "$f" ] || continue
    printf '%s\n' "$mt" | grep -qxF -- "$f" || echo "$f"
  done)
  if [ -n "$missing" ]; then
    echo "✖ Allowlisted in MAIN_OWNED but NOT tracked by the code repo:" >&2
    printf '%s\n' "$missing" | sed 's/^/    /' >&2
    echo "  Fix: git add -f <path>   (.gitignore ignores **/AGENTS.md by default)" >&2
    rc=1
  fi

  [ "$rc" -eq 0 ] && [ "${QUIET:-0}" != "1" ] && {
    if [ "$have_overlay" -eq 1 ]; then
      echo "agent-file-owner: clean — tracking sets disjoint, nothing orphaned."
    else
      echo "agent-file-owner: clean (overlay absent — allowlist check only)."
    fi
  }
  return $rc
}

case "${1:-}" in
  --path)  [ $# -ge 2 ] || { echo "usage: $0 --path <file>" >&2; exit 2; }
           mode_path "$2" ;;
  --audit) mode_audit ;;
  *)       echo "usage: $0 --path <file> | --audit" >&2; exit 2 ;;
esac
