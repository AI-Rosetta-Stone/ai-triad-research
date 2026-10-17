# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Request-FlightRecorderDump {
    <#
    .SYNOPSIS
        Requests a flight recorder dump from a running taxonomy process via named pipe.

    .DESCRIPTION
        Connects to the flight recorder named pipe for a given PID, sends a
        dump or summary request. Dump writes events to disk and returns the
        file path; summary returns in-memory stats without I/O.

    .PARAMETER PID
        Process ID of the taxonomy process. Can also be piped from Get-TaxonomyProcess.

    .PARAMETER Summary
        Request a lightweight summary (event count, time range, debate ID)
        instead of a full dump to disk.

    .PARAMETER TimeoutSeconds
        Connection timeout in seconds. Default: 5.

    .EXAMPLE
        Request-FlightRecorderDump -PID 12345

    .EXAMPLE
        Request-FlightRecorderDump -PID 12345 -Summary

    .EXAMPLE
        Get-TaxonomyProcess | Request-FlightRecorderDump

    .EXAMPLE
        Get-TaxonomyProcess -Type electron | Request-FlightRecorderDump | Get-FlightRecorderReport
    .LINK
        Show-AITriadHelp
    .LINK
        Get-AzureFlightRecorder
    .LINK
        Get-FlightRecorderDump
    .LINK
        Get-FlightRecorderReport
    .LINK
        Merge-FlightRecorderDumps
    .LINK
        Show-FlightRecorder
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, ValueFromPipelineByPropertyName)]
        [Alias('PID')]
        [int]$ProcessId,

        [Parameter()]
        [switch]$Summary,

        [Parameter()]
        [int]$TimeoutSeconds = 5
    )

    process {
        $pipeName = "taxonomy-flight-recorder-$ProcessId"

        try {
            $pipe = [System.IO.Pipes.NamedPipeClientStream]::new(
                '.',
                $pipeName,
                [System.IO.Pipes.PipeDirection]::InOut
            )

            $timeoutMs = $TimeoutSeconds * 1000
            try {
                $pipe.Connect($timeoutMs)
            } catch [TimeoutException] {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal "Request flight recorder dump from PID $ProcessId" `
                    -Problem "Named pipe '$pipeName' did not respond within ${TimeoutSeconds}s" `
                    -Location 'Request-FlightRecorderDump' `
                    -NextSteps @(
                        "Verify the process is running: Get-Process -Id $ProcessId"
                        'Ensure the flight recorder pipe listener is enabled in the app'
                    ))
            } catch {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal "Request flight recorder dump from PID $ProcessId" `
                    -Problem "Cannot connect to pipe '$pipeName': $($_.Exception.Message)" `
                    -Location 'Request-FlightRecorderDump' `
                    -NextSteps @(
                        "Verify the process is running: Get-Process -Id $ProcessId"
                        'Check that the flight recorder pipe listener is active'
                        'Run Get-TaxonomyProcess to find valid PIDs'
                    ))
            }

            $writer = [System.IO.StreamWriter]::new($pipe)
            $reader = [System.IO.StreamReader]::new($pipe)

            try {
                $actionName = if ($Summary) { 'summary' } else { 'dump' }
                $request = @{ action = $actionName } | ConvertTo-Json -Compress
                $writer.WriteLine($request)
                $writer.Flush()

                $pipe.WaitForPipeDrain()

                $responseLine = $reader.ReadLine()
                if (-not $responseLine) {
                    throw (New-ActionableError -AsErrorRecord `
                        -Goal "Request flight recorder $actionName from PID $ProcessId" `
                        -Problem 'Received empty response from flight recorder pipe' `
                        -Location 'Request-FlightRecorderDump' `
                        -NextSteps @('The process may have closed the connection unexpectedly'))
                }

                $response = $responseLine | ConvertFrom-Json

                $result = [PSCustomObject]@{
                    PID        = $ProcessId
                    Action     = $actionName
                    EventCount = if ($response.PSObject.Properties['event_count']) {
                                     $response.event_count
                                 } else { $null }
                    DebateId   = if ($response.PSObject.Properties['debate_id']) {
                                     $response.debate_id
                                 } else { $null }
                }

                if ($Summary) {
                    if ($response.PSObject.Properties['buffer_size_bytes']) {
                        $result | Add-Member -NotePropertyName BufferSizeBytes -NotePropertyValue $response.buffer_size_bytes
                    }
                } else {
                    $result | Add-Member -NotePropertyName Path -NotePropertyValue $response.path
                    if ($response.PSObject.Properties['size_bytes']) {
                        $result | Add-Member -NotePropertyName SizeBytes -NotePropertyValue $response.size_bytes
                    }
                }

                if ($response.PSObject.Properties['time_range']) {
                    $result | Add-Member -NotePropertyName TimeRange -NotePropertyValue $response.time_range
                }

                $result
            } finally {
                $reader.Dispose()
                $writer.Dispose()
            }
        } finally {
            if ($pipe) { $pipe.Dispose() }
        }
    }
}
