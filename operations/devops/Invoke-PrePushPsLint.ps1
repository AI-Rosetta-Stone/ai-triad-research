# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/607 (TL t/607#1, Lead t/607#2, p/233#163): the pre-push run of CI's repo-wide PowerShell lint suites,
    under CI's pinned Pester, for the suites whose inputs a push changed.

.DESCRIPTION
    A lint that scans the repo (an unregistered -Model literal in a test, a bare throw in scripts/AITriad...)
    only fails in CI's test-powershell shards, after a 12-minute run. #5503 reached a train that way. This
    runs the same suite files locally, so the offender is refused before the push, with CI's own message.

    SUITES is the one table: each lint's test file, the repo paths it READS (its scan roots, its registry
    and baseline files, and the suite file itself; quoted from the suite in each comment), and an optional
    Describe filter. A suite runs when any changed path starts with one of its Paths, so a scripts/**
    offender can never be missed because only tests/** changed, or the reverse (ModelLiteralLint reads
    both). pre-push-checks.sh triggers on the union of all Paths (TRIGGER_PREFIXES); a pin test keeps the
    two equal, and fails when a tests/*Lint*.Tests.ps1 is neither listed here nor in EXCLUDED with a reason.

    The Describe filter (ModelLiteralLint only, Lead p/233#163): its file-level scan is ~13 s and its four
    'Code-referenced model emitter' Describes add ~31 s, but they test the emitter, not offenders (CI still
    runs them). A filtered suite that runs ZERO tests fails, and a pin test fails if a filtered Describe
    name no longer exists in the file, so the filter can never match nothing and pass silently.

    Reads the WORKING TREE (the suites scan the disk, not git blobs). pre-push-checks.sh only calls this
    when the pushed sha is the checked-out HEAD, and warns instead of blocking when the lint inputs have
    uncommitted changes.

    Exit 0: every selected suite passed (or none was selected).
    Exit 1: a suite failed, errored, or a filtered suite ran nothing. CI's own failure message is printed.
    Exit 3: could not run (pwsh fine, but Pester $PesterVersion not installed, or ci.yml unreadable): a WARN
            naming the install command is printed. pre-push-checks.sh reports it as skipped, never as ok.

.PARAMETER RepoRoot
    The checkout to lint (default: two levels above this script).

.PARAMETER ChangedFilesPath
    A file holding the repo-relative paths the push changes, one per line. This is how the hook passes
    them (Lead t/607#6): a train push can list thousands of paths, past Windows' ~32 K command line.

.PARAMETER ChangedFiles
    The same paths as bare arguments, for a short direct run. Combined with -ChangedFilesPath if both given.

.PARAMETER Plan
    Print the selected suites (one 'name<TAB>file' per line) and exit 0, without running Pester.
#>
[CmdletBinding(PositionalBinding = $false)]  # every bare argument is a changed file, never -RepoRoot
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path,
    [string]$ChangedFilesPath = '',
    [switch]$Plan,
    # Remaining arguments: `pwsh -File` cannot bind `-ChangedFiles a b c` as an array, so short direct runs
    # pass the files positionally after the named parameters.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ChangedFiles = @()
)

$ErrorActionPreference = 'Stop'

if ($ChangedFilesPath) {
    if (-not (Test-Path -LiteralPath $ChangedFilesPath)) {
        Write-Warning "pre-push: WARN ps-lint skipped: the changed-file list $ChangedFilesPath is missing. CI still runs these lints."
        exit 3
    }
    $ChangedFiles = @($ChangedFiles) + @(Get-Content -LiteralPath $ChangedFilesPath | Where-Object { $_ })
}

# ── SUITES: the one table (t/607). Paths are prefixes of repo-relative paths. ──
$script:Suites = @(
    [pscustomobject]@{
        Name = 'ModelLiteralLint'; ExpectedSec = 15; File = 'tests/ModelLiteralLint.Tests.ps1'
        # Reads: tests/ (Scope Tests) and scripts/AITriad/ (Scope Production) via scripts/ModelLiteralScan.ps1
        # Get-ModelLiteralScopeScan; the registry ai-models.json (through the AITriad module);
        # lib/ai-config/modelLiteralLint.conformance.json; tests/modelLiteralLint.exemptions.baseline.json.
        Paths = @('tests/', 'scripts/', 'ai-models.json', 'lib/ai-config/')
        # The offender Describes. NOT the 'Code-referenced model emitter*' / 'codeReferencedModels.json is
        # fresh*' Describes (emitter output, ~31 s; CI runs them).
        Describes = @(
            'Model-id literals resolve to registered models'
            'Offender-resolution predicate — direct both-arms tests (t/3565, Guard Testability t/2971)'
            'Shared conformance corpus — resolution predicate (t/3656, SO cond 4)'
            'Exemption ratchet — production model-lint exemptions do not grow silently (t/3658)'
        )
    }
    [pscustomobject]@{
        Name = 'BareThrowLint'; ExpectedSec = 6; File = 'tests/BareThrowLint.Tests.ps1'
        # Reads: scripts/AITriad/ (bare throw and the actionable-no-mode lint); tests/fixtures/bare-throw-baseline.json.
        Paths = @('scripts/', 'tests/fixtures/bare-throw-baseline.json', 'tests/BareThrowLint.Tests.ps1'); Describes = @()
    }
    [pscustomobject]@{
        Name = 'CorpusJsonReadLint'; ExpectedSec = 17; File = 'tests/CorpusJsonReadLint.Tests.ps1'
        # Reads: scripts/ (recursive, minus archive/ and tests/); tests/fixtures/corpus-read-rewrite-baseline.json.
        Paths = @('scripts/', 'tests/fixtures/corpus-read-rewrite-baseline.json', 'tests/CorpusJsonReadLint.Tests.ps1'); Describes = @()
    }
    [pscustomobject]@{
        Name = 'NoModelPrefixBackendGuess'; ExpectedSec = 1; File = 'tests/NoModelPrefixBackendGuess.Tests.ps1'
        # Reads: scripts/AITriad/ (recursive *.ps1, *.psm1) and scripts/*.psm1 (e.g. scripts/AIEnrich.psm1).
        Paths = @('scripts/', 'tests/NoModelPrefixBackendGuess.Tests.ps1'); Describes = @()
    }
    [pscustomobject]@{
        Name = 'TrivyIgnoreRevisitLint'; ExpectedSec = 1; File = 'tests/TrivyIgnoreRevisitLint.Tests.ps1'
        # Reads: the committed .trivyignore only.
        Paths = @('.trivyignore', 'tests/TrivyIgnoreRevisitLint.Tests.ps1'); Describes = @()
    }
)

# tests/*Lint*.Tests.ps1 files (case-sensitive 'Lint') deliberately NOT run before a push, each with a reason.
$script:Excluded = @{
    'tests/PrePushPsLint.Tests.ps1' = 'the tests of this runner, not a repo-scan lint (it runs Pester itself, ~20 s)'
}

function Get-PrePushLintSuites {
    <# PURE. The suites whose Paths a changed file starts with. #>
    param([string[]]$ChangedFiles)
    $changed = @($ChangedFiles | Where-Object { $_ } | ForEach-Object { $_ -replace '\\', '/' })
    @($script:Suites | Where-Object {
            $s = $_
            @($changed | Where-Object { $f = $_; @($s.Paths | Where-Object { $f.StartsWith($_, [StringComparison]::Ordinal) }).Count -gt 0 }).Count -gt 0
        })
}

function Get-CiPesterVersion {
    <# The pin from ci.yml's env `PESTER_VERSION: '<v>'`, so there is no second literal. $null if unreadable. #>
    param([string]$RepoRoot)
    $ci = Join-Path $RepoRoot '.github' 'workflows' 'ci.yml'
    if (-not (Test-Path -LiteralPath $ci)) { return $null }
    $m = Select-String -LiteralPath $ci -Pattern "^\s*PESTER_VERSION:\s*'?([0-9][0-9.]*)'?\s*$" | Select-Object -First 1
    if ($m) { $m.Matches[0].Groups[1].Value } else { $null }
}

# Dot-sourced by the tests for the pure functions above; the run below is for direct invocation only.
if ($MyInvocation.InvocationName -eq '.') { return }

$selected = @(Get-PrePushLintSuites -ChangedFiles $ChangedFiles)
if ($Plan) { foreach ($s in $selected) { "$($s.Name)`t$($s.File)" }; exit 0 }
if ($selected.Count -eq 0) { exit 0 }

$PesterVersion = Get-CiPesterVersion -RepoRoot $RepoRoot
if (-not $PesterVersion) {
    Write-Warning "pre-push: WARN ps-lint skipped: could not read PESTER_VERSION from .github/workflows/ci.yml, so CI's pinned Pester is unknown. CI still runs these lints."
    exit 3
}
if (-not (Get-Module -ListAvailable -Name Pester | Where-Object { $_.Version -eq [version]$PesterVersion })) {
    Write-Warning "pre-push: WARN ps-lint skipped: Pester $PesterVersion (CI's pin) is not installed. Install it: pwsh -c `"Install-Module Pester -RequiredVersion $PesterVersion -Scope CurrentUser -Force -SkipPublisherCheck`". CI still runs these lints."
    exit 3
}
Import-Module Pester -RequiredVersion $PesterVersion -ErrorAction Stop

# Lead p/233#164: one line before the run, so a ~40 s hook doesn't look hung. ExpectedSec is measured
# locally (t/607#4: filtered ModelLiteralLint 14 s, CorpusJsonReadLint 16-18 s, BareThrowLint 6 s).
$total = ($selected | Measure-Object -Property ExpectedSec -Sum).Sum
Write-Host ("pre-push: ps-lint running {0}; expected ~{1}s (Pester {2})" -f (($selected | ForEach-Object { "$($_.Name) ~$($_.ExpectedSec)s" }) -join ', '), $total, $PesterVersion)

$failed = @()
foreach ($s in $selected) {
    $config = New-PesterConfiguration
    $config.Run.Path = @(Join-Path $RepoRoot $s.File)
    $config.Run.PassThru = $true
    $config.Run.Exit = $false
    $config.Output.Verbosity = 'Normal'
    if ($s.Describes.Count) { $config.Filter.FullName = @($s.Describes | ForEach-Object { "$([WildcardPattern]::Escape($_))*" }) }
    Write-Host "pre-push: ps-lint $($s.Name)$(if ($s.Describes.Count) { " (offender Describes only)" })"
    $r = Invoke-Pester -Configuration $config
    if ($null -eq $r) { $failed += "$($s.Name): Pester returned no result"; continue }
    if ($r.Result -ne 'Passed') { $failed += "$($s.Name): $($r.FailedCount) failed$(if ($r.FailedContainersCount) { ", $($r.FailedContainersCount) container error(s)" })"; continue }
    if ($s.Describes.Count -and $r.PassedCount -eq 0) {
        $failed += "$($s.Name): the Describe filter ran 0 tests (renamed Describes? update SUITES in operations/devops/Invoke-PrePushPsLint.ps1)"
    }
}
if ($failed.Count) {
    Write-Host "pre-push: ps-lint FAILED (CI's test-powershell would fail the same way):"
    $failed | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
exit 0
