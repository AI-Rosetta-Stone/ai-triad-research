#!/usr/bin/env bash
# t/391 (TL go p/9#81): decide whether a merge_group CI run needs the FULL suite.
#   ci-merge-group-scope.sh <base_sha> <head_sha> <filter_step_outcome>
# Writes `full=true|false` and `reason=...` to $GITHUB_OUTPUT (stdout if unset).
#
# The diff is base_sha..head_sha of the merge group: the union of EVERY PR in the batch, so a code
# change in one PR can't hide behind a docs PR batched with it.
#   full=true  when the batch touches shared code (SHARED_RE below), or whenever the scope can't be
#              judged: the paths-filter step failed, a SHA is missing or malformed, git diff fails,
#              or the diff is empty. Never fewer jobs on error (TL condition 1); each such case WARNs.
#   full=false only when the diff was computed and touches no shared code. Each gated job family
#              then runs only if the paths filter positively said its inputs changed, as on PRs.
# ci.yml reads it as `needs.changes.outputs.full != 'false'`, so a missing output (this script or
# the whole `changes` job never ran) also means the full suite.
set -uo pipefail

# Shared code: anything most job families import or build on, plus CI's own config. A change here
# runs everything (TL: "full suite for lib/, server, workflows, actions, manifests/lockfiles"), plus
# CI's own scripts (.github/scripts/) and root config several families read (SO #5110 p/136#12).
SHARED_RE='^(lib/|taxonomy-editor/src/server/|\.github/workflows/|\.github/actions/|\.github/ci/|\.github/scripts/|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.npmrc$|\.nvmrc$|\.node-version$|eslint\.config\.[cm]?[jt]s$)|(^|/)package\.json$|(^|/)tsconfig[^/]*\.json$'

out=${GITHUB_OUTPUT:-/dev/stdout}
base=${1:-} head=${2:-} outcome=${3:-}

decide() { # <full> <reason> [warn]
  echo "full=$1" >>"$out"
  echo "reason=$2" >>"$out"
  if [ "${3:-}" = warn ]; then echo "::warning::t/391 merge_group scope: FULL suite (fail-safe): $2"
  else echo "t/391 merge_group scope: full=$1: $2"; fi
  exit 0
}

[ "$outcome" = success ] || decide true "the paths-filter step did not succeed (outcome: ${outcome:-none})" warn
[[ $base =~ ^[0-9a-f]{40}$ && $head =~ ^[0-9a-f]{40}$ ]] || decide true "merge_group base/head SHA missing or malformed (base='$base' head='$head')" warn
if ! files=$(git diff --name-only "$base" "$head" 2>&1); then
  decide true "git diff $base..$head failed: $(printf '%s' "$files" | tr '\n' ' ' | head -c 300)" warn
fi
[ -n "$files" ] || decide true "the batch diff $base..$head is empty, so its scope can't be judged" warn
shared=$(printf '%s\n' "$files" | grep -E "$SHARED_RE" || true)
if [ -n "$shared" ]; then
  decide true "the batch changes shared code: $(printf '%s' "$shared" | tr '\n' ' ' | head -c 300)"
fi
decide false "the batch ($(printf '%s\n' "$files" | wc -l | tr -d ' ') files) touches no shared code; job families follow the paths filter"
