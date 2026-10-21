# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-TriadConfigReload {
    <#
    .SYNOPSIS
        Triggers a live runtime-config reload on a taxonomy-editor deployment.
    .DESCRIPTION
        POSTs to the admin config reload endpoint (/api/admin/config/reload) so the
        server re-reads its runtime configuration without a redeploy. Requires admin
        credentials (GITHUB_TOKEN). Use after Set-TriadConfig when you did not pass
        -Reload, or to force the server to pick up an out-of-band config change.
    .PARAMETER BaseUrl
        Base URL of the taxonomy-editor deployment. Defaults to the configured endpoint.
    .PARAMETER PassThru
        Return the server's reload response object instead of nothing.
    .EXAMPLE
        Invoke-TriadConfigReload
        # Force the deployment to reload its runtime config.
    .EXAMPLE
        Invoke-TriadConfigReload -PassThru
        # Reload and return the server response.
    .LINK
        Show-AITriadHelp
    .LINK
        Get-TriadConfig
    .LINK
        Set-TriadConfig
    .LINK
        Register-AIBackend
    .LINK
        Test-AIApiKey
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [string]$BaseUrl,

        [Parameter()]
        [switch]$PassThru
    )

    Set-StrictMode -Version Latest

    $Req = Resolve-TriadConfigRequest -BaseUrl $BaseUrl -CallerName 'Invoke-TriadConfigReload'

    $Params = @{
        Uri         = "$($Req.BaseUrl)/api/admin/config/reload"
        Method      = 'POST'
        Headers     = $Req.Headers
        ErrorAction = 'Stop'
    }

    try {
        Write-Verbose "POST $($Params.Uri)"
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
            -Goal 'Reload runtime config on taxonomy-editor' `
            -Problem "Config reload error: $Msg" `
            -Location 'Invoke-TriadConfigReload' `
            -NextSteps @('Verify $env:GITHUB_TOKEN is valid and has admin access',
                         'Verify the server is reachable at the BaseUrl',
                         "Endpoint: $($Params.Uri)"))
    }

    Assert-TriadConfigResponse -Response $Response -Goal 'Reload runtime config on taxonomy-editor' `
        -Uri $Params.Uri -CallerName 'Invoke-TriadConfigReload'

    if ($Response -and $Response.PSObject.Properties['errors'] -and @($Response.errors).Count -gt 0) {
        Write-Warning "Reload completed with warnings:"
        foreach ($err in $Response.errors) { Write-Warning "  $err" }
    }
    else {
        Write-Output "Config reloaded successfully."
    }

    if ($PassThru) {
        $Response
    }
}
