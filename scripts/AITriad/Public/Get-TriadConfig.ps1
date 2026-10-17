# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-TriadConfig {
    <#
    .SYNOPSIS
        Downloads the live runtime configuration from a taxonomy-editor deployment.
    .DESCRIPTION
        Calls the admin config endpoint (/api/admin/config) and returns the current
        runtime configuration, optionally writing it to a local file. Requires admin
        credentials (GITHUB_TOKEN). Use this to snapshot the deployed config before
        editing and re-uploading with Set-TriadConfig.
    .PARAMETER OutputPath
        Local path to write the downloaded config JSON. Default: ./runtime-config.json.
    .PARAMETER BaseUrl
        Base URL of the taxonomy-editor deployment. Defaults to the configured endpoint.
    .PARAMETER IncludeDefaults
        Include server-side default values in the returned config.
    .PARAMETER Format
        Output format: 'json' (default) or 'table'.
    .EXAMPLE
        Get-TriadConfig
        # Download the live config to ./runtime-config.json.
    .EXAMPLE
        Get-TriadConfig -Format table
        # Show the live config as a table.
    .LINK
        Show-AITriadHelp
    .LINK
        Set-TriadConfig
    .LINK
        Invoke-TriadConfigReload
    .LINK
        Register-AIBackend
    .LINK
        Test-AIApiKey
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [string]$OutputPath = './runtime-config.json',

        [Parameter()]
        [string]$BaseUrl,

        [Parameter()]
        [switch]$IncludeDefaults,

        [Parameter()]
        [ValidateSet('json', 'table')]
        [string]$Format = 'json'
    )

    Set-StrictMode -Version Latest

    $Req = Resolve-TriadConfigRequest -BaseUrl $BaseUrl -CallerName 'Get-TriadConfig'

    $Params = @{
        Uri         = "$($Req.BaseUrl)/api/admin/config"
        Method      = 'GET'
        Headers     = $Req.Headers
        ErrorAction = 'Stop'
    }

    try {
        Write-Verbose "GET $($Params.Uri)"
        $Response = Invoke-RestMethod @Params
    }
    catch {
        $StatusCode = $null
        if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
            $StatusCode = [int]$_.Exception.Response.StatusCode
        }

        $Msg = if ($StatusCode -eq 401) { 'Unauthorized — check GITHUB_TOKEN and admin status' }
               elseif ($StatusCode -eq 403) { 'Forbidden — admin access required' }
               elseif ($StatusCode) { "HTTP $StatusCode" }
               else { $_.Exception.Message }

        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Download runtime config from taxonomy-editor' `
            -Problem "Config API error: $Msg" `
            -Location 'Get-TriadConfig' `
            -NextSteps @('Verify $env:GITHUB_TOKEN is valid and has admin access',
                         'Verify the server is reachable at the BaseUrl',
                         "Endpoint: $($Params.Uri)"))
    }

    if ($Format -eq 'table') {
        $Config = if ($Response.PSObject.Properties['config']) { $Response.config } else { $Response }
        $Sections = @($Config.PSObject.Properties | Where-Object { $_.MemberType -eq 'NoteProperty' -and $_.Name -ne '_meta' })
        foreach ($Section in $Sections) {
            Write-Output "`n=== $($Section.Name) ==="
            if ($null -ne $Section.Value -and $Section.Value -is [PSCustomObject]) {
                $Section.Value.PSObject.Properties | ForEach-Object {
                    $Val = if ($_.Value -is [System.Collections.IEnumerable] -and $_.Value -isnot [string]) {
                        ($_.Value -join ', ')
                    } else { $_.Value }
                    Write-Output ("  {0,-35} {1}" -f $_.Name, $Val)
                }
            }
        }
        if ($Response.PSObject.Properties['errors'] -and @($Response.errors).Count -gt 0) {
            Write-Output "`n=== Validation Errors ==="
            foreach ($err in $Response.errors) { Write-Output "  ! $err" }
        }
        return
    }

    $Config = if ($Response.PSObject.Properties['config']) { $Response.config } else { $Response }
    $Config | ConvertTo-Json -Depth 10 | Set-Content -Path $OutputPath -Encoding utf8
    Write-Output "Config saved to $OutputPath"

    if ($IncludeDefaults -and $Response.PSObject.Properties['defaults']) {
        $DefaultsPath = [System.IO.Path]::ChangeExtension($OutputPath, '.defaults.json')
        $Response.defaults | ConvertTo-Json -Depth 10 | Set-Content -Path $DefaultsPath -Encoding utf8
        Write-Output "Defaults saved to $DefaultsPath"
    }

    if ($Response.PSObject.Properties['errors'] -and @($Response.errors).Count -gt 0) {
        Write-Warning "Server reported validation errors:"
        foreach ($err in $Response.errors) { Write-Warning "  $err" }
    }
}
