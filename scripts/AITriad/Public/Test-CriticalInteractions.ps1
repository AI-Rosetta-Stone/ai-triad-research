# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-CriticalInteractions {
    <#
    .SYNOPSIS
        Orchestrates running API and/or UX CUI tests and produces a unified report.
    .EXAMPLE
        Test-CriticalInteractions -BaseUrl 'https://taxonomy-editor.example.com' -Level API
    .EXAMPLE
        Test-CriticalInteractions -Level API -Priority P0 -Detailed
    .EXAMPLE
        Test-CriticalInteractions -CuiId 'CUI-TAX-001' -Level API
    .LINK
        Show-AITriadHelp
    .LINK
        Show-DebateDiagnostics
    .LINK
        Show-DebateHarvest
    .LINK
        Convert-DebateToAudio
    .LINK
        Get-AITClaim
    .LINK
        Get-CriticalInteraction
    .LINK
        Get-TopicFrequency
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [string]$BaseUrl = 'http://localhost:3000',

        [Parameter()]
        [ValidateSet('API', 'UX', 'Both')]
        [string]$Level = 'API',

        [Parameter()]
        [ValidateSet('Taxonomy', 'Debate', 'AI', 'Auth', 'Admin', 'Community', 'Data', 'Calibration')]
        [string]$Domain,

        [Parameter()]
        [ValidateSet('P0', 'P1', 'P2')]
        [string]$Priority,

        [Parameter()]
        [string]$CuiId,

        [Parameter()]
        [switch]$Detailed,

        [Parameter()]
        [hashtable]$AuthHeaders = @{},

        [Parameter()]
        [int]$CdpPort = 9222,

        [Parameter()]
        [string]$ScreenshotDir
    )

    Set-StrictMode -Version Latest
    $OverallSw = [System.Diagnostics.Stopwatch]::StartNew()

    $FilterParams = @{}
    if ($Domain) { $FilterParams['Domain'] = $Domain }
    if ($Priority) { $FilterParams['Priority'] = $Priority }
    if ($Level -ne 'Both') { $FilterParams['Level'] = $Level }

    $Interactions = Get-CriticalInteraction @FilterParams

    if ($CuiId) {
        $Interactions = @($Interactions | Where-Object { $_.Id -eq $CuiId })
        if (@($Interactions).Count -eq 0) {
            $Err = New-ActionableError -Goal "Run CUI test $CuiId" `
                -Problem "CUI ID '$CuiId' not found in catalog (or excluded by filters)" `
                -Location 'Test-CriticalInteractions' `
                -NextSteps @('Check the CUI ID with Get-CriticalInteraction', 'Remove conflicting -Domain or -Priority filters') `
                -AsErrorRecord   # without a mode switch New-ActionableError returns nothing and this threw $null (t/4155)
            throw $Err
        }
    }

    $Results = [System.Collections.Generic.List[PSObject]]::new()

    $RunLevels = switch ($Level) {
        'API'  { @('API') }
        'UX'   { @('UX') }
        'Both' { @('API', 'UX') }
    }

    if ($ScreenshotDir -and -not (Test-Path $ScreenshotDir)) {
        New-Item -ItemType Directory -Path $ScreenshotDir -Force | Out-Null
    }

    foreach ($Cui in $Interactions) {
        foreach ($RunLevel in $RunLevels) {
            $FnName = Convert-CuiIdToFunctionName -CuiId $Cui.Id -Level $RunLevel
            if (-not $FnName) { continue }

            $Cmd = Get-Command $FnName -ErrorAction SilentlyContinue
            if (-not $Cmd) {
                if ($RunLevel -eq $Level -or $Level -eq 'Both') {
                    $Results.Add([PSCustomObject]@{
                        PSTypeName = 'CuiTestResult'
                        CuiId      = $Cui.Id
                        Domain     = $Cui.Domain
                        Priority   = $Cui.Priority
                        Pass       = $false
                        DurationMs = 0
                        Checks     = 0
                        Passed     = 0
                        Failed     = 0
                        Details    = @()
                        Error      = "Test function $FnName not implemented"
                    })
                }
                continue
            }

            $TestParams = @{ BaseUrl = $BaseUrl }
            if ($Cmd.Parameters.ContainsKey('AuthHeaders')) {
                $TestParams['AuthHeaders'] = $AuthHeaders
            }
            if ($Cmd.Parameters.ContainsKey('CdpPort')) {
                $TestParams['CdpPort'] = $CdpPort
            }
            if ($Cmd.Parameters.ContainsKey('ScreenshotDir') -and $ScreenshotDir) {
                $TestParams['ScreenshotDir'] = $ScreenshotDir
            }

            try {
                $Result = & $FnName @TestParams
                $Results.Add($Result)
            } catch {
                $Results.Add([PSCustomObject]@{
                    PSTypeName = 'CuiTestResult'
                    CuiId      = $Cui.Id
                    Domain     = $Cui.Domain
                    Priority   = $Cui.Priority
                    Pass       = $false
                    DurationMs = 0
                    Checks     = 0
                    Passed     = 0
                    Failed     = 0
                    Details    = @()
                    Error      = $_.Exception.Message
                })
            }
        }
    }

    $OverallSw.Stop()

    if ($Detailed) {
        $Results
    } else {
        $P0Api = @($Results | Where-Object { $_.Priority -eq 'P0' })
        $P1Api = @($Results | Where-Object { $_.Priority -eq 'P1' })
        $P2Api = @($Results | Where-Object { $_.Priority -eq 'P2' })

        $P0Pass = @($P0Api | Where-Object { $_.Pass }).Count
        $P1Pass = @($P1Api | Where-Object { $_.Pass }).Count
        $P2Pass = @($P2Api | Where-Object { $_.Pass }).Count
        $TotalPass = @($Results | Where-Object { $_.Pass }).Count
        $TotalCount = @($Results).Count

        Write-Host ''
        Write-Host "CUI Test Results - $BaseUrl" -ForegroundColor Cyan
        if (@($P0Api).Count -gt 0) {
            $Color = if ($P0Pass -eq @($P0Api).Count) { 'Green' } else { 'Red' }
            Write-Host "  P0: $P0Pass/$(@($P0Api).Count) passed" -ForegroundColor $Color
        }
        if (@($P1Api).Count -gt 0) {
            $Color = if ($P1Pass -eq @($P1Api).Count) { 'Green' } else { 'Yellow' }
            Write-Host "  P1: $P1Pass/$(@($P1Api).Count) passed" -ForegroundColor $Color
        }
        if (@($P2Api).Count -gt 0) {
            $Color = if ($P2Pass -eq @($P2Api).Count) { 'Green' } else { 'Yellow' }
            Write-Host "  P2: $P2Pass/$(@($P2Api).Count) passed" -ForegroundColor $Color
        }

        $OverallColor = if ($TotalPass -eq $TotalCount) { 'Green' } else { 'Red' }
        Write-Host "  Overall: $TotalPass/$TotalCount passed" -ForegroundColor $OverallColor
        Write-Host "  Duration: $($OverallSw.ElapsedMilliseconds)ms" -ForegroundColor DarkGray
        Write-Host ''

        $Results
    }
}

function Convert-CuiIdToFunctionName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$CuiId,
        [Parameter()][string]$Level = 'API'
    )

    if ($CuiId -notmatch '^CUI-([A-Z]+)-(\d{3})$') { return $null }
    $DomainCode = $Matches[1].Substring(0,1).ToUpper() + $Matches[1].Substring(1).ToLower()
    $Number = $Matches[2]
    $Suffix = if ($Level -eq 'UX') { 'Ux' } else { '' }

    "Test-Cui${DomainCode}${Number}${Suffix}"
}
