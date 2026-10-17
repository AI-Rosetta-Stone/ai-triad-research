# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Resolve-TriadConfigRequest {
    [CmdletBinding()]
    param(
        [Parameter()]
        [string]$BaseUrl,

        [Parameter()]
        [string]$CallerName = 'Resolve-TriadConfigRequest'
    )

    Set-StrictMode -Version Latest

    $DefaultUrl = (Get-TaxEditorBaseUrl)

    if (-not $BaseUrl) {
        $BaseUrl = $env:TAXONOMY_EDITOR_URL
    }
    if (-not $BaseUrl) {
        $BaseUrl = $DefaultUrl
    }
    $BaseUrl = $BaseUrl.TrimEnd('/')

    $Token = $env:GITHUB_TOKEN
    if (-not $Token) {
        throw (New-ActionableError `
            -Goal 'Authenticate to taxonomy-editor admin API' `
            -Problem 'GITHUB_TOKEN environment variable is not set' `
            -Location $CallerName `
            -NextSteps @('Set $env:GITHUB_TOKEN to a GitHub personal access token',
                         'The token is used for admin endpoint authentication') `
            -AsErrorRecord)
    }

    [PSCustomObject]@{
        BaseUrl = $BaseUrl
        Headers = @{
            Authorization = "Bearer $Token"
            Accept        = 'application/json'
            'User-Agent'  = 'AITriad-ConfigManager/1.0'
        }
    }
}
