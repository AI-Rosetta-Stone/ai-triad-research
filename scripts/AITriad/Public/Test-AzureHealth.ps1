# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-AzureHealth {
    <#
    .SYNOPSIS
        Tests health of Azure infrastructure backing the Taxonomy Editor.
    .DESCRIPTION
        Checks Azure platform status, Container App responsiveness, and
        key dependent services (status.azure.com). Requires no Azure CLI
        login — all checks use public HTTP endpoints.

        When -UseCLI is specified AND 'az' is installed, also queries the
        Container App's provisioning state and replica count via Azure CLI.
    .PARAMETER BaseUrl
        The Container App URL. Default: production taxonomy-editor.
    .PARAMETER ResourceGroup
        Azure resource group name (used with -UseCLI).
    .PARAMETER AppName
        Container App name (used with -UseCLI).
    .PARAMETER UseCLI
        Use Azure CLI for deeper Container App diagnostics.
    .PARAMETER TimeoutSec
        HTTP request timeout in seconds. Default: 10.
    .EXAMPLE
        Test-AzureHealth
    .EXAMPLE
        Test-AzureHealth -UseCLI -ResourceGroup ai-triad -AppName taxonomy-editor
    .LINK
        Show-AITriadHelp
    .LINK
        Get-ContainerAppRevision
    .LINK
        Remove-StaleContainerImages
    .LINK
        Get-AzureFlightRecorder
    .LINK
        Test-TaxEditorInfra
    .LINK
        Deploy-TaxEditorInfra
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$BaseUrl = (Get-TaxEditorBaseUrl),

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [string]$AppName = 'taxonomy-editor',

        [Parameter()]
        [switch]$UseCLI,

        [Parameter()]
        [ValidateRange(1, 120)]
        [int]$TimeoutSec = 10,

        [Parameter()]
        [switch]$CheckConfig,

        [Parameter()]
        [hashtable]$ExpectedEnvVars = @{},

        [Parameter()]
        [string]$ExpectedTrafficRevision = '',

        [Parameter()]
        [ValidateRange(0, 100)]
        [int]$ExpectedTrafficWeight = 100,

        [Parameter()]
        [switch]$CheckFirewall,

        [Parameter()]
        [string]$StorageAccountName = '',

        [Parameter()]
        [string]$KeyVaultName = '',

        [Parameter()]
        [ValidateRange(1, 10)]
        [int]$ConfigRetryCount = 3
    )

    Set-StrictMode -Version Latest
    if ($CheckConfig) { $UseCLI = $true }

    # Get-TaxEditorBaseUrl returns $null in CI environments with no local config.
    # When -UseCLI/-CheckConfig is active, resolve the FQDN from the Container App
    # so the HTTP health checks have a valid target. (t/2403)
    if ([string]::IsNullOrWhiteSpace($BaseUrl) -and $UseCLI) {
        $FqdnOut = & az containerapp show -g $ResourceGroup -n $AppName `
            --query 'properties.configuration.ingress.fqdn' -o tsv 2>$null
        if ($LASTEXITCODE -eq 0 -and $FqdnOut) {
            $BaseUrl = "https://$($FqdnOut.Trim())"
        }
    }
    $BaseUrl = if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl.TrimEnd('/') } else { '' }
    $Checks = [System.Collections.Generic.List[PSObject]]::new()

    # ── Azure Status Page ────────────────────────────────────────────────
    $AzureStatus = Invoke-RemoteCheck -BaseUrl 'https://status.azure.com' -Path '/en-us/status' `
        -TimeoutSec $TimeoutSec -AcceptableStatusCodes @(200, 301, 302, 304)

    $Checks.Add([PSCustomObject]@{
        Check      = 'Azure Status Page'
        Pass       = $AzureStatus.Success
        ResponseMs = $AzureStatus.ResponseMs
        Detail     = if ($AzureStatus.Success) { "Reachable (HTTP $($AzureStatus.StatusCode))" } else { $AzureStatus.Error }
    })

    # ── Container App Liveness ───────────────────────────────────────────
    $AppLiveness = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/healthz' `
        -TimeoutSec $TimeoutSec -ExpectedField 'status'

    $Checks.Add([PSCustomObject]@{
        Check      = 'Container App Liveness'
        Pass       = $AppLiveness.Success -and $AppLiveness.Body.status -eq 'healthy'
        ResponseMs = $AppLiveness.ResponseMs
        Detail     = if ($AppLiveness.Success) { $AppLiveness.Body.status } else { $AppLiveness.Error }
    })

    # ── Container App Readiness ──────────────────────────────────────────
    $AppReady = Invoke-RemoteCheck -BaseUrl $BaseUrl -Path '/health' `
        -TimeoutSec $TimeoutSec -ExpectedField 'status'

    $ReadyDetail = if ($AppReady.Success) {
        $parts = @("status=$($AppReady.Body.status)")
        if ($AppReady.Body.PSObject.Properties['ai'] -and $AppReady.Body.ai.PSObject.Properties['geminiKeyConfigured']) {
            $parts += "geminiKey=$($AppReady.Body.ai.geminiKeyConfigured)"
        }
        $parts -join ' | '
    } else { $AppReady.Error }

    $Checks.Add([PSCustomObject]@{
        Check      = 'Container App Readiness'
        Pass       = $AppReady.Success -and $AppReady.Body.status -eq 'ok'
        ResponseMs = $AppReady.ResponseMs
        Detail     = $ReadyDetail
    })

    # ── TLS Certificate ──────────────────────────────────────────────────
    $TlsPass = $false
    $TlsDetail = 'Skipped'
    try {
        $Uri = [Uri]$BaseUrl
        $TcpClient = [System.Net.Sockets.TcpClient]::new()
        $TcpClient.Connect($Uri.Host, 443)
        $SslStream = [System.Net.Security.SslStream]::new($TcpClient.GetStream(), $false)
        $SslStream.AuthenticateAsClient($Uri.Host)
        $Cert = $SslStream.RemoteCertificate
        if ($Cert) {
            $Expiry = [datetime]$Cert.GetExpirationDateString()
            $DaysLeft = ($Expiry - (Get-Date)).Days
            $TlsPass = $DaysLeft -gt 7
            $TlsDetail = "Expires $($Expiry.ToString('yyyy-MM-dd')) ($DaysLeft days)"
        }
        $SslStream.Dispose()
        $TcpClient.Dispose()
    }
    catch {
        $TlsDetail = $_.Exception.Message
    }

    $Checks.Add([PSCustomObject]@{
        Check      = 'TLS Certificate'
        Pass       = $TlsPass
        ResponseMs = 0
        Detail     = $TlsDetail
    })

    # ── Azure CLI diagnostics (optional) ─────────────────────────────────
    if ($UseCLI) {
        $AzCmd = Get-Command az -ErrorAction SilentlyContinue
        if ($AzCmd) {
            try {
                $AppJson = & az containerapp show -g $ResourceGroup -n $AppName --output json 2>$null
                if ($LASTEXITCODE -eq 0 -and $AppJson) {
                    $App = $AppJson | ConvertFrom-Json
                    $ProvState = $App.properties.provisioningState
                    $RunState = $App.properties.runningStatus
                    $Checks.Add([PSCustomObject]@{
                        Check      = 'ACA Provisioning State'
                        Pass       = $ProvState -eq 'Succeeded'
                        ResponseMs = 0
                        Detail     = "provisioningState=$ProvState"
                    })
                    if ($RunState) {
                        $Checks.Add([PSCustomObject]@{
                            Check      = 'ACA Running Status'
                            Pass       = $RunState -eq 'Running'
                            ResponseMs = 0
                            Detail     = "runningStatus=$RunState"
                        })
                    }

                    # ── Active Revision Health ───────────────────────────
                    try {
                        $RevJson = & az containerapp revision list -g $ResourceGroup -n $AppName --output json 2>$null
                        if ($LASTEXITCODE -eq 0 -and $RevJson) {
                            $Revisions = @($RevJson | ConvertFrom-Json)
                            $ActiveRevs = @($Revisions | Where-Object {
                                $_.PSObject.Properties['properties'] -and
                                $_.properties.PSObject.Properties['active'] -and
                                $_.properties.active -eq $true
                            })
                            foreach ($Rev in $ActiveRevs) {
                                $RevName = if ($Rev.PSObject.Properties['name']) { $Rev.name } else { 'unknown' }
                                $HealthState = 'Unknown'
                                if ($Rev.properties.PSObject.Properties['healthState']) {
                                    $HealthState = $Rev.properties.healthState
                                }
                                $ProvError = $null
                                if ($Rev.properties.PSObject.Properties['provisioningError']) {
                                    $ProvError = $Rev.properties.provisioningError
                                }
                                $RevDetail = "revision=$RevName healthState=$HealthState"
                                if ($ProvError) { $RevDetail += " provisioningError=$ProvError" }
                                $Checks.Add([PSCustomObject]@{
                                    Check      = 'ACA Active Revision Health'
                                    Pass       = $HealthState -eq 'Healthy' -and -not $ProvError
                                    ResponseMs = 0
                                    Detail     = $RevDetail
                                })
                            }
                        }
                    }
                    catch {
                        $Checks.Add([PSCustomObject]@{
                            Check      = 'ACA Active Revision Health'
                            Pass       = $false
                            ResponseMs = 0
                            Detail     = "revision list failed: $($_.Exception.Message)"
                        })
                    }

                    # ── Replica Count ────────────────────────────────────
                    $MinReplicas = 1
                    if ($App.properties.template.PSObject.Properties['scale'] -and
                        $App.properties.template.scale.PSObject.Properties['minReplicas']) {
                        $MinReplicas = [int]$App.properties.template.scale.minReplicas
                    }

                    $ActiveRevision = $null
                    if ($App.properties.PSObject.Properties['latestRevisionName']) {
                        $ActiveRevision = $App.properties.latestRevisionName
                    }

                    if ($ActiveRevision) {
                        try {
                            $ReplicaJson = & az containerapp replica list -g $ResourceGroup -n $AppName --revision $ActiveRevision --output json 2>$null
                            if ($LASTEXITCODE -eq 0 -and $ReplicaJson) {
                                $Replicas = @($ReplicaJson | ConvertFrom-Json)
                                $RunningCount = @($Replicas | Where-Object {
                                    $_.PSObject.Properties['properties'] -and
                                    $_.properties.PSObject.Properties['runningState'] -and
                                    $_.properties.runningState -eq 'Running'
                                }).Count
                                $ReplicaPass = $RunningCount -ge $MinReplicas
                                $Checks.Add([PSCustomObject]@{
                                    Check      = 'ACA Replica Count'
                                    Pass       = $ReplicaPass
                                    ResponseMs = 0
                                    Detail     = "running=$RunningCount/minReplicas=$MinReplicas"
                                })

                                # ── Container Pull Status ────────────────
                                $BadContainers = [System.Collections.Generic.List[string]]::new()
                                foreach ($Replica in $Replicas) {
                                    $ReplicaName = if ($Replica.PSObject.Properties['name']) { $Replica.name } else { 'unknown' }
                                    $Containers = @()
                                    if ($Replica.PSObject.Properties['properties'] -and
                                        $Replica.properties.PSObject.Properties['containers']) {
                                        $Containers = @($Replica.properties.containers)
                                    }
                                    foreach ($Container in $Containers) {
                                        $State = 'Unknown'
                                        if ($Container.PSObject.Properties['runningState']) {
                                            $State = $Container.runningState
                                        }
                                        if ($State -ne 'Running') {
                                            $CName = if ($Container.PSObject.Properties['name']) { $Container.name } else { 'unnamed' }
                                            $BadContainers.Add("$ReplicaName/$CName=$State")
                                        }
                                    }
                                }
                                $ContainerPass = $BadContainers.Count -eq 0
                                $ContainerDetail = if ($ContainerPass) { "All containers Running ($($Replicas.Count) replicas)" }
                                                   else { $BadContainers -join ', ' }
                                $Checks.Add([PSCustomObject]@{
                                    Check      = 'ACA Container Pull Status'
                                    Pass       = $ContainerPass
                                    ResponseMs = 0
                                    Detail     = $ContainerDetail
                                })
                            }
                        }
                        catch {
                            $Checks.Add([PSCustomObject]@{
                                Check      = 'ACA Replica Count'
                                Pass       = $false
                                ResponseMs = 0
                                Detail     = "replica list failed: $($_.Exception.Message)"
                            })
                        }
                    }
                }
                else {
                    $Checks.Add([PSCustomObject]@{
                        Check      = 'ACA CLI Query'
                        Pass       = $false
                        ResponseMs = 0
                        Detail     = 'az containerapp show failed — verify login and resource group'
                    })
                }
            }
            catch {
                $Checks.Add([PSCustomObject]@{
                    Check      = 'ACA CLI Query'
                    Pass       = $false
                    ResponseMs = 0
                    Detail     = $_.Exception.Message
                })
            }
        }
        else {
            $Checks.Add([PSCustomObject]@{
                Check      = 'ACA CLI Query'
                Pass       = $false
                ResponseMs = 0
                Detail     = 'Azure CLI (az) not found — install from https://aka.ms/installazurecli'
            })
        }
    }

    # ── Config verification (-CheckConfig) ──────────────────────────────
    # Coverage limit: secretRef vars and dynamic ACA-domain vars
    # (ALLOWED_ORIGINS, APPLICATIONINSIGHTS_*) not verified — require
    # Bicep outputs or runtime reads (v2 path).
    if ($CheckConfig) {
        $AzCmd2 = Get-Command az -ErrorAction SilentlyContinue
        if (-not $AzCmd2) {
            $Checks.Add([PSCustomObject]@{
                Check = 'Config:CLI'; Pass = $false; ResponseMs = 0
                Detail = 'Azure CLI (az) not found — required for -CheckConfig'
            })
        }
        else {
            # ── Firewall validation ──────────────────────────────────────
            if ($CheckFirewall) {
                if ([string]::IsNullOrWhiteSpace($StorageAccountName) -or
                    [string]::IsNullOrWhiteSpace($KeyVaultName)) {
                    throw (New-ActionableError -AsErrorRecord `
                        -Goal      'Verify Storage + Key Vault firewall defaultAction' `
                        -Problem   '-CheckFirewall specified but StorageAccountName or KeyVaultName is empty' `
                        -Location  'Test-AzureHealth -CheckFirewall' `
                        -NextSteps 'Pass -StorageAccountName and -KeyVaultName when using -CheckFirewall')
                }
                # t/2431: az CLI returns storage network rules under `networkRuleSet`, not `networkAcls`.
                $StActionRaw = (& az storage account show -n $StorageAccountName -g $ResourceGroup `
                    --query 'networkRuleSet.defaultAction' -o tsv 2>$null)
                $StAction = if (-not [string]::IsNullOrWhiteSpace($StActionRaw)) { $StActionRaw.Trim() } else { '' }
                $StPass = ($LASTEXITCODE -eq 0) -and ($StAction -eq 'Allow')
                $Checks.Add([PSCustomObject]@{
                    Check = 'Config:Firewall:Storage'; Pass = $StPass; ResponseMs = 0
                    Detail = if ($StPass) { 'networkRuleSet.defaultAction=Allow' }
                             else { "networkRuleSet.defaultAction=$StAction (expected Allow — consumption-tier ACA SNAT trap)" }
                })
                # t/2431: Key Vault networkAcls is null when no network restrictions are configured;
                # publicNetworkAccess=Enabled is the controlling flag that permits ACA managed-identity calls.
                $KvPubAccessRaw = (& az keyvault show -n $KeyVaultName -g $ResourceGroup `
                    --query 'properties.publicNetworkAccess' -o tsv 2>$null)
                $KvPubAccess = if (-not [string]::IsNullOrWhiteSpace($KvPubAccessRaw)) { $KvPubAccessRaw.Trim() } else { '' }
                $KvPass = ($LASTEXITCODE -eq 0) -and ($KvPubAccess -eq 'Enabled')
                $Checks.Add([PSCustomObject]@{
                    Check = 'Config:Firewall:KeyVault'; Pass = $KvPass; ResponseMs = 0
                    Detail = if ($KvPass) { 'publicNetworkAccess=Enabled' }
                             else { "publicNetworkAccess=$KvPubAccess (expected Enabled — required for ACA managed-identity calls)" }
                })
            }
            # ── Traffic weight ───────────────────────────────────────────
            if (-not [string]::IsNullOrWhiteSpace($ExpectedTrafficRevision)) {
                $TrafficJson = & az containerapp ingress traffic show `
                    -g $ResourceGroup -n $AppName --output json 2>$null
                if ($LASTEXITCODE -eq 0 -and $TrafficJson) {
                    $Traffic = @($TrafficJson | ConvertFrom-Json)
                    $RevEntry = @($Traffic | Where-Object {
                        $_.PSObject.Properties['revisionName'] -and
                        $_.revisionName -eq $ExpectedTrafficRevision
                    })
                    if ($RevEntry.Count -eq 0) {
                        $Checks.Add([PSCustomObject]@{
                            Check = 'Config:Traffic'; Pass = $false; ResponseMs = 0
                            Detail = "revision '$ExpectedTrafficRevision' not found in traffic rules — possible auto-promotion"
                        })
                    }
                    elseif ([int]$RevEntry[0].weight -ne $ExpectedTrafficWeight) {
                        $Checks.Add([PSCustomObject]@{
                            Check = 'Config:Traffic'; Pass = $false; ResponseMs = 0
                            Detail = "weight=$($RevEntry[0].weight) expected=$ExpectedTrafficWeight for '$ExpectedTrafficRevision'"
                        })
                    }
                    else {
                        $Checks.Add([PSCustomObject]@{
                            Check = 'Config:Traffic'; Pass = $true; ResponseMs = 0
                            Detail = "'$ExpectedTrafficRevision' at $($RevEntry[0].weight)%"
                        })
                    }
                }
                else {
                    $Checks.Add([PSCustomObject]@{
                        Check = 'Config:Traffic'; Pass = $false; ResponseMs = 0
                        Detail = 'az containerapp ingress traffic show failed'
                    })
                }
            }
            # ── Env var check (retry for ACA eventual consistency) ───────
            if ($ExpectedEnvVars.Count -gt 0) {
                $EnvResults = @{}
                $EnvAllPass = $false
                for ($Attempt = 1; $Attempt -le $ConfigRetryCount; $Attempt++) {
                    $AppJson2 = & az containerapp show -g $ResourceGroup -n $AppName --output json 2>$null
                    if ($LASTEXITCODE -ne 0 -or -not $AppJson2) {
                        foreach ($Key in $ExpectedEnvVars.Keys) {
                            $EnvResults[$Key] = @{ Pass = $false; Detail = 'az containerapp show failed' }
                        }
                        break
                    }
                    $App2 = $AppJson2 | ConvertFrom-Json
                    $LiveEnv = @{}
                    $Containers2 = @($App2.properties.template.containers)
                    if ($Containers2.Count -gt 0 -and $Containers2[0].PSObject.Properties['env']) {
                        foreach ($E in @($Containers2[0].env)) {
                            if ($E.PSObject.Properties['name'] -and $E.PSObject.Properties['value']) {
                                $LiveEnv[$E.name] = $E.value
                            }
                        }
                    }
                    $RoundPass = $true
                    $RoundResults = @{}
                    foreach ($Kv in $ExpectedEnvVars.GetEnumerator()) {
                        $ExpectedVal = $Kv.Value
                        $LiveVal = if ($LiveEnv.ContainsKey($Kv.Key)) { $LiveEnv[$Kv.Key] } else { $null }
                        $Pass = if ($ExpectedVal -eq '') { ($null -eq $LiveVal -or $LiveVal -eq '') }
                                 else { $LiveVal -eq $ExpectedVal }
                        $Detail = if ($Pass) { 'ok' }
                                  elseif ($null -eq $LiveVal) { "MISSING (expected '$ExpectedVal')" }
                                  else { "MISMATCH: live='$LiveVal' expected='$ExpectedVal'" }
                        $RoundResults[$Kv.Key] = @{ Pass = $Pass; Detail = $Detail }
                        if (-not $Pass) { $RoundPass = $false }
                    }
                    $EnvResults = $RoundResults
                    $EnvAllPass = $RoundPass
                    if ($EnvAllPass -or $Attempt -eq $ConfigRetryCount) { break }
                    Write-Verbose "Env var check attempt $Attempt/$ConfigRetryCount not clean — retrying in 5s (ACA eventual consistency)"
                    Start-Sleep -Seconds 5
                }
                foreach ($Key in $EnvResults.Keys) {
                    $Checks.Add([PSCustomObject]@{
                        Check = "Config:EnvVar:$Key"; Pass = $EnvResults[$Key].Pass
                        ResponseMs = 0; Detail = $EnvResults[$Key].Detail
                    })
                }
            }
        }
    }

    # ── Summary ──────────────────────────────────────────────────────────
    $AllPass = @($Checks | Where-Object { -not $_.Pass }).Count -eq 0

    [PSCustomObject]@{
        Platform  = 'Azure'
        Healthy   = $AllPass
        Checks    = @($Checks)
        Timestamp = (Get-Date).ToString('o')
    }
}
