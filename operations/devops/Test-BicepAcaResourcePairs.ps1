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

# cpu value: json('N') | json(varName) | bare number. memory value: 'NGi' | varName.
$cpuValueRx = 'json\s*\(\s*(?:''(?<lit>[^'']+)''|(?<var>[A-Za-z_][A-Za-z0-9_]*))\s*\)|(?<num>[0-9]+(?:\.[0-9]+)?)'
$memValueRx = '''(?<lit>[^'']+)''|(?<var>[A-Za-z_][A-Za-z0-9_]*)'

function Resolve-PairValue([System.Text.RegularExpressions.Match]$M, [string]$Kind) {
    foreach ($g in 'lit', 'num') { if ($M.Groups[$g].Success) { return $M.Groups[$g].Value } }
    $name = $M.Groups['var'].Value
    if ($stringVars.ContainsKey($name)) { return $stringVars[$name] }
    $unresolved.Add("${Kind}: $name")
    return '?'
}

function Add-Pair([string]$Cpu, [string]$Memory) {
    if ($null -ne $Cpu -and $null -ne $Memory -and $Cpu -ne '?' -and $Memory -ne '?') {
        $pairs.Add([PSCustomObject]@{ Cpu = $Cpu; Memory = $Memory })
    }
}

$cpuSites = 0   # every non-comment `cpu:` occurrence — each must end up in exactly one pair
foreach ($line in $lines) {
    $code = ($line -replace '//.*$', '')
    $cpuSites += ([regex]::Matches($code, '\bcpu\s*:')).Count

    # Inline objects, e.g. the staging ternary `? { cpu: json(prodCpu), memory: prodMemory } : {...}` (t/4203)
    $inlineRx = "\{\s*cpu\s*:\s*(?:$cpuValueRx)\s*,\s*memory\s*:\s*(?:$memValueRx)\s*\}"
    foreach ($m in [regex]::Matches($code, "\{\s*cpu\s*:\s*(?<c>[^,}]+?)\s*,\s*memory\s*:\s*(?<mem>[^}]+?)\s*\}")) {
        $cm = [regex]::Match($m.Groups['c'].Value, "^(?:$cpuValueRx)$")
        $mm = [regex]::Match($m.Groups['mem'].Value, "^(?:$memValueRx)$")
        if (-not $cm.Success -or -not $mm.Success) { $unresolved.Add("inline: $($m.Value)"); continue }
        Add-Pair (Resolve-PairValue $cm 'cpu') (Resolve-PairValue $mm 'memory')
    }
    if ($code -match $inlineRx) { continue }   # a one-line object is complete; never opens a block

    if (-not $inBlock) {
        if ($code -match 'resources\s*:\s*\{') {
            $inBlock = $true
            $cpu     = $null
            $memory  = $null
        }
        continue
    }

    if ($code -match "cpu\s*:\s*(?:$cpuValueRx)\s*$") { $cpu = Resolve-PairValue ([regex]::Match($code, "cpu\s*:\s*(?:$cpuValueRx)")) 'cpu' }
    if ($code -match "memory\s*:\s*(?:$memValueRx)\s*$") { $memory = Resolve-PairValue ([regex]::Match($code, "memory\s*:\s*(?:$memValueRx)")) 'memory' }

    # Closing brace — end of resources block
    if ($code -match '^\s*\}\s*$') {
        Add-Pair $cpu $memory
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

# ── Every cpu: site must be accounted for (no silent skip of an unparsed form) ─
if ($cpuSites -ne $pairs.Count) {
    Write-CIError "Found $cpuSites cpu: site(s) in main.bicep but parsed only $($pairs.Count) cpu:memory pair(s) — a resources form this gate does not understand. Extend the parser rather than let a pair go unchecked."
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
