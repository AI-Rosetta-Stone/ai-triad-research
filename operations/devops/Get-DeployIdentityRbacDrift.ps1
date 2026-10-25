# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Impure bridge for the t/4397 deploy-identity RBAC drift check.
.DESCRIPTION
    Queries the live `az role assignment list` for github-ai-triad-deploy and evaluates drift via
    the pure Get-DeployIdentityRbacDriftVerdict predicate against the checked-in manifest
    (deploy-identity-rbac-manifest.json). Detection only -- never grants, revokes, or otherwise
    mutates any role assignment.
.PARAMETER RgScope
    The resource group's full ARM scope, e.g.
    /subscriptions/<sub>/resourceGroups/ai-triad. No default -- a stale default would silently
    compare against the wrong subscription/RG if either ever changes.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $RgScope
)

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'DeployIdentityRbacDriftVerdict.ps1')

$manifestPath = Join-Path $PSScriptRoot 'deploy-identity-rbac-manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

$liveJson = $null
try { $liveJson = az role assignment list --assignee $manifest.principalAppId --all -o json 2>$null } catch { $liveJson = $null }

if (-not $liveJson) {
    return [pscustomobject]@{
        Violations = @()
        ShouldAct  = $false
        QueryError = "az role assignment list returned nothing for '$($manifest.principalAppId)' -- az CLI auth or network failure; refusing to report a clean zero."
    }
}

$liveParsed = $liveJson | ConvertFrom-Json
$live = @($liveParsed | ForEach-Object { [pscustomobject]@{ roleDefinitionName = $_.roleDefinitionName; scope = $_.scope } })

$verdict = Get-DeployIdentityRbacDriftVerdict -Expected $manifest.expectedAssignments -Live $live -RgScope $RgScope
[pscustomobject]@{
    Violations = $verdict.Violations
    ShouldAct  = $verdict.ShouldAct
    QueryError = $null
}
