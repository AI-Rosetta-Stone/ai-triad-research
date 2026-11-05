# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Static check (t/4850): a caller's literal argument to a bounded-retry parameter
    (one declared [ValidateRange(...)]) must fall inside that parameter's declared range.

.DESCRIPTION
    t/4842 incident: `Wait-MountReady -MaxAttempts` was declared [ValidateRange(1,20)].
    t/4760 raised every caller to `-MaxAttempts 22` without touching the declaration, so
    the very first call threw ParameterBindingValidationException on both environments.
    The gate's own catch block treated this as a fail-closed "gate defect", rolling back
    4 separate healthy prod revisions over ~4.5h before #4458 raised the range to 30.

    #4458 closed that one VECTOR (20 -> 30). This closes the CLASS: nothing stops a future
    caller from raising a literal past whatever the declared ceiling is and reproducing the
    identical failure shape with a different number. This file is dot-sourced by
    tests/Get-BoundedRetryRangeDrift.Tests.ps1, which runs inside the already-required
    test-powershell CI gate (same mechanism as TrivyIgnoreRevisitLint.ps1, t/3539#2 Option C
    -- an assertion inside an existing blocking suite, not a new gate).

    Deliberately NOT a hardcoded table of function/param/range triples: that would just move
    the drift risk from "callers vs. declaration" to "this lint's table vs. declaration".
    Instead both sides are parsed from the real source on every run:

    1. Get-DeclaredBoundedRetryRange scans a .ps1 file's own text for
       `[ValidateRange(min,max)]` attributes and the parameter name they guard, per function.
    2. Get-CallerBoundedRetryLiteral scans a caller file's (.yml or .ps1) text for
       `-ParamName <int-literal>` immediately following one of the known function names, and
       returns ONLY literal values -- a caller passing a variable (e.g. `-MaxAttempts $N`)
       isn't checked here, because its value isn't knowable statically; that's an accepted gap,
       not a false "clean".
    3. Get-BoundedRetryRangeGap cross-references the two: a caller literal outside its
       parameter's declared [Min,Max] is a gap. A caller literal for a function/param pair
       with NO declared ValidateRange is skipped (fail-open -- nothing to check it against).

    `[int]::MaxValue` as a declared upper bound means "no real ceiling" and is represented as
    $null -- the upper-bound check is skipped for that parameter, matching the semantics (e.g.
    Get-MountReadinessVerdict's own $Attempt/$MaxAttempts, as opposed to Wait-MountReady's
    actual retry-loop ceiling).
#>

Set-StrictMode -Version Latest

function Get-DeclaredBoundedRetryRange {
    <#
    .SYNOPSIS
        Returns every {Function; Param; Min; Max} declared via [ValidateRange(...)] in the
        given PowerShell source lines. Max is $null when the declared ceiling is
        [int]::MaxValue (no real bound to check against).
    #>
    [CmdletBinding()]
    param(
        [string[]]$Line,
        [string]$Path
    )

    if ($null -eq $Line) {
        $Line = @(Get-Content -LiteralPath $Path)
    }

    $declared = [System.Collections.Generic.List[object]]::new()
    $currentFunction = $null

    foreach ($text in $Line) {
        $fnMatch = [regex]::Match($text, '^\s*function\s+([A-Za-z0-9_-]+)')
        if ($fnMatch.Success) {
            $currentFunction = $fnMatch.Groups[1].Value
            continue
        }
        if ([string]::IsNullOrEmpty($currentFunction)) { continue }

        $rangeMatch = [regex]::Match($text, '\[ValidateRange\(\s*([^,\)]+?)\s*,\s*([^,\)]+?)\s*\)\]')
        if (-not $rangeMatch.Success) { continue }

        # The parameter name on the SAME line as the attribute -- true for every bounded-retry
        # declaration in this codebase today (attribute and $param are never split across lines).
        $paramMatch = [regex]::Match($text, '\$(\w+)')
        if (-not $paramMatch.Success) { continue }

        $minToken = $rangeMatch.Groups[1].Value.Trim()
        $maxToken = $rangeMatch.Groups[2].Value.Trim()

        $min = $null
        if ($minToken -match '^-?\d+$') { $min = [int]$minToken }
        $max = $null
        if ($maxToken -match '^-?\d+$') { $max = [int]$maxToken }
        # else ([int]::MaxValue, or anything else unparseable): leave $null -- no real/knowable
        # ceiling to flag a caller literal against. Fail-open, not a guess.

        if ($null -eq $min -and $null -eq $max) { continue }

        $declared.Add([pscustomobject]@{
            Function = $currentFunction
            Param    = $paramMatch.Groups[1].Value
            Min      = $min
            Max      = $max
        })
    }

    return $declared.ToArray()
}

