# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

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
    $FailedCount        = $null
    $VitestFailedCount  = $null

    # vitest's colour codes arrive either as real ESC bytes or as the literal text "^[" (how gh
    # renders them); strip both (t/4271).
    $AnsiPattern = '(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]'
    # vitest marks a failure location with U+276F; kept out of the source so it stays ASCII.
    $LocationMark = [string][char]0x276F

    # gh prefixes each line with "job<TAB>step<TAB>timestamp "; strip a leading
    # "<stuff>##[error]" and any leading timestamp so matching is prefix-agnostic.
    $Lines = $LogText -split "\r?\n"
    $InAssertionBlock = $false
    # vitest state: inside the "Failed Tests N" / "Failed Suites N" block, and the FAIL entries
    # still waiting for their error line / location. vitest groups failures with an identical
    # error under one error, so several entries can be pending at once.
    $InVitestBlock = $false
    $PendingError = [System.Collections.Generic.List[object]]::new()
    $PendingLocation = [System.Collections.Generic.List[object]]::new()

    foreach ($Raw in $Lines) {
        # `gh run view --log` prefixes each line with "job<TAB>step<TAB>ISO-timestamp ".
        # Strip up to and including that timestamp so content matches cleanly (no-op when
        # the caller pipes an already-clean log).
        $Line = (($Raw -replace $AnsiPattern, '') -replace '^.*?\d{4}-\d{2}-\d{2}T[0-9:.]+Z\s+', '').Trim()
        if ([string]::IsNullOrWhiteSpace($Line)) { continue }

        # vitest run summary: "Tests  2 failed | 11637 passed ...". Checked before the block
        # logic because it also ends the failure block.
        if ($Line -match '^Tests\s+(\d+)\s+failed\b') {
            $VitestFailedCount = [int]$Matches[1]
            $InVitestBlock = $false
            continue
        }
        if ($Line -match '^Test Files\s+\d+\s+failed\b') { $InVitestBlock = $false; continue }
        if ($Line -match 'Failed (?:Tests|Suites) \d+') { $InVitestBlock = $true; continue }

        if ($InVitestBlock) {
            # "FAIL  <file> > <describe> > <test>"; a suite-level failure has no " > " part and
            # may end with " [ <file> ]".
            if ($Line -match '^FAIL\s+(.+)$') {
                $Spec = ($Matches[1] -replace '\s+\[\s*[^\]]*\]\s*$', '').Trim()
                $Parts = @($Spec -split '\s+>\s+')
                $Entry = [PSCustomObject]@{
                    PSTypeName = 'AITriad.CITestFailure'
                    Runner     = 'vitest'
                    File       = $Parts[0]
                    TestName   = if ($Parts.Count -gt 1) { $Parts[-1] } else { $null }
                    Suite      = if ($Parts.Count -gt 2) { ($Parts[1..($Parts.Count - 2)] -join ' > ') } else { $null }
                    FullName   = $Spec
                    Error      = $null
                    Location   = $null
                }
                $VitestFailures.Add($Entry)
                $FailingTests.Add($Spec)
                $PendingError.Add($Entry)
                continue
            }
            if ($PendingError.Count -gt 0) {
                # The first line after the FAIL line(s) is the error message.
                foreach ($E in $PendingError) { $E.Error = $Line }
                $PendingLocation.AddRange($PendingError)
                $PendingError.Clear()
                continue
            }
            if ($PendingLocation.Count -gt 0 -and $Line.StartsWith($LocationMark) -and
                $Line -match '\s(\S+:\d+:\d+)\s*$') {
                foreach ($E in $PendingLocation) { $E.Location = $Matches[1] }
                $PendingLocation.Clear()
                continue
            }
            # Diff, code frame and separator lines belong to the failure; nothing else to take.
            continue
        }

        # A Pester FAILING test line: "[-] <name> <ms>", optionally prefixed with ##[error].
        if ($Line -match '\[-\]\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*ms)?\s*$') {
            $Name = ($Matches[1] -replace '^.*##\[error\]', '').Trim()
            $FailingTests.Add($Name)
            $PesterFailureLines.Add(($Line -replace '^.*##\[error\]', '').Trim())
            $InAssertionBlock = $true
            continue
        }

        # Assertion detail that belongs to the failing test just above it.
        if ($InAssertionBlock -and
            $Line -match 'Expected|But was|but got|Should\s|##\[group\]Message|at .+:\d+') {
            $PesterFailureLines.Add(($Line -replace '^.*##\[error\]', '').Trim())
            continue
        }
        $InAssertionBlock = $false

        # Pester's own run summary — pull the failed count if present.
        if ($Line -match 'Tests? (?:Passed|completed).*Failed:\s*(\d+)' -or
            $Line -match 'Failed:\s*(\d+)\b') {
            $FailedCount = [int]$Matches[1]
            continue
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

    # vitest re-emits each failure's error as a GitHub "##[error]" annotation after the run; those
    # belong to a test, not to the infrastructure (t/4271).
    if ($VitestFailures.Count -gt 0) {
        $TestErrors = [System.Collections.Generic.HashSet[string]]::new([string[]]@($VitestFailures | ForEach-Object { $_.Error } | Where-Object { $_ }))
        $InfraErrorLines = @($InfraErrorLines | Where-Object { -not $TestErrors.Contains($_) })
    }

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
