# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Pulls production taxonomy-editor server logs from Azure Log Analytics by time window /
    requestId / pattern, parsing Pino JSON fields.
.DESCRIPTION
    Where Get-ServerLog wraps the shallow `az containerapp logs show` live-tail buffer, this
    cmdlet queries Log Analytics directly (`az monitor log-analytics query`) for history deeper
    than the buffer — the evidence source the t/3078 debate-500 diagnosis had to hand-write KQL for.

    Queries ContainerAppConsoleLogs_CL (or ContainerAppSystemLogs_CL with -System), filters by
    time window (default: last 15 min), requestId, and/or a substring pattern, then parses each
    row's Log_s (the raw Pino JSON line) into structured fields: Level, RequestId, Component,
    Method, Path, Status, DurationMs, Message. Non-JSON / boundary-sliced lines (t/2860) are still
    surfaced as rows with Level='unparsed' so no evidence is lost, and counted.

    Requires the az CLI logged in with reader access to the Log Analytics workspace. No AI calls.

    Auth: the workspace customerId is resolved once (first workspace named 'log-aitriad*' in the
    resource group) and cached for the session; override with $env:TAXEDITOR_LOG_WORKSPACE_ID.
.PARAMETER From
    Lower bound of the window (UTC-compared). Default: 15 minutes before -To.
.PARAMETER To
    Upper bound. Default: now (UTC).
.PARAMETER RequestId
    Correlate one request end-to-end. Console logs only (system logs are not per-request).
.PARAMETER Pattern
    Case-insensitive substring matched server-side against the raw log line (KQL `contains`).
.PARAMETER App
    Container app to query (ContainerAppName_s). Default 'taxonomy-editor'.
.PARAMETER System
    Query ContainerAppSystemLogs_CL (revision/replica/restart events) instead of console logs.
    System rows are emitted raw (Type/Reason/Message), not Pino-parsed.
.PARAMETER ResourceGroup
    Azure resource group. Default 'ai-triad'.
.PARAMETER Max
    Row cap (KQL `take`). Default 1000.
.PARAMETER Raw
    Emit the raw Log_s string per row instead of a structured object (console mode only).
.OUTPUTS
    [PSCustomObject] AITriad.ServerLogEntry (console) or AITriad.ServerSystemLogEntry (-System),
    or raw strings with -Raw.
.EXAMPLE
    Get-TaxEditorServerLogs -From (Get-Date).AddHours(-1) -Pattern '500'
    # Every line containing '500' in the last hour.
.EXAMPLE
    Get-TaxEditorServerLogs -RequestId req-6f1c... -From (Get-Date).AddHours(-6)
    # Trace one request across the deeper Log Analytics history.
.EXAMPLE
    Get-TaxEditorServerLogs -System -From (Get-Date).AddHours(-2)
    # Revision/replica/restart events (e.g. correlate a 500 spike with a restart).
.LINK
    Get-ServerLog
.LINK
    Get-DebateRateLimitSummary
.LINK
    Show-AITriadHelp
