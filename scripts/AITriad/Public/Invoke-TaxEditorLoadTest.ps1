# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-TaxEditorLoadTest {
    <#
    .SYNOPSIS
        Measures taxonomy-editor's per-container session capacity on staging (t/4180).
    .DESCRIPTION
        Drives operations/devops/load-test/run-load-test.mjs through a ramp of concurrent
        virtual users across the reader, editor and debater profiles, samples the
        container app's CPU/memory via `az monitor metrics` for each step's window, and
        prints a one-page result naming the lowest concurrent-session count at which p95
        latency exceeds 2s or the error rate exceeds 1%, and which resource (CPU, memory,
        event loop proxy, or GitHub budget) gave out first.

        STAGING ONLY. -BaseUrl is rejected unless it contains "staging" — this cmdlet
        refuses to run against prod. It does NOT resize the container app itself (a
        cpu/memory change to a shared Azure resource is a manual, human-confirmed step,
        not something this harness does on your behalf) — it only checks staging's
        current size against -TargetCpu/-TargetMemory and warns if they don't match prod's
        (see t/4180's "temporarily match staging's size if it differs"). The container
        app's REPLICA scale (not size) is captured before the run and restored in a
        `finally` block, even on failure.

        Editors are expected to hit the GitHub API poll budget before CPU/memory (t/4180#1)
        — more replicas will not raise their ceiling; this is reported per-profile, not
        just in aggregate, so that distinction survives in the result.
    .PARAMETER BaseUrl
        Staging URL to test. Must contain the substring "staging" (case-insensitive).
    .PARAMETER Levels
        Ramp of concurrent VUs. Default: 5, 10, 25, 50, 100.
    .PARAMETER DurationSec
        Seconds to hold each ramp level. Default: 60.
    .PARAMETER Profiles
        Which workload profiles to run. Default: reader, editor, debater.
    .PARAMETER DebaterBackend
        AI backend id used by the debater profile. Default: groq-openai-gpt-oss-20b (a
        free-tier, non-Gemini backend — see load-test/README.md, "Debater profile backend
        choice": no server-side stub-backend mode exists today).
    .PARAMETER ContainerAppName
        Container app to monitor and restore. Default: taxonomy-editor-staging.
    .PARAMETER ResourceGroup
        Resource group containing the container app. Default: ai-triad.
    .PARAMETER OutDir
        Directory to write the raw JSON result and this cmdlet's one-page report.
        Default: a timestamped folder under the system temp directory.
    .PARAMETER TargetCpu
        Per-container vCPU this cmdlet checks staging against and warns if it doesn't
        match (t/4180: "temporarily match staging's size if it differs" — the resize
        itself is manual, see .DESCRIPTION). Default: 2.0 (prod's current size,
        deploy/azure/main.bicep). Staging normally runs 0.25 vCPU / 0.5Gi — a per-
        container capacity number measured at that size would not describe prod.
    .PARAMETER TargetMemory
        Per-container memory this cmdlet checks staging against. Default: 4Gi. ACA
        Consumption only allows fixed cpu:memory pairs, so -TargetCpu 2.0 pairs with this
        (ARM rejects 2.0 vCPU with anything but 4Gi, t/3182).
    .PARAMETER SkipResourceMatch
        Suppress the size-mismatch warning. The measured capacity still describes
        staging's OWN size whenever it doesn't actually match -TargetCpu/-TargetMemory —
        use this only when that is deliberately acceptable for the run.
    .PARAMETER SkipAzureMetrics
        Skip the `az monitor metrics` calls and the size-mismatch check entirely (dry run
        without Azure CLI access). The result then cannot attribute a breach to CPU/memory
        — only latency/error-rate/GitHub budget are reported.
    .EXAMPLE
        Invoke-TaxEditorLoadTest -BaseUrl https://taxonomy-editor-staging.yellowbush-aeda037d.eastus.azurecontainerapps.io
    .EXAMPLE
        Invoke-TaxEditorLoadTest -BaseUrl $staging -Levels 5,10,25 -DurationSec 30 -Profiles reader
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-TaxEditorSmokeTest
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)]
        [string]$BaseUrl,

        [int[]]$Levels = @(5, 10, 25, 50, 100),

        [int]$DurationSec = 60,

        [ValidateSet('reader', 'editor', 'debater')]
        [string[]]$Profiles = @('reader', 'editor', 'debater'),

        [string]$DebaterBackend = 'groq-openai-gpt-oss-20b',

        [string]$ContainerAppName = 'taxonomy-editor-staging',

        [string]$ResourceGroup = 'ai-triad',

        [string]$OutDir,

        [double]$TargetCpu = 2.0,

        [string]$TargetMemory = '4Gi',

        [switch]$SkipResourceMatch,

        [switch]$SkipAzureMetrics
    )

    Set-StrictMode -Version Latest

    if ($BaseUrl -notmatch '(?i)staging') {
        throw (New-ActionableError -Goal 'Run the t/4180 load-test harness' `
                -Problem "-BaseUrl '$BaseUrl' does not contain 'staging' — refusing to run. This harness must never be pointed at prod." `
                -Location 'Invoke-TaxEditorLoadTest' `
                -NextSteps @(
                    'Pass the staging URL, e.g. https://taxonomy-editor-staging.yellowbush-aeda037d.eastus.azurecontainerapps.io',
                    'If staging has been renamed, update this guard alongside the rename'
                ) -PassThru)
    }

    if (-not $OutDir) {
        $OutDir = Join-Path ([System.IO.Path]::GetTempPath()) ("tax-editor-load-test-{0:yyyyMMdd-HHmmss}" -f (Get-Date))
    }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $jsonOut = Join-Path $OutDir 'result.json'

    $repoRoot = (Get-Item (Join-Path $PSScriptRoot '..\..\..\')).FullName
    $driverPath = Join-Path $repoRoot 'operations\devops\load-test\run-load-test.mjs'
    if (-not (Test-Path $driverPath)) {
        throw (New-ActionableError -Goal 'Run the t/4180 load-test harness' `
                -Problem "Driver script not found at '$driverPath'" `
                -Location 'Invoke-TaxEditorLoadTest' `
                -NextSteps @('Run this cmdlet from a checkout containing operations/devops/load-test/run-load-test.mjs') -PassThru)
    }

    $priorScale = $null
    if (-not $SkipAzureMetrics) {
        Write-Host "Capturing current scale/size config for '$ContainerAppName'..."
        $priorScale = az containerapp show --name $ContainerAppName --resource-group $ResourceGroup `
            --query '{minReplicas: properties.template.scale.minReplicas, maxReplicas: properties.template.scale.maxReplicas, cpu: properties.template.containers[0].resources.cpu, memory: properties.template.containers[0].resources.memory}' `
            -o json 2>$null | ConvertFrom-Json
        if (-not $priorScale) {
            Write-Warning "Could not read current scale/size config for '$ContainerAppName' — restore-on-exit will be skipped. Pass -SkipAzureMetrics to suppress this warning, or verify 'az containerapp show' access."
        } elseif (-not $SkipResourceMatch -and ($priorScale.cpu -ne $TargetCpu -or $priorScale.memory -ne $TargetMemory)) {
            # This cmdlet intentionally does NOT resize the container itself (resource/cost
            # changes to a shared Azure resource are a manual, human-confirmed step, not
            # something this harness does on the operator's behalf). It only measures and
            # reports honestly: a size mismatch means the result below describes staging's
            # OWN per-container capacity, not prod's, until the operator resizes it to match
            # and re-runs.
            Write-Warning ("'{0}' is sized {1} vCPU / {2}, not prod's {3} vCPU / {4} (deploy/azure/main.bicep). " `
                    + "The measured capacity below describes STAGING's size, not prod's. To measure prod-equivalent " `
                    + "capacity (t/4180's ask), resize it first: az containerapp update --name {0} --resource-group {5} " `
                    + "--cpu {3} --memory {4} — then re-run and restore the size afterward. Pass -SkipResourceMatch to " `
                    + "suppress this warning when staging's own size is deliberately what you want measured." `
                    -f $ContainerAppName, $priorScale.cpu, $priorScale.memory, $TargetCpu, $TargetMemory, $ResourceGroup)
        }
    }

    try {
        Write-Host "Warming up (staging scales to zero when idle — this excludes cold-start from the ramp)..."
        # fetch-allowlist: warm-up GET against our own staging app's /healthz (not arbitrary
        # external content — $BaseUrl is already validated as the staging host above; t/3314)
        try { Invoke-WebRequest -Uri "$BaseUrl/healthz" -TimeoutSec 60 -UseBasicParsing | Out-Null } catch {
            Write-Warning "Warm-up request failed: $($_.Exception.Message). Proceeding anyway — the first ramp step will absorb the cold start instead."
        }

        $levelsArg = $Levels -join ','
        $profilesArg = $Profiles -join ','
        Write-Host "Running ramp: levels=$levelsArg profiles=$profilesArg durationSec=$DurationSec ..."
        $nodeArgs = @(
            $driverPath,
            '--base-url', $BaseUrl,
            '--levels', $levelsArg,
            '--duration-sec', $DurationSec,
            '--profiles', $profilesArg,
            '--debater-backend', $DebaterBackend,
            '--out', $jsonOut
        )
        # node's final stdout is the full result JSON (also written to $jsonOut) — capture and
        # discard it here so it doesn't leak into this cmdlet's own output pipeline (PowerShell
        # treats a native command's stdout lines as success-stream objects). Progress lines on
        # stderr are left alone and continue to the host normally.
        $null = & node @nodeArgs
        if ($LASTEXITCODE -ne 0) {
            throw (New-ActionableError -Goal 'Run the t/4180 load-test harness' `
                    -Problem "run-load-test.mjs exited with code $LASTEXITCODE" `
                    -Location 'Invoke-TaxEditorLoadTest' `
                    -NextSteps @('Check stderr output above for the failing request/profile', "Inspect $jsonOut if it was written before the failure") -PassThru)
        }

        $result = Get-Content $jsonOut -Raw | ConvertFrom-Json

        $azureMetricsByStep = @{}
        if (-not $SkipAzureMetrics) {
            Write-Host "Sampling az monitor metrics per step..."
            foreach ($step in $result.steps) {
                $key = "$($step.profile)@$($step.level)"
                # t/4180 Lead review: without -start-time/-end-time, this queried the metrics
                # API's default ("now") range regardless of which step it was called for — every
                # step got the same post-ramp snapshot, not that step's real CPU/memory. The
                # driver now reports each step's wall-clock window; bound the query to it.
                if (-not $step.PSObject.Properties['startTime'] -or -not $step.PSObject.Properties['endTime']) {
                    Write-Warning "Step $key has no startTime/endTime (stale driver?) — skipping per-step metrics for it."
                    continue
                }
                try {
                    $cpu = az monitor metrics list --resource-group $ResourceGroup --resource $ContainerAppName `
                        --resource-type 'Microsoft.App/containerApps' --metric 'UsageNanoCores' `
                        --start-time $step.startTime --end-time $step.endTime `
                        --interval PT1M --aggregation Average -o json 2>$null | ConvertFrom-Json
                    $mem = az monitor metrics list --resource-group $ResourceGroup --resource $ContainerAppName `
                        --resource-type 'Microsoft.App/containerApps' --metric 'WorkingSetBytes' `
                        --start-time $step.startTime --end-time $step.endTime `
                        --interval PT1M --aggregation Average -o json 2>$null | ConvertFrom-Json
                    $azureMetricsByStep[$key] = @{
                        cpuNanoCores = ($cpu.value.timeseries.data | Where-Object { $null -ne $_.average } | Select-Object -Last 1).average
                        memWorkingSetBytes = ($mem.value.timeseries.data | Where-Object { $null -ne $_.average } | Select-Object -Last 1).average
                    }
                } catch {
                    Write-Warning "az monitor metrics failed for step $key : $($_.Exception.Message)"
                }
            }
        }

        $bp = $result.breakingPoint
        Write-Host ''
        Write-Host '=== t/4180 load-test result ===' -ForegroundColor Cyan
        if (-not $bp) {
            Write-Host "No breach observed across the ramp (levels: $levelsArg). The configured ceiling exceeds what this run measured — widen -Levels to find it."
        } else {
            $limiterNote = if ($bp.profile -eq 'editor') {
                '(editor profiles are expected to be GitHub-API-budget-bound per t/4180#1 — check githubRateLimitRemaining below before attributing this to CPU/memory)'
            } else { '' }
            Write-Host "Breaking point: $($bp.level) concurrent $($bp.profile) sessions $limiterNote"
            Write-Host "  p95Breach=$($bp.p95Breach) errorBreach=$($bp.errorBreach)"
            $az = $azureMetricsByStep["$($bp.profile)@$($bp.level)"]
            if ($az) {
                Write-Host "  CPU (nanocores): $($az.cpuNanoCores)  Memory (bytes): $($az.memWorkingSetBytes)"
            }
        }
        Write-Host ''
        Write-Host 'Per-profile breakdown:'
        foreach ($profile in $Profiles) {
            Write-Host "  ${profile}:"
            foreach ($step in ($result.steps | Where-Object { $_.profile -eq $profile } | Sort-Object level)) {
                Write-Host ("    level={0,3} p50={1,6:N0}ms p95={2,6:N0}ms errRate={3,5:N2}% rps={4,6:N1} ghRemaining={5}" `
                        -f $step.level, $step.p50Ms, $step.p95Ms, $step.errorRatePct, $step.rps, $step.githubRateLimitRemaining)
            }
        }
        Write-Host ''
        Write-Host "Raw result: $jsonOut"

        [PSCustomObject]@{
            PSTypeName = 'AITriad.LoadTestResult'
            BaseUrl = $BaseUrl
            BreakingPoint = $bp
            Steps = $result.steps
            AzureMetricsByStep = $azureMetricsByStep
            ResultPath = $jsonOut
        }
    } finally {
        if ($priorScale) {
            Write-Host "Restoring '$ContainerAppName' scale to min=$($priorScale.minReplicas) max=$($priorScale.maxReplicas)..."
            az containerapp update --name $ContainerAppName --resource-group $ResourceGroup `
                --min-replicas $priorScale.minReplicas --max-replicas $priorScale.maxReplicas -o none 2>$null
        }
    }
}
