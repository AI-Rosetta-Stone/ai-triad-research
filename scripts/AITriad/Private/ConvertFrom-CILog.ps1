# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-CILogContentLine {
    # Strip ANSI colour codes and gh's "job<TAB>step<TAB>ISO-timestamp " prefix, then trim.
    # No-op (beyond trim) when the caller pipes an already-clean log line.
    param(
        [AllowEmptyString()][string]$Raw,
        [string]$AnsiPattern
    )
    (($Raw -replace $AnsiPattern, '') -replace '^.*?\d{4}-\d{2}-\d{2}T[0-9:.]+Z\s+', '').Trim()
}

function Test-CIVitestBoundary {
    # vitest run-summary / block-boundary lines. Mutates $State (InVitestBlock,
    # VitestFailedCount) and returns $true when the line was fully handled.
    param($Line, $State)
    if ($Line -match '^Tests\s+(\d+)\s+failed\b') {
        $State.VitestFailedCount = [int]$Matches[1]
        $State.InVitestBlock = $false
        return $true
    }
    if ($Line -match '^Test Files\s+\d+\s+failed\b') { $State.InVitestBlock = $false; return $true }
    if ($Line -match 'Failed (?:Tests|Suites) \d+') { $State.InVitestBlock = $true; return $true }
    return $false
}

function New-CIVitestFailureEntry {
    # Build a vitest failure record from a "FAIL <file> > <describe> > <test>" spec.
    param($Spec)
    $Clean = ($Spec -replace '\s+\[\s*[^\]]*\]\s*$', '').Trim()
    $Parts = @($Clean -split '\s+>\s+')
    [PSCustomObject]@{
        PSTypeName = 'AITriad.CITestFailure'
        Runner     = 'vitest'
        File       = $Parts[0]
        TestName   = if ($Parts.Count -gt 1) { $Parts[-1] } else { $null }
        Suite      = if ($Parts.Count -gt 2) { ($Parts[1..($Parts.Count - 2)] -join ' > ') } else { $null }
        FullName   = $Clean
        Error      = $null
        Location   = $null
    }
}

function Add-CIVitestLine {
    # Consume one line inside the vitest "Failed Tests/Suites" block, filling the
    # pending FAIL entries with their shared error message and location.
    param($Line, $VitestFailures, $FailingTests, $PendingError, $PendingLocation, $LocationMark)
    if ($Line -match '^FAIL\s+(.+)$') {
        $Entry = New-CIVitestFailureEntry -Spec $Matches[1]
        $VitestFailures.Add($Entry)
        $FailingTests.Add($Entry.FullName)
        $PendingError.Add($Entry)
        return
    }
    if ($PendingError.Count -gt 0) {
        foreach ($E in $PendingError) { $E.Error = $Line }
        $PendingLocation.AddRange($PendingError)
        $PendingError.Clear()
        return
    }
    if ($PendingLocation.Count -gt 0 -and $Line.StartsWith($LocationMark) -and
        $Line -match '\s(\S+:\d+:\d+)\s*$') {
        foreach ($E in $PendingLocation) { $E.Location = $Matches[1] }
        $PendingLocation.Clear()
    }
}

function Update-CIPesterAndInfra {
    # Handle a non-vitest line: a Pester "[-]" failure, its assertion detail, the
    # Pester run summary, or a real "##[error]" infrastructure error. Mutates $State
    # (InAssertionBlock, FailedCount) and the given collections.
    param($Line, $State, $FailingTests, $PesterFailureLines, $InfraErrorLines)

    # A Pester FAILING test line: "[-] <name> <ms>", optionally prefixed with ##[error].
    if ($Line -match '\[-\]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*ms)?\s*$') {
        $Name = ($Matches[1] -replace '^.*##\[error\]', '').Trim()
        $FailingTests.Add($Name)
        $PesterFailureLines.Add(($Line -replace '^.*##\[error\]', '').Trim())
        $State.InAssertionBlock = $true
        return
    }

    # Assertion detail that belongs to the failing test just above it.
    if ($State.InAssertionBlock -and
        $Line -match 'Expected|But was|but got|Should\s|##\[group\]Message|at .+:\d+') {
        $PesterFailureLines.Add(($Line -replace '^.*##\[error\]', '').Trim())
        return
    }
    $State.InAssertionBlock = $false

    # Pester's own run summary — pull the failed count if present.
    if ($Line -match 'Tests? (?:Passed|completed).*Failed:\s*(\d+)' -or
        $Line -match 'Failed:\s*(\d+)\b') {
        $State.FailedCount = [int]$Matches[1]
        return
    }

    # Everything else carrying ##[error] that is NOT a test failure/assertion and NOT
    # the generic step-wrapper marker is a real infrastructure error.
    if ($Line -match '##\[error\]' -and
        $Line -notmatch '\[-\]' -and
        $Line -notmatch 'Process completed with exit code') {
        $Msg = ($Line -replace '^.*##\[error\]', '').Trim()
        if ($Msg) { $InfraErrorLines.Add($Msg) }
    }
}

