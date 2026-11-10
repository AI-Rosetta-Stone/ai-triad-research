# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Three-state gate verdict convention (t/4496): PASS, FAIL or GATE-UNREADABLE.
.DESCRIPTION
    A warn-only gate that cannot read its target (403, missing file, auth failure) used to look the
    same in CI as one that passed clean: both exit 0, both leave the step green. The share-freshness
    gate ran green for an unknown period while getting a 403 (t/4390). This helper makes the third
    outcome explicit and machine-readable:

      PASS             the gate read real content and found nothing wrong.
      FAIL             the gate read real content and found the condition it checks for.
      GATE-UNREADABLE  the gate could not read its target, so it has NO verdict. Always carries a
                       reason. This is neither a pass nor a fail, and must never be read as either.

    Contract (the same in gate-verdict.mjs, the JavaScript / github-script twin):
      - step output   verdict=<PASS|FAIL|GATE-UNREADABLE>, reason=<one line>, gate=<name>
                      (written to $GITHUB_OUTPUT, so `steps.<id>.outputs.verdict` is readable)
      - step summary  one markdown block per verdict (appended to $GITHUB_STEP_SUMMARY)
      - annotation    PASS: plain line. FAIL and GATE-UNREADABLE: ::warning:: (warn-only gates
                      never fail the step; the verdict, not the exit code, carries the signal).

    Pure core: New-GateVerdict, Get-GateReadFailureReason, Format-GateVerdictSummary and
    Format-GateVerdictOutput do no I/O. Write-GateVerdict is the thin writer.
    Promotion of a gate that uses this to blocking: docs/CodeReview/gate-signal-integrity.md rule 3.

    Dot-source to use:  . (Join-Path $PSScriptRoot 'GateVerdict.ps1')
#>

Set-StrictMode -Version Latest

# Canonical actionable-error helper (never a bare `throw`, root AGENTS.md).
. (Join-Path $PSScriptRoot '..' '..' 'scripts' 'AITriad' 'Private' 'New-ActionableError.ps1')

$script:GateVerdictValues = @('PASS', 'FAIL', 'GATE-UNREADABLE')

function ConvertTo-GateVerdictLine {
    # One line, no control characters: step outputs are `key=value` lines, and an embedded newline
    # would end the value early (and could inject a second key).
    param([AllowNull()][AllowEmptyString()][string] $Text)
    if ($null -eq $Text) { return '' }
    return (($Text -replace '[\r\n\t]+', ' ') -replace '\s{2,}', ' ').Trim()
}

