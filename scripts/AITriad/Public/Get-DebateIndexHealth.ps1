# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-DebateIndexHealth {
    <#
    .SYNOPSIS
        Scan the debates index (.debate-index.json) for type-invalid entries.
    .DESCRIPTION
        Reads the aggregated debate index `.debate-index.json` from the debates
        directory (the cache the Electron main process reads via
        listDebateSessionsIndexed — debateIO.ts) and reports entries whose
        `summary` fields hold the wrong type — most notably a `title` that is an
        object `{final, original}` instead of a string, which crashes DebateTableRow
        with "Objects are not valid as a React child" (t/2334/t/2729).

        This is the INDEX-file complement to Test-DebateIndexIntegrity, which
        despite its name validates the per-session `debate-*.json` FILES, not the
        index. Use this cmdlet for the aggregated index; that one for the sessions.

        Emits one row per offending field (Id, Field, Expected, Actual, Detail).
        With -Repair, deletes the offending entries from the index so the app
        re-extracts them from their session files on next launch (it compares
        mtimeMs). Repair rewrites the index in the app's compact format.

        No AI calls are made — this is a purely offline diagnostic.
    .PARAMETER DebatesDir
        Override the debates directory. Defaults to Join-Path (Get-DataRoot) 'debates'.
    .PARAMETER Repair
        Delete offending entries from the index so they are re-extracted on next
        app launch. Supports -WhatIf / -Confirm.
    .PARAMETER PassThru
        Return a summary object (IndexPath, TotalEntries, BadEntries, Removed,
        Details) instead of only the per-issue rows.
    .OUTPUTS
        [PSCustomObject] per-issue rows, or a summary object with -PassThru.
    .EXAMPLE
        Get-DebateIndexHealth
    .EXAMPLE
        Get-DebateIndexHealth -Repair -WhatIf
    .EXAMPLE
        Get-DebateIndexHealth -Repair
    .LINK
        Show-AITriadHelp
    .LINK
        Test-DebateIndexIntegrity
    .LINK
        Get-DebateSessionState
    #>
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [string]$DebatesDir,

        [Parameter()]
        [switch]$Repair,

        [Parameter()]
        [switch]$PassThru
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $DebatesDir) {
        $DataRoot = Get-DataRoot
        if (-not $DataRoot) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal     'Locate debates index' `
                -Problem  'Could not resolve data root — .aitriad.json not found' `
                -Location 'Get-DebateIndexHealth' `
                -NextSteps 'Run from the repo root, or set $env:AI_TRIAD_DATA_ROOT.')
        }
        $DebatesDir = Join-Path $DataRoot 'debates'
    }

    $IndexPath = Join-Path $DebatesDir '.debate-index.json'
    $Issues    = [System.Collections.Generic.List[PSCustomObject]]::new()

    if (-not (Test-Path $IndexPath)) {
        Write-Host ''
        Write-Host '=== Debate Index Health ===' -ForegroundColor Cyan
        Write-Host "  Index not found: $IndexPath" -ForegroundColor Yellow
        Write-Host '  Nothing to scan (the app rebuilds the index on next launch).' -ForegroundColor White
        Write-Host ''
        if ($PassThru) {
            return [PSCustomObject]@{ IndexPath = $IndexPath; TotalEntries = 0; BadEntries = 0; Removed = 0; Details = @() }
        }
        return
    }

    try {
        $Index = Get-Content -Raw -Path $IndexPath | ConvertFrom-Json
    } catch {
        throw (New-ActionableError -AsErrorRecord `
            -Goal     'Scan the debates index' `
            -Problem  "Index is not valid JSON: $($_.Exception.Message)" `
            -Location 'Get-DebateIndexHealth' `
            -NextSteps @('Inspect the file: ' + $IndexPath,
                         'The app rebuilds a corrupt index on next launch — deleting the file is safe.'))
    }

    # Entries is a Record<id, {mtimeMs, summary}>. Absent/empty → nothing to scan.
    $EntryProps = @()
    if ($Index.PSObject.Properties['entries'] -and $null -ne $Index.entries) {
        $EntryProps = @($Index.entries.PSObject.Properties)
    }

    # Field contracts on entry.summary (debateIO.ts DebateSessionSummary):
    #   required strings, date strings (ConvertFrom-Json may coerce to [datetime]),
    #   and optional strings validated only when present and non-null.
    $RequiredStringFields = @('id', 'title', 'phase')
    $DateFields           = @('created_at', 'updated_at')
    $OptionalStringFields = @('topic_text', 'model')

    $BadIds = [System.Collections.Generic.HashSet[string]]::new()

    $AddIssue = {
        param($Id, $Field, $Expected, $Actual, $Detail)
        [void]$BadIds.Add($Id)
        $Issues.Add([PSCustomObject]@{
            Id       = $Id
            Field    = $Field
            Expected = $Expected
            Actual   = $Actual
            Detail   = $Detail
        })
    }

    foreach ($Prop in $EntryProps) {
        $Id    = $Prop.Name
        $Entry = $Prop.Value

        if ($null -eq $Entry -or -not $Entry.PSObject.Properties['summary'] -or $null -eq $Entry.summary) {
            & $AddIssue $Id 'summary' 'object' $(if ($null -eq $Entry) { 'null-entry' } else { 'missing' }) 'entry has no summary object'
            continue
        }
        $S = $Entry.summary

        foreach ($Field in $RequiredStringFields) {
            if (-not $S.PSObject.Properties[$Field]) {
                & $AddIssue $Id $Field 'string' 'missing' "summary.$Field is absent"
            } elseif ($null -eq $S.$Field) {
                & $AddIssue $Id $Field 'string' 'null' "summary.$Field is null"
            } elseif ($S.$Field -isnot [string]) {
                $Detail = "summary.$Field is $($S.$Field.GetType().Name)"
                if ($S.$Field -is [System.Management.Automation.PSCustomObject]) {
                    $Keys = @($S.$Field.PSObject.Properties.Name) -join ', '
                    $Detail += " {$Keys}"
                }
                & $AddIssue $Id $Field 'string' $S.$Field.GetType().Name $Detail
            }
        }

        foreach ($Field in $DateFields) {
            if (-not $S.PSObject.Properties[$Field]) {
                & $AddIssue $Id $Field 'string' 'missing' "summary.$Field is absent"
            } elseif ($null -eq $S.$Field) {
                & $AddIssue $Id $Field 'string' 'null' "summary.$Field is null"
            } elseif ($S.$Field -isnot [string] -and $S.$Field -isnot [datetime]) {
                & $AddIssue $Id $Field 'string' $S.$Field.GetType().Name "summary.$Field is $($S.$Field.GetType().Name)"
            }
        }

        foreach ($Field in $OptionalStringFields) {
            if ($S.PSObject.Properties[$Field] -and $null -ne $S.$Field -and $S.$Field -isnot [string]) {
                & $AddIssue $Id $Field 'string' $S.$Field.GetType().Name "summary.$Field is $($S.$Field.GetType().Name)"
            }
        }
    }

    $TotalEntries = $EntryProps.Count
    $BadCount     = $BadIds.Count
    $Removed      = 0

    # ── Repair: delete offending entries; app re-extracts on next launch ──
    if ($Repair -and $BadCount -gt 0) {
        if ($PSCmdlet.ShouldProcess($IndexPath, "Remove $BadCount type-invalid entry(ies)")) {
            foreach ($Id in @($BadIds)) {
                $Index.entries.PSObject.Properties.Remove($Id)
                $Removed++
            }
            # Match the app's compact serialization (JSON.stringify — no pretty,
            # no BOM, no trailing newline; saveIndex in debateIO.ts).
            $Json = $Index | ConvertTo-Json -Depth 20 -Compress
            Assert-DataWriteAllowed -Path $IndexPath  # t/2902
            [System.IO.File]::WriteAllText($IndexPath, $Json, [System.Text.UTF8Encoding]::new($false))
        }
    }

    # ── Report ──
    Write-Host ''
    Write-Host '=== Debate Index Health ===' -ForegroundColor Cyan
    Write-Host "  Index:       $IndexPath" -ForegroundColor White
    Write-Host "  Entries:     $TotalEntries" -ForegroundColor White
    Write-Host "  Bad entries: $BadCount" -ForegroundColor $(if ($BadCount -gt 0) { 'Red' } else { 'Green' })
    if ($Repair) {
        Write-Host "  Removed:     $Removed" -ForegroundColor $(if ($Removed -gt 0) { 'Yellow' } else { 'Green' })
    }
    if ($BadCount -gt 0) {
        Write-Host ''
        foreach ($Issue in $Issues) {
            Write-Host "  [Error] $($Issue.Id) — $($Issue.Field): expected $($Issue.Expected), got $($Issue.Actual) ($($Issue.Detail))" -ForegroundColor Red
        }
    } else {
        Write-Host '  All index entries are type-valid.' -ForegroundColor Green
    }
    Write-Host ''

    if ($PassThru) {
        return [PSCustomObject]@{
            IndexPath    = $IndexPath
            TotalEntries = $TotalEntries
            BadEntries   = $BadCount
            Removed      = $Removed
            Details      = @($Issues)
        }
    }

    # Default: emit the per-issue rows (pipeline-friendly diagnostic table).
    $Issues
}
