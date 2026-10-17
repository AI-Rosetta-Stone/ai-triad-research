# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-AzureFlightRecorder {
    <#
    .SYNOPSIS
        Retrieves flight recorder dumps from the Azure-hosted Taxonomy Editor.

    .DESCRIPTION
        Reads flight recorder dumps from the GitHub data repo (works even when the
        app is not running). Uses 'gh api' for authentication.

        Use -TriggerDump to create a fresh dump on the running server (requires
        session cookie for Azure Easy Auth).

    .PARAMETER List
        List available dump files without downloading.

    .PARAMETER Last
        Download the N most recent dump files. Default: 1.

    .PARAMETER TriggerDump
        Trigger a fresh server-side flight recorder dump, then download it.
        Requires the app to be running and a valid session cookie.

    .PARAMETER Filename
        Download a specific dump file by name.

    .PARAMETER Merged
        Download the client + server pair for a given DumpId and produce a
        single merged JSONL timeline via Merge-FlightRecorderDumps. Works
        against GitHub — no session cookie or running app required.

    .PARAMETER DumpId
        Correlation ID for -Merged. Resolves the client/server pair on
        GitHub (paired naming: client-{DumpId}.jsonl + server-{DumpId}.jsonl,
        or legacy: flight-recorder-{DumpId}.jsonl + server-flight-recorder-{DumpId}.jsonl).
        Single-side dumps merge gracefully with a warning.

    .PARAMETER OutputPath
        Directory to save downloaded files. Default: current directory.

    .PARAMETER Open
        Open downloaded dumps in the flight recorder viewer after saving.

    .PARAMETER DataRepo
        GitHub data repo in owner/repo format.

    .PARAMETER SessionCookie
        AppServiceAuthSession cookie value for -TriggerDump. Falls back to
        $env:TAXONOMY_SESSION_COOKIE.

    .PARAMETER BaseUrl
        Base URL of the Taxonomy Editor instance (for -TriggerDump).

    .EXAMPLE
        Get-AzureFlightRecorder -List

    .EXAMPLE
        Get-AzureFlightRecorder -Last 3

    .EXAMPLE
        Get-AzureFlightRecorder -TriggerDump

    .EXAMPLE
        Get-AzureFlightRecorder -Filename 'server-flight-recorder-2026-06-12T10-30-00.000Z.jsonl'

    .EXAMPLE
        # Download and merge a paired client + server dump by correlation ID (t/1377)
        Get-AzureFlightRecorder -Merged -DumpId 'a1b2c3d4' -Open

    .EXAMPLE
        # Chain: get latest available dumpId from -List, then merge it
        $latest = (Get-AzureFlightRecorder -List | Where-Object Name -Match '^client-(.+)\.jsonl$' | Select-Object -First 1).Name -replace '^client-','' -replace '\.jsonl$',''
        Get-AzureFlightRecorder -Merged -DumpId $latest
    .LINK
        Show-AITriadHelp
    .LINK
        Test-AzureHealth
    .LINK
        Get-ContainerAppRevision
    .LINK
        Remove-StaleContainerImages
    .LINK
        Test-TaxEditorInfra
    .LINK
        Deploy-TaxEditorInfra
    .LINK
        Get-FlightRecorderDump
    #>
    [CmdletBinding(DefaultParameterSetName = 'List')]
    param(
        [Parameter(ParameterSetName = 'List')]
        [switch]$List,

        [Parameter(ParameterSetName = 'Download')]
        [int]$Last = 1,

        [Parameter(ParameterSetName = 'Trigger')]
        [switch]$TriggerDump,

        [Parameter(ParameterSetName = 'ByName', Mandatory)]
        [string]$Filename,

        [Parameter(ParameterSetName = 'Merged', Mandatory)]
        [switch]$Merged,

        [Parameter(ParameterSetName = 'Merged', Mandatory)]
        [string]$DumpId,

        [Parameter()]
        [string]$OutputPath = '.',

        [Parameter()]
        [switch]$Open,

        [Parameter()]
        [string]$DataRepo = 'AI-Rosetta-Stone/ai-triad-data',

        [Parameter()]
        [string]$SessionCookie,

        [Parameter()]
        [string]$BaseUrl = (Get-TaxEditorBaseUrl)
    )

    $BaseUrl = $BaseUrl.TrimEnd('/')

    # ── Verify gh CLI is available ──
    function Assert-GhCli {
        if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Read flight recorder dumps from GitHub' `
                -Problem 'The GitHub CLI (gh) is not installed or not in PATH' `
                -Location 'Get-AzureFlightRecorder' `
                -NextSteps @(
                    'Install: winget install GitHub.cli',
                    'Then authenticate: gh auth login'
                ))
        }
    }

    # ── List files from GitHub ──
    function Get-GitHubDumpList {
        Assert-GhCli
        Write-Host "Fetching flight recorder dumps from $DataRepo ..." -ForegroundColor Cyan
        $raw = gh api "repos/$DataRepo/contents/flight-recorder" 2>&1
        if ($LASTEXITCODE -ne 0) {
            if ("$raw" -match '404|Not Found') {
                Write-Warning "No flight-recorder directory in $DataRepo yet."
                Write-Warning 'Dumps appear after the server persists them (requires latest container image).'
                return @()
            }
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'List flight recorder dumps from GitHub' `
                -Problem "gh api failed: $raw" `
                -Location 'Get-AzureFlightRecorder:Get-GitHubDumpList' `
                -NextSteps @(
                    'Check gh auth status: gh auth status',
                    "Verify repo access: gh api repos/$DataRepo"
                ))
        }
        $items = $raw | ConvertFrom-Json
        @($items) |
            Where-Object { $_.name -match '^(server-)?flight-recorder-.+\.jsonl$' } |
            Sort-Object { $_.name } -Descending
    }

    # ── Download a file from GitHub ──
    function Save-GitHubDumpFile {
        param([string]$Name, [int]$Size = 0)
        Assert-GhCli

        $outDir = Resolve-Path $OutputPath -ErrorAction SilentlyContinue
        if (-not $outDir) {
            New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
            $outDir = Resolve-Path $OutputPath
        }
        $outFile = Join-Path $outDir $Name

        Write-Host "  Downloading $Name ..." -ForegroundColor Cyan
        gh api "repos/$DataRepo/contents/flight-recorder/$Name" -H 'Accept: application/vnd.github.raw' > $outFile 2>&1
        if ($LASTEXITCODE -ne 0) {
            $errContent = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
            Remove-Item $outFile -ErrorAction SilentlyContinue
            throw (New-ActionableError -AsErrorRecord `
                -Goal "Download flight recorder dump $Name" `
                -Problem "gh api download failed: $errContent" `
                -Location 'Get-AzureFlightRecorder:Save-GitHubDumpFile' `
                -NextSteps @('Check gh auth status', 'Verify the file exists in the repo'))
        }
        $fileInfo = Get-Item $outFile
        $fileInfo | Add-Member -NotePropertyName Source -NotePropertyValue 'GitHub' -Force

        # Parse header for summary
        $lines = Get-Content $outFile -TotalCount 5
        $events = 0; $trigger = $null; $version = $null; $debateId = $null
        foreach ($line in $lines) {
            try {
                $obj = $line | ConvertFrom-Json
                if ($obj._type -eq 'header') {
                    $events = $obj.ring_buffer_events_retained
                    $version = $obj.app_version
                    $debateId = $obj.active_debate_id
                }
                if ($obj._type -eq 'trigger') { $trigger = $obj.trigger_type }
            } catch { }
        }
        $fileInfo | Add-Member -NotePropertyName Events -NotePropertyValue $events -Force
        $fileInfo | Add-Member -NotePropertyName Trigger -NotePropertyValue $trigger -Force
        $fileInfo | Add-Member -NotePropertyName AppVersion -NotePropertyValue $version -Force
        $fileInfo | Add-Member -NotePropertyName DebateId -NotePropertyValue $debateId -Force

        Write-Host "  Saved: $outFile ($([math]::Round($fileInfo.Length / 1024, 1)) KB, $events events)" -ForegroundColor Green
        return $fileInfo
    }

    # ── REST API helper (for TriggerDump only) ──
    function Invoke-FRApi {
        param([string]$Method, [string]$Endpoint, [switch]$Raw)
        $cookie = if ($SessionCookie) { $SessionCookie } else { $env:TAXONOMY_SESSION_COOKIE }
        if (-not $cookie) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Authenticate with Azure Taxonomy Editor' `
                -Problem 'No session cookie provided. -TriggerDump requires Azure Easy Auth.' `
                -Location 'Get-AzureFlightRecorder' `
                -NextSteps @(
                    "Log in at $BaseUrl in your browser",
                    'Open DevTools (F12) > Application > Cookies',
                    "Copy the 'AppServiceAuthSession' cookie value",
                    '$env:TAXONOMY_SESSION_COOKIE = ''<paste cookie value here>'''
                ))
        }
        $url = "$BaseUrl$Endpoint"
        try {
            $headers = @{ Cookie = "AppServiceAuthSession=$cookie" }
            $params = @{
                Uri             = $url
                Method          = $Method
                Headers         = $headers
                UseBasicParsing = $true
                TimeoutSec      = 30
            }
            if ($Method -eq 'POST') {
                $params.ContentType = 'application/json'
                $params.Body = '{}'
            }
            $response = Invoke-WebRequest @params
            if ($Raw) { return $response }
            $ct = $response.Headers['Content-Type']
            if ($ct -and $ct -notmatch 'application/json') {
                if ($response.Content -match '<title>Sign In') {
                    throw (New-ActionableError -AsErrorRecord `
                        -Goal 'Authenticate with Azure Taxonomy Editor' `
                        -Problem 'Session cookie is expired or invalid' `
                        -Location 'Get-AzureFlightRecorder:Invoke-FRApi' `
                        -NextSteps @(
                            "Log in at $BaseUrl in your browser",
                            "Copy a fresh 'AppServiceAuthSession' cookie",
                            '$env:TAXONOMY_SESSION_COOKIE = ''<paste new value>'''
                        ))
                }
                throw "Unexpected response Content-Type: $ct"
            }
            return $response.Content | ConvertFrom-Json
        } catch [Microsoft.PowerShell.Commands.HttpResponseException] {
            $status = [int]$_.Exception.Response.StatusCode
            throw (New-ActionableError -AsErrorRecord `
                -Goal "Call flight recorder API" `
                -Problem "HTTP $status from $Method $url" `
                -Location 'Get-AzureFlightRecorder:Invoke-FRApi' `
                -NextSteps @(
                    "Verify the app is running: open $BaseUrl in a browser",
                    'If 401/403: refresh session cookie',
                    'If 404: deploy the latest container image'
                ))
        }
    }

    # ── TriggerDump (REST API — requires running app) ──
    if ($PSCmdlet.ParameterSetName -eq 'Trigger' -or $TriggerDump) {
        Write-Host 'Triggering server-side flight recorder dump...' -ForegroundColor Cyan
        $result = Invoke-FRApi -Method POST -Endpoint '/api/flight-recorder/server-dump'
        $fname = if ($result.PSObject.Properties['filename']) { $result.filename } else { $null }
        if (-not $fname) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Trigger server flight recorder dump' `
                -Problem 'Server returned OK but no filename in response' `
                -Location 'Get-AzureFlightRecorder' `
                -NextSteps @(
                    "Check server logs: az containerapp logs show -n taxonomy-editor -g rg-aitriad --tail 50",
                    'The server recorder may be uninitialized'
                ))
        }
        Write-Host "  Server dump created: $fname" -ForegroundColor Green
        Write-Host '  Waiting for GitHub persistence ...' -ForegroundColor DarkGray
        Start-Sleep -Seconds 5
        $saved = Save-GitHubDumpFile -Name $fname
        if ($Open) { $saved | Show-FlightRecorder }
        return $saved
    }

    # ── GitHub-based operations (work when app is down) ──
    $ghFiles = Get-GitHubDumpList
    if (-not $ghFiles -or @($ghFiles).Count -eq 0) {
        Write-Warning 'No flight recorder dumps found.'
        Write-Warning 'Trigger a dump with: Get-AzureFlightRecorder -TriggerDump'
        return
    }

    # ── Merged (t/1377): download the client/server pair for a DumpId, merge locally ──
    if ($PSCmdlet.ParameterSetName -eq 'Merged') {
        $pair = Find-GitHubDumpPair -DumpId $DumpId -Files $ghFiles
        $hasClient = $null -ne $pair.Client
        $hasServer = $null -ne $pair.Server

        if (-not $hasClient -and -not $hasServer) {
            Write-Warning "No dump files matching DumpId '$DumpId' in $DataRepo (checked paired + legacy schemes)."
            Write-Warning 'Use: Get-AzureFlightRecorder -List   to see available filenames.'
            return
        }
        if (-not $hasClient) {
            Write-Warning "No client-side dump for DumpId '$DumpId' — merging server-only."
        }
        if (-not $hasServer) {
            Write-Warning "No server-side dump for DumpId '$DumpId' — merging client-only."
        }
        Write-Host "Pair discovered (scheme=$($pair.Scheme)): client=$(if ($hasClient){$pair.Client.name}else{'(missing)'}) server=$(if ($hasServer){$pair.Server.name}else{'(missing)'})" -ForegroundColor Cyan

        # Download available sides
        $clientLocal = $null
        $serverLocal = $null
        if ($hasClient) { $clientLocal = Save-GitHubDumpFile -Name $pair.Client.name -Size $pair.Client.size }
        if ($hasServer) { $serverLocal = Save-GitHubDumpFile -Name $pair.Server.name -Size $pair.Server.size }

        # Merge — Merge-FlightRecorderDumps handles single-side gracefully
        $mergedName = "merged-$DumpId.jsonl"
        $outDir = Resolve-Path $OutputPath -ErrorAction SilentlyContinue
        if (-not $outDir) { $outDir = (New-Item -ItemType Directory -Path $OutputPath -Force).FullName } else { $outDir = $outDir.Path }
        $mergedPath = Join-Path $outDir $mergedName

        $mergeParams = @{ OutputPath = $mergedPath; PassThru = $true }
        if ($clientLocal) { $mergeParams.ClientPath = $clientLocal.FullName }
        if ($serverLocal) { $mergeParams.ServerPath = $serverLocal.FullName }
        $mergedInfo = Merge-FlightRecorderDumps @mergeParams

        # Tag the result so pipeline consumers can distinguish merged output from single-file downloads
        if ($mergedInfo) {
            $mergedInfo | Add-Member -NotePropertyName Source -NotePropertyValue 'GitHub+Merged' -Force
            $mergedInfo | Add-Member -NotePropertyName DumpId -NotePropertyValue $DumpId -Force
            $mergedInfo | Add-Member -NotePropertyName Scheme -NotePropertyValue $pair.Scheme -Force
        }
        if ($Open -and $mergedInfo) { $mergedInfo | Show-FlightRecorder }
        return $mergedInfo
    }

    # ── ByName ──
    if ($PSCmdlet.ParameterSetName -eq 'ByName') {
        $match = @($ghFiles) | Where-Object { $_.name -eq $Filename }
        if (-not $match) {
            Write-Warning "File '$Filename' not found. Available dumps:"
            @($ghFiles) | ForEach-Object { Write-Warning "  $($_.name)" }
            return
        }
        $saved = Save-GitHubDumpFile -Name $Filename -Size $match.size
        if ($Open) { $saved | Show-FlightRecorder }
        return $saved
    }

    # ── List ──
    if ($PSCmdlet.ParameterSetName -eq 'List') {
        Write-Host "  $(@($ghFiles).Count) dump file(s) available:" -ForegroundColor Green
        @($ghFiles) | ForEach-Object {
            [PSCustomObject]@{
                Name     = $_.name
                Size     = "$([math]::Round($_.size / 1024, 1)) KB"
                Type     = if ($_.name -match '^server-') { 'server' } else { 'client' }
            }
        } | Format-Table -AutoSize
        return
    }

    # ── Download (most recent N) ──
    $toDownload = @($ghFiles) | Select-Object -First $Last
    Write-Host "  Downloading $(@($toDownload).Count) of $(@($ghFiles).Count) dump(s)..." -ForegroundColor Cyan
    $downloaded = @()
    foreach ($f in $toDownload) {
        $downloaded += Save-GitHubDumpFile -Name $f.name -Size $f.size
    }
    if ($Open -and $downloaded.Count -gt 0) {
        $downloaded | ForEach-Object { $_ | Show-FlightRecorder }
    }
    return $downloaded
}
