# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Resolve a built commit's per-SHA image tag to its immutable @sha256:<digest> ref (t/3679).
.DESCRIPTION
    The deploy-by-digest handoff (t/3679 deploy-by-digest, conditions 2 + 4 + 7): container.yml
    pushes a PERMANENT `sha-<commit>` tag for every built image (condition 1). This script resolves
    that tag -> the immutable digest, so the ACA revision is pinned to content-addressed bytes and a
    pod recycle re-pulls IDENTICAL bytes — never a mutated :latest (the t/3679 recycle-swap hazard).

    FAIL-CLOSED (condition 4): an empty/invalid Sha, no image tagged `sha-<Sha>`, or an ambiguous
    match (>1 distinct digest for a short-SHA prefix) is a TERMINATING actionable error — the deploy
    ABORTS rather than falling back to :latest or an empty ref. Resolution is from the per-SHA tag
    (the TESTED artifact), NEVER from :latest (condition 2).

    STRUCTURE: the pure matcher `Resolve-ImageDigestFromImages` does the logic on an in-memory image
    list (no I/O) and is Pester-tested both-arms (tests/ResolveImageDigest.Tests.ps1) — the co-located
    single source its test and this script share (t/3010 pattern). The guarded impure entrypoint below
    performs the GHCR query (Get-TaxEditorImage) only when the file is INVOKED, not when dot-sourced,
    so a test can dot-source it and exercise the pure function directly.
.PARAMETER Sha
    The commit SHA to deploy — the SAME value passed to the build (Invoke-ContainerBuild.ps1 -Sha).
    Full SHA recommended; a >=7-char prefix is tolerated but must be unambiguous.
.PARAMETER Package
    GHCR package in owner/name form. Default: ai-rosetta-stone/taxonomy-editor.
.PARAMETER Registry
    Container registry host. Default: ghcr.io.
.PARAMETER Last
    Number of GHCR versions to scan. Default: 100.
.PARAMETER GitHubOutput
    When set (invoked path only), append `image_ref=` and `digest=` to $env:GITHUB_OUTPUT.
.EXAMPLE
    ./Resolve-ImageDigest.ps1 -Sha 30281107abc... -GitHubOutput
