# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Set-TriadConfig {
    <#
    .SYNOPSIS
        Uploads a local runtime configuration to a taxonomy-editor deployment.
    .DESCRIPTION
        Reads a local config JSON file and POSTs it to the admin config endpoint,
        replacing the deployment's live runtime configuration. Requires admin
        credentials (GITHUB_TOKEN). Supports -WhatIf/-Confirm (ConfirmImpact High),
        an optional pre-upload diff, and an optional reload after upload. Pair with
        Get-TriadConfig to download-edit-upload safely.
    .PARAMETER InputPath
        Local path to the config JSON to upload. Default: ./runtime-config.json.
    .PARAMETER BaseUrl
        Base URL of the taxonomy-editor deployment. Defaults to the configured endpoint.
    .PARAMETER DiffFirst
        Show a diff between the live config and the local file before uploading.
    .PARAMETER Reload
        Trigger a config reload on the server after a successful upload.
    .EXAMPLE
        Set-TriadConfig -DiffFirst
        # Diff local vs live, then upload after confirmation.
    .EXAMPLE
        Set-TriadConfig -InputPath ./runtime-config.json -Reload
        # Upload and reload the server config in one step.
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TriadConfig
    .LINK
        Invoke-TriadConfigReload
    .LINK
        Register-AIBackend
    .LINK
        Test-AIApiKey
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter()]
        [string]$InputPath = './runtime-config.json',

        [Parameter()]
        [string]$BaseUrl,

        [Parameter()]
        [switch]$DiffFirst,

        [Parameter()]
        [switch]$Reload
    )

    Set-StrictMode -Version Latest

    if (-not (Test-Path $InputPath)) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Upload runtime config to taxonomy-editor' `
            -Problem "Config file not found: $InputPath" `
            -Location 'Set-TriadConfig' `
            -NextSteps @("Create the file or specify a valid -InputPath",
                         "Use Get-TriadConfig to download the current config first"))
    }

    $RawJson = Get-Content -Path $InputPath -Raw -Encoding utf8
    try {
        $ConfigObj = $RawJson | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Parse local config file' `
            -Problem "Invalid JSON in $InputPath — $($_.Exception.Message)" `
            -Location 'Set-TriadConfig' `
            -NextSteps @('Fix JSON syntax errors in the config file',
                         'Validate with: Get-Content ./runtime-config.json | ConvertFrom-Json'))
    }

    $KnownSections = @('_meta', 'resilience', 'rateLimiting', 'tiers', 'quotas',
                        'sessions', 'analytics', 'flightRecorder', 'community',
                        'feedback', 'server', 'cache')
    $UnknownKeys = @($ConfigObj.PSObject.Properties |
        Where-Object { $_.MemberType -eq 'NoteProperty' -and $_.Name -notin $KnownSections } |
        ForEach-Object { $_.Name })
    if (@($UnknownKeys).Count -gt 0) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Validate local config schema' `
            -Problem "Unknown config sections: $($UnknownKeys -join ', ')" `
            -Location 'Set-TriadConfig' `
            -NextSteps @('Remove unknown sections from the config file',
                         "Valid sections: $($KnownSections -join ', ')"))
    }

    $Req = Resolve-TriadConfigRequest -BaseUrl $BaseUrl -CallerName 'Set-TriadConfig'

    if ($DiffFirst) {
        Write-Verbose "Fetching current config for diff..."
        try {
            $Current = Invoke-RestMethod -Uri "$($Req.BaseUrl)/api/admin/config" `
                -Method GET -Headers $Req.Headers -ErrorAction Stop
            $CurrentJson = ($Current.config | ConvertTo-Json -Depth 10).Split("`n")
            $LocalJson = ($ConfigObj | ConvertTo-Json -Depth 10).Split("`n")

            $Diffs = Compare-Object -ReferenceObject $CurrentJson -DifferenceObject $LocalJson
            if (@($Diffs).Count -eq 0) {
                Write-Output "No differences — local config matches server."
                return
            }
            Write-Output "=== Config Diff (server => local) ==="
            foreach ($d in $Diffs) {
                $Indicator = if ($d.SideIndicator -eq '=>') { '+' } else { '-' }
                Write-Output "$Indicator $($d.InputObject)"
            }
            Write-Output "=== End Diff ==="
            Write-Output ""
        }
        catch {
            Write-Warning "Could not fetch current config for diff: $($_.Exception.Message)"
        }
    }

    if (-not $PSCmdlet.ShouldProcess("$($Req.BaseUrl)/api/admin/config", 'Upload runtime config')) {
        return
    }

    $UploadParams = @{
        Uri         = "$($Req.BaseUrl)/api/admin/config"
        Method      = 'PUT'
        Headers     = $Req.Headers
        Body        = (@{ config = $ConfigObj } | ConvertTo-Json -Depth 10 -Compress)
        ContentType = 'application/json'
        ErrorAction = 'Stop'
    }

    try {
        Write-Verbose "PUT $($UploadParams.Uri)"
        $Response = Invoke-RestMethod @UploadParams
    }
    catch {
        $StatusCode = $null
        if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
            $StatusCode = [int]$_.Exception.Response.StatusCode
        }

        $Msg = if ($StatusCode -eq 400) { 'Validation failed — server rejected the config' }
               elseif ($StatusCode -eq 401) { 'Unauthorized — check GITHUB_TOKEN and admin status' }
               elseif ($StatusCode -eq 403) { 'Forbidden — admin access required' }
               elseif ($StatusCode) { "HTTP $StatusCode" }
               else { $_.Exception.Message }

        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Upload runtime config to taxonomy-editor' `
            -Problem "Config upload error: $Msg" `
            -Location 'Set-TriadConfig' `
            -NextSteps @('Verify the config file passes schema validation',
                         'Check server logs for detailed validation errors',
                         "Endpoint: $($UploadParams.Uri)"))
    }

    Write-Output "Config uploaded successfully."

    if ($Response -and $Response.PSObject.Properties['errors'] -and @($Response.errors).Count -gt 0) {
        Write-Warning "Server reported validation warnings:"
        foreach ($err in $Response.errors) { Write-Warning "  $err" }
    }

    if ($Reload) {
        Write-Verbose "Triggering config reload..."
        Invoke-TriadConfigReload -BaseUrl $Req.BaseUrl
    }
}
