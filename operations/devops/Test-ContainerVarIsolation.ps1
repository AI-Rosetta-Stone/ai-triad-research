<#
.SYNOPSIS
    CI check (t/4794#9 item 2, hardened t/4953): every *_CONTAINER env var -- whether the server
    code reads it OR main.bicep declares it -- must be wired in main.bicep's baseEnv (prod) AND
    resolve, for staging, to a value that is set, DIFFERENT from prod's, and `staging-`-prefixed.

.DESCRIPTION
    t/4794: AZURE_ANALYTICS_CONTAINER was read by the server (process.env.AZURE_ANALYTICS_CONTAINER,
    server.ts:1428) but never wired in main.bicep for either app, so staging silently fell back to
    the same code default as prod ('analytics') and leaked 213 staging-origin events into prod's
    analytics data over ~15h. The existing t/4506 wiring check (Test-EnvBicepWiring.ps1) is
    warn-only and checks only "is this name wired SOMEWHERE" -- it does not check that prod and
    staging actually resolve to DIFFERENT values, which is the real isolation property a
    *_CONTAINER var needs.

    Discovery (the union of two sources):
      1. Server code: taxonomy-editor/src/server/**/*.ts (excluding __tests__/ and *.test.ts).
         Recognised read forms (t/4953):
           - dot access:        env.X_CONTAINER / process.env.X_CONTAINER
           - quoted brackets:   env['X_CONTAINER'] / process.env["X_CONTAINER"] / env[`X_CONTAINER`]
           - destructuring:     const { X_CONTAINER } = process.env   (multi-name, multi-line,
                                renames and defaults included)
         An INDIRECT read (`process.env[<expression>]`) cannot be resolved statically. It is
         reported as a WARN finding ("indirect, needs an allowlist reason"), not a failure: the
         real server code has several such helpers today and none reads a *_CONTAINER var.
      2. main.bicep (t/100#4, TL p/12#68): every *_CONTAINER name in baseEnv or
         stagingEnvOverrides, so a container var the scanner can't see is still checked.

    For each discovered name, statically from main.bicep (via Get-BicepBaseEnv.ps1):
      - prod (baseEnv, no -ForStaging) has it as a literal;
      - staging's effective value (baseEnv merged with stagingEnvOverrides, -ForStaging) is set,
        differs from prod's, and starts with `staging-`.
    A dropped staging override makes staging INHERIT prod's value -- the exact incident shape --
    and fails here, as does an override equal to prod's.

.OUTPUTS
    Exits 1 with one ::error:: line per violation plus an actionable error on stderr.
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

# Local minimal helper (copied from Get-BicepBaseEnv.ps1): operations/devops scripts don't import
# AITriad.psm1, so CI steps can run them standalone.
function New-ActionableError {
    param([string]$Goal, [string]$Problem, [string]$Location, [string]$NextSteps)
    "Goal: $Goal`nProblem: $Problem`nLocation: $Location`nResolve: $NextSteps"
}

$goal = 'Prove every *_CONTAINER env var resolves to an isolated staging- value, different from prod (t/4794, t/4953)'

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $ServerRoot) { $ServerRoot = Join-Path $repoRoot 'taxonomy-editor/src/server' }
if (-not $BicepPath)  { $BicepPath  = Join-Path $repoRoot 'deploy/azure/main.bicep' }

# ── 1. Discover every distinct *_CONTAINER var the server code reads ────────────────────────
$nameRx = '[A-Z][A-Z0-9_]*_CONTAINER'
# `env` must be either `process.env` or a standalone `env` identifier (not `safeEnv`, `foo.env`).
$envRx  = '(?:process\.env|(?<![\w$.])env)'
$dotPattern      = "$envRx\.($nameRx)\b"
$bracketPattern  = "$envRx\[\s*(?:'($nameRx)'|""($nameRx)""|``($nameRx)``)\s*\]"
$destructPattern = "(?s)\{([^{}]*)\}\s*=\s*$envRx\b"
# One level of nested brackets is allowed in the key (`process.env[NAMES[backend]]`).
$indirectPattern = "$envRx\[\s*([^\[\]'""``\s][^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*?)\s*\]"

$files = Get-ChildItem -Path $ServerRoot -Recurse -Filter '*.ts' -File |
    Where-Object { $_.FullName -notmatch '[\\/]__tests__[\\/]' -and $_.FullName -notmatch '\.test\.ts$' }

$fromCode = [System.Collections.Generic.SortedSet[string]]::new()
$indirect = [System.Collections.Generic.SortedSet[string]]::new()  # dedupes two reads on one line
foreach ($file in $files) {
    $text = Get-Content $file.FullName -Raw
    if (-not $text) { continue }
    foreach ($m in [regex]::Matches($text, $dotPattern)) { [void]$fromCode.Add($m.Groups[1].Value) }
    foreach ($m in [regex]::Matches($text, $bracketPattern)) {
        foreach ($g in 1..3) { if ($m.Groups[$g].Success) { [void]$fromCode.Add($m.Groups[$g].Value) } }
    }
    foreach ($m in [regex]::Matches($text, $destructPattern)) {
        foreach ($n in [regex]::Matches($m.Groups[1].Value, "\b($nameRx)\b")) { [void]$fromCode.Add($n.Groups[1].Value) }
    }
    foreach ($m in [regex]::Matches($text, $indirectPattern)) {
        $lineNo = ($text.Substring(0, $m.Index) -split "`n").Count
        $rel = [System.IO.Path]::GetRelativePath($ServerRoot, $file.FullName) -replace '\\', '/'
        [void]$indirect.Add("${rel}:$lineNo reads env[$($m.Groups[1].Value)]")
    }
}

foreach ($i in $indirect) {
    # Fallback: an indirect read can't be resolved to a name, so it is surfaced as a finding
    # instead of being checked. WARN, per docs/error-handling.md -- never a silent skip.
    Write-Host "::warning::Test-ContainerVarIsolation: WARN indirect env read at $i -- the var name can't be resolved statically, so it is NOT isolation-checked. If it can hold a *_CONTAINER name, read it directly; otherwise it needs an allowlist reason (t/4953)."
}

if ($fromCode.Count -eq 0) {
    Write-Host "::error::Test-ContainerVarIsolation: discovered 0 *_CONTAINER vars in $ServerRoot"
    [Console]::Error.WriteLine((New-ActionableError -Goal $goal `
        -Problem "the scanner discovered 0 *_CONTAINER vars in the server code at $ServerRoot -- scanner broken or server code moved (population floor, same principle as t/4058's lint)" `
        -Location 'Test-ContainerVarIsolation.ps1, step 1 (server-code discovery)' `
        -NextSteps 'Check -ServerRoot points at taxonomy-editor/src/server, and that the read forms there are ones this scanner recognises (see .DESCRIPTION); extend the scanner rather than lowering the floor.'))
    exit 1
}
Write-Host "Test-ContainerVarIsolation: server code reads $($fromCode.Count) *_CONTAINER var(s): $([string]::Join(', ', $fromCode))"

# ── 2. Resolve against Bicep: baseEnv-only (prod) vs staging-merged ─────────────────────────
$bicepParser = Join-Path $PSScriptRoot 'Get-BicepBaseEnv.ps1'
try {
    $baseOnly    = & $bicepParser -BicepPath $BicepPath
    $staging     = & $bicepParser -BicepPath $BicepPath -ForStaging
    $bicepNames  = @(& $bicepParser -BicepPath $BicepPath -ForStaging -NamesOnly)
} catch {
    Write-Host "::error::Test-ContainerVarIsolation: could not parse $BicepPath"
    [Console]::Error.WriteLine((New-ActionableError -Goal $goal `
        -Problem "Get-BicepBaseEnv.ps1 failed on ${BicepPath}: $($_.Exception.Message)" `
        -Location 'Test-ContainerVarIsolation.ps1, step 2 (Bicep resolution)' `
        -NextSteps 'Fix the main.bicep shape the parser reports (it fails closed on purpose, t/4794), then re-run.'))
    exit 1
}

$discovered = [System.Collections.Generic.SortedSet[string]]::new($fromCode)
foreach ($n in $bicepNames) { if ($n -cmatch "^$nameRx$") { [void]$discovered.Add($n) } }

$violations = [System.Collections.Generic.List[string]]::new()
foreach ($name in $discovered) {
    if (-not $baseOnly.ContainsKey($name)) {
        $violations.Add("'$name' is not wired as a literal in main.bicep's baseEnv (prod) at all")
        continue
    }
    $prod = $baseOnly[$name]
    if (-not $staging.ContainsKey($name) -or [string]::IsNullOrEmpty($staging[$name])) {
        $violations.Add("'$name' has no staging value set (prod is '$prod')")
        continue
    }
    $stg = $staging[$name]
    if ($stg -ceq $prod) {
        $violations.Add("'$name' resolves to the SAME value ('$prod') for prod and staging -- the stagingEnvOverrides entry is missing or equals prod's, so staging would serve prod's container")
        continue
    }
    if (-not $stg.StartsWith('staging-', [System.StringComparison]::Ordinal)) {
        $violations.Add("'$name' staging value '$stg' differs from prod's '$prod' but lacks the 'staging-' prefix every staging container uses")
    }
}

if ($violations.Count -gt 0) {
    foreach ($v in $violations) { Write-Host "::error::Test-ContainerVarIsolation: $v" }
    [Console]::Error.WriteLine((New-ActionableError -Goal $goal `
        -Problem "$($violations.Count) of $($discovered.Count) *_CONTAINER var(s) are not isolated between prod and staging (see the ::error:: lines above)" `
        -Location "$BicepPath (var baseEnv / var stagingEnvOverrides)" `
        -NextSteps "For each var: give baseEnv a literal prod value, and add a stagingEnvOverrides entry resolving to a 'staging-' value (a param with a literal default, as AZURE_ANALYTICS_CONTAINER does). Never let staging inherit prod's container (t/4794)."))
    exit 1
}

Write-Host "Test-ContainerVarIsolation: PASSED -- all $($discovered.Count) *_CONTAINER var(s) ($([string]::Join(', ', $discovered))) resolve to set, different, staging- prefixed staging values."
exit 0