#>
[CmdletBinding()]
param(
    [Parameter()][string]$Sha,
    [string]$Package  = 'ai-rosetta-stone/taxonomy-editor',
    [string]$Registry = 'ghcr.io',
    [ValidateRange(1, 100)][int]$Last = 100,
    [switch]$GitHubOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Canonical actionable-error helper (Private to the module; dot-sourced so it is available in this
# script's scope AND when a test dot-sources this file). Never a bare `throw` (root AGENTS.md).
. (Join-Path $PSScriptRoot '..' '..' 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1')

function Resolve-ImageDigestFromImages {
    <#
    .SYNOPSIS
        PURE: match a commit SHA against a list of GHCR images and return its immutable @sha256 ref.
    .DESCRIPTION
        No I/O. Given candidate images (each with a .Tags string[] and a .Digest 'sha256:...' — the
        GhcrImage shape from Get-TaxEditorImage), find the one tagged `sha-<Sha>` (exact, or a
        `sha-<Sha>...` prefix for short-SHA tolerance) and return its digest ref. Fail-closed on
        empty/invalid/not-found/ambiguous — the failing arms condition 4 requires.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Sha,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Images,
        [string]$Package  = 'ai-rosetta-stone/taxonomy-editor',
        [string]$Registry = 'ghcr.io'
    )
    $ImageName = "$Registry/$Package"

    # ── Arm 1: empty SHA — refuse to default to :latest (condition 2) ──
    if ([string]::IsNullOrWhiteSpace($Sha)) {
        New-ActionableError -Goal 'Resolve the deploy image to an immutable digest (t/3679)' `
            -Problem 'No commit SHA was provided — refusing to default to :latest (condition 2: the deploy never resolves from the mutable tag).' `
            -Location 'operations/devops/Resolve-ImageDigest.ps1' `
            -NextSteps @(
                'Pass -Sha <commit> — the SAME sha passed to the build (Invoke-ContainerBuild.ps1 -Sha <commit>).',
                'deploy-azure.yml: set the workflow `sha` input. deploy-staging.yml: derives it from the triggering run.'
            ) -ErrorType 'EmptyShaInput' -Throw
    }

    # Hardening: a SHA is hex only. Reject anything else so a `sha-$Sha*` wildcard match can't be
    # abused and a typo fails loud rather than matching unintended tags.
    if ($Sha -notmatch '^[0-9a-fA-F]{7,40}$') {
        New-ActionableError -Goal "Resolve image for commit '$Sha' to an immutable digest (t/3679)" `
            -Problem "The SHA '$Sha' is not a valid hex commit SHA (7-40 hex chars)." `
            -Location 'operations/devops/Resolve-ImageDigest.ps1' `
            -NextSteps @('Pass a valid git commit SHA (the full 40-char SHA is safest).') `
            -ErrorType 'InvalidShaInput' -Throw
    }

    $Tag = "sha-$Sha"
    # Candidates: only `sha-` tags — NEVER :latest (condition 2). Prefix match tolerates a short SHA.
    $Matches = @($Images | Where-Object {
        $Tags = @($_.Tags)
        @($Tags | Where-Object { $_ -like "sha-$Sha*" }).Count -gt 0
    })
    $Digests = @($Matches | ForEach-Object { $_.Digest } | Sort-Object -Unique)

    # ── Arm 2: not found — the commit was never built (or its per-SHA tag was pruned) ──
    if ($Digests.Count -eq 0) {
        New-ActionableError -Goal "Resolve image for commit $Sha to an immutable digest (t/3679)" `
            -Problem "No GHCR image is tagged '$Tag'. The commit was never built, or its per-SHA tag does not exist." `
            -Location 'operations/devops/Resolve-ImageDigest.ps1' `
            -NextSteps @(
                "Build it first: Invoke-ContainerBuild.ps1 -Sha $Sha",
                "Verify the tag exists: Get-TaxEditorImage -Last 100 | Where-Object { `$_.Tags -contains '$Tag' }"
            ) -ErrorType 'ImageTagNotFound' -Throw
    }

    # ── Arm 3: ambiguous — a short-SHA prefix matched >1 distinct build ──
    if ($Digests.Count -gt 1) {
        New-ActionableError -Goal "Resolve image for commit $Sha to an immutable digest (t/3679)" `
            -Problem "Ambiguous: '$Sha' matches $($Digests.Count) distinct digests ($($Digests -join ', ')) — a short-SHA prefix hit multiple builds." `
            -Location 'operations/devops/Resolve-ImageDigest.ps1' `
            -NextSteps @('Pass the FULL 40-char commit SHA to disambiguate.') `
            -ErrorType 'AmbiguousShaMatch' -Throw
    }

    # ── Success: exactly one digest — return the immutable, content-addressed ref ──
    $Digest = $Digests[0]
    if ([string]::IsNullOrWhiteSpace($Digest) -or $Digest -notmatch '^sha256:[0-9a-f]{64}$') {
        New-ActionableError -Goal "Resolve image for commit $Sha to an immutable digest (t/3679)" `
            -Problem "The matched image's digest is missing or malformed ('$Digest') — cannot pin an unverifiable ref." `
            -Location 'operations/devops/Resolve-ImageDigest.ps1' `
            -NextSteps @('Re-query GHCR; if the version has no digest, rebuild the image.') `
            -ErrorType 'MalformedDigest' -Throw
    }
    [pscustomobject]@{
        Sha      = $Sha
        Tag      = $Tag
        Digest   = $Digest
        ImageRef = "$ImageName@$Digest"
    }
}

# ── Impure entrypoint — runs ONLY when the file is invoked, not when dot-sourced (tests dot-source) ──
if ($MyInvocation.InvocationName -ne '.') {
    Import-Module (Join-Path $PSScriptRoot '..' '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force
    $Images = @(Get-TaxEditorImage -Last $Last -Package $Package)
    $Result = Resolve-ImageDigestFromImages -Sha $Sha -Images $Images -Package $Package -Registry $Registry
    if ($GitHubOutput -and $env:GITHUB_OUTPUT) {
        Add-Content -Path $env:GITHUB_OUTPUT -Value "image_ref=$($Result.ImageRef)"
        Add-Content -Path $env:GITHUB_OUTPUT -Value "digest=$($Result.Digest)"
    }
    Write-Host "Resolved commit $($Result.Sha) -> $($Result.ImageRef)"
    $Result
}
