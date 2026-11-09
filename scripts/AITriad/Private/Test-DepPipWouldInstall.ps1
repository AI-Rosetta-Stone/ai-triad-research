# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Test-DepPipWouldInstall {
    <#
    .SYNOPSIS
        Checks whether pip's `--dry-run` "Would install ..." summary line mentions a given
        pinned spec, regardless of where in that line it falls (t/4884, Quality changes-
        requested round 2, p/678#233).
    .DESCRIPTION
        pip's dry-run summary lists every package it would install on ONE line, in
        alphabetical order, e.g. "Would install fsspec-2026.9.0 mpmath-1.3.0 networkx-3.7
        sympy-1.14.0 torch-2.15.0+cpu". Asserting `-Match 'Would install torch'` assumes torch
        is always the first name on that line -- true only when none of its dependencies
        needed installing (observed on a dev machine where torch's deps were already present,
        so torch itself was the only thing left to list), false on a clean CI runner where
        fsspec/mpmath/networkx/sympy sort alphabetically before "torch" and so appear first.
        This checks for the spec ANYWHERE in the line instead, so it holds regardless of which
        dependencies happen to already be installed on whichever machine runs it.
    .PARAMETER Output
        The captured `pip install --dry-run ...` output lines.
    .PARAMETER PinnedSpec
        The spec as it appears in pip-constraints.txt, e.g. 'torch==2.15.0+cpu' (pip's summary
        line uses the dash form, 'torch-2.15.0+cpu' -- this function converts internally).
    .OUTPUTS
        [bool]
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        # Not [Parameter(Mandatory)]: PowerShell's mandatory-parameter check rejects the WHOLE
        # array if ANY element is an empty string -- real process output routinely has blank
        # lines (pip's own --dry-run output does, between "Would install ..." and its trailing
        # "[notice]" lines), so Mandatory here would reject every real caller. Validate
        # non-null manually instead.
        [string[]]$Output,
        [Parameter(Mandatory)][string]$PinnedSpec
    )

    if ($null -eq $Output) {
        throw (New-ActionableError -AsErrorRecord `
            -Goal 'Check whether a pip dry-run output mentions a pinned spec' `
            -Problem '-Output was $null' `
            -Location 'Test-DepPipWouldInstall' `
            -NextSteps @('Pass the captured pip output lines, even if some are blank'))
    }

    $Text = $Output -join "`n"
    $DashForm = $PinnedSpec -replace '==', '-'
    $Text -match "Would install .*\b$([regex]::Escape($DashForm))\b"
}
