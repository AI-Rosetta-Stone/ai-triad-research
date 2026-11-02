# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Regenerates operations/devops/test-powershell-shard-durations.json (t/4095) -- the per-file
    duration data ShardBalancer.ps1 bin-packs against.
.DESCRIPTION
    Two sources:

    -FromCiRun <runId[]> (preferred): reads the six test-powershell shard job logs of each green CI
    run and measures each file's real wall-clock cost on the CI runner, setup included
    (ConvertFrom-PesterShardLog), then takes each file's MEDIAN across the runs
    (Merge-ShardDurationSample). Pass several runs (5 is a good default): one run's per-file
    times swing ~25% of the suite, so balancing against a single run overfits it.

    Local (default): runs the WHOLE suite here with -PassThru and records each file's Pester
    container Duration. Local timings differ from the Linux runners, so prefer -FromCiRun.

    Both measure per-FILE cost. The original version summed each file's TEST durations, which
    excludes BeforeAll, module imports and other setup: it recorded ~742s for a suite whose six
    shards take ~40 min combined, so the bin-packing balanced the wrong numbers.

    ShardBalancer.ps1 falls back to the MEDIAN duration for any file this JSON doesn't list, so
    regenerate when shard wall-clock times visibly drift apart, not on every test file addition.

    Run from the repo root:
      ./operations/devops/Update-TestPowershellDurations.ps1 -FromCiRun 41501306096, 41507081739, ...
      ./operations/devops/Update-TestPowershellDurations.ps1
#>
[CmdletBinding(DefaultParameterSetName = 'Local', SupportsShouldProcess)]
param(
    [Parameter(Mandatory, ParameterSetName = 'FromCi')]
    [long[]]$FromCiRun,

    [Parameter(ParameterSetName = 'FromCi')]
    [string]$Repo = 'AI-Rosetta-Stone/ai-triad-research',

    [string]$OutFile = "$PSScriptRoot/test-powershell-shard-durations.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = (Get-Location).Path

function Format-DurationsError([string]$Problem, [string]$NextSteps) {
    "Update-TestPowershellDurations: $Problem`n" +
    "  Goal:       regenerate test-powershell-shard-durations.json.`n" +
    "  Problem:    $Problem`n" +
    "  Location:   operations/devops/Update-TestPowershellDurations.ps1.`n" +
    "  Next steps: $NextSteps"
}

$durations = @{}

if ($PSCmdlet.ParameterSetName -eq 'FromCi') {
    . "$PSScriptRoot/ShardDurationsFromLog.ps1"
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw (Format-DurationsError 'the gh CLI is not on PATH.' 'install gh and run gh auth login.')
    }
    $samples = [System.Collections.Generic.List[hashtable]]::new()
    foreach ($runId in $FromCiRun) {
        $jobs = @(gh run view $runId --repo $Repo --json jobs -q '.jobs[] | select(.name|test("^test-powershell \\(\\d+\\)$")) | [.databaseId, .name, .conclusion] | @tsv' |
            ForEach-Object { $id, $name, $conclusion = $_ -split "`t"; [pscustomobject]@{ Id = $id; Name = $name; Conclusion = $conclusion } })
        if ($LASTEXITCODE -ne 0 -or $jobs.Count -eq 0) {
            throw (Format-DurationsError "run $runId has no test-powershell shard jobs (or gh failed)." 'pass ids of ci.yml runs that ran test-powershell.')
        }
        $notGreen = @($jobs | Where-Object Conclusion -ne 'success')
        if ($notGreen.Count -gt 0) {
            throw (Format-DurationsError "shard job(s) not successful in run ${runId}: $(($notGreen | ForEach-Object { "$($_.Name)=$($_.Conclusion)" }) -join ', ')." 'use runs where every test-powershell shard succeeded.')
        }
        $runDurations = @{}
        foreach ($job in $jobs) {
            $log = @(gh api "repos/$Repo/actions/jobs/$($job.Id)/logs")
            if ($LASTEXITCODE -ne 0) {
                throw (Format-DurationsError "could not download the log for $($job.Name) (run $runId, job $($job.Id))." 'logs expire after the retention period; pick more recent runs.')
            }
            $perFile = ConvertFrom-PesterShardLog -LogLine $log -Source "run $runId $($job.Name)"
            foreach ($path in $perFile.Keys) {
                if ($runDurations.ContainsKey($path)) {
                    throw (Format-DurationsError "$path appears in more than one shard log of run $runId." 'the shard assignment overlapped; check ShardBalancer coverage for this run.')
                }
                $runDurations[$path] = $perFile[$path]
            }
        }
        Write-Host "run ${runId}: $($runDurations.Count) files, $([math]::Round(($runDurations.Values | Measure-Object -Sum).Sum, 1))s"
        $samples.Add($runDurations)
    }
    # Per-file median across runs: one run's timings are too noisy to balance against.
    $durations = Merge-ShardDurationSample -Sample $samples.ToArray()
}
else {
    . ./operations/devops/Get-PesterExcludePaths.ps1
    $config = New-PesterConfiguration
    $allTests = @(Get-ChildItem ./tests -Recurse -Filter *.Tests.ps1 | Sort-Object FullName)
    $config.Run.Path = @($allTests.FullName)
    $config.Run.ExcludePath = Get-PesterExcludePaths
    $config.Output.Verbosity = 'Normal'
    $config.Run.Exit = $false
    $config.Run.PassThru = $true

    Write-Host "Running the full Pester suite ($($allTests.Count) files) to measure per-file duration..."
    $r = Invoke-Pester -Configuration $config
    # Container Duration covers the whole file run (BeforeAll, setup, tests); summing test
    # Durations does not, and undercounts setup-heavy files severalfold.
    foreach ($container in @($r.Containers | Where-Object Type -eq 'File')) {
        $relPath = $container.Item.FullName.Substring($repoRoot.Length + 1) -replace '\\', '/'
        $durations[$relPath] = [math]::Round($container.Duration.TotalSeconds, 3)
    }
}

$ordered = [ordered]@{}
foreach ($path in ($durations.Keys | Sort-Object)) { $ordered[$path] = $durations[$path] }
$total = [math]::Round(($durations.Values | Measure-Object -Sum).Sum, 1)
if ($PSCmdlet.ShouldProcess($OutFile, "write $($durations.Count) file durations ($($total)s total)")) {
    $ordered | ConvertTo-Json | Out-File -FilePath $OutFile -Encoding utf8
    Write-Host "Wrote $($durations.Count) file durations ($($total)s total) to $OutFile"
}
