# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4572 write-freeze (SO C3, e/370#2, e/370#4): the small, committed set of consumer
# keys that have been RECALIBRATED against the corrected contradiction/entailment/
# neutral label mapping. A consumer's own recalibration PR adds its key here; nothing
# else may add or remove a key. Empty today -- no consumer has recalibrated yet, so
# every consumer is frozen by default (SO: "frozen unless explicitly marked
# recalibrated", never "frozen only if someone remembers to set a flag").
$script:NliDirectionalGateRecalibratedConsumers = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]@(),
    [System.StringComparer]::OrdinalIgnoreCase
)

function Test-NliDirectionalGateFrozen {
    <#
    .SYNOPSIS
        t/4572 write-freeze (SO C3, e/370#2, e/370#4): true unless $Consumer has been
        explicitly marked recalibrated against the corrected label mapping.
    .DESCRIPTION
        The engine fix (t/4572) changes the directional gate's verdicts for every
        caller -- true neutral pairs stop reading as 'opposes', true contradictions
        stop reading as 'agrees'. For a consumer that only reads/decides at runtime
        that's a pure improvement. For a consumer that WRITES corpus data
        (Invoke-PolarityGatePass's stance_polarity_flag, Invoke-QbafConflictAnalysis's
        conflicts.json, Invoke-OrgClaimMatching's -WriteProposals path), it's a new
        batch of outputs from thresholds (tau_contra, tau_entail) that were tuned
        against the swapped semantics -- uncalibrated until each consumer is
        re-examined on its own (SO Q2: phased, not "all land together").

        Each writing consumer calls this with ITS OWN key and treats a frozen result
        the same as its existing -SkipDirectionalGate (or, for Invoke-OrgClaimMatching,
        as a deferred write) -- mutates nothing, reusing an already-tested path rather
        than adding new branches. The default (a key not in the recalibrated set) is
        frozen -- the freeze is real between merge and each consumer's own
        recalibration, not opt-in.
    .PARAMETER Consumer
        The consumer's own key (e.g. 'PolarityGatePass', 'QbafConflictAnalysis',
        'OrgClaimMatching'). Case-insensitive.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [string]$Consumer
    )
    -not $script:NliDirectionalGateRecalibratedConsumers.Contains($Consumer)
}
