# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Deactivates a Container Apps revision only after a fresh t/4242 verdict says it is safe.
.DESCRIPTION
    The manual/rollback counterpart of the deploy workflows' guarded deactivate loop
    (deploy-staging.yml, deploy-azure.yml; t/4308). Immediately before the destructive call it reads
    BOTH independently-sourced weights fresh: the revision's own `trafficWeight` (az containerapp
    revision show) and the app's ingress traffic config (az containerapp show), and asks the shared
    predicate Get-RevisionDeactivationVerdict (operations/devops/Get-RevisionDeactivationVerdict.ps1,
    the one predicate all routes use). Anything but 'deactivate' skips with a WARN. An unreadable
    weight on either source is never read as 0 (the predicate's SO C3 rule).
.OUTPUTS
    The verdict object (Action, Reason, RevisionName), with Deactivated = $true/$false added.
#>
function Invoke-GuardedRevisionDeactivate {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][string]$ResourceGroup,
        [Parameter(Mandatory)][string]$AppName,
        [Parameter(Mandatory)][string]$RevisionName,
        [string]$ServingRevisionName,
        [string[]]$ProtectedNames = @(),
        [string]$CallerName = 'Invoke-GuardedRevisionDeactivate'
    )
    Set-StrictMode -Version Latest
    Import-RevisionDeactivationVerdict -CallerName $CallerName

    $fresh = $null
    $revJson = & az containerapp revision show -g $ResourceGroup -n $AppName --revision $RevisionName --output json 2>$null
    if ($LASTEXITCODE -eq 0 -and $revJson) { try { $fresh = ($revJson -join "`n") | ConvertFrom-Json } catch { $fresh = $null } }
    $app = $null
    $appJson = & az containerapp show -g $ResourceGroup -n $AppName --output json 2>$null
    if ($LASTEXITCODE -eq 0 -and $appJson) { try { $app = ($appJson -join "`n") | ConvertFrom-Json } catch { $app = $null } }

    $props = if ($null -ne $fresh -and $fresh.PSObject.Properties['properties']) { $fresh.properties } else { $null }
    $weight = if ($null -ne $props -and $props.PSObject.Properties['trafficWeight']) { $props.trafficWeight } else { $null }
    $active = if ($null -ne $props -and $props.PSObject.Properties['active']) { [bool]$props.active } else { $false }

    $trafficEntries = $null; $latestRevisionName = $null
    if ($null -ne $app -and $app.PSObject.Properties['properties']) {
        $ap = $app.properties
        if ($ap.PSObject.Properties['configuration'] -and $ap.configuration.PSObject.Properties['ingress'] -and
            $ap.configuration.ingress.PSObject.Properties['traffic']) {
            $trafficEntries = @($ap.configuration.ingress.traffic)
        }
        if ($ap.PSObject.Properties['latestRevisionName']) { $latestRevisionName = [string]$ap.latestRevisionName }
    }
    $ingress = Get-IngressTrafficWeightForRevision -RevisionName $RevisionName -TrafficEntries $trafficEntries -LatestRevisionName $latestRevisionName
    $verdict = Get-RevisionDeactivationVerdict -RevisionName $RevisionName -TrafficWeight $weight -Active $active `
        -IngressWeight $ingress.IngressWeight -IsLatestRevisionWithTraffic $ingress.IsLatestRevisionWithTraffic `
        -ServingRevisionName $ServingRevisionName -ProtectedNames $ProtectedNames

    $deactivated = $false
    if ($verdict.Action -eq 'deactivate') {
        Write-Verbose "${CallerName}: deactivating '$RevisionName' (fresh verdict: $($verdict.Reason))."
        & az containerapp revision deactivate -g $ResourceGroup -n $AppName --revision $RevisionName 2>$null
        if ($LASTEXITCODE -eq 0) { $deactivated = $true }
        else { Write-Warning "${CallerName}: failed to deactivate revision '$RevisionName' (exit $LASTEXITCODE); manual cleanup may be needed." }
    }
    else {
        Write-Warning "${CallerName}: not deactivating revision '$RevisionName': fresh re-check says $($verdict.Reason) (t/4242 guard)."
    }
    $verdict | Add-Member -NotePropertyName Deactivated -NotePropertyValue $deactivated -Force -PassThru
}

function Import-RevisionDeactivationVerdict {
    # Loads the shared predicate from the repo checkout into the module scope once. Fails closed: a
    # missing predicate throws before any deactivate, never deactivates unguarded.
    [CmdletBinding()]
    param([string]$CallerName = 'Import-RevisionDeactivationVerdict')
    if ((Get-Variable -Name RevisionVerdictLoaded -Scope Script -ValueOnly -ErrorAction SilentlyContinue) -eq $true) { return }
    $path = if ($script:RepoRoot) { Join-Path $script:RepoRoot 'operations' 'devops' 'Get-RevisionDeactivationVerdict.ps1' } else { $null }
    if (-not $path -or -not (Test-Path -LiteralPath $path)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Deactivate a revision only after the t/4242 traffic-weight guard' `
            -Problem "The shared guard predicate was not found at '$path'" `
            -Location $CallerName `
            -NextSteps @('Run this cmdlet from a checkout containing operations/devops/Get-RevisionDeactivationVerdict.ps1',
                         'Nothing was deactivated'))
    }
    . $path
    # Dot-sourcing inside a function scopes the definitions to it; publish them to the module scope.
    foreach ($fn in 'Get-RevisionDeactivationVerdict', 'Get-IngressTrafficWeightForRevision') {
        Set-Item -Path "function:script:$fn" -Value (Get-Item "function:$fn").ScriptBlock
    }
    $script:RevisionVerdictLoaded = $true
}
