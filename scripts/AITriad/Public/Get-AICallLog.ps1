# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-AICallLog {
    <#
    .SYNOPSIS
        Read the AI call log (ai-call-log.jsonl) as filterable, pipeline-friendly objects.
    .DESCRIPTION
        The reader for the AI Call Log (t/3243; epic t/3235, TL design t/3235#1). Parses the
        append-only JSONL written by Write-AICallLogEntry (t/3241) into typed [AICallLogEntry]
        objects and emits them one per record down the pipeline, so they compose with
        Where-Object / Sort-Object / Select-Object.

        Reading is decoupled from the AI_CALL_LOG_ENABLED capture flag: the flag gates WRITES,
        not reads — you can always inspect whatever the log already holds. When the log file is
        absent or empty (e.g. logging was never enabled, or Clear-AICallLog just rotated it), the
        result is simply empty — non-fatal, no error. A line that fails to parse is skipped with a
        WARN (fallback-path logging) rather than aborting the whole read.
    .PARAMETER Scenario
        Keep only records whose Scenario matches this wildcard pattern (case-insensitive -like).
        E.g. -Scenario 'Debate', -Scenario 'Fact*'.
    .PARAMETER Status
        Keep only records whose Status matches this wildcard pattern (case-insensitive -like).
        E.g. -Status 200, -Status '4*' (all 4xx), -Status '*timeout*'.
    .PARAMETER After
        Keep only records at or after this timestamp (compared against the record Datetime).
    .PARAMETER Before
        Keep only records strictly before this timestamp (compared against the record Datetime).
    .PARAMETER Path
        Log file override (fixtures/tests). Default: Get-AICallLogPath (data-root resolved).
    .OUTPUTS
        [AICallLogEntry] — one per matching JSONL record, in file (chronological) order.
    .EXAMPLE
        Get-AICallLog
        All logged AI calls, oldest first.
    .EXAMPLE
        Get-AICallLog -Scenario Debate -Status '4*'
        Debate-scenario calls that returned a 4xx status.
    .EXAMPLE
        Get-AICallLog -After (Get-Date).AddHours(-1) | Sort-Object RetryCount -Descending
        Calls in the last hour, most-retried first.
    .LINK
        Clear-AICallLog
    .LINK
        Get-AICostReport
    #>
    # NB: no [OutputType([AICallLogEntry])] — a module-scoped PS class can't be resolved in the
    # attribute at dot-source parse time ("Unable to find type"); the codebase convention (e.g.
    # Get-FreeTierStatus, Get-AITDebate) is to construct the class in the body and document the
    # return type in .OUTPUTS instead.
    [CmdletBinding()]
    param(
        [Parameter()]
        [SupportsWildcards()]
        [string]$Scenario,

        [Parameter()]
        [SupportsWildcards()]
        [string]$Status,

        [Parameter()]
        [datetime]$After,

        [Parameter()]
        [datetime]$Before,

        [Parameter()]
        [string]$Path
    )
    Set-StrictMode -Version Latest

    $logPath = if ($PSBoundParameters.ContainsKey('Path') -and $Path) { $Path } else { Get-AICallLogPath }

    if (-not (Test-Path -LiteralPath $logPath)) {
        Write-Verbose "Get-AICallLog: no log file at '$logPath' — returning empty (logging may never have been enabled)."
        return
    }

    $lines = @(Get-Content -LiteralPath $logPath -Encoding utf8 -ErrorAction SilentlyContinue)
    if ($lines.Count -eq 0) {
        Write-Verbose "Get-AICallLog: log file '$logPath' is empty — returning empty."
        return
    }

    # Normalize the range bounds to UTC once. Records are stored UTC (ISO-8601 'Z'), but a
    # user-supplied -After/-Before may be Local/Unspecified kind; comparing raw ticks across
    # DateTimeKind is a silent tz bug near boundaries. ToUniversalTime() treats an Unspecified
    # bound as local time — the sane default for a hand-typed date.
    $afterUtc  = if ($PSBoundParameters.ContainsKey('After'))  { $After.ToUniversalTime() }  else { $null }
    $beforeUtc = if ($PSBoundParameters.ContainsKey('Before')) { $Before.ToUniversalTime() } else { $null }

    $lineNo = 0
    foreach ($line in $lines) {
        $lineNo++
        if ([string]::IsNullOrWhiteSpace($line)) { continue }

        $rec = $null
        try {
            $rec = $line | ConvertFrom-Json -ErrorAction Stop
        }
        catch {
            # Fallback-path logging (docs/error-handling.md): one corrupt line must not abort the
            # whole read — skip it and surface which line and why.
            Write-Warning "Get-AICallLog: skipping unparseable line $lineNo in '$logPath' ($($_.Exception.Message))."
            continue
        }

        # Parse Datetime once; needed both for the range filters and the emitted typed value.
        # A missing/unparseable Datetime yields [datetime]::MinValue (never matches a real range).
        $dt = [datetime]::MinValue
        if ($rec.PSObject.Properties['Datetime'] -and -not [string]::IsNullOrWhiteSpace([string]$rec.Datetime)) {
            if ($rec.Datetime -is [datetime]) {
                # ConvertFrom-Json already parsed the ISO-8601 string to a DateTime (Kind=Utc for a
                # 'Z' suffix), preserving sub-seconds. Use it DIRECTLY. Re-stringifying + re-parsing
                # (the old path) rendered default-culture text with no fractional seconds and
                # downgraded Kind Utc->Unspecified — dropping ms for BOTH JS 3-digit and PS 7-digit
                # records, and shifting -After/-Before on non-UTC hosts (ToUniversalTime treats
                # Unspecified as local). See t/3245.
                $dt = $rec.Datetime
            }
            else {
                # Fallback: a Datetime value ConvertFrom-Json did NOT coerce (non-ISO / unusual
                # form) — parse the raw string, round-trip-kind aware.
                $parsed = [datetime]::MinValue
                if ([datetime]::TryParse(
                        [string]$rec.Datetime, [cultureinfo]::InvariantCulture,
                        [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$parsed)) {
                    $dt = $parsed
                }
                else {
                    Write-Warning "Get-AICallLog: line $lineNo has an unparseable Datetime '$($rec.Datetime)' in '$logPath'; treating as MinValue."
                }
            }
        }

        # Apply filters (skip non-matches before materializing the typed object). Compare in UTC;
        # the MinValue sentinel (missing Datetime) is left as-is so it sorts before any real bound.
        $dtUtc = if ($dt -eq [datetime]::MinValue) { $dt } else { $dt.ToUniversalTime() }
        if ($null -ne $afterUtc  -and $dtUtc -lt $afterUtc)  { continue }
        if ($null -ne $beforeUtc -and $dtUtc -ge $beforeUtc) { continue }

        $recScenario = if ($rec.PSObject.Properties['Scenario']) { [string]$rec.Scenario } else { '' }
        if ($PSBoundParameters.ContainsKey('Scenario') -and $recScenario -notlike $Scenario) { continue }

        $recStatus = if ($rec.PSObject.Properties['Status']) { [string]$rec.Status } else { '' }
        if ($PSBoundParameters.ContainsKey('Status') -and $recStatus -notlike $Status) { continue }

        [AICallLogEntry]@{
            ID          = if ($rec.PSObject.Properties['ID'])          { [int]$rec.ID }          else { 0 }
            Datetime    = $dt
            Scenario    = $recScenario
            PromptID    = if ($rec.PSObject.Properties['PromptID'])    { [string]$rec.PromptID } else { '' }
            PromptStart = if ($rec.PSObject.Properties['PromptStart']) { [string]$rec.PromptStart } else { '' }
            RetryCount  = if ($rec.PSObject.Properties['RetryCount'])  { [int]$rec.RetryCount }  else { 0 }
            Status      = $recStatus
            # t/4088 fields; lines written before them read as ''.
            Model       = if ($rec.PSObject.Properties['Model'])       { [string]$rec.Model }       else { '' }
            Backend     = if ($rec.PSObject.Properties['Backend'])     { [string]$rec.Backend }     else { '' }
            KeySource   = if ($rec.PSObject.Properties['KeySource'])   { [string]$rec.KeySource }   else { '' }
        }
    }
}
