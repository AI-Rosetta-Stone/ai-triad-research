# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-GhcrAuthToken {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Package,

        [Parameter()]
        [ValidateSet('pull', 'pull,push')]
        [string]$Scope = 'pull,push',

        [Parameter()]
        [string]$CallerName = 'Get-GhcrAuthToken'
    )

    Set-StrictMode -Version Latest

    $Token = $env:GITHUB_TOKEN
    if (-not $Token) {
        throw (New-ActionableError `
            -Goal 'Authenticate to GHCR' `
            -Problem 'GITHUB_TOKEN environment variable is not set' `
            -Location $CallerName `
            -NextSteps @('Set $env:GITHUB_TOKEN to a GitHub personal access token',
                         'Token needs write:packages scope for tag operations') `
            -AsErrorRecord)
    }

    $AuthBytes = [System.Text.Encoding]::UTF8.GetBytes("_:$Token")
    $AuthBase64 = [System.Convert]::ToBase64String($AuthBytes)

    try {
        $Resp = Invoke-RestMethod `
            -Uri "https://ghcr.io/token?scope=repository:${Package}:${Scope}&service=ghcr.io" `
            -Headers @{ Authorization = "Basic $AuthBase64" } `
            -ErrorAction Stop
        return $Resp.token
    }
    catch {
        throw (New-ActionableError `
            -Goal 'Authenticate to GHCR' `
            -Problem "Failed to obtain GHCR bearer token: $($_.Exception.Message)" `
            -Location $CallerName `
            -NextSteps @('Verify GITHUB_TOKEN has write:packages scope',
                         "Package: $Package") `
            -AsErrorRecord)
    }
}
