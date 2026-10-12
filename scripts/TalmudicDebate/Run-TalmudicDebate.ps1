# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

[CmdletBinding()]
param(
    [string]$ConfigPath = 'debate-talmudic-openai.json',

    [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Stop-WithActionableError {
    param(
        [Parameter(Mandatory)]
        [string]$Goal,

        [Parameter(Mandatory)]
        [string]$Problem,

        [Parameter(Mandatory)]
        [string]$Location,

        [Parameter(Mandatory)]
        [string[]]$NextSteps
    )

    [Console]::Error.WriteLine('')
    [Console]::Error.WriteLine("  Goal:     $Goal")
    [Console]::Error.WriteLine("  Error:    $Problem")
    [Console]::Error.WriteLine("  Location: $Location")
    [Console]::Error.WriteLine('  Resolve:')
    for ($index = 0; $index -lt $NextSteps.Count; $index++) {
        [Console]::Error.WriteLine("  $($index + 1). $($NextSteps[$index])")
    }
    exit 1
}

$repoRoot = [System.IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$dataRoot = Join-Path $repoRoot '.local-data\ai-triad-data'
$resolvedConfigPath = if ([System.IO.Path]::IsPathRooted($ConfigPath)) {
    $ConfigPath
}
else {
    Join-Path $repoRoot $ConfigPath
}

foreach ($commandName in @('git', 'npx')) {
    if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        Stop-WithActionableError `
            -Goal 'Run a Talmudic debate' `
            -Problem "Required command '$commandName' is not available" `
            -Location 'Run-TalmudicDebate.ps1 dependency check' `
            -NextSteps @("Install $commandName and ensure it is on PATH", 'Open a new PowerShell 7 session and rerun this script')
    }
}

if (-not (Test-Path -LiteralPath $resolvedConfigPath -PathType Leaf)) {
    Stop-WithActionableError `
        -Goal 'Load the debate configuration' `
        -Problem "Configuration file '$resolvedConfigPath' does not exist" `
        -Location 'Run-TalmudicDebate.ps1 configuration check' `
        -NextSteps @('Pass -ConfigPath with an existing JSON file', 'Create a config containing "moderatorMode": "talmudic"')
}

try {
    $config = Get-Content -Raw -LiteralPath $resolvedConfigPath | ConvertFrom-Json
}
catch {
    Stop-WithActionableError `
        -Goal 'Parse the debate configuration' `
        -Problem $_.Exception.Message `
        -Location $resolvedConfigPath `
        -NextSteps @('Correct the JSON syntax', 'Validate the file with ConvertFrom-Json and rerun')
}

$moderatorModeProperty = $config.PSObject.Properties['moderatorMode']
if (-not $moderatorModeProperty -or $moderatorModeProperty.Value -ne 'talmudic') {
    Stop-WithActionableError `
        -Goal 'Run with Talmudic moderation' `
        -Problem 'The configuration does not set "moderatorMode" to "talmudic"' `
        -Location $resolvedConfigPath `
        -NextSteps @('Add "moderatorMode": "talmudic" to the configuration', 'Use a Talmudic debate configuration file')
}

$referencesProperty = $config.PSObject.Properties['talmudicReferences']
$referencesEnabled = $false
$corpusPath = $null
if ($null -ne $referencesProperty -and $null -ne $referencesProperty.Value) {
    $enabledProperty = $referencesProperty.Value.PSObject.Properties['enabled']
    $pathProperty = $referencesProperty.Value.PSObject.Properties['corpusPath']
    $referencesEnabled = $null -ne $enabledProperty -and [bool]$enabledProperty.Value
    if ($referencesEnabled) {
        if ($null -eq $pathProperty -or [string]::IsNullOrWhiteSpace([string]$pathProperty.Value)) {
            Stop-WithActionableError `
                -Goal 'Load the source-grounded Talmudic corpus' `
                -Problem 'talmudicReferences.enabled is true but corpusPath is missing' `
                -Location $resolvedConfigPath `
                -NextSteps @('Set corpusPath to ./.local-data/talmudic-corpus/pilot-v1.json', 'Run ./scripts/TalmudicDebate/Initialize-TalmudicCorpus.ps1')
        }
        $corpusPath = if ([System.IO.Path]::IsPathRooted([string]$pathProperty.Value)) {
            [System.IO.Path]::GetFullPath([string]$pathProperty.Value)
        }
        else {
            [System.IO.Path]::GetFullPath((Join-Path $repoRoot ([string]$pathProperty.Value)))
        }
        if (-not (Test-Path -LiteralPath $corpusPath -PathType Leaf)) {
            Stop-WithActionableError `
                -Goal 'Load the source-grounded Talmudic corpus' `
                -Problem "Configured corpus '$corpusPath' does not exist" `
                -Location 'Run-TalmudicDebate.ps1 corpus validation' `
                -NextSteps @('Run ./scripts/TalmudicDebate/Initialize-TalmudicCorpus.ps1', 'Confirm corpusPath points beneath .local-data\talmudic-corpus')
        }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $dataRoot '.git') -PathType Container)) {
    Write-Host "Setting up sparse debate data inside the repository: $dataRoot"
    & git clone --depth 1 --filter=blob:none --sparse https://github.com/AI-Rosetta-Stone/ai-triad-data.git $dataRoot
    if ($LASTEXITCODE -ne 0) {
        Stop-WithActionableError `
            -Goal 'Set up the debate data' `
            -Problem "git clone failed with exit code $LASTEXITCODE" `
            -Location $dataRoot `
            -NextSteps @('Confirm GitHub is reachable', 'Remove an incomplete .local-data\ai-triad-data directory and rerun')
    }
}

& git -C $dataRoot sparse-checkout set taxonomy/Origin conflicts
if ($LASTEXITCODE -ne 0) {
    Stop-WithActionableError `
        -Goal 'Prepare the debate taxonomy' `
        -Problem "git sparse-checkout failed with exit code $LASTEXITCODE" `
        -Location $dataRoot `
        -NextSteps @('Verify the local data checkout is a valid Git repository', 'Rerun after repairing or replacing the local checkout')
}

$taxonomyPath = Join-Path $dataRoot 'taxonomy\Origin'
if (-not (Test-Path -LiteralPath $taxonomyPath -PathType Container)) {
    Stop-WithActionableError `
        -Goal 'Load the debate taxonomy' `
        -Problem "Taxonomy directory '$taxonomyPath' is missing" `
        -Location 'Run-TalmudicDebate.ps1 data validation' `
        -NextSteps @('Run git sparse-checkout set taxonomy/Origin conflicts in the local data checkout', 'Delete the incomplete local checkout and rerun this script')
}

if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) {
    if ($NonInteractive) {
        Stop-WithActionableError `
            -Goal 'Authenticate the OpenAI debate model' `
            -Problem 'OPENAI_API_KEY is not set' `
            -Location 'Run-TalmudicDebate.ps1 credential check' `
            -NextSteps @('Set OPENAI_API_KEY in the current process', 'Rerun without -NonInteractive to enter the key securely')
    }

    $secureKey = Read-Host 'Enter OPENAI_API_KEY' -AsSecureString
    $env:OPENAI_API_KEY = ConvertFrom-SecureString $secureKey -AsPlainText
}

$env:AI_TRIAD_DATA_ROOT = [System.IO.Path]::GetFullPath($dataRoot)

Write-Host "AI_TRIAD_DATA_ROOT=$env:AI_TRIAD_DATA_ROOT"
Write-Host 'OPENAI_API_KEY is set (value hidden)'
Write-Host "Running Talmudic debate config: $resolvedConfigPath"
if ($referencesEnabled) {
    Write-Host "Talmudic reference mode: source-grounded ($corpusPath)" -ForegroundColor Green
}
else {
    Write-Host 'Talmudic reference mode: method-only' -ForegroundColor Yellow
}

Push-Location $repoRoot
try {
    & npx tsx .\lib\debate\cli.ts --config $resolvedConfigPath
    $debateExitCode = $LASTEXITCODE
}
finally {
    Pop-Location
}

if ($debateExitCode -ne 0) {
    Stop-WithActionableError `
        -Goal 'Complete the Talmudic debate' `
        -Problem "The debate CLI exited with code $debateExitCode" `
        -Location 'lib/debate/cli.ts' `
        -NextSteps @('Review the actionable CLI error above', 'Verify the API key, model access, data checkout, and configuration')
}

Write-Host 'Talmudic debate completed successfully.'
