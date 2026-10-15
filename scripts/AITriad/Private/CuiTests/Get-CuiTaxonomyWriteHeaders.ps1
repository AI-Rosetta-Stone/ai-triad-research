# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-CuiTaxonomyWriteHeaders {
    <#
    .SYNOPSIS
        Headers for a CUI test's PUT /api/taxonomy/:pov: the caller's headers plus If-Match set
        from a fresh GET's ETag (t/4222, SO condition C2 on #3266).
    .DESCRIPTION
        #3266 (t/4187) makes PUT /api/taxonomy/:pov return 428 BASE_VERSION_REQUIRED when there is
        no If-Match. This GETs the same POV with the same headers and copies the ETag into If-Match.

        When the server sends no ETag (servers before #3266), the headers come back without
        If-Match and a WARN says so, so the CUI test still works against the current server.
        A failed GET is treated the same way: the PUT then reports its own failure.

        Always returns a NEW hashtable; the caller's headers are never modified.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [Parameter(Mandatory)][string]$Pov,
        [Parameter()][hashtable]$Headers = @{},
        [Parameter()][int]$TimeoutSec = 15
    )

    $Result = @{}
    foreach ($Key in $Headers.Keys) { $Result[$Key] = $Headers[$Key] }

    $Uri = "$($BaseUrl.TrimEnd('/'))/api/taxonomy/$Pov"
    $ETag = $null
    try {
        $Resp = Invoke-WebRequest -Uri $Uri -Method GET -TimeoutSec $TimeoutSec -UseBasicParsing `
            -ErrorAction Stop -Headers $Headers
        if ($Resp.Headers -and $Resp.Headers['ETag']) { $ETag = [string](@($Resp.Headers['ETag'])[0]) }
    }
    catch {
        Write-Warning "CUI taxonomy write: GET $Uri failed before the PUT ($($_.Exception.Message)); sending the PUT without If-Match."
        return $Result
    }

    if ([string]::IsNullOrWhiteSpace($ETag)) {
        Write-Warning "CUI taxonomy write: GET $Uri returned no ETag; sending the PUT without If-Match (expected only on servers that predate #3266, t/4187)."
        return $Result
    }
    $Result['If-Match'] = $ETag
    $Result
}
