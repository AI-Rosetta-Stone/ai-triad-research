<#
.SYNOPSIS
    CI check (t/4794#9 item 2): every AZURE_*_CONTAINER var the server code reads must be
    wired in BOTH main.bicep's baseEnv AND stagingEnvOverrides, resolving to a DIFFERENT
    value in each -- the specific isolation property this incident broke.

.DESCRIPTION
    t/4794: AZURE_ANALYTICS_CONTAINER was read by the server (process.env.AZURE_ANALYTICS_CONTAINER,
    server.ts:1428) but never wired in main.bicep for either app, so staging silently fell back to
    the same code default as prod ('analytics') and leaked 213 staging-origin events into prod's
    analytics data over ~15h. The existing t/4506 wiring check (Test-EnvBicepWiring.ps1) is
    warn-only and checks only "is this name wired SOMEWHERE" -- it does not check that prod and
    staging actually resolve to DIFFERENT values, which is the real isolation property a
    *_CONTAINER var needs. This check is narrower in scope (only *_CONTAINER vars) but BLOCKING,
    and checks the differing-value property directly.

    Scans taxonomy-editor/src/server/**/*.ts (excluding __tests__/*.test.ts) for any
    `env.<NAME>` or `process.env.<NAME>` reference where <NAME> matches `AZURE_*_CONTAINER`
    (catches both the destructured-env form used by userContentContainer.ts/communityContainer.ts/
    briefExportsContainer.ts and the process.env form used by server.ts -- "env." is a substring
    of "process.env." too, so one pattern catches both).

    For each distinct name found, requires (via Get-BicepBaseEnv.ps1):
      - present in baseEnv (prod, no -ForStaging) as a literal;
      - present under -ForStaging, resolving to a value that DIFFERS from the baseEnv-only value.
    A var present in baseEnv but with NO override at all resolves to the SAME value under both
    calls -- exactly the shape that bit us -- and fails this check.

.OUTPUTS
    Exits 1 with one ::error:: line per violation (BLOCKING, unlike t/4506's warn-only check).
    Exits 0 if every discovered *_CONTAINER var isolates cleanly.

.EXAMPLE
    pwsh -NoProfile -File operations/devops/Test-ContainerVarIsolation.ps1
#>
[CmdletBinding()]
param(
    [string]$ServerRoot,
    [string]$BicepPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $ServerRoot) { $ServerRoot = Join-Path $repoRoot 'taxonomy-editor/src/server' }
if (-not $BicepPath)  { $BicepPath  = Join-Path $repoRoot 'deploy/azure/main.bicep' }

# ── 1. Discover every distinct AZURE_*_CONTAINER var the server code reads ──────────────────
$containerVarPattern = 'env\.([A-Z][A-Z0-9_]*_CONTAINER)\b'
$files = Get-ChildItem -Path $ServerRoot -Recurse -Filter '*.ts' -File |
    Where-Object { $_.FullName -notmatch '[\\/]__tests__[\\/]' -and $_.FullName -notmatch '\.test\.ts$' }

$discovered = [System.Collections.Generic.SortedSet[string]]::new()
foreach ($file in $files) {
    foreach ($line in Get-Content $file.FullName) {
        foreach ($m in [regex]::Matches($line, $containerVarPattern)) {
            [void]$discovered.Add($m.Groups[1].Value)
        }
    }
}

if ($discovered.Count -eq 0) {
    Write-Error "Test-ContainerVarIsolation: discovered 0 AZURE_*_CONTAINER vars in $ServerRoot -- scanner broken or server code moved (population floor, same principle as t/4058's lint)."
    exit 1
}

# ── 2. Resolve each against Bicep: baseEnv-only vs staging-merged ───────────────────────────
$bicepParser = Join-Path $PSScriptRoot 'Get-BicepBaseEnv.ps1'
$baseOnly = & $bicepParser -BicepPath $BicepPath
$staging  = & $bicepParser -BicepPath $BicepPath -ForStaging

$violations = [System.Collections.Generic.List[string]]::new()
foreach ($name in $discovered) {
    if (-not $baseOnly.ContainsKey($name)) {
        $violations.Add("'$name' is not wired as a literal in main.bicep's baseEnv at all")
        continue
    }
    if (-not $staging.ContainsKey($name)) {
        $violations.Add("'$name' is in baseEnv but Get-BicepBaseEnv.ps1 -ForStaging dropped it entirely (should be impossible if baseEnv has it)")
        continue
    }
    if ($staging[$name] -eq $baseOnly[$name]) {
        $violations.Add("'$name' resolves to the SAME value ('$($baseOnly[$name])') for prod and staging -- no stagingEnvOverrides entry isolates it, so staging would serve prod's container")
    }
}

if ($violations.Count -gt 0) {
    foreach ($v in $violations) { Write-Host "::error::Test-ContainerVarIsolation: $v" }
    Write-Error "Test-ContainerVarIsolation: $($violations.Count) of $($discovered.Count) AZURE_*_CONTAINER var(s) are not isolated between prod and staging. (t/4794)"
    exit 1
}

Write-Host "Test-ContainerVarIsolation: PASSED -- all $($discovered.Count) AZURE_*_CONTAINER var(s) ($([string]::Join(', ', $discovered))) resolve to different prod/staging values."
exit 0
