<#
.SYNOPSIS
    CI gate: validates that every Container App's cpu:memory pair in main.bicep
    is an ACA Consumption plan allowed combination. Exits non-zero on any invalid pair.

.DESCRIPTION
    Parses deploy/azure/main.bicep for `resources: { cpu: ... memory: ... }` blocks
    and checks each pair against the ACA Consumption allowed-pairs table (co-located
    here per gate co-location practice).

    ACA Consumption allowed cpu:memory pairs (source: Azure docs):
      0.25 vCPU / 0.5 Gi    0.50 vCPU / 1 Gi      0.75 vCPU / 1.5 Gi
      1.00 vCPU / 2 Gi      1.25 vCPU / 2.5 Gi    1.50 vCPU / 3 Gi
      1.75 vCPU / 3.5 Gi   2.00 vCPU / 4 Gi

    Gate proof arms (required in PR description before merge — t/3212):
      FIRE (invalid combo): cpu: json('2.0') + memory: '2Gi' -> exits 1
      FIRE (zero pairs):    bicep with no resources block     -> exits 1
      CLEAN:                existing valid pairs              -> exits 0

.PARAMETER BicepPath
    Path to deploy/azure/main.bicep. Defaults to repo-relative location.

.PARAMETER SuppressAnnotations
    Emits plain PAIR-ERROR: lines instead of ::error:: annotations. Use in tests
    to avoid polluting CI log with annotations from deliberate FIRE-arm runs.
#>
[CmdletBinding()]
param(
    [string]$BicepPath,
    [switch]$SuppressAnnotations
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Allowed-pairs table (co-located per gate co-location practice) ────────────
# Key: cpu as [double]; Value: required memory string
$allowedPairs = @{
    [double]0.25 = '0.5Gi'
    [double]0.5  = '1Gi'
    [double]0.75 = '1.5Gi'
    [double]1.0  = '2Gi'
    [double]1.25 = '2.5Gi'
    [double]1.5  = '3Gi'
    [double]1.75 = '3.5Gi'
    [double]2.0  = '4Gi'
}

function Write-CIError([string]$msg) {
    if ($SuppressAnnotations) { Write-Host "PAIR-ERROR: $msg" }
    else { Write-Host "::error::$msg" }
}

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not $BicepPath) { $BicepPath = Join-Path $repoRoot 'deploy/azure/main.bicep' }

if (-not (Test-Path $BicepPath)) {
    Write-CIError "main.bicep not found at: $BicepPath"
    exit 1
}

# ── Parse resources blocks ────────────────────────────────────────────────────
# State machine: detect 'resources: {', collect cpu/memory, close on '}'.
# The resources block in ACA Bicep is flat (no nested braces), so the first
# closing '}' after the opening terminates the block.
$lines    = Get-Content $BicepPath
$inBlock  = $false
$cpu      = $null
$memory   = $null
$pairs    = [System.Collections.Generic.List[PSCustomObject]]::new()
$unresolved = [System.Collections.Generic.List[string]]::new()

# Top-level string-literal vars (e.g. var prodCpu = '1.0', t/4263), so `cpu: json(prodCpu)` and
# `memory: prodMemory` resolve. Without this, a block referencing a var silently dropped out of
# the check (the pair count fell from 2 to 1 with no error).
$stringVars = @{}
foreach ($line in $lines) {
    if ($line -match "^\s*var\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([^']*)'\s*(//.*)?$") {
        $stringVars[$Matches[1]] = $Matches[2]
    }
}

foreach ($line in $lines) {
    if (-not $inBlock) {
        if ($line -match 'resources\s*:\s*\{') {
            $inBlock = $true
            $cpu     = $null
            $memory  = $null
        }
        continue
    }

    # Extract cpu — json('N'), json(varName) or bare numeric
    if ($line -match 'cpu\s*:\s*json\s*\(\s*''([^'']+)''\s*\)') {
        $cpu = $Matches[1]
    } elseif ($line -match 'cpu\s*:\s*json\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)') {
        $name = $Matches[1]
        if ($stringVars.ContainsKey($name)) { $cpu = $stringVars[$name] } else { $unresolved.Add("cpu: json($name)") ; $cpu = '?' }
    } elseif ($line -match "cpu\s*:\s*([0-9]+(?:\.[0-9]+)?)") {
        $cpu = $Matches[1]
    }

    # Extract memory — '4Gi' literal or varName
    if ($line -match "memory\s*:\s*'([^']+)'") {
        $memory = $Matches[1]
    } elseif ($line -match 'memory\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(//.*)?$') {
        $name = $Matches[1]
        if ($stringVars.ContainsKey($name)) { $memory = $stringVars[$name] } else { $unresolved.Add("memory: $name"); $memory = '?' }
    }

    # Closing brace — end of resources block
    if ($line -match '^\s*\}\s*$') {
        if ($null -ne $cpu -and $null -ne $memory -and $cpu -ne '?' -and $memory -ne '?') {
            $pairs.Add([PSCustomObject]@{ Cpu = $cpu; Memory = $memory })
        }
        $inBlock = $false
        $cpu     = $null
        $memory  = $null
    }
}

# ── Fail closed on references the parser cannot resolve to a literal ─────────
if ($unresolved.Count -gt 0) {
    Write-CIError "Unresolvable cpu/memory reference(s) in main.bicep: $($unresolved -join ', '). Use a literal or a top-level string var (var x = '...')."
    exit 1
}

# ── No-silent-skip guard ──────────────────────────────────────────────────────
if ($pairs.Count -eq 0) {
    Write-CIError 'No cpu:memory pairs found in main.bicep resources blocks — check parsing or bicep structure'
    exit 1
}

# ── Validate each pair ────────────────────────────────────────────────────────
$pass = $true
$rows = [System.Collections.Generic.List[PSCustomObject]]::new()

foreach ($pair in $pairs) {
    $cpuDouble = [double]$pair.Cpu
    $expected  = $allowedPairs[$cpuDouble]

    if ($null -eq $expected) {
        $rows.Add([PSCustomObject]@{ Cpu = $pair.Cpu; Memory = $pair.Memory; Expected = '(no valid pair for this cpu)'; Status = 'FAIL' })
        Write-CIError "Invalid ACA cpu:memory — cpu=$($pair.Cpu) is not a recognized ACA Consumption vCPU value"
        $pass = $false
    } elseif ($pair.Memory -ne $expected) {
        $rows.Add([PSCustomObject]@{ Cpu = $pair.Cpu; Memory = $pair.Memory; Expected = $expected; Status = 'FAIL' })
        Write-CIError "Invalid ACA cpu:memory — cpu=$($pair.Cpu) requires memory=$expected, got '$($pair.Memory)' (ContainerAppInvalidResourceTotal — t/3212)"
        $pass = $false
    } else {
        $rows.Add([PSCustomObject]@{ Cpu = $pair.Cpu; Memory = $pair.Memory; Expected = $expected; Status = 'OK' })
    }
}

$rows | Format-Table Cpu, Memory, Expected, Status -AutoSize | Out-String | Write-Host

if (-not $pass) {
    Write-CIError 'ACA cpu:memory validation failed. Fix main.bicep to use an allowed pair. See t/3212.'
    exit 1
}

Write-Host "ACA cpu:memory validation PASSED — $($pairs.Count) pair(s) checked."
