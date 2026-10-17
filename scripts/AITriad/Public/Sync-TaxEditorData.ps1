# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Sync-TaxEditorData {
    <#
    .SYNOPSIS
        Forces the taxonomy editor server to reload data from GitHub.
    .DESCRIPTION
        Sends a POST to the server's /api/sync/resync endpoint to trigger
        an immediate data refresh, bypassing the normal < 5 minute poll.
    .PARAMETER BaseUrl
        Server base URL. Default: production.
    .PARAMETER Mode
        Resync mode: fetch-only (pull latest from GitHub) or reset-main
        (delete session branch and start fresh). Default: fetch-only.
    .PARAMETER TimeoutSec
        HTTP request timeout in seconds. Default: 30.
    .EXAMPLE
        Sync-TaxEditorData
    .EXAMPLE
        Sync-TaxEditorData -BaseUrl 'https://staging.example.com'
    .EXAMPLE
        Sync-TaxEditorData -Mode reset-main
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TaxEditorBlob
    .LINK
        Get-TaxEditorDataCommit
    .LINK
        Restore-TaxEditorBlob
    .LINK
        Restore-TaxEditorKnownGood
    .LINK
        Set-TaxEditorKnownGood
    .LINK
        Undo-TaxEditorDataCommit
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [string]$BaseUrl = (Get-TaxEditorBaseUrl),

        [Parameter()]
        [ValidateSet('fetch-only', 'reset-main')]
        [string]$Mode = 'fetch-only',

        [Parameter()]
        [ValidateRange(1, 120)]
        [int]$TimeoutSec = 30
    )

    Set-StrictMode -Version Latest
    $CallerName = 'Sync-TaxEditorData'

    $Uri = "$BaseUrl/api/sync/resync"
    $BodyJson = @{ mode = $Mode } | ConvertTo-Json -Compress

    try {
        $Sw = [System.Diagnostics.Stopwatch]::StartNew()
        $Response = Invoke-RestMethod -Uri $Uri -Method POST `
            -Body $BodyJson -ContentType 'application/json' `
            -TimeoutSec $TimeoutSec -ErrorAction Stop
        $Sw.Stop()

        [PSCustomObject]@{
            Action    = 'DataSync'
            Mode      = $Mode
            Ok        = if ($Response.PSObject.Properties['ok']) { $Response.ok } else { $true }
            Message   = if ($Response.PSObject.Properties['message']) { $Response.message } else { 'Sync triggered' }
            Ms        = $Sw.ElapsedMilliseconds
            BaseUrl   = $BaseUrl
            Timestamp = (Get-Date).ToString('o')
        }
    }
    catch {
        $StatusCode = $null
        if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
            $StatusCode = [int]$_.Exception.Response.StatusCode
        }

        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Trigger server data sync' `
            -Problem "POST $Uri failed$(if ($StatusCode) { " (HTTP $StatusCode)" }): $($_.Exception.Message)" `
            -Location $CallerName `
            -NextSteps @("Verify server is running: Test-TaxEditorHealth -BaseUrl '$BaseUrl'",
                         'Check if the server requires authentication for sync endpoints'))
    }
}
