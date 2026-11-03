<#
.SYNOPSIS
    CI check (t/4506, Class 5 prevention): every `process.env.<NAME>` read in the
    server source is either wired in main.bicep's baseEnv, or explicitly allowlisted
    with a reason.

.DESCRIPTION
    `bicep-env-drift` (Test-BicepEnvDrift.ps1) compares DEPLOYED Bicep literals vs
    the ExpectedEnvVars table -- it says nothing about whether the SERVER CODE reads
    a var Bicep never provides at all. That's the exact t/4504 failure class: #3691
    added a `process.env.IDENTITY_MAP` read, the Bicep wiring landed separately in
    #3744, and a deploy shipped the first without the second.

    Scans taxonomy-editor/src/server/**/*.ts (excluding __tests__) line-by-line for
    `process.env.<NAME>` and `process.env['<NAME>']` / `process.env["<NAME>"]`.
    For each distinct name, requires it in Get-BicepBaseEnv.ps1's -NamesOnly output
    (prod baseEnv) AND -ForStaging (staging overrides), OR on the allowlist
    (env-var-allowlist.json) with a non-empty one-line reason.

    KNOWN SCANNER GAPS (Quality review, t/4506#2) -- intentionally partial, not
    accidentally broken: a line-level regex cannot catch a COMPUTED key
    (`process.env[varName]`) or DESTRUCTURING (`const { PORT } = process.env`).
    Both read env vars without the scanner ever seeing the literal name.

.PARAMETER ServerRoot
    Root to scan. Defaults to taxonomy-editor/src/server relative to the repo root.

.PARAMETER AllowlistPath
    Path to env-var-allowlist.json. Defaults to the canonical location next to
    this script.

.OUTPUTS
    Prints one `::warning file=<path>,line=<n>::` annotation per unwired,
    unallowlisted read (inline PR diff annotation, Quality note 4). Exits 0 always
    -- warn-only (T1); promotion to blocking is a separate T2 per the ticket.

.EXAMPLE
    pwsh -NoProfile -File operations/devops/Test-EnvBicepWiring.ps1
#>
[CmdletBinding()]
param(
    [string]$ServerRoot,
    [string]$AllowlistPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $ServerRoot)     { $ServerRoot     = Join-Path $repoRoot 'taxonomy-editor/src/server' }
if (-not $AllowlistPath)  { $AllowlistPath  = Join-Path $PSScriptRoot 'env-var-allowlist.json' }

# ── 1. Names Bicep actually provides (prod baseEnv + staging overrides) ──────
$bicepParser = Join-Path $PSScriptRoot 'Get-BicepBaseEnv.ps1'
$wiredNames  = [System.Collections.Generic.HashSet[string]]::new(
    [string[]](. $bicepParser -NamesOnly -ForStaging)
)

# ── 2. Allowlist: name -> non-empty one-line reason ──────────────────────────
$allowlist = @{}
if (Test-Path $AllowlistPath) {
    $raw = Get-Content $AllowlistPath -Raw | ConvertFrom-Json
    foreach ($prop in $raw.PSObject.Properties) {
        $allowlist[$prop.Name] = [string]$prop.Value
    }
} else {
    Write-Warning "env-var-allowlist.json not found at $AllowlistPath -- treating as empty allowlist"
}

# ── 3. Scan every non-test .ts file under ServerRoot for process.env reads ───
# Matches `process.env.NAME`, `process.env['NAME']`, `process.env["NAME"]` on
# one line each. Does NOT catch computed keys or destructuring (see .DESCRIPTION).
$envReadPattern = "process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[['""]([A-Za-z_][A-Za-z0-9_]*)['""]\]"

$files = Get-ChildItem -Path $ServerRoot -Recurse -Filter '*.ts' -File |
    Where-Object { $_.FullName -notmatch '[\\/]__tests__[\\/]' }

$violationCount = 0
foreach ($file in $files) {
    $lineNum = 0
    foreach ($line in Get-Content $file.FullName) {
        $lineNum++
        foreach ($m in [regex]::Matches($line, $envReadPattern)) {
            $name = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
            if ($wiredNames.Contains($name)) { continue }
            if ($allowlist.ContainsKey($name) -and $allowlist[$name]) { continue }
            $violationCount++
            $relPath = $file.FullName.Substring($repoRoot.Length + 1).Replace('\', '/')
            $reason = if ($allowlist.ContainsKey($name)) { ' (allowlisted but reason is empty -- treated as unwired)' } else { '' }
            Write-Host "::warning file=$relPath,line=$lineNum::env var '$name' is read but not wired in main.bicep's baseEnv (prod or staging) and not allowlisted$reason -- wire it in main.bicep baseEnv, or allowlist it in operations/devops/env-var-allowlist.json with a reason"
        }
    }
}

if ($violationCount -eq 0) {
    Write-Host "Test-EnvBicepWiring: PASSED -- every process.env read is wired in Bicep or allowlisted"
} else {
    Write-Host "Test-EnvBicepWiring: $violationCount unwired/unallowlisted env read(s) found (warn-only, t/4506)"
}
exit 0
