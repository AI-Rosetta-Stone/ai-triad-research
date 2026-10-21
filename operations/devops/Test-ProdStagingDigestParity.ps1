<#
.SYNOPSIS
    Post-deploy warn-only check: does prod serve the same image digest as staging?
    (t/4194 prevention item 3.)

.DESCRIPTION
    The 10-12/10-13 incidents left staging pinned to a stale (pre-org-move) image for days with
    nobody noticing, because nothing ever compared the two. This is deliberately WARN-ONLY, never
    failing the deploy: a skew is sometimes intentional (e.g. staging mid-promotion, or holding back
    a risky change) — the job here is to make a silent skew visible, not to force the two to match.

    `Get-ServingImage` and `Get-DigestParityVerdict` are pure (no Azure calls), split out for Pester
    testing. `Test-ProdStagingDigestParity` is the impure wrapper that queries both container apps
    live and feeds the SERVING revisions' images into the predicate.

    t/4399: compare what each app SERVES (the revision(s) its ingress traffic routes to), never
    `properties.template` (the app's desired template). deploy-azure.yml's Bicep apply writes prod's
    image into the staging template while `trafficPinRevisionNameStaging` keeps staging traffic on
    its previous revision, so a template read reported PARITY-OK after every prod deploy no matter
    what staging served — blind to the exact t/4194 shape (template current, traffic pinned old).

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
    Pure resolver (t/4399): which image does an app SERVE? Takes the app's ingress traffic entries
    (`properties.configuration.ingress.traffic`), its `latestRevisionName`, and a revision -> image
    map, and returns @{ Image; Revisions; Reason }. `Image` is $null — UNKNOWN, never a guess — when:
      - no traffic entry has weight > 0;
      - a weighted entry's revision can't be named or has no image in the map;
      - traffic is split across revisions serving DIFFERENT images (a split is its own outcome; a
        split across revisions on the same image resolves to that image).
    A `latestRevision: true` entry resolves to `latestRevisionName`.
#>
function Get-ServingImage {
    param(
        [object[]]$Traffic,
        [string]$LatestRevisionName,
        [hashtable]$RevisionImages
    )
    $weighted = @($Traffic | Where-Object { $_ -and [int]$_.weight -gt 0 })
    if ($weighted.Count -eq 0) {
        return [PSCustomObject]@{ Image = $null; Revisions = @(); Reason = 'no ingress traffic entry has weight > 0' }
    }
    $served = [System.Collections.Generic.List[object]]::new()
    foreach ($t in $weighted) {
        $hasLatest = $t.PSObject.Properties.Name -contains 'latestRevision' -and $t.latestRevision
        $hasName = $t.PSObject.Properties.Name -contains 'revisionName' -and $t.revisionName
        $rev = if ($hasName) { [string]$t.revisionName } elseif ($hasLatest) { $LatestRevisionName } else { $null }
        if ([string]::IsNullOrWhiteSpace($rev)) {
            return [PSCustomObject]@{ Image = $null; Revisions = @(); Reason = "a weighted traffic entry (weight $($t.weight)) names no revision" }
        }
        $img = if ($RevisionImages -and $RevisionImages.ContainsKey($rev)) { [string]$RevisionImages[$rev] } else { '' }
        if ([string]::IsNullOrWhiteSpace($img)) {
            return [PSCustomObject]@{ Image = $null; Revisions = @($rev); Reason = "could not resolve the image of serving revision '$rev'" }
        }
        $served.Add([PSCustomObject]@{ Revision = $rev; Weight = [int]$t.weight; Image = $img })
    }
    $revs = @($served | ForEach-Object { "$($_.Revision)=$($_.Weight)%" })
    $images = @($served | ForEach-Object { $_.Image } | Sort-Object -Unique)
    if ($images.Count -gt 1) {
        $detail = ($served | ForEach-Object { "$($_.Revision)=$($_.Weight)% $($_.Image)" }) -join '; '
        return [PSCustomObject]@{ Image = $null; Revisions = $revs; Reason = "traffic is split across revisions serving different images ($detail)" }
    }
    return [PSCustomObject]@{ Image = $images[0]; Revisions = $revs; Reason = $null }
}

<#
.SYNOPSIS
    Pure predicate: given the two apps' SERVING image strings, decide match/mismatch. No Azure calls
    — the CLI wrapper below does the live query and passes the results in. An empty/null digest for
    either side means "could not determine" (e.g. app doesn't exist, az call failed, or a traffic
    split — see Get-ServingImage) and is reported as its own outcome, never silently read as a match.
    The optional revision/reason strings only enrich the message.
#>
function Get-DigestParityVerdict {
    param(
        [string]$ProdImage,
        [string]$StagingImage,
        [string]$ProdRevisions = '',
        [string]$StagingRevisions = '',
        [string]$ProdReason = '',
        [string]$StagingReason = ''
    )
    $prodLabel = if ($ProdRevisions) { "prod [$ProdRevisions]" } else { 'prod' }
    $stagingLabel = if ($StagingRevisions) { "staging [$StagingRevisions]" } else { 'staging' }
    if ([string]::IsNullOrWhiteSpace($ProdImage) -or [string]::IsNullOrWhiteSpace($StagingImage)) {
        $why = @(
            if ($ProdReason) { "prod: $ProdReason" }
            if ($StagingReason) { "staging: $StagingReason" }
        ) -join '; '
        $whySuffix = if ($why) { " ($why)" } else { '' }
        return [PSCustomObject]@{
            Match        = $false
            Determinable = $false
            ProdImage    = $ProdImage
            StagingImage = $StagingImage
            Message      = "Could not determine one or both serving images ($prodLabel='$ProdImage' $stagingLabel='$StagingImage')$whySuffix — parity UNKNOWN, not a confirmed match."
        }
    }
    $match = ($ProdImage -eq $StagingImage)
    $msg = if ($match) {
        "Prod and staging serve the same image: $ProdImage ($prodLabel, $stagingLabel)"
    } else {
        "Prod ($ProdImage, $prodLabel) and staging ($StagingImage, $stagingLabel) serve DIFFERENT images. If intentional (staging mid-promotion, or deliberately holding a risky change), no action needed — otherwise staging is stale (t/4194 class)."
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
    # Live query: the app's ingress traffic + latestRevisionName, then each weighted revision's own
    # image. Any az failure yields Image=$null with a reason, which the predicate reports as UNKNOWN.
    function Get-LiveServingImage([string]$App) {
        try {
            $json = az containerapp show -n $App -g $ResourceGroup `
                --query "{traffic: properties.configuration.ingress.traffic, latest: properties.latestRevisionName}" -o json 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $json) {
                return [PSCustomObject]@{ Image = $null; Revisions = @(); Reason = "az containerapp show failed for '$App'" }
            }
            # Not `$app`: PowerShell names are case-insensitive, so it would overwrite [string]$App.
            $info = ($json -join "`n") | ConvertFrom-Json
            $traffic = @($info.traffic)
            $images = @{}
            foreach ($t in $traffic) {
                if (-not $t -or [int]$t.weight -le 0) { continue }
                $hasName = $t.PSObject.Properties.Name -contains 'revisionName' -and $t.revisionName
                $rev = if ($hasName) { [string]$t.revisionName } else { [string]$info.latest }
                if ([string]::IsNullOrWhiteSpace($rev) -or $images.ContainsKey($rev)) { continue }
                $img = az containerapp revision show -n $App -g $ResourceGroup --revision $rev `
                    --query "properties.template.containers[0].image" -o tsv 2>$null
                if ($LASTEXITCODE -eq 0 -and $img) { $images[$rev] = ($img -join '').Trim() }
            }
            return Get-ServingImage -Traffic $traffic -LatestRevisionName ([string]$info.latest) -RevisionImages $images
        } catch {
            return [PSCustomObject]@{ Image = $null; Revisions = @(); Reason = "live query for '$App' threw: $($_.Exception.Message)" }
        }
    }
    $prod = Get-LiveServingImage $ProdApp
    $staging = Get-LiveServingImage $StagingApp
    $verdict = Get-DigestParityVerdict -ProdImage $prod.Image -StagingImage $staging.Image `
        -ProdRevisions ($prod.Revisions -join ', ') -StagingRevisions ($staging.Revisions -join ', ') `
        -ProdReason ([string]$prod.Reason) -StagingReason ([string]$staging.Reason)
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
