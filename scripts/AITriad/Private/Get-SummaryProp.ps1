# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# ── Canonical summary-structure constants (single source of truth) ──────────
# The POV camps and the pov_summaries → camp → key_points path are referenced
# by BOTH the merge writer (Merge-ChunkSummaries) and the density checker
# (Test-SummaryDensity). Divergence between those two access paths is what
# produced the t/1646 false-positive density warning: the writer stored camps
# as [ordered] hashtables and read them back via dictionary-safe access, while
# the checker read the same structure through $x.PSObject.Properties[...],
# which is BLIND to dictionary keys (it exposes .NET members like Count/Keys,
# not the entries). Both sites now share these definitions so the path can
# never drift again.
$script:AITriadPovCamps      = @('accelerationist', 'safetyist', 'skeptic')
$script:AITriadPovCategories = @('Desires', 'Beliefs', 'Intentions')

function Get-SummaryProp {
    <#
    .SYNOPSIS
        Reads a named member from a summary object, whether it is an [ordered]
        hashtable or a PSCustomObject.
    .DESCRIPTION
        Summary objects take two shapes in the pipeline:

          * In-memory merged summaries (Merge-ChunkSummaries) are [ordered]
            hashtables whose entries are NOT visible via PSObject.Properties.
          * Single-shot summaries and re-parsed JSON are PSCustomObjects whose
            NoteProperties ARE visible via PSObject.Properties (and, for
            dictionaries, key access via .Contains/[$Name]).

        Under Set-StrictMode -Version Latest, touching a missing property throws.
        This reader returns $null for a missing member on either shape, so a
        single malformed chunk degrades gracefully and the density checker sees
        the same values the merge writer stored.
    .PARAMETER Object
        The container to read from (dictionary, PSCustomObject, or $null).
    .PARAMETER Name
        The member/key name to read.
    #>
    param($Object, [string]$Name)

    # t/4934: the shape dispatch lives in Get-JsonField.ps1, shared with the smoke phases.
    return (Get-JsonField -Body $Object -Name $Name)
}
