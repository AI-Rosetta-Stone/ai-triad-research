# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-DebateIndexIntegrity {
    <#
    .SYNOPSIS
        Validate debate session files for field-type integrity.
    .DESCRIPTION
        Reads debate-*.json files from the debates directory and validates that
        summary fields used by the Electron UI contain the expected types.
        Catches the class of bug where extractSummary() sets title to a
        structured topic object instead of a string (t/2334), which crashes
        DebateTableRow with "Objects are not valid as a React child".

        Checks per session file:
        - title: non-empty string (not an object or null)
        - id, created_at, updated_at, phase: non-empty strings
        - debate_model: string or absent
        - topic.final / topic.original: strings when topic is an object
        - title fallback: warns when title is absent and topic is an object
          (the extractSummary fallback would render the object, crashing the UI)
    .PARAMETER DebatesDir
        Override the debates directory. Defaults to Join-Path (Get-DataRoot) 'debates'.
    .PARAMETER PassThru
        Return a result object instead of only writing to the host.
    .EXAMPLE
        Test-DebateIndexIntegrity
    .EXAMPLE
        Test-DebateIndexIntegrity -PassThru
    .LINK
        Test-TaxonomyIntegrity
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [string]$DebatesDir,

        [switch]$PassThru
    )

    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    if (-not $DebatesDir) {
        $DataRoot = Get-DataRoot
        if (-not $DataRoot) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal     'Locate debates directory' `
                -Problem  'Could not resolve data root — .aitriad.json not found' `
                -Location 'Test-DebateIndexIntegrity' `
                -NextSteps 'Run from the repo root, or set $env:AI_TRIAD_DATA_ROOT.')
        }
        $DebatesDir = Join-Path $DataRoot 'debates'
    }

    if (-not (Test-Path $DebatesDir)) {
        Write-Host ''
        Write-Host '=== Debate Index Integrity ===' -ForegroundColor Cyan
        Write-Host "  Debates dir not found: $DebatesDir" -ForegroundColor Yellow
        Write-Host "  No debate sessions to validate." -ForegroundColor White
        Write-Host ''
        if ($PassThru) {
            return [PSCustomObject]@{ Files = 0; Passed = 0; Issues = 0; Details = @() }
        }
        return
    }

    $Files    = @(Get-ChildItem -Path $DebatesDir -Filter 'debate-*.json' -File)
    $Issues   = [System.Collections.Generic.List[PSCustomObject]]::new()
    $Passed   = 0

    foreach ($File in $Files) {
        try {
            $Data = Get-Content -Raw -Path $File.FullName | ConvertFrom-Json
        } catch {
            $Issues.Add([PSCustomObject]@{
                File    = $File.Name
                Field   = '<parse>'
                Problem = "JSON parse failed: $_"
            })
            continue
        }

        $SessionId = if ($Data.PSObject.Properties['id'] -and $null -ne $Data.id) { "$($Data.id)" } else { $File.Name }
        $FileIssues = [System.Collections.Generic.List[string]]::new()

        # ── String field checks ──
        # Note: ConvertFrom-Json in PS 7 coerces ISO 8601 strings to [DateTime].
        # Date fields accept either [string] or [DateTime]; id/phase must be strings.
        $StringFields = @('id', 'phase')
        foreach ($Field in $StringFields) {
            if (-not $Data.PSObject.Properties[$Field]) {
                $FileIssues.Add("${Field}: missing")
            } elseif ($null -eq $Data.$Field) {
                $FileIssues.Add("${Field}: null")
            } elseif ($Data.$Field -isnot [string]) {
                $FileIssues.Add("${Field}: expected string, got $($Data.$Field.GetType().Name)")
            } elseif ([string]::IsNullOrWhiteSpace($Data.$Field)) {
                $FileIssues.Add("${Field}: empty string")
            }
        }

        $DateFields = @('created_at', 'updated_at')
        foreach ($Field in $DateFields) {
            if (-not $Data.PSObject.Properties[$Field]) {
                $FileIssues.Add("${Field}: missing")
            } elseif ($null -eq $Data.$Field) {
                $FileIssues.Add("${Field}: null")
            } elseif ($Data.$Field -isnot [string] -and $Data.$Field -isnot [datetime]) {
                $FileIssues.Add("${Field}: expected string, got $($Data.$Field.GetType().Name)")
            } elseif ([string]::IsNullOrWhiteSpace("$($Data.$Field)")) {
                $FileIssues.Add("${Field}: empty string")
            }
        }

        # ── title check (the t/2334 bug trigger) ──
        $HasTitle  = $Data.PSObject.Properties['title'] -and -not [string]::IsNullOrWhiteSpace("$($Data.title)")
        $TitleIsObj = $Data.PSObject.Properties['title'] -and $null -ne $Data.title -and $Data.title -isnot [string]

        if ($TitleIsObj) {
            $Keys = ($Data.title.PSObject.Properties.Name) -join ', '
            $FileIssues.Add("title: expected string, got object {$Keys} — extractSummary fallback would crash DebateTableRow (t/2334)")
        } elseif (-not $HasTitle) {
            # title absent/empty — check if topic fallback would be an object
            if ($Data.PSObject.Properties['topic'] -and $null -ne $Data.topic -and $Data.topic -isnot [string]) {
                $Keys = ($Data.topic.PSObject.Properties.Name) -join ', '
                $FileIssues.Add("title: absent; topic is object {$Keys} — extractSummary would fall back to topic object, crashing UI (t/2334)")
            } else {
                $FileIssues.Add("title: absent or empty")
            }
        }

        # ── debate_model: string or absent ──
        if ($Data.PSObject.Properties['debate_model'] -and $null -ne $Data.debate_model -and $Data.debate_model -isnot [string]) {
            $FileIssues.Add("debate_model: expected string, got $($Data.debate_model.GetType().Name)")
        }

        # ── topic: if present as object, final/original should be strings ──
        if ($Data.PSObject.Properties['topic'] -and $null -ne $Data.topic -and $Data.topic -isnot [string]) {
            foreach ($TField in @('final', 'original')) {
                if ($Data.topic.PSObject.Properties[$TField]) {
                    $Val = $Data.topic.$TField
                    if ($null -ne $Val -and $Val -isnot [string]) {
                        $FileIssues.Add("topic.${TField}: expected string, got $($Val.GetType().Name)")
                    }
                }
            }
        }

        if ($FileIssues.Count -gt 0) {
            foreach ($Msg in $FileIssues) {
                $Issues.Add([PSCustomObject]@{ File = $File.Name; SessionId = $SessionId; Field = $Msg.Split(':')[0]; Problem = $Msg })
            }
        } else {
            $Passed++
        }
    }

    # ── Report ──
    Write-Host ''
    Write-Host '=== Debate Index Integrity ===' -ForegroundColor Cyan
    Write-Host "  Directory:  $DebatesDir" -ForegroundColor White
    Write-Host "  Files:      $($Files.Count)" -ForegroundColor White
    Write-Host "  Passed:     $Passed" -ForegroundColor Green
    Write-Host "  Issues:     $($Issues.Count)" -ForegroundColor $(if ($Issues.Count -gt 0) { 'Red' } else { 'Green' })

    if ($Issues.Count -gt 0) {
        Write-Host ''
        foreach ($Issue in $Issues) {
            Write-Host "  [Error] $($Issue.File) — $($Issue.Problem)" -ForegroundColor Red
        }
    } else {
        Write-Host ''
        Write-Host '  All debate files passed!' -ForegroundColor Green
    }
    Write-Host ''

    if ($PassThru) {
        [PSCustomObject]@{
            Files   = $Files.Count
            Passed  = $Passed
            Issues  = $Issues.Count
            Details = @($Issues)
        }
    }

    if ($Issues.Count -gt 0) {
        Write-Error "Test-DebateIndexIntegrity: $($Issues.Count) issue(s) found in $($Files.Count) debate file(s)." -ErrorAction Continue
    }
}
