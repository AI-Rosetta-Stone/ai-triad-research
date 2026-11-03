# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Post-deploy warn-only check (t/4728): for a tracked set of env var names that are SUPPOSED to
    be Bicep-declared, does staging's SERVING revision actually match `main.bicep`'s declared value?

.DESCRIPTION
    t/4728's incident (p/868#31, 2026-10-31): a CLI `--set-env-vars` override (`FREE_POOL_DAILY_CALLS_CAP=5`
    for the t/4677 staging proof) was silently wiped by the next prod Bicep apply, because the value
    lived only in the live container app, never in `main.bicep`. Nothing watched for that gap.

    Same t/4399/t/4407 lesson as the other post-deploy checks in this directory: read what's actually
    SERVING (`properties.configuration.ingress.traffic`, weight > 0), never `properties.template` —
    staging runs `activeRevisionsMode: Multiple` (t/4728#1 / p/868#34), so a `--set-env-vars` call
    creates a new revision at 0% traffic while the app-level template query reports the NEW value
    even though the OLD revision is still serving 100% of requests. `az containerapp show` alone
    would have reported "fixed" while staging kept running the stale value — exactly what happened
    on 10-31 before the catch.

    `Get-ServingEnvValue` (reused from Test-AllowedOriginsFqdnParity.ps1 — same resolver, no app-specific
    logic) and `Get-EnvDriftVerdict` are pure, no Azure calls. `Test-StagingEnvCliDrift` is the impure
    wrapper that queries the live app and `main.bicep`'s static declaration.

    Tracked keys are intentionally a short, explicit list — this is NOT a generic "diff every env var"
    comparator (that's a bigger lift, left as a possible follow-up if this class recurs). Today it
    tracks only `FREE_POOL_DAILY_CALLS_CAP`.

    Gate proof arms:
      Fire (serving value != Bicep-declared value): ::warning::, exit 0.
      Pass (match): a plain "ENVDRIFT-OK" line, exit 0.
      No weighted traffic at all (e.g. a container app with zero revisions serving): a plain
      "ENVDRIFT-SKIP" line, exit 0 — NOT a false OK, and not a hard failure either, since there's
      nothing live to compare against yet (e.g. right after the app is first created).
    Never blocks the deploy — this only makes drift visible.

.PARAMETER SuppressAnnotations
    When set, emits plain ENVDRIFT- lines instead of ::warning:: workflow annotations. Use in test
    subprocess calls to avoid polluting the CI log with annotations that look like real drift.
#>
[CmdletBinding()]
param(
    [string]$App = 'taxonomy-editor-staging',
    [string]$ResourceGroup = 'ai-triad',
    [string]$BicepPath = (Join-Path $PSScriptRoot '..' '..' 'deploy' 'azure' 'main.bicep'),
    [switch]$SuppressAnnotations
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Name -> the Bicep param that supplies its stagingEnvOverrides value, and that param's own
# default. Extend this list if another CLI-fragile override needs the same protection.
$script:TrackedKeys = @(
    [PSCustomObject]@{ Name = 'FREE_POOL_DAILY_CALLS_CAP'; BicepParam = 'freePoolDailyCallsCapStaging' }
    # t/4738: staging's blob-container isolation. A CLI containment fix (p/868#83) proved these
    # need the same protection as the cap above, or the next prod apply silently reverts staging
    # to reading/writing prod's containers.
    [PSCustomObject]@{ Name = 'AZURE_USER_CONTENT_CONTAINER'; BicepParam = 'azureUserContentContainerStaging' }
    [PSCustomObject]@{ Name = 'AZURE_COMMUNITY_CONTAINER'; BicepParam = 'azureCommunityContainerStaging' }
    [PSCustomObject]@{ Name = 'AZURE_BRIEF_EXPORTS_CONTAINER'; BicepParam = 'azureBriefExportsContainerStaging' }
    # t/4794: a fourth container (analytics) nobody wired — same class as the three above, caught
    # live when staging's events landed in prod's analytics container for ~15 hours.
    [PSCustomObject]@{ Name = 'AZURE_ANALYTICS_CONTAINER'; BicepParam = 'azureAnalyticsContainerStaging' }
)

function Write-EnvDriftWarning([string]$msg) {
    if ($SuppressAnnotations) { Write-Host "ENVDRIFT-WARN: $msg" }
    else { Write-Host "::warning::$msg" }
}

<#
.SYNOPSIS
    Pure resolver, identical shape to Test-AllowedOriginsFqdnParity.ps1's Get-ServingEnvValue.
    Returns @{ Value; Revisions; Reason }. $null Value means UNKNOWN (no weighted traffic, an
    unnamed weighted revision, a revision with no recorded value, or a split across DIFFERENT
    values) — never a guess.
#>
function Get-ServingEnvValue {
    param(
        [object[]]$Traffic,
        [string]$LatestRevisionName,
        [hashtable]$RevisionValues,
        [string]$ValueLabel = 'value'
    )
    $weighted = @($Traffic | Where-Object { $_ -and [int]$_.weight -gt 0 })
    if ($weighted.Count -eq 0) {
        return [PSCustomObject]@{ Value = $null; Revisions = @(); Reason = 'no ingress traffic entry has weight > 0' }
    }
    $served = [System.Collections.Generic.List[object]]::new()
    foreach ($t in $weighted) {
        $hasLatest = $t.PSObject.Properties.Name -contains 'latestRevision' -and $t.latestRevision
        $hasName = $t.PSObject.Properties.Name -contains 'revisionName' -and $t.revisionName
        $rev = if ($hasName) { [string]$t.revisionName } elseif ($hasLatest) { $LatestRevisionName } else { $null }
        if ([string]::IsNullOrWhiteSpace($rev)) {
            return [PSCustomObject]@{ Value = $null; Revisions = @(); Reason = "a weighted traffic entry (weight $($t.weight)) names no revision" }
        }
        $val = if ($RevisionValues -and $RevisionValues.ContainsKey($rev)) { [string]$RevisionValues[$rev] } else { '' }
        if ([string]::IsNullOrWhiteSpace($val)) {
            return [PSCustomObject]@{ Value = $null; Revisions = @($rev); Reason = "serving revision '$rev' has no $ValueLabel set" }
        }
        $served.Add([PSCustomObject]@{ Revision = $rev; Weight = [int]$t.weight; Value = $val })
    }
    $revs = @($served | ForEach-Object { "$($_.Revision)=$($_.Weight)%" })
    $values = @($served | ForEach-Object { $_.Value } | Sort-Object -Unique)
    if ($values.Count -gt 1) {
        $detail = ($served | ForEach-Object { "$($_.Revision)=$($_.Weight)% $($_.Value)" }) -join '; '
        return [PSCustomObject]@{ Value = $null; Revisions = $revs; Reason = "traffic is split across revisions with DIFFERENT ${ValueLabel}s ($detail)" }
    }
    return [PSCustomObject]@{ Value = $values[0]; Revisions = $revs; Reason = $null }
}

<#
.SYNOPSIS
    Pure predicate: given one env var's live-serving value and Bicep's statically declared value,
    decide match/mismatch/undeterminable/skip. Quality's edge case (p/800#7): no serving revision
    at all (Reason mentions "no ingress traffic") is its own SKIP outcome — distinct from a genuine
    mismatch, and never a false OK.
#>
function Get-EnvDriftVerdict {
    param(
        [string]$App,
        [string]$Key,
        [string]$LiveValue,
        [string]$BicepValue,
        [string]$Revisions = '',
        [string]$Reason = ''
    )
    $label = if ($Revisions) { "$App [$Revisions] $Key" } else { "$App $Key" }
    if ($Reason -match 'no ingress traffic entry has weight') {
        return [PSCustomObject]@{
            Outcome = 'Skip'; LiveValue = $LiveValue; BicepValue = $BicepValue
            Message = "$label`: no serving revision found (no weighted traffic) — skipping, not a confirmed match."
        }
    }
    if ([string]::IsNullOrWhiteSpace($LiveValue)) {
        $why = if ($Reason) { " ($Reason)" } else { '' }
        return [PSCustomObject]@{
            Outcome = 'Undeterminable'; LiveValue = $LiveValue; BicepValue = $BicepValue
            Message = "$label`: could not determine the serving value$why — drift UNKNOWN, not a confirmed match."
        }
    }
    if ([string]::IsNullOrWhiteSpace($BicepValue)) {
        return [PSCustomObject]@{
            Outcome = 'Undeterminable'; LiveValue = $LiveValue; BicepValue = $BicepValue
            Message = "$label`: could not resolve main.bicep's declared value for '$Key' — drift UNKNOWN."
        }
    }
    $match = $LiveValue.Trim() -eq $BicepValue.Trim()
    if ($match) {
        return [PSCustomObject]@{
            Outcome = 'Match'; LiveValue = $LiveValue; BicepValue = $BicepValue
            Message = "$label`: serving value ($LiveValue) matches main.bicep's declared value."
        }
    }
    return [PSCustomObject]@{
        Outcome = 'Mismatch'; LiveValue = $LiveValue; BicepValue = $BicepValue
        Message = "$label`: serving value ($LiveValue) does NOT match main.bicep's declared value ($BicepValue) — this is the t/4728 CLI-drift class. A prior CLI override, or this one, may have been set outside Bicep."
    }
}

<#
.SYNOPSIS
    Extracts a Bicep `param <name> ... = '<value>'` default (string literal only — this does not
    evaluate expressions). Returns $null if the param isn't found or its default isn't a simple
    string literal.
#>
function Get-BicepParamDefault {
    param([string]$BicepText, [string]$ParamName)
    if ($BicepText -match "param $ParamName\s+string\s*=\s*'([^']*)'") { return $Matches[1] }
    return $null
}

function Test-StagingEnvCliDrift {
    param(
        [string]$App,
        [string]$ResourceGroup,
        [string]$BicepPath
    )
    $bicepText = Get-Content $BicepPath -Raw
    $json = az containerapp show -n $App -g $ResourceGroup `
        --query "{traffic: properties.configuration.ingress.traffic, latest: properties.latestRevisionName}" -o json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $json) {
        Write-EnvDriftWarning "$App`: az containerapp show failed — drift UNKNOWN for all tracked keys."
        return @()
    }
    $info = ($json -join "`n") | ConvertFrom-Json
    $traffic = @($info.traffic)

    $verdicts = foreach ($tracked in $script:TrackedKeys) {
        $key = $tracked.Name
        $values = @{}
        foreach ($t in $traffic) {
            if (-not $t -or [int]$t.weight -le 0) { continue }
            $hasName = $t.PSObject.Properties.Name -contains 'revisionName' -and $t.revisionName
            $rev = if ($hasName) { [string]$t.revisionName } else { [string]$info.latest }
            if ([string]::IsNullOrWhiteSpace($rev) -or $values.ContainsKey($rev)) { continue }
            $v = az containerapp revision show -n $App -g $ResourceGroup --revision $rev `
                --query "properties.template.containers[0].env[?name=='$key'].value | [0]" -o tsv 2>$null
            if ($LASTEXITCODE -eq 0 -and $v) { $values[$rev] = ($v -join '').Trim() }
        }
        $resolved = Get-ServingEnvValue -Traffic $traffic -LatestRevisionName ([string]$info.latest) -RevisionValues $values -ValueLabel $key
        $bicepValue = Get-BicepParamDefault -BicepText $bicepText -ParamName $tracked.BicepParam
        $v = Get-EnvDriftVerdict -App $App -Key $key -LiveValue $resolved.Value -BicepValue $bicepValue `
            -Revisions ($resolved.Revisions -join ', ') -Reason ([string]$resolved.Reason)
        switch ($v.Outcome) {
            'Skip' { Write-Host "ENVDRIFT-SKIP: $($v.Message)" }
            'Match' { Write-Host "ENVDRIFT-OK: $($v.Message)" }
            default { Write-EnvDriftWarning $v.Message }
        }
        $v
    }
    return @($verdicts)
}

if ($MyInvocation.InvocationName -ne '.') {
    Test-StagingEnvCliDrift -App $App -ResourceGroup $ResourceGroup -BicepPath $BicepPath | Out-Null
}
