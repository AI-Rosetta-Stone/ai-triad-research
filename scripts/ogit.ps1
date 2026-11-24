#!/usr/bin/env pwsh
# Overlay repo wrapper — equivalent to the `ogit` shell alias but works in non-interactive
# shells (Bash tool, CI scripts) where aliases are unavailable.
#
# Usage: pwsh ./scripts/ogit.ps1 <git-args>
#   e.g. pwsh ./scripts/ogit.ps1 status
#        pwsh ./scripts/ogit.ps1 add -f .interweave/mcp.json
#        pwsh ./scripts/ogit.ps1 commit -m "message"
#
# Always resolves paths relative to the git repo root, so it works from any subdirectory.

# Primary: ask git for the repo root. Fallback: the script lives at <repo>/scripts/ogit.ps1,
# so $PSScriptRoot/.. is the repo root — reliable even in nested non-interactive pwsh sessions
# where git may not be in PATH or rev-parse returns nothing.
$repoRoot = git rev-parse --show-toplevel 2>$null
if (-not $repoRoot) {
    $repoRoot = (Resolve-Path "$PSScriptRoot/..").Path
}

& git --git-dir="$repoRoot/.orca-git" --work-tree="$repoRoot" @args
