#!/usr/bin/env bash
# Doc link check (t/2091): relative links in MAIN-REPO-TRACKED docs must resolve
# against `git ls-files` (main-repo presence), NOT the on-disk working tree.
#
# Why: the fleet shares a combined working tree where the Orca overlay
# (overlay-only/, .orca/, nested AGENTS.md, …) is present on disk but is NOT
# tracked in the public main repo. A relative link from a public doc (e.g. root
# AGENTS.md) to an overlay-only path resolves locally for fleet agents yet 404s
# for anyone viewing the public repo (t/2089). Filesystem existence !=
# main-repo presence.
#
# Scope (AC #3): only files returned by `git ls-files` are checked. Overlay-only
# docs are absent from `git ls-files`, so they are exempt and may freely link to
# overlay paths. A tracked doc whose link resolves to an untracked path is a
# public dead link and is flagged.
#
# Emits ::warning:: annotations and exits non-zero when any public dead link is
# found. Wired into ci.yml (doc-accuracy job) with continue-on-error while it is
# advisory — matches the check-doc-claims.sh soft-launch pattern. Drop
# continue-on-error in ci.yml to promote it to a hard gate.
#
# Self-test: `check-doc-links.sh --self-test` builds a synthetic repo that
# reproduces the t/2089 case (root AGENTS.md -> overlay-only/docs/…) and asserts
# it is caught while an overlay-only doc linking the same path is not (AC #4).
set -euo pipefail

# ── path normalization (collapse ./, ../, //) ───────────────────────────────
normalize_path() {
  local path="$1" part joined
  local -a parts=() out=()
  local IFS='/'
  read -ra parts <<< "$path"
  for part in "${parts[@]}"; do
    case "$part" in
      ''|'.') continue ;;
      '..')
        if [ "${#out[@]}" -gt 0 ] && [ "${out[-1]}" != ".." ]; then
          unset 'out[-1]'
        else
          out+=('..')
        fi
        ;;
      *) out+=("$part") ;;
    esac
  done
  joined="${out[*]}"
  printf '%s' "$joined"
}

# ── core check over a repo root ─────────────────────────────────────────────
# Prints one line per dead link: "<doc>\t<target>\t<resolved>". Exits 0 always;
# caller decides annotation/exit policy. Membership = `git ls-files` (files) plus
# every ancestor directory (so links to tracked directories resolve).
find_dead_links() {
  local root="$1"
  (
    cd "$root"
    declare -A TRACKED_SET TRACKED_DIR
    local p d
    # Pure-bash ancestor extraction (${d%/*}) — no per-file subshell. A
    # $(dirname) loop over the full tree spawns tens of thousands of
    # subprocesses and times out on Git Bash / Windows.
    while IFS= read -r p; do
      TRACKED_SET["$p"]=1
      d="$p"
      while [[ "$d" == */* ]]; do
        d="${d%/*}"
        TRACKED_DIR["$d"]=1
      done
    done < <(git ls-files)

    local doc dir target resolved
    while IFS= read -r doc; do
      if [[ "$doc" == */* ]]; then dir="${doc%/*}"; else dir='.'; fi
      # extract link targets: the URL portion of [text](url)
      while IFS= read -r target; do
        target="${target%%#*}"      # drop #anchor
        target="${target%% *}"      # drop optional "title" after a space
        [ -z "$target" ] && continue
        case "$target" in
          http://*|https://*|mailto:*|tel:*|ftp://*|//*|/*|\#*) continue ;;
        esac
        if [ "$dir" = '.' ]; then
          resolved="$(normalize_path "$target")"
        else
          resolved="$(normalize_path "$dir/$target")"
        fi
        [ -z "$resolved" ] && continue
        if [ -z "${TRACKED_SET[$resolved]:-}" ] && [ -z "${TRACKED_DIR[$resolved]:-}" ]; then
          printf '%s\t%s\t%s\n' "$doc" "$target" "$resolved"
        fi
      done < <(grep -oP '\]\(\K[^)]+' "$doc" 2>/dev/null || true)
    done < <(git ls-files '*.md' '*.markdown')
  )
}

run_ci_check() {
  local root="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
  local exit_code=0 count=0
  echo "=== Doc link check (main-repo-tracked docs) ==="
  while IFS=$'\t' read -r doc target resolved; do
    [ -z "$doc" ] && continue
    echo "::warning file=$doc,title=Public dead link::$doc links to '$target' -> '$resolved', which is NOT tracked in the main repo (public 404). Overlay-only targets do not belong in a public/tracked doc."
    count=$((count + 1))
    exit_code=1
  done < <(find_dead_links "$root")
  if [ "$count" -eq 0 ]; then
    echo "  OK — no public dead links in tracked docs"
  else
    echo "  $count public dead link(s) found"
  fi
  return "$exit_code"
}

# ── self-test (AC #4): reproduce the t/2089 case in a synthetic repo ─────────
run_self_test() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  (
    cd "$tmp"
    git init -q
    git config user.email t@t.t
    git config user.name t
    # public, TRACKED doc that links into an overlay-only path (the t/2089 bug)
    mkdir -p docs
    printf '# Public\nSee [x](overlay-only/docs/token-efficiency.md).\nAlso [ok](docs/real.md).\n' > AGENTS.md
    printf '# Real\n' > docs/real.md
    git add AGENTS.md docs/real.md
    git commit -qm init
    # overlay-only file: present on disk, NOT tracked (exempt, AC #3)
    mkdir -p overlay-only/docs
    printf '# tok\n' > overlay-only/docs/token-efficiency.md
    printf '# Overlay\nLink to [tok](docs/token-efficiency.md) is fine here.\n' > overlay-only/AGENTS.md
  )
  local out
  out="$(find_dead_links "$tmp")"
  local pass=1
  # 1. root AGENTS.md -> overlay-only/... MUST be flagged
  if ! grep -q $'^AGENTS.md\toverlay-only/docs/token-efficiency.md' <<< "$out"; then
    echo "FAIL: root AGENTS.md -> overlay-only/… was not flagged"; pass=0
  fi
  # 2. tracked -> tracked (docs/real.md) must NOT be flagged
  if grep -q 'docs/real.md' <<< "$out"; then
    echo "FAIL: tracked link docs/real.md was wrongly flagged"; pass=0
  fi
  # 3. overlay-only doc (untracked) must be exempt entirely
  if grep -q '^overlay-only/AGENTS.md' <<< "$out"; then
    echo "FAIL: overlay-only doc was not exempt"; pass=0
  fi
  if [ "$pass" -eq 1 ]; then
    echo "self-test OK — t/2089 case caught; tracked + overlay cases correct"
    return 0
  fi
  echo "--- dead-link output was ---"; printf '%s\n' "$out"
  return 1
}

case "${1:-}" in
  --self-test) run_self_test ;;
  --root) run_ci_check "${2:-}" ;;
  *) run_ci_check ;;
esac
