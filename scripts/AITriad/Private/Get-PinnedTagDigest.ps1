# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-PinnedTagDigest {
    # The digest a tag names, '' when GHCR says the tag doesn't exist (404). Any other
    # outcome throws, so the caller never writes when it can't tell (fail closed).
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$Package,
        [Parameter(Mandatory)][string]$TagName,
        [Parameter(Mandatory)][hashtable]$Headers,
        [Parameter(Mandatory)][string]$CallerName
    )

    Set-StrictMode -Version Latest
    try {
        $Resp = Invoke-WebRequest -Uri "https://ghcr.io/v2/$Package/manifests/$TagName" `
            -Headers $Headers -SkipHttpErrorCheck -ErrorAction Stop
    }
    catch {
        $Resp = $null
        $Why = $_.Exception.Message
    }
    if ($null -ne $Resp -and [int]$Resp.StatusCode -eq 404) { return '' }
    if ($null -ne $Resp -and [int]$Resp.StatusCode -eq 200) {
        $Found = Get-OciManifestDigest -Response $Resp
        if ($Found) { return $Found }
        $Why = 'GHCR returned 200 but no manifest digest could be determined'
    }
    elseif ($null -ne $Resp) {
        $Why = "GHCR returned HTTP $([int]$Resp.StatusCode)"
    }
    throw (New-ActionableError `
        -Goal "Read the tag '$TagName' before writing it" `
        -Problem "Could not tell whether the tag exists, so nothing was written: $Why" `
        -Location $CallerName `
        -NextSteps @('Re-run the tag-known-good job', "Check ghcr.io/${Package}:$TagName by hand") `
        -AsErrorRecord)
}
