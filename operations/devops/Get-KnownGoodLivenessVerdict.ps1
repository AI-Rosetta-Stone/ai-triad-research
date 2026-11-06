# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
#
# t/4170 ask 3: a liveness check for the known-good GHCR tag, independent of
# Remove-StaleContainerImages / Set-TaxEditorKnownGood (owned by the PowerShell
# role, scripts/AITriad/). Pure predicate + thin impure shim, matching the
# t/4173 Get-ScheduledWorkflowLiveness.ps1 shape in this same directory.

function Get-KnownGoodLivenessVerdict {
    <#
    .SYNOPSIS
        Pure. Judges whether a known-good GHCR tag exists and is within N
        deploys of the newest deploy.
    .DESCRIPTION
        Takes plain GHCR image data in (no network, no fs) and returns a
        verdict. A "deploy" is any image carrying a per-commit `sha-*` tag
        (the permanent tag container.yml pushes for every build, t/3679) --
        counting those, not every other version, keeps the window resistant
        to unrelated cleanup/cosign-attestation noise.
    .PARAMETER Images
        Array of objects with Tags (string[]) and CreatedAt (parseable date)
        properties -- any order, sorted internally. Shape matches
        AITriad's Get-TaxEditorImage output (GhcrImage: Tags/Digest/CreatedAt/IsKnownGood).
    .PARAMETER MaxDeploysBehind
        How many newer deploys the known-good tag may lag before it's
        flagged stale. Default: 5.
    .PARAMETER ProdDeployTimes
        t/4924: completion times of successful production deploys
        (deploy-azure.yml). When given, a "deploy" is a prod deploy after the
        known-good image was built, NOT any sha-* image push. Image pushes
        include every staging build and rebuilds of older commits (the
        t/4840 streak fired #4640 at "7 behind" while known-good was exactly
        prod's serving digest). Each prod deploy re-tags known-good itself,
        so the count stays near 1 unless tagging stops working. Omit it to
        keep the image-push count.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Images,

        [Parameter()]
        [ValidateRange(0, 1000)]
        [int]$MaxDeploysBehind = 5,

        [Parameter()]
        [AllowEmptyCollection()]
        [datetime[]]$ProdDeployTimes
    )

    Set-StrictMode -Version Latest

    $KnownGood = @($Images | Where-Object { @($_.Tags) -contains 'known-good' })

    if (@($KnownGood).Count -eq 0) {
        return [PSCustomObject]@{
            Status        = 'missing'
            Pass          = $false
            DeploysBehind = $null
            Message       = 'no GHCR image carries the known-good tag'
        }
    }

    $KG = $KnownGood[0]
    $KGCreated = [datetime]$KG.CreatedAt

    $Basis = if ($PSBoundParameters.ContainsKey('ProdDeployTimes')) { 'prod deploy' } else { 'image push' }
    $DeploysSince = if ($Basis -eq 'prod deploy') {
        @($ProdDeployTimes | Where-Object { $_ -gt $KGCreated }).Count
    } else {
        @(
            $Images | Where-Object {
                $_ -ne $KG -and
                @($_.Tags | Where-Object { $_ -match '^sha-' }).Count -gt 0 -and
                ([datetime]$_.CreatedAt) -gt $KGCreated
            }
        ).Count
    }

    $Pass = $DeploysSince -le $MaxDeploysBehind

    [PSCustomObject]@{
        Status        = if ($Pass) { 'ok' } else { 'stale' }
        Pass          = $Pass
        DeploysBehind = $DeploysSince
        Basis         = $Basis
        Message       = if ($Pass) {
            "known-good is $DeploysSince $Basis(s) behind (limit $MaxDeploysBehind)"
        } else {
            "known-good is $DeploysSince $Basis(s) behind the newest -- exceeds limit $MaxDeploysBehind"
        }
    }
}

function Test-TaxEditorKnownGoodLiveness {
    <#
    .SYNOPSIS
        Impure shim. Fetches GHCR image history for the taxonomy editor and
        judges known-good liveness via Get-KnownGoodLivenessVerdict.
    .PARAMETER Package
        GitHub package in owner/name format. Default: ai-rosetta-stone/taxonomy-editor.
    .PARAMETER Last
        Number of image versions to fetch. Default: 100.
    .PARAMETER MaxDeploysBehind
        How many newer deploys the known-good tag may lag before it's stale. Default: 5.
    .EXAMPLE
        Test-TaxEditorKnownGoodLiveness
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [string]$Package = 'ai-rosetta-stone/taxonomy-editor',

        [Parameter()]
        [ValidateRange(1, 100)]
        [int]$Last = 100,

        [Parameter()]
        [ValidateRange(0, 1000)]
        [int]$MaxDeploysBehind = 5,

        # t/4924: the repo whose deploy-azure.yml (production-only) runs count as deploys.
        [Parameter()]
        [string]$Repo = 'AI-Rosetta-Stone/ai-triad-research'
    )

    Set-StrictMode -Version Latest

    $Images = @(Get-TaxEditorImage -Last $Last -Package $Package)

    # t/4924: judge by successful prod deploys, not image pushes. If the run list can't be read,
    # fall back to the image-push count (stricter: it over-counts, so it can only false-fire,
    # never hide a stale tag) and say so.
    $Raw = gh run list --repo $Repo --workflow deploy-azure.yml --status success --limit 50 --json updatedAt 2>$null
    if ($LASTEXITCODE -eq 0 -and $Raw) {
        $ProdDeployTimes = @(@($Raw | ConvertFrom-Json) | ForEach-Object { [datetime]$_.updatedAt })
        Get-KnownGoodLivenessVerdict -Images $Images -MaxDeploysBehind $MaxDeploysBehind -ProdDeployTimes $ProdDeployTimes
    } else {
        Write-Warning "t/4924: could not read deploy-azure.yml runs for $Repo; falling back to counting sha-* image pushes (may over-count staging builds and rebuilds)."
        Get-KnownGoodLivenessVerdict -Images $Images -MaxDeploysBehind $MaxDeploysBehind
    }
}
