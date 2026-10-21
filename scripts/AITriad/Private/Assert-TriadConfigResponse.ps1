# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Refuses an admin config response that isn't parsed JSON (t/4370).
.DESCRIPTION
    Invoke-RestMethod turns a JSON response into an object and leaves anything else as a string.
    A hosted, Easy-Auth-fronted deployment answers a request it can't authenticate with its
    sign-in page: HTTP 200 text/html. Without this check, the config cmdlets read that page as
    success: Set-TriadConfig printed "Config uploaded successfully." and Get-TriadConfig saved
    the HTML as the config file. Easy Auth doesn't accept the GITHUB_TOKEN bearer header, and it
    has no client-directed sign-in for GitHub (t/4134#25), so hosted admin writes need a signed-in
    browser session for now.
#>
function Assert-TriadConfigResponse {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()][object]$Response,
        [Parameter(Mandatory)][string]$Goal,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$CallerName
    )

    Set-StrictMode -Version Latest

    if ($Response -isnot [string]) { return }

    $text = $Response.TrimStart()
    $isHtml = $text.StartsWith('<', [System.StringComparison]::Ordinal)
    $problem = if ($isHtml) {
        'The server returned an HTML page (most likely the Easy Auth sign-in page), not the admin config JSON. Hosted deployments do not accept the GITHUB_TOKEN bearer header, so nothing was read or written.'
    } else {
        'The server returned a non-JSON response, so nothing was read or written.'
    }
    $preview = if ($text.Length -gt 80) { $text.Substring(0, 80) + '…' } else { $text }

    throw (New-ActionableError -AsErrorRecord `
        -Goal $Goal `
        -Problem "$problem Response starts: $preview" `
        -Location $CallerName `
        -NextSteps @('For a hosted deployment (staging or prod), sign in to the app as an admin and use the Runtime Config panel (t/4370)',
                     'For a local server, point -BaseUrl or $env:TAXONOMY_EDITOR_URL at it (no Easy Auth in front)',
                     "Endpoint: $Uri"))
}