function ConvertFrom-CILog {
    <#
    .SYNOPSIS
        Pure parser (t/2882): extract Pester failures and error lines from a gh run log.
    .DESCRIPTION
        Takes the raw text of a `gh run view --log`/`--log-failed` capture and returns a
        structured summary: the failing Pester test names, the raw `[-]` failure lines
        plus their assertion detail (test-emitted), and the remaining `##[error]` lines
        (real infrastructure errors — a failed step, a module-load error, etc.).

        vitest failures (t/4271) are read from the "Failed Tests N" block: each one becomes a
        VitestFailures entry (Runner, File, Suite, TestName, FullName, Error, Location), and its
        "<file> > <describe> > <test>" name is added to FailingTests. ANSI colour codes are
        stripped first, and vitest's trailing "##[error]" copies of a test's error are kept out
        of InfraErrorLines. FailedCount adds vitest's "Tests N failed" to Pester's count.

        Pure by design (no gh call) so it is unit-testable against synthetic log text.
    .PARAMETER LogText
        The captured CI log text.
    .PARAMETER FailedJobs
        Optional list of failed job names (from `gh run view --json jobs`), echoed through.
    .OUTPUTS
        [PSCustomObject] with FailedJobs, FailingTests, PesterFailureLines, VitestFailures,
        InfraErrorLines, FailedCount.
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$LogText,

        [Parameter()]
        [string[]]$FailedJobs = @()
    )

    Set-StrictMode -Version Latest

    $FailingTests       = [System.Collections.Generic.List[string]]::new()
    $PesterFailureLines = [System.Collections.Generic.List[string]]::new()
    $InfraErrorLines    = [System.Collections.Generic.List[string]]::new()
    $VitestFailures     = [System.Collections.Generic.List[object]]::new()

    # Mutable parse state, shared with the per-line helpers (hashtable is passed by reference).
    $State = @{
        InVitestBlock     = $false
        InAssertionBlock  = $false
        FailedCount       = $null
        VitestFailedCount = $null
    }

    # vitest's colour codes arrive either as real ESC bytes or as the literal text "^[" (how gh
    # renders them); strip both (t/4271).
    $AnsiPattern = '(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]'
    # vitest marks a failure location with U+276F; kept out of the source so it stays ASCII.
    $LocationMark = [string][char]0x276F

    # gh prefixes each line with "job<TAB>step<TAB>timestamp "; strip a leading
    # "<stuff>##[error]" and any leading timestamp so matching is prefix-agnostic.
    $Lines = $LogText -split "\r?\n"
    # vitest state: FAIL entries still waiting for their error line / location. vitest groups
    # failures with an identical error under one error, so several entries can be pending at once.
    $PendingError = [System.Collections.Generic.List[object]]::new()
    $PendingLocation = [System.Collections.Generic.List[object]]::new()

    foreach ($Raw in $Lines) {
        $Line = Get-CILogContentLine -Raw $Raw -AnsiPattern $AnsiPattern
        if ([string]::IsNullOrWhiteSpace($Line)) { continue }

        # vitest run summary / block boundaries are checked first because they also end the block.
        if (Test-CIVitestBoundary -Line $Line -State $State) { continue }

        if ($State.InVitestBlock) {
            Add-CIVitestLine -Line $Line -VitestFailures $VitestFailures -FailingTests $FailingTests `
                -PendingError $PendingError -PendingLocation $PendingLocation -LocationMark $LocationMark
            continue
        }

        Update-CIPesterAndInfra -Line $Line -State $State -FailingTests $FailingTests `
            -PesterFailureLines $PesterFailureLines -InfraErrorLines $InfraErrorLines
    }

    # vitest re-emits each failure's error as a GitHub "##[error]" annotation after the run; those
    # belong to a test, not to the infrastructure (t/4271).
    if ($VitestFailures.Count -gt 0) {
        $TestErrors = [System.Collections.Generic.HashSet[string]]::new([string[]]@($VitestFailures | ForEach-Object { $_.Error } | Where-Object { $_ }))
        $InfraErrorLines = @($InfraErrorLines | Where-Object { -not $TestErrors.Contains($_) })
    }

    $FailedCount       = $State.FailedCount
    $VitestFailedCount = $State.VitestFailedCount
    # Pester and vitest counts can both be present when --log-failed spans several jobs.
    if ($null -ne $VitestFailedCount) {
        $FailedCount = if ($null -ne $FailedCount) { $FailedCount + $VitestFailedCount } else { $VitestFailedCount }
    }

    return [PSCustomObject]@{
        FailedJobs         = @($FailedJobs)
        FailingTests       = @($FailingTests)
        PesterFailureLines = @($PesterFailureLines)
        VitestFailures     = @($VitestFailures)
        InfraErrorLines    = @($InfraErrorLines)
        FailedCount        = $FailedCount
    }
}
