<#
.SYNOPSIS
    Post-deploy warn-only check: does prod serve the same image digest as staging?
    (t/4194 prevention item 3.)

.DESCRIPTION
    The 10-12/10-13 incidents left staging pinned to a stale (pre-org-move) image for days with
    nobody noticing, because nothing ever compared the two. This is deliberately WARN-ONLY, never
    failing the deploy: a skew is sometimes intentional (e.g. staging mid-promotion, or holding back
    a risky change) — the job here is to make a silent skew visible, not to force the two to match.

    `Get-DigestParityVerdict` is the pure predicate (no Azure calls), split out for Pester testing.
    `Test-ProdStagingDigestParity` is the impure wrapper that queries both container apps live via
    `az containerapp show` and feeds their digests into the predicate.

    Gate proof arms:
      Fire (mismatch): different digests -> ::warning:: annotation, exit 0 (never blocks the deploy).
      Pass (match): same digest -> a plain "parity OK" line, exit 0.

.PARAMETER SuppressAnnotations
    When set, emits plain PARITY- lines instead of ::warning:: workflow annotations. Use in test
    subprocess calls to avoid polluting the CI log with annotations that look like real drift.
#>
[CmdletBinding()]
param(
    [string]$ProdApp = 'taxonomy-editor',
    [string]$StagingApp = 'taxonomy-editor-staging',
    [string]$ResourceGroup = 'ai-triad',
    [switch]$SuppressAnnotations
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-ParityWarning([string]$msg) {
    if ($SuppressAnnotations) { Write-Host "PARITY-WARN: $msg" }
    else { Write-Host "::warning::$msg" }
}

<#
.SYNOPSIS
    Pure predicate: given the two apps' running image strings, decide match/mismatch. No Azure calls
    — the CLI wrapper below does the live query and passes the results in. An empty/null digest for
    either side means "could not determine" (e.g. app doesn't exist, or az call failed) and is
    reported as its own outcome, never silently read as a match.
#>
function Get-DigestParityVerdict {
    param(
        [string]$ProdImage,
        [string]$StagingImage
    )
    if ([string]::IsNullOrWhiteSpace($ProdImage) -or [string]::IsNullOrWhiteSpace($StagingImage)) {
        return [PSCustomObject]@{
            Match        = $false
            Determinable = $false
            ProdImage    = $ProdImage
            StagingImage = $StagingImage
            Message      = "Could not determine one or both images (prod='$ProdImage' staging='$StagingImage') — parity UNKNOWN, not a confirmed match."
        }
    }
    $match = ($ProdImage -eq $StagingImage)
    $msg = if ($match) {
        "Prod and staging serve the same image: $ProdImage"
    } else {
        "Prod ($ProdImage) and staging ($StagingImage) serve DIFFERENT images. If intentional (staging mid-promotion, or deliberately holding a risky change), no action needed — otherwise staging is stale (t/4194 class)."
    }
    return [PSCustomObject]@{
        Match        = $match
        Determinable = $true
        ProdImage    = $ProdImage
        StagingImage = $StagingImage
        Message      = $msg
    }
}

function Test-ProdStagingDigestParity {
    param(
        [string]$ProdApp,
        [string]$StagingApp,
        [string]$ResourceGroup
    )
    function Get-RunningImage([string]$App) {
        try {
            $out = az containerapp show -n $App -g $ResourceGroup --query "properties.template.containers[0].image" -o tsv 2>$null
            if ($LASTEXITCODE -ne 0) { return $null }
            return $out.Trim()
        } catch { return $null }
    }
    $prodImage = Get-RunningImage $ProdApp
    $stagingImage = Get-RunningImage $StagingApp
    $verdict = Get-DigestParityVerdict -ProdImage $prodImage -StagingImage $stagingImage
    if (-not $verdict.Determinable -or -not $verdict.Match) {
        Write-ParityWarning $verdict.Message
    } else {
        Write-Host "PARITY-OK: $($verdict.Message)"
    }
    return $verdict
}

if ($MyInvocation.InvocationName -ne '.') {
    Test-ProdStagingDigestParity -ProdApp $ProdApp -StagingApp $StagingApp -ResourceGroup $ResourceGroup | Out-Null
}
