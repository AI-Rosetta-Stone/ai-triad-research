# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.
#
# t/121 (Interweave; SO condition on #4792, t/71#3): pure decision core for
# Set-TaxEditorPinnedTag. GHCR cleanup protects images BY TAG, but prod pins
# revisions BY DIGEST. A container.yml re-run for the same commit moves
# sha-<commit> to a new digest and leaves the pinned digest untagged, so
# ghcr-cleanup may delete it (and its child manifests) after 30 days, and a
# minReplicas:0 cold start then fails to pull. Each deploy therefore tags the
# exact digest it pins with a tag that never moves.

function Get-PinnedImageTagName {
    <#
    .SYNOPSIS
        Pure. The non-moving GHCR tag a deploy puts on the exact digest it pins.
    .DESCRIPTION
        Returns 'pinned-<runId>-<first 12 hex of the digest>'.
        The digest prefix is part of the name, so one name can only ever be
        meant for one digest: a different digest always gets a different tag,
        and the tag never has a reason to move. The run attempt is NOT part of
        the name: every writer in one run (the pre-deploy pin-digest job, the
        post-deploy retry, a re-run of either) computes the same name for the
        same digest and gets AlreadyPinned, and a "re-run all jobs" that
        re-resolves a DIFFERENT digest gets a different name (t/121#5).
        The result always starts with 'pinned-', which ghcr-cleanup protects
        by pattern (Get-StaleImageDeletionVerdict -ProtectedTags).
    .PARAMETER Digest
        The pinned manifest digest, sha256:<64 hex>.
    .PARAMETER RunId
        The deploy's GitHub Actions run id (digits).
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Digest,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$RunId
    )

    Set-StrictMode -Version Latest

    if ($Digest -notmatch '^sha256:[0-9a-fA-F]{64}$') {
        throw (New-ActionableError `
            -Goal 'Name the pinned-digest tag' `
            -Problem "'$Digest' is not a sha256 manifest digest (sha256:<64 hex>)" `
            -Location 'Get-PinnedImageTagName' `
            -NextSteps @('Pass the digest the revision is pinned to, from the deploy''s resolved image ref (...@sha256:<hex>)') `
            -AsErrorRecord)
    }
    if ($RunId -notmatch '^[0-9]{1,20}$') {
        throw (New-ActionableError `
            -Goal 'Name the pinned-digest tag' `
            -Problem "'$RunId' is not a GitHub Actions run id (digits only)" `
            -Location 'Get-PinnedImageTagName' `
            -NextSteps @('Pass ${{ github.run_id }}') `
            -AsErrorRecord)
    }

    $Hex12 = $Digest.Substring('sha256:'.Length, 12).ToLowerInvariant()
    "pinned-$RunId-$Hex12"
}

function Get-PinnedImageTagVerdict {
    <#
    .SYNOPSIS
        Pure. Decides whether to write a pinned-digest tag.
    .DESCRIPTION
        Returns [pscustomobject]@{ Action; Reason } where Action is:
          Create        - the tag does not exist yet; PUT it.
          AlreadyPinned - the tag already names this digest (a re-run); write nothing.
          Refuse        - the tag names a DIFFERENT digest. A pinned tag must never
                          move, so nothing is written and the caller warns.
        An existing digest that is unknown (the read failed) is not represented
        here: the caller must not call this, and must not PUT, when it cannot
        read the tag (fail closed).
    .PARAMETER Digest
        The digest the deploy pins.
    .PARAMETER ExistingDigest
        The digest the tag already names, or empty when the tag does not exist.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)]
        [string]$Digest,

        [Parameter()]
        [AllowEmptyString()]
        [AllowNull()]
        [string]$ExistingDigest
    )

    Set-StrictMode -Version Latest

    if ([string]::IsNullOrEmpty($ExistingDigest)) {
        return [pscustomobject]@{ Action = 'Create'; Reason = 'the tag does not exist yet' }
    }
    if ([string]::Equals($ExistingDigest, $Digest, [System.StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{ Action = 'AlreadyPinned'; Reason = "the tag already names $Digest" }
    }
    [pscustomobject]@{
        Action = 'Refuse'
        Reason = "the tag already names $ExistingDigest, not $Digest, and a pinned tag never moves"
    }
}
