# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Post-deploy warn-only check (t/4407, SO follow-up to #3665): does each app's SERVING revision's
    `ALLOWED_ORIGINS` env name that app's own live ingress FQDN?

.DESCRIPTION
    #3665's test (tests/BicepAllowedOrigins.Tests.ps1) only reads `main.bicep`, so nothing compares
    the LIVE value. That's the same blind spot t/4399 closed for digest parity: a check that reads
    config instead of what's actually running can stay green through a drift like t/4406's (staging
    served prod's origin for days). This check reads each app's own serving-revision env, never
    `properties.template`, and compares it against that SAME app's `properties.configuration.ingress.fqdn`
    (never cross-checked against the other app — that's t/4399's job).

    `Get-ServingEnvValue` and `Get-OriginsFqdnVerdict` are pure (no Azure calls), split out for
    Pester. `Test-AllowedOriginsFqdnParity` is the impure wrapper that queries both apps live.

    Gate proof arms:
      Fire (mismatch, missing env, or a traffic split across different origins): ::warning::, exit 0.
      Pass (match): a plain "ORIGIN-OK" line, exit 0.
    Never blocks the deploy — a deliberate temporary origin override is possible and shouldn't fail.

.PARAMETER SuppressAnnotations
    When set, emits plain ORIGIN- lines instead of ::warning:: workflow annotations. Use in test
    subprocess calls to avoid polluting the CI log with annotations that look like real drift.
#>
[CmdletBinding()]
param(
    [string[]]$Apps = @('taxonomy-editor', 'taxonomy-editor-staging'),
    [string]$ResourceGroup = 'ai-triad',
    [switch]$SuppressAnnotations
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-OriginWarning([string]$msg) {
    if ($SuppressAnnotations) { Write-Host "ORIGIN-WARN: $msg" }
    else { Write-Host "::warning::$msg" }
}

<#
.SYNOPSIS
    Pure resolver, the t/4399 serving-revision pattern genericized to any per-revision string value
    (here, each weighted revision's `ALLOWED_ORIGINS`). Returns @{ Value; Revisions; Reason }.
    `Value` is $null — UNKNOWN, never a guess — when:
      - no traffic entry has weight > 0;
      - a weighted entry's revision can't be named, or that revision has no recorded value;
      - traffic is split across revisions with DIFFERENT values (a split on the SAME value resolves
        to that value, same as t/4399's same-image split).
    A `latestRevision: true` entry resolves to `LatestRevisionName`.
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
    Pure predicate: given one app's serving `ALLOWED_ORIGINS` value and its own live ingress FQDN,
    decide match/mismatch. `ALLOWED_ORIGINS` is a scheme+host URL (e.g. `https://host`); only the
    host is compared, case-insensitively, against the bare FQDN. An empty/unresolvable origin or
    FQDN, or an origin that fails to parse as a URL, is its own UNDETERMINABLE outcome.
#>
function Get-OriginsFqdnVerdict {
    param(
        [string]$App,
        [string]$OriginsValue,
        [string]$Fqdn,
        [string]$Revisions = '',
        [string]$Reason = ''
    )
    $label = if ($Revisions) { "$App [$Revisions]" } else { $App }
    if ([string]::IsNullOrWhiteSpace($Fqdn)) {
        return [PSCustomObject]@{
            Match = $false; Determinable = $false; OriginsValue = $OriginsValue; Fqdn = $Fqdn
            Message = "$label`: no live ingress FQDN resolved — ALLOWED_ORIGINS parity UNKNOWN."
        }
    }
    if ([string]::IsNullOrWhiteSpace($OriginsValue)) {
        $why = if ($Reason) { " ($Reason)" } else { '' }
        return [PSCustomObject]@{
            Match = $false; Determinable = $false; OriginsValue = $OriginsValue; Fqdn = $Fqdn
            Message = "$label`: could not determine the serving ALLOWED_ORIGINS value$why — parity UNKNOWN, not a confirmed match."
        }
    }
    $uri = $null
    if (-not [System.Uri]::TryCreate($OriginsValue.Trim(), [System.UriKind]::Absolute, [ref]$uri)) {
        return [PSCustomObject]@{
            Match = $false; Determinable = $false; OriginsValue = $OriginsValue; Fqdn = $Fqdn
            Message = "$label`: ALLOWED_ORIGINS value '$OriginsValue' is not a parseable URL — parity UNKNOWN."
        }
    }
    $host_ = $uri.Host
    $match = $host_.Equals($Fqdn, [System.StringComparison]::OrdinalIgnoreCase)
    $msg = if ($match) {
        "$label`: ALLOWED_ORIGINS ($OriginsValue) names its own ingress FQDN ($Fqdn)."
    } else {
        "$label`: ALLOWED_ORIGINS ($OriginsValue, host '$host_') does NOT match its own live ingress FQDN ('$Fqdn'). If this app is meant to accept writes from a different origin, confirm that's intentional — otherwise this is the t/4406 skew class."
    }
    return [PSCustomObject]@{
        Match = $match; Determinable = $true; OriginsValue = $OriginsValue; Fqdn = $Fqdn; Message = $msg
    }
}

function Test-AllowedOriginsFqdnParity {
    param(
        [string[]]$Apps,
        [string]$ResourceGroup
    )
    function Get-LiveServingOrigins([string]$App) {
        try {
            $json = az containerapp show -n $App -g $ResourceGroup `
                --query "{traffic: properties.configuration.ingress.traffic, latest: properties.latestRevisionName, fqdn: properties.configuration.ingress.fqdn}" -o json 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $json) {
                return [PSCustomObject]@{ Value = $null; Revisions = @(); Reason = "az containerapp show failed for '$App'"; Fqdn = '' }
            }
            # Not `$app`: PowerShell names are case-insensitive, so it would overwrite [string]$App.
            $info = ($json -join "`n") | ConvertFrom-Json
            $traffic = @($info.traffic)
            $values = @{}
            foreach ($t in $traffic) {
                if (-not $t -or [int]$t.weight -le 0) { continue }
                $hasName = $t.PSObject.Properties.Name -contains 'revisionName' -and $t.revisionName
                $rev = if ($hasName) { [string]$t.revisionName } else { [string]$info.latest }
                if ([string]::IsNullOrWhiteSpace($rev) -or $values.ContainsKey($rev)) { continue }
                $v = az containerapp revision show -n $App -g $ResourceGroup --revision $rev `
                    --query "properties.template.containers[0].env[?name=='ALLOWED_ORIGINS'].value | [0]" -o tsv 2>$null
                if ($LASTEXITCODE -eq 0 -and $v) { $values[$rev] = ($v -join '').Trim() }
            }
            $resolved = Get-ServingEnvValue -Traffic $traffic -LatestRevisionName ([string]$info.latest) -RevisionValues $values -ValueLabel 'ALLOWED_ORIGINS'
            $resolved | Add-Member -NotePropertyName Fqdn -NotePropertyValue ([string]$info.fqdn) -PassThru
        } catch {
            return [PSCustomObject]@{ Value = $null; Revisions = @(); Reason = "live query for '$App' threw: $($_.Exception.Message)"; Fqdn = '' }
        }
    }
    $verdicts = foreach ($app in $Apps) {
        $r = Get-LiveServingOrigins $app
        $v = Get-OriginsFqdnVerdict -App $app -OriginsValue $r.Value -Fqdn $r.Fqdn -Revisions ($r.Revisions -join ', ') -Reason ([string]$r.Reason)
        if (-not $v.Determinable -or -not $v.Match) { Write-OriginWarning $v.Message }
        else { Write-Host "ORIGIN-OK: $($v.Message)" }
        $v
    }
    return @($verdicts)
}

if ($MyInvocation.InvocationName -ne '.') {
    Test-AllowedOriginsFqdnParity -Apps $Apps -ResourceGroup $ResourceGroup | Out-Null
}
