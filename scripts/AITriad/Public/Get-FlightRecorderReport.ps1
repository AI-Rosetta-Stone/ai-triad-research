# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-FlightRecorderReport {
    <#
    .SYNOPSIS
        Parses a flight recorder JSONL dump and produces a summary report.

    .DESCRIPTION
        Reads a flight recorder JSONL file, analyzes the events, and builds
        a report including phase timeline, current state, error/warning
        summary, and component coverage.

    .PARAMETER Path
        Path to the JSONL dump file. Can be piped from Request-FlightRecorderDump
        or Get-FlightRecorderDump.

    .PARAMETER Detailed
        Include full event listing in the report.

    .PARAMETER AsObject
        Return structured output instead of formatted text.

    .EXAMPLE
        Get-FlightRecorderReport -Path ./flight-recorder-dump.jsonl

    .EXAMPLE
        Get-FlightRecorderDump -Last 1 | Get-FlightRecorderReport

    .EXAMPLE
        Get-TaxonomyProcess | Request-FlightRecorderDump | Get-FlightRecorderReport -AsObject
    .LINK
        Show-AITriadHelp
    .LINK
        Get-AzureFlightRecorder
    .LINK
        Get-FlightRecorderDump
    .LINK
        Merge-FlightRecorderDumps
    .LINK
        Request-FlightRecorderDump
    .LINK
        Show-FlightRecorder
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string]$Path,

        [Parameter()]
        [switch]$Detailed,

        [Parameter()]
        [switch]$AsObject
    )

    process {
        if (-not (Test-Path $Path)) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal 'Generate flight recorder report' `
                -Problem "File not found: $Path" `
                -Location 'Get-FlightRecorderReport' `
                -NextSteps @(
                    'Verify the dump file path is correct'
                    'Run Get-FlightRecorderDump to list available dumps'
                ))
        }

        $header = $null
        $context = $null
        $dictionary = @{}
        $events = [System.Collections.Generic.List[object]]::new()
        $phases = [System.Collections.Generic.List[object]]::new()
        $errors = [System.Collections.Generic.List[object]]::new()
        $warnings = [System.Collections.Generic.List[object]]::new()
        $componentCounts = @{}
        $levelCounts = @{ debug = 0; info = 0; warn = 0; error = 0; fatal = 0 }
        $typeCounts = @{}
        $lastSpeaker = $null
        $lastRound = $null
        $lastPhase = $null
        $firstWall = $null
        $lastWall = $null

        foreach ($line in [System.IO.File]::ReadLines($Path)) {
            if (-not $line.Trim()) { continue }

            try {
                $obj = $line | ConvertFrom-Json
            } catch {
                continue
            }

            $recType = $null
            if ($obj.PSObject.Properties['_type']) {
                $recType = $obj._type
            }

            switch ($recType) {
                'header' {
                    $header = $obj
                }
                'dictionary' {
                    if ($obj.PSObject.Properties['entries']) {
                        foreach ($entry in $obj.entries) {
                            $dictionary["$($entry.handle)"] = $entry.value
                        }
                    }
                }
                'context' {
                    $context = $obj
                }
                'event' {
                    $events.Add($obj)

                    # Resolve dictionary handles
                    $componentName = $obj.component
                    $handleKey = "$componentName"
                    if ($dictionary.ContainsKey($handleKey)) {
                        $componentName = $dictionary[$handleKey]
                    }

                    # Track component coverage
                    $compKey = [string]$componentName
                    if ($componentCounts.ContainsKey($compKey)) {
                        $componentCounts[$compKey]++
                    } else {
                        $componentCounts[$compKey] = 1
                    }

                    # Track event types
                    $evtType = ''
                    if ($obj.PSObject.Properties['type']) {
                        $evtType = [string]$obj.type
                    }
                    if ($typeCounts.ContainsKey($evtType)) {
                        $typeCounts[$evtType]++
                    } else {
                        $typeCounts[$evtType] = 1
                    }

                    # Track levels
                    $level = 'info'
                    if ($obj.PSObject.Properties['level']) {
                        $level = [string]$obj.level
                    }
                    if ($levelCounts.ContainsKey($level)) {
                        $levelCounts[$level]++
                    }

                    # Collect errors and warnings
                    if ($level -eq 'error' -or $level -eq 'fatal') {
                        $errors.Add($obj)
                    } elseif ($level -eq 'warn') {
                        $warnings.Add($obj)
                    }

                    # Track phase transitions
                    if ($evtType -eq 'debate.phase') {
                        $phaseName = ''
                        if ($obj.PSObject.Properties['data'] -and $obj.data.PSObject.Properties['phase']) {
                            $phaseName = $obj.data.phase
                        } elseif ($obj.PSObject.Properties['message']) {
                            $phaseName = $obj.message
                        }
                        $phases.Add([PSCustomObject]@{
                            Phase = $phaseName
                            Seq   = if ($obj.PSObject.Properties['_seq']) { $obj._seq } else { 0 }
                            Wall  = if ($obj.PSObject.Properties['_wall']) { $obj._wall } else { 0 }
                        })
                        $lastPhase = $phaseName
                    }

                    # Track speaker/round
                    if ($obj.PSObject.Properties['speaker']) {
                        $spk = $obj.speaker
                        $spkKey = "$spk"
                        if ($dictionary.ContainsKey($spkKey)) {
                            $spk = $dictionary[$spkKey]
                        }
                        $lastSpeaker = [string]$spk
                    }
                    if ($evtType -eq 'debate.round' -and $obj.PSObject.Properties['data']) {
                        if ($obj.data.PSObject.Properties['round']) {
                            $lastRound = $obj.data.round
                        }
                    }

                    # Track time range
                    if ($obj.PSObject.Properties['_wall']) {
                        $wall = $obj._wall
                        if ($null -eq $firstWall) { $firstWall = $wall }
                        $lastWall = $wall
                    }
                }
            }
        }

        # Build phase timeline with event counts
        $phaseTimeline = [System.Collections.Generic.List[object]]::new()
        for ($i = 0; $i -lt $phases.Count; $i++) {
            $startSeq = $phases[$i].Seq
            $endSeq = if ($i + 1 -lt $phases.Count) { $phases[$i + 1].Seq } else { [int]::MaxValue }
            $count = 0
            foreach ($evt in $events) {
                $seq = 0
                if ($evt.PSObject.Properties['_seq']) { $seq = $evt._seq }
                if ($seq -ge $startSeq -and $seq -lt $endSeq) { $count++ }
            }
            $phaseTimeline.Add([PSCustomObject]@{
                Phase      = $phases[$i].Phase
                EventCount = $count
            })
        }

        # Build current state
        $currentState = [PSCustomObject]@{
            Phase   = if ($context -and $context.PSObject.Properties['debate']) {
                          if ($context.debate.PSObject.Properties['phase']) { $context.debate.phase } else { $lastPhase }
                      } else { $lastPhase }
            Round   = $lastRound
            Speaker = $lastSpeaker
        }

        # Build error summary
        $errorCategories = @{}
        foreach ($err in $errors) {
            $cat = 'uncategorized'
            if ($err.PSObject.Properties['error_category']) {
                $cat = [string]$err.error_category
            } elseif ($err.PSObject.Properties['type']) {
                $cat = [string]$err.type
            }
            if ($errorCategories.ContainsKey($cat)) {
                $errorCategories[$cat]++
            } else {
                $errorCategories[$cat] = 1
            }
        }

        # Time range
        $timeRangeStart = $null
        $timeRangeEnd = $null
        if ($null -ne $firstWall) {
            $timeRangeStart = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$firstWall).DateTime.ToString('o')
        }
        if ($null -ne $lastWall) {
            $timeRangeEnd = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$lastWall).DateTime.ToString('o')
        }

        # Top components sorted by count
        $topComponents = $componentCounts.GetEnumerator() |
            Sort-Object Value -Descending |
            Select-Object @{N='Component';E={$_.Key}}, @{N='Events';E={$_.Value}}

        $report = [PSCustomObject]@{
            DumpFile       = $Path
            Header         = if ($header) {
                                 [PSCustomObject]@{
                                     SchemaVersion = if ($header.PSObject.Properties['schema_version']) { $header.schema_version } else { $null }
                                     Capacity      = if ($header.PSObject.Properties['ring_buffer_capacity']) { $header.ring_buffer_capacity } else { 0 }
                                     Retained      = if ($header.PSObject.Properties['ring_buffer_events_retained']) { $header.ring_buffer_events_retained } else { 0 }
                                     Total         = if ($header.PSObject.Properties['ring_buffer_events_total']) { $header.ring_buffer_events_total } else { 0 }
                                     Lost          = if ($header.PSObject.Properties['events_lost']) { $header.events_lost } else { 0 }
                                 }
                             } else { $null }
            TimeRange      = [PSCustomObject]@{
                                 Start = $timeRangeStart
                                 End   = $timeRangeEnd
                             }
            EventCount     = $events.Count
            LevelCounts    = [PSCustomObject]$levelCounts
            PhaseTimeline  = @($phaseTimeline)
            CurrentState   = $currentState
            ErrorCount     = $errors.Count
            WarningCount   = $warnings.Count
            ErrorSummary   = $errorCategories
            Components     = @($topComponents)
            DebateId       = if ($context -and $context.PSObject.Properties['debate'] -and
                                 $context.debate.PSObject.Properties['id']) {
                                 $context.debate.id
                             } else { $null }
        }

        if ($Detailed) {
            $report | Add-Member -NotePropertyName Events -NotePropertyValue @($events) -Force
            $report | Add-Member -NotePropertyName Errors -NotePropertyValue @($errors) -Force
            $report | Add-Member -NotePropertyName Warnings -NotePropertyValue @($warnings) -Force
        }

        if ($AsObject) {
            $report
        } else {
            _Format-FlightRecorderReport $report
        }
    }
}

function _Format-FlightRecorderReport {
    param([object]$Report)

    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.AppendLine("=== Flight Recorder Report ===")
    [void]$sb.AppendLine("File: $($Report.DumpFile)")

    if ($Report.Header) {
        [void]$sb.AppendLine("Events: $($Report.Header.Retained) retained / $($Report.Header.Total) total ($($Report.Header.Lost) lost)")
    } else {
        [void]$sb.AppendLine("Events: $($Report.EventCount)")
    }

    if ($Report.TimeRange.Start) {
        [void]$sb.AppendLine("Time range: $($Report.TimeRange.Start) .. $($Report.TimeRange.End)")
    }

    if ($Report.DebateId) {
        [void]$sb.AppendLine("Debate ID: $($Report.DebateId)")
    }

    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("--- Level Summary ---")
    [void]$sb.AppendLine("  debug: $($Report.LevelCounts.debug)  info: $($Report.LevelCounts.info)  warn: $($Report.LevelCounts.warn)  error: $($Report.LevelCounts.error)  fatal: $($Report.LevelCounts.fatal)")

    if ($Report.PhaseTimeline.Count -gt 0) {
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("--- Phase Timeline ---")
        foreach ($phase in $Report.PhaseTimeline) {
            [void]$sb.AppendLine("  $($phase.Phase): $($phase.EventCount) events")
        }
    }

    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("--- Current State ---")
    [void]$sb.AppendLine("  Phase: $($Report.CurrentState.Phase ?? 'n/a')  Round: $($Report.CurrentState.Round ?? 'n/a')  Speaker: $($Report.CurrentState.Speaker ?? 'n/a')")

    if ($Report.ErrorCount -gt 0) {
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("--- Errors ($($Report.ErrorCount)) ---")
        foreach ($cat in $Report.ErrorSummary.GetEnumerator()) {
            [void]$sb.AppendLine("  $($cat.Key): $($cat.Value)")
        }
    }

    if ($Report.WarningCount -gt 0) {
        [void]$sb.AppendLine("  Warnings: $($Report.WarningCount)")
    }

    if ($Report.Components.Count -gt 0) {
        [void]$sb.AppendLine("")
        [void]$sb.AppendLine("--- Component Coverage ---")
        foreach ($comp in $Report.Components | Select-Object -First 15) {
            [void]$sb.AppendLine("  $($comp.Component): $($comp.Events)")
        }
        if ($Report.Components.Count -gt 15) {
            [void]$sb.AppendLine("  ... and $($Report.Components.Count - 15) more")
        }
    }

    $sb.ToString()
}
