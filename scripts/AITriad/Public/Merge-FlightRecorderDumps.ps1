# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Merge-FlightRecorderDumps {
    <#
    .SYNOPSIS
        Merges paired client + server flight recorder dumps into a single
        interleaved JSONL timeline.

    .DESCRIPTION
        Takes a dumpId (or explicit file paths) and merges the client and
        server JSONL dumps into one file sorted by wall-clock timestamp.
        Each event gets an _source field ('client' or 'server') for visual
        distinction. Context records from both files are merged into a
        combined snapshot.

        Handles single-file scenarios gracefully — if only the client or
        server dump exists, outputs what's available without error.

    .PARAMETER DumpId
        The paired dump correlation ID. Resolves to client-{DumpId}.jsonl
        and server-{DumpId}.jsonl in the dump directory.

    .PARAMETER ClientPath
        Explicit path to a client dump file. Use with -ServerPath for
        arbitrary file pairs, or alone for a single file.

    .PARAMETER ServerPath
        Explicit path to a server dump file. Use with -ClientPath for
        arbitrary file pairs, or alone for a single file.

    .PARAMETER DumpDir
        Directory containing paired dumps. Default: auto-detected from
        Electron userData path under admin/flight-recorder-dumps/.

    .PARAMETER OutputPath
        Path to write the merged JSONL file. If omitted, writes to
        merged-{DumpId}.jsonl in the dump directory (or current dir
        for explicit paths).

    .PARAMETER PassThru
        Return the output file info object instead of just writing.

    .EXAMPLE
        # Merge by dumpId
        Merge-FlightRecorderDumps -DumpId 'a1b2c3d4'

    .EXAMPLE
        # Merge explicit files
        Merge-FlightRecorderDumps -ClientPath ./client-dump.jsonl -ServerPath ./server-dump.jsonl

    .EXAMPLE
        # Single file — just adds _source tagging
        Merge-FlightRecorderDumps -ClientPath ./flight-recorder-2026-06-24.jsonl

    .EXAMPLE
        # Merge and pipe to report
        Merge-FlightRecorderDumps -DumpId 'a1b2c3d4' -PassThru | Get-FlightRecorderReport
    .LINK
        Show-AITriadHelp
    .LINK
        Get-AzureFlightRecorder
    .LINK
        Get-FlightRecorderDump
    .LINK
        Get-FlightRecorderReport
    .LINK
        Request-FlightRecorderDump
    .LINK
        Show-FlightRecorder
    #>
    [CmdletBinding(DefaultParameterSetName = 'ByDumpId')]
    param(
        [Parameter(Mandatory, ParameterSetName = 'ByDumpId', Position = 0)]
        [string]$DumpId,

        [Parameter(ParameterSetName = 'ByPath')]
        [string]$ClientPath,

        [Parameter(ParameterSetName = 'ByPath')]
        [string]$ServerPath,

        [Parameter(ParameterSetName = 'ByDumpId')]
        [string]$DumpDir,

        [Parameter()]
        [string]$OutputPath,

        [Parameter()]
        [switch]$PassThru
    )

    # ── Resolve file paths ───────────────────────────────────────────────
    if ($PSCmdlet.ParameterSetName -eq 'ByDumpId') {
        if (-not $DumpDir) {
            $DumpDir = Get-FlightRecorderDir   # shared resolver (t/1712)
            $pairedDir = Join-Path (Split-Path $DumpDir) 'admin/flight-recorder-dumps'
            if (Test-Path $pairedDir) { $DumpDir = $pairedDir }
        }

        if (-not (Test-Path $DumpDir)) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Merge flight recorder dumps' `
                -Problem "Dump directory not found: $DumpDir" `
                -Location 'Merge-FlightRecorderDumps' `
                -NextSteps @(
                    'Verify the dump directory exists'
                    'Use -DumpDir to specify a custom path'
                    'Run Get-FlightRecorderDump to list available dumps'
                ))
        }

        $ClientPath = Join-Path $DumpDir "client-${DumpId}.jsonl"
        $ServerPath = Join-Path $DumpDir "server-${DumpId}.jsonl"

        # Fall back to legacy naming if paired naming not found
        if (-not (Test-Path $ClientPath) -and -not (Test-Path $ServerPath)) {
            $legacyClient = Join-Path $DumpDir "flight-recorder-${DumpId}.jsonl"
            $legacyServer = Join-Path $DumpDir "server-flight-recorder-${DumpId}.jsonl"
            if (Test-Path $legacyClient) { $ClientPath = $legacyClient }
            if (Test-Path $legacyServer) { $ServerPath = $legacyServer }
        }

        if (-not $OutputPath) {
            $OutputPath = Join-Path $DumpDir "merged-${DumpId}.jsonl"
        }
    } else {
        if (-not $ClientPath -and -not $ServerPath) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Merge flight recorder dumps' `
                -Problem 'At least one of -ClientPath or -ServerPath must be provided' `
                -Location 'Merge-FlightRecorderDumps' `
                -NextSteps @(
                    'Provide -ClientPath, -ServerPath, or both'
                    'Use -DumpId instead to resolve files by correlation ID'
                ))
        }

        if (-not $OutputPath) {
            $baseDir = if ($ClientPath) { Split-Path $ClientPath } else { Split-Path $ServerPath }
            $baseName = if ($ClientPath) {
                [System.IO.Path]::GetFileNameWithoutExtension($ClientPath)
            } else {
                [System.IO.Path]::GetFileNameWithoutExtension($ServerPath)
            }
            $OutputPath = Join-Path $baseDir "merged-${baseName}.jsonl"
        }
    }

    $hasClient = $ClientPath -and (Test-Path $ClientPath)
    $hasServer = $ServerPath -and (Test-Path $ServerPath)

    if (-not $hasClient -and -not $hasServer) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Merge flight recorder dumps' `
            -Problem 'No dump files found' `
            -Location 'Merge-FlightRecorderDumps' `
            -NextSteps @(
                "Client path: $ClientPath — $(if (Test-Path $ClientPath) {'exists'} else {'NOT FOUND'})"
                "Server path: $ServerPath — $(if (Test-Path $ServerPath) {'exists'} else {'NOT FOUND'})"
                'Use Get-FlightRecorderDump to list available files'
            ))
    }

    $sources = @()
    if ($hasClient) { $sources += 'client' }
    if ($hasServer) { $sources += 'server' }
    Write-Verbose "Merging sources: $($sources -join ' + ')"

    # ── Parse both files ─────────────────────────────────────────────────
    $headers = @{}
    $dictionaries = @{}
    $contexts = @{}
    $triggers = @{}
    $allEvents = [System.Collections.Generic.List[PSCustomObject]]::new()

    foreach ($source in $sources) {
        $filePath = if ($source -eq 'client') { $ClientPath } else { $ServerPath }
        Write-Verbose "Reading $source dump: $filePath"

        $lineNum = 0
        foreach ($line in [System.IO.File]::ReadLines($filePath)) {
            $lineNum++
            if (-not $line.Trim()) { continue }

            try {
                $obj = $line | ConvertFrom-Json
            } catch {
                Write-Warning "$source line $lineNum — skipped unparseable line"
                continue
            }

            $recType = $null
            if ($obj.PSObject.Properties['_type']) { $recType = $obj._type }

            switch ($recType) {
                'header' {
                    $headers[$source] = $obj
                }
                'dictionary' {
                    $dictionaries[$source] = $obj
                }
                'context' {
                    $contexts[$source] = $obj
                }
                'trigger' {
                    $triggers[$source] = $obj
                }
                'event' {
                    $obj | Add-Member -NotePropertyName '_source' -NotePropertyValue $source -Force
                    $allEvents.Add($obj)
                }
            }
        }

        $eventCount = @($allEvents | Where-Object { $_._source -eq $source }).Count
        Write-Verbose "${source}: $eventCount events"
    }

    # ── Build merged header ──────────────────────────────────────────────
    $mergedHeader = [ordered]@{
        _type                        = 'header'
        _version                     = 1
        schema_version               = '1.0.0'
        merged                       = $true
        merge_timestamp              = (Get-Date -Format 'o')
        sources                      = $sources
        total_events                 = $allEvents.Count
    }

    foreach ($source in $sources) {
        if ($headers.ContainsKey($source)) {
            $h = $headers[$source]
            $mergedHeader["${source}_timestamp"] = $h.timestamp
            $mergedHeader["${source}_uptime_ms"] = $h.uptime_ms
            $mergedHeader["${source}_capacity"] = $h.ring_buffer_capacity
            $mergedHeader["${source}_retained"] = $h.ring_buffer_events_retained
            $mergedHeader["${source}_lost"] = $h.events_lost
        }
    }

    # ── Merge dictionaries ───────────────────────────────────────────────
    $mergedEntries = [System.Collections.Generic.List[object]]::new()
    $seenValues = @{}

    foreach ($source in $sources) {
        if (-not $dictionaries.ContainsKey($source)) { continue }
        $dict = $dictionaries[$source]
        if (-not $dict.PSObject.Properties['entries']) { continue }

        foreach ($entry in $dict.entries) {
            $key = "$($entry.category):$($entry.value)"
            if (-not $seenValues.ContainsKey($key)) {
                $seenValues[$key] = $true
                $mergedEntries.Add([ordered]@{
                    handle        = $mergedEntries.Count
                    category      = $entry.category
                    value         = $entry.value
                    registered_at = $entry.registered_at
                    source        = $source
                })
            }
        }
    }

    $mergedDictionary = [ordered]@{
        _type   = 'dictionary'
        entries = @($mergedEntries)
    }

    # ── Merge context records ────────────────────────────────────────────
    $mergedContext = [ordered]@{ _type = 'context' }

    foreach ($source in $sources) {
        if (-not $contexts.ContainsKey($source)) { continue }
        $ctx = $contexts[$source]
        foreach ($prop in $ctx.PSObject.Properties) {
            if ($prop.Name -eq '_type') { continue }
            $mergedContext[$prop.Name] = $prop.Value
        }
        # Tag which source contributed which sections
        $mergedContext["_${source}_fields"] = @($ctx.PSObject.Properties | Where-Object { $_.Name -ne '_type' } | ForEach-Object { $_.Name })
    }

    # ── Sort events by wall clock ────────────────────────────────────────
    $sorted = $allEvents | Sort-Object { $_._wall }

    # Re-sequence merged events
    $seq = 0
    foreach ($evt in $sorted) {
        $evt | Add-Member -NotePropertyName '_merged_seq' -NotePropertyValue $seq -Force
        $seq++
    }

    # ── Write merged JSONL ───────────────────────────────────────────────
    $outputDir = Split-Path $OutputPath
    if ($outputDir -and -not (Test-Path $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }

    $writer = [System.IO.StreamWriter]::new($OutputPath, $false, [System.Text.UTF8Encoding]::new($false))
    try {
        $writer.WriteLine(($mergedHeader | ConvertTo-Json -Depth 10 -Compress))
        $writer.WriteLine(($mergedDictionary | ConvertTo-Json -Depth 10 -Compress))

        if ($mergedContext.Count -gt 1) {
            $writer.WriteLine(($mergedContext | ConvertTo-Json -Depth 10 -Compress))
        }

        foreach ($evt in $sorted) {
            $writer.WriteLine(($evt | ConvertTo-Json -Depth 10 -Compress))
        }

        foreach ($source in $sources) {
            if ($triggers.ContainsKey($source)) {
                $trig = $triggers[$source]
                $trig | Add-Member -NotePropertyName '_source' -NotePropertyValue $source -Force
                $writer.WriteLine(($trig | ConvertTo-Json -Depth 10 -Compress))
            }
        }
    } finally {
        $writer.Dispose()
    }

    $fileInfo = Get-Item $OutputPath
    $clientCount = @($sorted | Where-Object { $_._source -eq 'client' }).Count
    $serverCount = @($sorted | Where-Object { $_._source -eq 'server' }).Count

    Write-Host "Merged $($allEvents.Count) events ($clientCount client + $serverCount server) → $OutputPath" -ForegroundColor Green
    Write-Host "  File size: $([math]::Round($fileInfo.Length / 1024, 1)) KB" -ForegroundColor DarkGray

    if ($PassThru) {
        $fileInfo | Add-Member -NotePropertyName Events -NotePropertyValue $allEvents.Count -Force
        $fileInfo | Add-Member -NotePropertyName ClientEvents -NotePropertyValue $clientCount -Force
        $fileInfo | Add-Member -NotePropertyName ServerEvents -NotePropertyValue $serverCount -Force
        $fileInfo | Add-Member -NotePropertyName Sources -NotePropertyValue $sources -Force
        $fileInfo
    }
}