#>
function Get-TaxEditorServerLogs {
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter()]
        [datetime]$From,

        [Parameter()]
        [datetime]$To,

        [Parameter()]
        [string]$RequestId,

        [Parameter()]
        [string]$Pattern,

        [Parameter()]
        [ValidateSet('taxonomy-editor', 'taxonomy-editor-staging')]
        [string]$App = 'taxonomy-editor',

        [Parameter()]
        [switch]$System,

        [Parameter()]
        [string]$ResourceGroup = 'ai-triad',

        [Parameter()]
        [ValidateRange(1, 50000)]
        [int]$Max = 1000,

        [Parameter()]
        [switch]$Raw
    )

    process {
        Set-StrictMode -Version Latest

        Assert-AzCli -CallerName 'Get-TaxEditorServerLogs'

        # ── Window (default last 15 min) ──────────────────────────────────
        $toUtc   = if ($PSBoundParameters.ContainsKey('To'))   { $To.ToUniversalTime() }   else { [datetime]::UtcNow }
        $fromUtc = if ($PSBoundParameters.ContainsKey('From')) { $From.ToUniversalTime() } else { $toUtc.AddMinutes(-15) }
        if ($fromUtc -gt $toUtc) {
            throw (New-ActionableError -AsErrorRecord `
                -Goal     'Query server logs over a time window' `
                -Problem  "-From ($fromUtc) is after -To ($toUtc)." `
                -Location 'Get-TaxEditorServerLogs' `
                -NextSteps @('Pass -From earlier than -To, or omit both for the last 15 minutes.'))
        }

        # ── Resolve + cache the Log Analytics workspace customerId ─────────
        $workspaceId = if ($env:TAXEDITOR_LOG_WORKSPACE_ID) {
            $env:TAXEDITOR_LOG_WORKSPACE_ID
        } elseif ((Test-Path variable:script:TaxEditorLogWorkspaceId) -and $script:TaxEditorLogWorkspaceId) {
            # StrictMode-safe: the cache var is unset until the az-resolve path below runs once, so
            # existence-guard before reading it — a bare reference throws on fresh import (t/3427).
            $script:TaxEditorLogWorkspaceId
        } else {
            $wsRaw = Invoke-Az -CallerName 'Get-TaxEditorServerLogs' -Arguments @(
                'monitor', 'log-analytics', 'workspace', 'list',
                '--resource-group', $ResourceGroup,
                '--query', "[?starts_with(name,'log-aitriad')].customerId | [0]",
                '--output', 'tsv')
            $wsId = if ($wsRaw) { ([string]$wsRaw).Trim() } else { $null }
            if ([string]::IsNullOrWhiteSpace($wsId)) {
                throw (New-ActionableError -AsErrorRecord `
                    -Goal     'Resolve the Log Analytics workspace for the container app' `
                    -Problem  "No workspace named 'log-aitriad*' found in resource group '$ResourceGroup'." `
                    -Location 'Get-TaxEditorServerLogs' `
                    -NextSteps @(
                        "List workspaces: az monitor log-analytics workspace list -g $ResourceGroup -o table"
                        'Or set $env:TAXEDITOR_LOG_WORKSPACE_ID to the workspace customerId (GUID).'
                    ))
            }
            $script:TaxEditorLogWorkspaceId = $wsId
            $wsId
        }

        # ── Build the KQL (single-quote escape every interpolated value) ───
        $esc = { param($s) if ($null -eq $s) { '' } else { ([string]$s).Replace('\', '\\').Replace("'", "\'") } }
        $fromZ = $fromUtc.ToString('yyyy-MM-ddTHH:mm:ssZ')
        $toZ   = $toUtc.ToString('yyyy-MM-ddTHH:mm:ssZ')
        $table = if ($System) { 'ContainerAppSystemLogs_CL' } else { 'ContainerAppConsoleLogs_CL' }

        $kql = [System.Collections.Generic.List[string]]::new()
        $kql.Add($table)
        $kql.Add("| where ContainerAppName_s == '$(& $esc $App)'")
        # t/3117: MUST be todatetime('<iso>'), NOT datetime('<iso>'). KQL's datetime() literal is
        # unquoted (datetime(2026-08-28T…)); wrapping a QUOTED string in datetime() silently fails to
        # constrain the `between`, so the query returns full Log Analytics retention (116K rows, timeout)
        # AND leaks out-of-window rows into results. todatetime() is the string→datetime conversion fn.
        $kql.Add("| where TimeGenerated between (todatetime('$fromZ') .. todatetime('$toZ'))")

        if ($RequestId) {
            if ($System) {
                Write-Warning '-RequestId is ignored with -System (system logs are not per-request).'
            } else {
                if ($RequestId -notmatch '^[\w.:\-]+$') {
                    throw (New-ActionableError -AsErrorRecord `
                        -Goal     'Filter server logs by requestId' `
                        -Problem  "RequestId '$RequestId' contains characters outside the allowed set [A-Za-z0-9._:-]." `
                        -Location 'Get-TaxEditorServerLogs' `
                        -NextSteps @('Pass the requestId as emitted by the server (e.g. req-<uuid>).'))
                }
                $kql.Add("| where Log_s has '$(& $esc $RequestId)'")
            }
        }
        if ($Pattern) { $kql.Add("| where Log_s contains '$(& $esc $Pattern)'") }

        if ($System) { $kql.Add('| project TimeGenerated, Log_s, Type_s, Reason_s, RevisionName_s') }
        else         { $kql.Add('| project TimeGenerated, Log_s, RevisionName_s') }
        # t/3150: order DESC then take, so the cap keeps the NEWEST $Max rows. (asc+take silently
        # returned the OLDEST $Max and dropped the most recent events — a triage footgun; the
        # silent-wrong-subset class, same as t/3117.) The set is re-sorted ascending below for
        # chronological display; the emitted row shape is unchanged.
        $kql.Add('| order by TimeGenerated desc')
        $kql.Add("| take $Max")
        # t/3117: MUST be a SINGLE LINE (join with space, not newline). The query is passed inline
        # as one `--analytics-query` arg to `& az`; an embedded newline truncates the arg at the
        # PowerShell→az native-command boundary, so az receives only the first line
        # (`ContainerAppConsoleLogs_CL`) and dumps the whole table — every where/project/order/take
        # clause is silently lost (Diagnostics proof: multi-line → 116k full dump; single-line → 3
        # in-window rows). KQL is whitespace-insensitive between `|` stages, so space-join is valid.
        $analyticsQuery = $kql -join ' '
        Write-Verbose "KQL (single-line arg to az): $analyticsQuery"

        # ── Run the query ─────────────────────────────────────────────────
        $json = Invoke-Az -CallerName 'Get-TaxEditorServerLogs' -Arguments @(
            'monitor', 'log-analytics', 'query',
            '--workspace', $workspaceId,
            '--analytics-query', $analyticsQuery,
            '--output', 'json')
        $rows = if ($json) { @($json | ConvertFrom-Json) } else { @() }

        # t/3150: the query returns the NEWEST $Max (desc+take); re-sort ascending for chronological
        # display (TimeGenerated is ISO-8601 → a lexical sort is chronological). Warn on a cap hit —
        # older events in the window were dropped; never silently return a wrong subset.
        $rows = @($rows | Sort-Object { [string]$_.TimeGenerated })
        if ($rows.Count -ge $Max) {
            Write-Warning "Hit the -Max cap ($Max): the window has at least $Max matching lines — showing the NEWEST $Max; older events were dropped. Narrow -From/-To or raise -Max to see them."
        }

        # ── StrictMode-safe field read (absent property -> $null) ──────────
        $getField = {
            param($obj, [string]$name)
            if ($null -eq $obj) { return $null }
            $p = $obj.PSObject.Properties[$name]
            if ($p) { return $p.Value } else { return $null }
        }
        $parseTime = {
            param($iso)
            if ([string]::IsNullOrWhiteSpace($iso)) { return $null }
            # t/3129: Log Analytics TimeGenerated is UTC, but `az --output json | ConvertFrom-Json`
            # yields a timezone-NAIVE value. A bare Parse() assumes LOCAL time, so on a DST-observing
            # machine it applies the summer offset then .UtcDateTime subtracts it → Time shifted by the
            # offset (e.g. 06:42Z shown as 05:42 on BST). AssumeUniversal parses the naive value as UTC.
            try { return [datetimeoffset]::Parse([string]$iso, $null, [System.Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime } catch { return [string]$iso }
        }

        # ── System logs: emit raw rows, no Pino parse ──────────────────────
        if ($System) {
            foreach ($row in $rows) {
                [PSCustomObject]@{
                    PSTypeName = 'AITriad.ServerSystemLogEntry'
                    Time       = & $parseTime (& $getField $row 'TimeGenerated')
                    Type       = & $getField $row 'Type_s'
                    Reason     = & $getField $row 'Reason_s'
                    Revision   = & $getField $row 'RevisionName_s'
                    Message    = & $getField $row 'Log_s'
                }
            }
            return
        }

        # ── Console logs: parse Log_s as Pino JSON ─────────────────────────
        $pinoLevelMap = @{ 10 = 'trace'; 20 = 'debug'; 30 = 'info'; 40 = 'warn'; 50 = 'error'; 60 = 'fatal' }
        $unparsed = 0

        foreach ($row in $rows) {
            $logStr = & $getField $row 'Log_s'
            $tg     = & $getField $row 'TimeGenerated'
            $rev    = & $getField $row 'RevisionName_s'
            if ([string]::IsNullOrWhiteSpace($logStr)) { continue }

            if ($Raw) { Write-Output ([string]$logStr); continue }

            $entry = $null
            try { $entry = [string]$logStr | ConvertFrom-Json -ErrorAction Stop } catch { }

            if ($null -eq $entry) {
                # Boundary-sliced (t/2860) or non-JSON stdout — surface it, don't drop it.
                $unparsed++
                [PSCustomObject]@{
                    PSTypeName = 'AITriad.ServerLogEntry'
                    Time       = & $parseTime $tg
                    Level      = 'unparsed'
                    RequestId  = $null
                    Component  = $null
                    Method     = $null
                    Path       = $null
                    Status     = $null
                    DurationMs = $null
                    Message    = [string]$logStr
                    Revision   = $rev
                    Raw        = [string]$logStr
                }
                continue
            }

            $entryRequestId = & $getField $entry 'requestId'
            # KQL `has` is token-coarse; confirm the exact requestId on the parsed field.
            if ($RequestId -and $entryRequestId -ne $RequestId) { continue }

            $entryLevel = & $getField $entry 'level'
            $levelName  = if ($null -ne $entryLevel -and $pinoLevelMap.ContainsKey([int]$entryLevel)) {
                $pinoLevelMap[[int]$entryLevel]
            } else { "$entryLevel" }

            [PSCustomObject]@{
                PSTypeName = 'AITriad.ServerLogEntry'
                Time       = & $parseTime $tg
                Level      = $levelName
                RequestId  = $entryRequestId
                Component  = & $getField $entry 'component'
                Method     = & $getField $entry 'method'
                Path       = & $getField $entry 'path'
                Status     = & $getField $entry 'status'
                DurationMs = & $getField $entry 'duration_ms'
                Message    = & $getField $entry 'msg'
                Revision   = $rev
                Raw        = $entry
            }
        }

        if ($unparsed -gt 0) {
            Write-Warning ("{0} log line(s) were unparseable (emitted with Level='unparsed') — likely Pino lines sliced at Azure's ~16KB Fluent Bit boundary (t/2860)." -f $unparsed)
        }
    }
}
