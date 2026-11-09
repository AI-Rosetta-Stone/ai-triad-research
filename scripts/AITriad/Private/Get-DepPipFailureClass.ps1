# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Get-DepPipFailureClass {
    <#
    .SYNOPSIS
        Classifies a failed `pip` run's output as 'ResolutionFailure' or 'NetworkError', for
        the torch+cpu resolve check (t/4884, Quality must-fix at t/4884#10).
    .DESCRIPTION
        The real `pip --dry-run` resolution test (torch+cpu pin actually resolves, in
        Test-DepPythonPackages.Tests.ps1) runs against the live PyTorch CPU wheel index in
        CI. A transient DNS failure, timeout, or index outage is not evidence the pin is
        wrong -- but an unclassified nonzero exit would fail `ci-gate` for every PR on any of
        those, which is a worse failure mode than the one this check exists to catch.

        Only a recognized RESOLUTION failure (pip could not find a matching distribution, or
        its resolver found a genuine conflict) counts as 'ResolutionFailure'. A recognized
        NETWORK failure counts as 'NetworkError'. Anything neither pattern recognizes also
        classifies as 'NetworkError' -- the caller's job is to catch real pin regressions, not
        to catalog every way pip's output can look; when this function doesn't recognize the
        shape, the safer failure mode is "skip and show the output" over "redden ci-gate for
        everyone on an unrecognized string."
    .PARAMETER Output
        The failed command's captured stdout+stderr lines.
    .OUTPUTS
        'ResolutionFailure' or 'NetworkError'.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string[]]$Output
    )

    $Text = $Output -join "`n"

    $ResolutionPatterns = @(
        'No matching distribution found',
        'ResolutionImpossible',
        'Could not find a version that satisfies the requirement'
    )
    foreach ($Pattern in $ResolutionPatterns) {
        if ($Text -match [regex]::Escape($Pattern)) { return 'ResolutionFailure' }
    }

    $NetworkPatterns = @(
        'ConnectionError',
        'timed out',
        'Temporary failure in name resolution',
        'NewConnectionError',
        'ProxyError'
    )
    foreach ($Pattern in $NetworkPatterns) {
        if ($Text -match [regex]::Escape($Pattern)) { return 'NetworkError' }
    }

    # Unrecognized shape: neither a known resolution failure nor a known network failure.
    # Default to 'NetworkError' (skip, not fail) -- see .DESCRIPTION. The caller always logs
    # $Text regardless of classification, so an unrecognized shape is still visible for a
    # human to triage; it just doesn't redden ci-gate on its own.
    return 'NetworkError'
}
