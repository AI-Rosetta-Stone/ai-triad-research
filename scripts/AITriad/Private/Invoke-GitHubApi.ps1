# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-GitHubApi {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Endpoint,

        [Parameter()]
        [ValidateSet('GET', 'POST', 'PATCH', 'PUT', 'DELETE')]
        [string]$Method = 'GET',

        [Parameter()]
        [object]$Body,

        [Parameter()]
        [string]$CallerName = 'Invoke-GitHubApi'
    )

    Set-StrictMode -Version Latest

    $Token = $env:GITHUB_TOKEN
    if (-not $Token) {
        throw (New-ActionableError `
            -Goal 'Call GitHub API' `
            -Problem 'GITHUB_TOKEN environment variable is not set' `
            -Location $CallerName `
            -NextSteps @('Set $env:GITHUB_TOKEN to a GitHub personal access token',
                         'Token needs repo scope for data operations') `
            -AsErrorRecord)
    }

    $Headers = @{
        Authorization  = "Bearer $Token"
        Accept         = 'application/vnd.github+json'
        'User-Agent'   = 'AITriad-DataRollback/1.0'
    }

    $Params = @{
        Uri         = "https://api.github.com$Endpoint"
        Method      = $Method
        Headers     = $Headers
        ErrorAction = 'Stop'
    }

    if ($Body) {
        $Params['Body']        = ($Body | ConvertTo-Json -Depth 10 -Compress)
        $Params['ContentType'] = 'application/json'
    }

    try {
        Invoke-RestMethod @Params
    }
    catch {
        $StatusCode = $null
        if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
            $StatusCode = [int]$_.Exception.Response.StatusCode
        }

        $Msg = if ($StatusCode -eq 404) { 'Resource not found' }
               elseif ($StatusCode -eq 409) { 'Conflict — the operation could not be completed' }
               elseif ($StatusCode -eq 422) { 'Validation failed — check parameters' }
               elseif ($StatusCode) { "HTTP $StatusCode" }
               else { $_.Exception.Message }

        throw (New-ActionableError `
            -Goal "$Method $Endpoint" `
            -Problem "GitHub API error: $Msg" `
            -Location $CallerName `
            -NextSteps @('Verify GITHUB_TOKEN has repo scope',
                         "Endpoint: $Endpoint") `
            -AsErrorRecord)
    }
}
