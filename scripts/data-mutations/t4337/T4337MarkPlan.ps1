# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    The t/4337 option-A mark builder: which docs get duplicate_of, and which groups go to review.
.DESCRIPTION
    Pure (no I/O), so tests/T4337MarkPlan.Tests.ps1 can pin it (SO e/344#5 point 4: the 16 groups the
    first builder missed, t/4337#29). Rules (SO e/344#5, TL-accepted e/344#6):
      - Every multi-doc identity group is considered, not only all-identical ones.
      - The group's canonical is chosen by C6 over the WHOLE group: has a summary, then most live
        taxonomy references, then ordinal id.
      - Mark only the canonical's byte-identical twins (same non-null content hash). Then the group
        canonical (spec 4.6 rule 1) and every marked doc's resolved id are the same doc.
      - Every other member goes to the human review pass, unmarked: a different body, or a second
        identical subset. When the canonical has no twin at all, the whole group goes to review
        (marking a subset whose best member isn't the canonical would split canonicalDocId from
        resolve, SO C8).
.OUTPUTS
    Marks (id, duplicate_of, duplicate_of_ref, group, has_metadata) and Review (canonical, members,
    reason), both ordered by the group's first member id.
#>
function Get-T4337MarkPlan {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Groups,   # each a [string[]] of member ids
        [Parameter(Mandatory)][hashtable]$Hash,       # id -> effective content hash, or $null
        [Parameter(Mandatory)][hashtable]$HasSummary, # id -> bool
        [Parameter(Mandatory)][hashtable]$LiveRefs,   # id -> int
        [Parameter(Mandatory)][hashtable]$HasMetadata,
        [string]$RefPrefix = 't4337-cleanup-2026-10'
    )
    $ord = { param([string[]]$Ids) $a = [string[]]$Ids.Clone(); [Array]::Sort($a, [StringComparer]::Ordinal); $a }
    $c6 = { param([string[]]$Ids)
        @(& $ord $Ids | Sort-Object -Stable @{ Expression = { -[int][bool]$HasSummary[$_] } }, @{ Expression = { -[int]$LiveRefs[$_] } }) }
    $sorted = @($Groups | ForEach-Object { , [string[]](& $ord ([string[]]$_)) } | Sort-Object { $_[0] })

    $marks = [System.Collections.Generic.List[object]]::new()
    $review = [System.Collections.Generic.List[object]]::new()
    $n = 0
    foreach ($members in $sorted) {
        if ($members.Count -lt 2) { continue }
        $canon = (& $c6 $members)[0]
        $ch = $Hash[$canon]
        $twins = @($members | Where-Object { $_ -cne $canon -and $ch -and $Hash[$_] -ceq $ch })
        $rest = @($members | Where-Object { $_ -cne $canon -and $twins -notcontains $_ })
        if ($twins.Count -eq 0) {
            $review.Add([pscustomobject]@{ canonical = $canon; members = [string[]]$members; reason = 'canonical-has-no-identical-twin' })
            continue
        }
        if ($rest.Count) {
            $review.Add([pscustomobject]@{ canonical = $canon; members = [string[]]$rest; reason = 'differs-from-canonical-or-second-identical-subset' })
        }
        $n++
        foreach ($m in $twins) {
            $marks.Add([pscustomobject]@{ id = $m; duplicate_of = $canon; duplicate_of_ref = ('{0}#g{1:D3}' -f $RefPrefix, $n); group = $n; has_metadata = [bool]$HasMetadata[$m] })
        }
    }
    [pscustomobject]@{ Marks = $marks.ToArray(); Review = $review.ToArray(); GroupsWithMarks = $n }
}