function Get-CallerBoundedRetryLiteral {
    <#
    .SYNOPSIS
        Returns every {Function; Param; Value; LineNumber} where one of the given function
        names is invoked with a literal int argument to a named parameter, on the same line
        (how every call site in this codebase is written today).
    #>
    [CmdletBinding()]
    param(
        [string[]]$Line,
        [string]$Path,
        [Parameter(Mandatory)][string[]]$FunctionName
    )

    if ($null -eq $Line) {
        $Line = @(Get-Content -LiteralPath $Path)
    }

    $found = [System.Collections.Generic.List[object]]::new()
    $fnPattern = ($FunctionName | ForEach-Object { [regex]::Escape($_) }) -join '|'
    if ([string]::IsNullOrEmpty($fnPattern)) { return $found.ToArray() }

    for ($i = 0; $i -lt $Line.Count; $i++) {
        $text = $Line[$i]
        if ($text -match '^\s*#') { continue }
        if ($text -notmatch "\b($fnPattern)\b") { continue }
        $fnName = $Matches[1]

        foreach ($argMatch in [regex]::Matches($text, '-(\w+)\s+(-?\d+)(?!\d*[.\w])')) {
            $found.Add([pscustomobject]@{
                Function   = $fnName
                Param      = $argMatch.Groups[1].Value
                Value      = [int]$argMatch.Groups[2].Value
                LineNumber = $i + 1
            })
        }
    }

    return $found.ToArray()
}

function Get-BoundedRetryRangeGap {
    <#
    .SYNOPSIS
        Cross-references declared ranges against caller literals. Returns the literals that
        fall outside their parameter's declared range. Empty result = clean. A caller literal
        for a function/param pair with no declared range is skipped (nothing to check).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object[]]$Declared,
        [Parameter(Mandatory)][object[]]$CallerLiteral,
        [string]$SourcePath
    )

    $gaps = [System.Collections.Generic.List[object]]::new()

    foreach ($literal in $CallerLiteral) {
        $range = $Declared | Where-Object { $_.Function -eq $literal.Function -and $_.Param -eq $literal.Param } | Select-Object -First 1
        if ($null -eq $range) { continue }

        $belowMin = ($null -ne $range.Min) -and ($literal.Value -lt $range.Min)
        $aboveMax = ($null -ne $range.Max) -and ($literal.Value -gt $range.Max)
        if (-not ($belowMin -or $aboveMax)) { continue }

        $gaps.Add([pscustomobject]@{
            Function   = $literal.Function
            Param      = $literal.Param
            Value      = $literal.Value
            Min        = $range.Min
            Max        = $range.Max
            SourcePath = $SourcePath
            LineNumber = $literal.LineNumber
        })
    }

    return $gaps.ToArray()
}

function Format-BoundedRetryRangeGapMessage {
    <#
    .SYNOPSIS
        Actionable message naming each caller literal that would throw
        ParameterBindingValidationException at runtime, instead of being caught live by a
        gate's own catch block (the t/4842 shape).
    #>
    [CmdletBinding()]
    param([object[]]$Gap)

    if ($null -eq $Gap -or $Gap.Count -eq 0) {
        return 'Bounded-retry callers: every literal is within its parameter''s declared ValidateRange.'
    }
    $lines = $Gap | ForEach-Object {
        $boundDesc = if ($null -ne $_.Min -and $null -ne $_.Max) { "[$($_.Min),$($_.Max)]" }
                     elseif ($null -ne $_.Min) { ">= $($_.Min)" }
                     else { "<= $($_.Max)" }
        "  $($_.SourcePath):$($_.LineNumber): $($_.Function) -$($_.Param) $($_.Value) is outside the declared range $boundDesc"
    }
    return @(
        "$($Gap.Count) bounded-retry caller literal(s) would throw ParameterBindingValidationException at runtime (t/4842 shape):"
        $lines
        "Either raise the declared [ValidateRange(...)] ceiling on the target parameter (and re-check the"
        "retry budget it implies), or lower the caller's literal to fit the existing declared range."
    ) -join [Environment]::NewLine
}