function New-GateVerdict {
    <#
    .SYNOPSIS
        PURE. Build a gate verdict object: @{ Gate; Verdict; Reason; Details }.
    .DESCRIPTION
        GATE-UNREADABLE requires a non-empty -Reason: an unreadable verdict with no reason is exactly
        the silent signal this convention exists to remove. PASS and FAIL may omit it.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Gate,
        [Parameter(Mandatory)] [ValidateSet('PASS', 'FAIL', 'GATE-UNREADABLE')] [string] $Verdict,
        [AllowEmptyString()] [string] $Reason = '',
        [AllowEmptyCollection()] [string[]] $Details = @()
    )
    if ($Verdict -eq 'GATE-UNREADABLE' -and [string]::IsNullOrWhiteSpace($Reason)) {
        New-ActionableError -Goal "Record a GATE-UNREADABLE verdict for gate '$Gate' (t/4496)" `
            -Problem 'GATE-UNREADABLE was requested with no reason. An unreadable verdict must say why the target could not be read.' `
            -Location 'New-GateVerdict (operations/devops/GateVerdict.ps1)' `
            -NextSteps @(
                'Pass -Reason with the read failure, e.g. (Get-GateReadFailureReason -ErrorText $stderr).',
                'If the target WAS read, the verdict is PASS or FAIL, not GATE-UNREADABLE.'
            ) -ErrorType 'GateVerdictMissingReason' -Throw
    }
    return [PSCustomObject]@{
        Gate    = $Gate
        Verdict = $Verdict
        Reason  = (ConvertTo-GateVerdictLine $Reason)
        Details = @($Details | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
}

function Get-GateReadFailureReason {
    <#
    .SYNOPSIS
        PURE. Turn a failed read's error text (az / REST stderr, an exception message) into a short,
        classified reason for a GATE-UNREADABLE verdict. The raw text is kept, truncated.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()] [AllowEmptyString()] [string] $ErrorText,
        [int] $MaxLength = 300
    )
    $raw = ConvertTo-GateVerdictLine $ErrorText
    $class = switch -Regex ($raw) {
        '\b403\b|Forbidden|AuthorizationFailed|AuthorizationPermissionMismatch|does not have authorization|does not have .+permission' { 'access denied (403)'; break }
        '\b401\b|Unauthorized|AuthenticationFailed|AADSTS\d+|az login|token .*expired' { 'authentication failed (401)'; break }
        '\b404\b|ResourceNotFound|NotFound|does not exist|not found|No such file' { 'target not found (404)'; break }
        '\b429\b|TooManyRequests|throttl|rate limit' { 'throttled (429)'; break }
        'timed out|timeout|ServiceUnavailable|\b503\b|\b502\b|ServerBusy' { 'service unavailable or timed out'; break }
        default { 'read failed' }
    }
    if ([string]::IsNullOrWhiteSpace($raw)) { return "$class (no error text captured)" }
    if ($raw.Length -gt $MaxLength) { $raw = $raw.Substring(0, $MaxLength) + '...' }
    return "${class}: $raw"
}

function Format-GateVerdictOutput {
    <#
    .SYNOPSIS
        PURE. The $GITHUB_OUTPUT lines for a verdict: gate=, verdict=, reason= (each one line).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [pscustomobject] $Verdict)
    return @(
        "gate=$(ConvertTo-GateVerdictLine $Verdict.Gate)"
        "verdict=$($Verdict.Verdict)"
        "reason=$(ConvertTo-GateVerdictLine $Verdict.Reason)"
    )
}

function Format-GateVerdictSummary {
    <#
    .SYNOPSIS
        PURE. The $GITHUB_STEP_SUMMARY markdown block for a verdict.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [pscustomobject] $Verdict)
    $meaning = switch ($Verdict.Verdict) {
        'PASS'            { 'read the target; nothing wrong found' }
        'FAIL'            { 'read the target; found the condition this gate checks for' }
        'GATE-UNREADABLE' { 'could NOT read the target; this is no verdict, not a pass' }
    }
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("### Gate verdict: $($Verdict.Gate)")
    $lines.Add('')
    $lines.Add("**$($Verdict.Verdict)** ($meaning)")
    if ($Verdict.Reason) {
        $lines.Add('')
        $lines.Add("Reason: $($Verdict.Reason)")
    }
    foreach ($d in @($Verdict.Details)) { $lines.Add("- $(ConvertTo-GateVerdictLine $d)") }
    $lines.Add('')
    return ($lines -join "`n")
}

function Write-GateVerdict {
    <#
    .SYNOPSIS
        Thin writer: append the verdict to the step summary and step output, and print one line.
    .DESCRIPTION
        Paths default to $env:GITHUB_STEP_SUMMARY / $env:GITHUB_OUTPUT. When one is unset (a local
        run), that sink is skipped with a WARN saying so. Never throws on a sink write failure
        either: the verdict line is still printed, with a WARN naming the failed sink, because a
        reporting fault must not turn into a silent verdict.
        -SuppressAnnotations prints `GATE-VERDICT ...` lines instead of ::warning:: annotations, for
        test subprocesses.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [pscustomobject] $Verdict,
        [AllowEmptyString()] [string] $SummaryPath = $env:GITHUB_STEP_SUMMARY,
        [AllowEmptyString()] [string] $OutputPath = $env:GITHUB_OUTPUT,
        [switch] $SuppressAnnotations
    )
    $line = "$($Verdict.Gate): $($Verdict.Verdict)"
    if ($Verdict.Reason) { $line += " - $($Verdict.Reason)" }

    if ($Verdict.Verdict -eq 'PASS' -or $SuppressAnnotations) {
        Write-Host "GATE-VERDICT $line"
    } else {
        Write-Host "::warning title=$($Verdict.Verdict)::$line"
    }

    $sinks = @(
        @{ Name = 'GITHUB_STEP_SUMMARY'; Path = $SummaryPath; Text = (Format-GateVerdictSummary -Verdict $Verdict) }
        @{ Name = 'GITHUB_OUTPUT'; Path = $OutputPath; Text = ((Format-GateVerdictOutput -Verdict $Verdict) -join "`n") }
    )
    foreach ($s in $sinks) {
        if ([string]::IsNullOrWhiteSpace($s.Path)) {
            Write-Host "WARN: $($s.Name) is not set (local run?) - gate verdict not written there, console line only."
            continue
        }
        try {
            Add-Content -LiteralPath $s.Path -Value $s.Text -Encoding utf8 -ErrorAction Stop
        } catch {
            Write-Host "WARN: could not write the gate verdict to $($s.Name) ($($s.Path)): $($_.Exception.Message)"
        }
    }
}
