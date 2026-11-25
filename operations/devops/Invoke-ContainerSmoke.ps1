# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/611 (TL t/611#1, Lead t/611#2): run the deploy smoke's phases against the CI-built container, so a PR
    that locks a route the smoke reads anonymously fails in CI instead of rolling back its own deploy.

.DESCRIPTION
    The deploy smoke (Invoke-TaxEditorSmokeTest) ran only against staging and prod at deploy time, so #5500
    (anonymous access to the analytics read-back refused) passed CI and then rolled its own deploy back
    (t/579). This runs the same phase functions (scripts/AITriad/Private/TaxEditorSmokeTestPhases.ps1),
    with the module imported from the checkout, against a container started with a hosted-like profile.

    PHASES is the one table. Each Invoke-Smoke*Phase function is either RUN or SKIPPED with a reason; a pin
    test (tests/ContainerSmoke.Tests.ps1) fails when a new phase function is neither, so nothing is ever
    skipped silently. Every skip prints `WARN smoke-phase-skipped: <phase>: <reason>`.

    GATE mirrors the deploy smoke's OverallPass (Invoke-TaxEditorSmokeTest.ps1): Health, and every
    endpoint-style result (Endpoint, AnonEndpoint, Analytics, DataPresence, OpedFiles) must pass. Azure is in
    prod's gate but cannot run here (skipped, with the reason). EmbeddingLatency, CachePresence and
    IdentityAllowlist are run but stay WARN-only, exactly as prod treats them (a fresh container's cache is
    still warming; stricter than prod would false-red PRs). Their status is in the summary table.

    Exit 0: every gating phase passed. Exit 1: a gating phase failed (each failure's own message is printed),
    or the module could not be imported.

.PARAMETER BaseUrl
    The running container (e.g. http://localhost:7863).

.PARAMETER SummaryPath
    Where to append the Markdown table (the step summary). Default: $env:GITHUB_STEP_SUMMARY, if set.

.PARAMETER HealthMaxAttempts
    Health-phase attempts (10 s apart) for the container's cold start.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BaseUrl,
    [string]$SummaryPath = $env:GITHUB_STEP_SUMMARY,
    [int]$HealthMaxAttempts = 12,
    [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'

# ── PHASES: the one table (t/611). Kind: 'gate' (fails the job), 'warn' (reported, like prod), 'skip'. ──
$script:Phases = @(
    [pscustomobject]@{ Name = 'Health';            Kind = 'gate' }
    [pscustomobject]@{ Name = 'Endpoint';          Kind = 'gate' }
    [pscustomobject]@{ Name = 'AnonEndpoint';      Kind = 'gate' }
    [pscustomobject]@{ Name = 'Azure';             Kind = 'skip'; Reason = 'needs az and the live Azure resources (Container App, storage, Key Vault); none exist for a CI container' }
    [pscustomobject]@{ Name = 'GitHub';            Kind = 'skip'; Reason = 'checks GitHub status, rate limits and the deployed SHA''s ci.yml run; there is no deployed SHA in CI, and prod treats it as WARN-only anyway' }
    [pscustomobject]@{ Name = 'Analytics';         Kind = 'gate' }
    [pscustomobject]@{ Name = 'DataPresence';      Kind = 'gate' }
    [pscustomobject]@{ Name = 'OpedFiles';         Kind = 'gate' }
    [pscustomobject]@{ Name = 'EmbeddingLatency';  Kind = 'warn' }
    [pscustomobject]@{ Name = 'CachePresence';     Kind = 'warn' }
    [pscustomobject]@{ Name = 'IdentityAllowlist'; Kind = 'warn' }
)

function Get-ContainerSmokePhaseVerdict {
    <# PURE. { Pass, Detail } for one phase's return value. Unknown shapes fail (fail closed). #>
    param([string]$Name, $Result)
    switch ($Name) {
        'Health' {
            $bad = @($Result.Checks | Where-Object { -not $_.Healthy } | ForEach-Object { "$($_.Endpoint): $($_.Detail)" })
            return [pscustomobject]@{ Pass = [bool]$Result.Healthy; Detail = if ($Result.Healthy) { 'healthy' } else { "unhealthy: $($bad -join '; ')" } }
        }
        { $_ -in 'Endpoint', 'AnonEndpoint', 'Analytics', 'DataPresence' } {
            $rows = @($Result)
            if ($rows.Count -eq 0) { return [pscustomobject]@{ Pass = $false; Detail = 'returned no results (fail closed)' } }
            $failed = @($rows | Where-Object { -not $_.Pass })
            $detail = if ($failed.Count) {
                "$($failed.Count)/$($rows.Count) failed: " + (($failed | ForEach-Object { "$($_.Endpoint) -> $($_.Status) $($_.Error)".Trim() }) -join '; ')
            } else { "$($rows.Count)/$($rows.Count) passed" }
            return [pscustomobject]@{ Pass = ($failed.Count -eq 0); Detail = $detail }
        }
        'OpedFiles' { return [pscustomobject]@{ Pass = [bool]$Result.Pass; Detail = if ($Result.Pass) { 'assets present' } else { "$($Result.Result.Error)" } } }
        'EmbeddingLatency' { return [pscustomobject]@{ Pass = ($Result.Status -eq 'ok'); Detail = "$($Result.Status), $($Result.Ms) ms" } }
        'CachePresence' { return [pscustomobject]@{ Pass = [bool]$Result.Present; Detail = "$($Result.Status)" } }
        'IdentityAllowlist' { return [pscustomobject]@{ Pass = ($Result.Status -eq 'ok'); Detail = "$($Result.Status), unreachable=$($Result.Count)" } }
        default { return [pscustomobject]@{ Pass = $false; Detail = "no verdict rule for phase '$Name' (add one to Get-ContainerSmokePhaseVerdict)" } }
    }
}

function Format-ContainerSmokeSummary {
    <# PURE. The step-summary Markdown table. #>
    param([object[]]$Rows)
    $lines = @('## Container smoke (t/611): the deploy smoke''s phases against the CI-built image', '',
        '| Phase | Ran / skipped | Gates the job | Result | Detail / reason |', '|---|---|---|---|---|')
    foreach ($r in $Rows) {
        $cell = ([string]$r.Detail) -replace '\|', '\|' -replace '[\r\n]+', ' '
        if ($cell.Length -gt 300) { $cell = $cell.Substring(0, 300) + '…' }
        $lines += "| $($r.Phase) | $($r.Ran) | $($r.Gates) | $($r.Result) | $cell |"
    }
    ($lines -join "`n") + "`n"
}

# Dot-sourced by the tests for the table and the pure functions; the run is for direct invocation only.
if ($MyInvocation.InvocationName -eq '.') { return }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
try {
    $module = Import-Module (Join-Path $repoRoot 'scripts' 'AITriad' 'AITriad.psd1') -Force -PassThru -ErrorAction Stop
} catch {
    Write-Host "::error::container-smoke: could not import the AITriad module from the checkout: $($_.Exception.Message)"
    exit 1
}

$rows = @()
$failures = @()
foreach ($p in $script:Phases) {
    if ($p.Kind -eq 'skip') {
        Write-Host "WARN smoke-phase-skipped: $($p.Name): $($p.Reason)"
        $rows += [pscustomobject]@{ Phase = $p.Name; Ran = 'skipped'; Gates = '-'; Result = '-'; Detail = $p.Reason }
        continue
    }
    $fn = "Invoke-Smoke$($p.Name)Phase"
    $result = $null
    $err = $null
    try {
        # Private functions: run inside the module's scope.
        $result = & $module {
            param($Fn, $BaseUrl, $TimeoutSec, $HealthMaxAttempts)
            switch ($Fn) {
                'Invoke-SmokeHealthPhase' { Invoke-SmokeHealthPhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec -MaxAttempts $HealthMaxAttempts -RetryIntervalSec 10 }
                'Invoke-SmokeEmbeddingLatencyPhase' { Invoke-SmokeEmbeddingLatencyPhase -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec -CeilingSec 2 }
                default { & $Fn -BaseUrl $BaseUrl -TimeoutSec $TimeoutSec }
            }
        } $fn $BaseUrl $TimeoutSec $HealthMaxAttempts
    } catch {
        $err = $_.Exception.Message
    }
    $v = if ($err) { [pscustomobject]@{ Pass = $false; Detail = "threw: $err" } } else { Get-ContainerSmokePhaseVerdict -Name $p.Name -Result $result }
    $resultText = if ($v.Pass) { 'pass' } elseif ($p.Kind -eq 'gate') { 'FAIL' } else { 'degraded (warn)' }
    $rows += [pscustomobject]@{ Phase = $p.Name; Ran = 'ran'; Gates = $(if ($p.Kind -eq 'gate') { 'yes' } else { 'no (WARN-only, as in prod)' }); Result = $resultText; Detail = $v.Detail }
    if (-not $v.Pass) {
        if ($p.Kind -eq 'gate') {
            $failures += "$($p.Name): $($v.Detail)"
            Write-Host "::error::container-smoke: phase $($p.Name) failed: $($v.Detail)"
        } else {
            Write-Host "::warning::container-smoke: phase $($p.Name) degraded (WARN-only, as in the deploy smoke): $($v.Detail)"
        }
    }
}

$md = Format-ContainerSmokeSummary -Rows $rows
if ($SummaryPath) { Add-Content -LiteralPath $SummaryPath -Value $md } else { Write-Host $md }
if ($failures.Count) {
    Write-Host "container-smoke: FAILED ($($failures.Count) gating phase(s)). A PR that changes what these routes allow anonymously would also fail the deploy smoke and roll back (t/579)."
    exit 1
}
Write-Host "container-smoke: every gating phase passed."
exit 0
