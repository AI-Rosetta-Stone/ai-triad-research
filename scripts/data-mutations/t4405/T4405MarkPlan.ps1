# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    The t/4405 mark builder for the t/4398 review groups: R1 (same raw file), R2 (PI-approved
    decisions) and the t/4402 human-reviewed text-2026 marks.
.DESCRIPTION
    Pure (no I/O), so tests/T4405MarkPlan.Tests.ps1 pins every guard. The rules are the SO's e/348#2
    conditions as accepted by the TL (e/348#3, #10):
      R1, a member and its group canonical with IDENTICAL, NON-EMPTY substantive raw-blob sets:
        - an empty substantive set on either side          -> review (condition 1);
        - titles that disagree                             -> review, never rejection (e/348#5),
          unless the pair is human-reviewed (t/4402);
        - title agreement that is only weak (a null or arXiv-id title on a side) needs a second
          signal (a near-equal snapshot or the same normalized URL), else review (condition 2);
        - a blob shared by 3+ docs is accepted only when every doc sharing it is in the group (or is
          a human-reviewed doc joining it) and their non-weak titles agree, with AT LEAST ONE non-weak title
          among them (SO e/348#12: all-null / all-arXiv-id agreement is vacuous); else review. Every 3+
          blob is recorded (docs, group, titles) for the recount (TL e/348#10);
        - a damaged or materially shorter canonical snapshot -> review: overriding the C6 canonical
          needs a decision and may re-point applied marks (condition 3);
        - an applied mark on either side -> review (never re-point, condition 3).
      R2: the PI-approved pairs (t/4398#4/#5), with the same applied-mark check.
      Human: t/4402's decisions (text-2026 and -1 into the WEO group), with the same check.

    Get-T4405MarkPlan is the orchestrator; the per-group, per-member, 3+-blob, R2 and chain
    phases live in the T4405-prefixed private helpers below it (t/4405 complexity refactor,
    gh#5379), each a behaviour-preserving extraction of what was formerly one scriptblock or
    one inline block. They are called only from Get-T4405MarkPlan, so they inherit its
    Set-StrictMode scope exactly as the former scriptblocks did.
.OUTPUTS
    Marks { id; duplicate_of; basis; group }, Review { canonical; member; reason }, Blobs
    { blob; docs; group; titles; accepted }, all in ordinal order.
#>
function ConvertTo-T4405TitleKey {
    <#
    .SYNOPSIS
        The normalized title used for agreement: lowercase, a trailing publisher segment (" | X", " - X",
        " — X") dropped when at least three words remain, anything but letters and digits a space,
        spaces collapsed. '' for a null or empty title.
    #>
    [OutputType([string])]
    param([AllowNull()][AllowEmptyString()][string]$Title)
    if ([string]::IsNullOrWhiteSpace($Title)) { return '' }
    $t = $Title.ToLowerInvariant()
    $m = [regex]::Match($t, '^(.*\S)\s+(\||-|—|–)\s+[^|—–-]+$')
    if ($m.Success -and @($m.Groups[1].Value -split '\s+' | Where-Object { $_ }).Count -ge 3) { $t = $m.Groups[1].Value }
    (($t -replace '[^\p{L}\p{Nd}]+', ' ').Trim() -replace '\s+', ' ')
}

function Test-T4405WeakTitle {
    <#
    .SYNOPSIS
        A title key too weak to agree on its own (SO e/348#2 condition 2): empty, or an arXiv id such as
        "1606 06565v2" (the key of "1606.06565v2").
    #>
    [OutputType([bool])]
    param([AllowEmptyString()][string]$TitleKey)
    (-not $TitleKey) -or ($TitleKey -match '^\d{4} \d{4,5}( ?v\d+)?$')
}

function ConvertTo-T4405UrlKey {
    <#
    .SYNOPSIS
        A URL compared for the second signal: scheme, "www.", query, fragment and a trailing slash dropped;
        lowercase. '' when there is no URL.
    #>
    [OutputType([string])]
    param([AllowNull()][AllowEmptyString()][string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return '' }
    $u = $Url.Trim().ToLowerInvariant() -replace '^[a-z][a-z0-9+.-]*://', '' -replace '^www\.', ''
    $u = ($u -split '[?#]', 2)[0]
    $u.TrimEnd('/')
}

function ConvertTo-T4405BlobSetKey {
    <#
    .SYNOPSIS
        The ordinal-sorted, comma-joined key of a substantive blob set, so two sets compare equal
        iff they hold the same blobs. The input is cloned before sorting, so the caller's array is
        left untouched.
    #>
    [OutputType([string])]
    param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Blobs)
    $a = [string[]]$Blobs.Clone()
    [Array]::Sort($a, [StringComparer]::Ordinal)
    $a -join ','
}

function Test-T4405TitlesAgree {
    <#
    .SYNOPSIS
        Two non-empty title keys agree when they are ordinally equal or one contains the other
        (e/348#2). An empty key never agrees.
    #>
    [OutputType([bool])]
    param([AllowEmptyString()][string]$A, [AllowEmptyString()][string]$B)
    $A -and $B -and ($A -ceq $B -or $A.Contains($B) -or $B.Contains($A))
}

function Get-T4405SubstantiveBlobs {
    <#
    .SYNOPSIS
        A document's substantive blob ids (the empty, non-null members dropped). A missing id reads
        as EMPTY, not as @($null) -- a one-element array would defeat condition 1 (the empty-set guard).
    #>
    [OutputType([string[]])]
    param([Parameter(Mandatory)][hashtable]$Raw, [Parameter(Mandatory)][string]$Id)
    if ($Raw.ContainsKey($Id) -and $null -ne $Raw[$Id]) { [string[]]@($Raw[$Id] | Where-Object { $_ }) }
    else { [string[]]@() }
}

function Get-T4405BlobSharers {
    <#
    .SYNOPSIS
        Every doc whose substantive set holds a blob, ordinal-sorted and with empties dropped. '' docs
        and a missing blob read as the empty set.
    #>
    [OutputType([string[]])]
    param([Parameter(Mandatory)][hashtable]$Sharers, [Parameter(Mandatory)][string]$Blob)
    if ($Sharers.ContainsKey($Blob)) { [string[]]@($Sharers[$Blob] | Where-Object { $_ } | Sort-Object) }
    else { [string[]]@() }
}

function Test-T4405WeakPair {
    <#
    .SYNOPSIS
        A canonical/member pair whose title agreement is only weak (SO e/348#2 condition 2): a flagged
        weak title or a missing title key on either side.
    #>
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][hashtable]$TitleKey,
        [Parameter(Mandatory)][hashtable]$TitleWeak,
        [Parameter(Mandatory)][string]$Canon,
        [Parameter(Mandatory)][string]$Member
    )
    $TitleWeak[$Canon] -or $TitleWeak[$Member] -or -not $TitleKey[$Canon] -or -not $TitleKey[$Member]
}

function Get-T4405HumanByCanon {
    <#
    .SYNOPSIS
        Inverts the human-reviewed member -> canonical map into canonical -> [members], so a group can
        pull in the human-reviewed docs joining it (t/4402).
    #>
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][hashtable]$Human)
    $byCanon = @{}
    foreach ($k in $Human.Keys) {
        $c = [string]$Human[$k]
        if (-not $byCanon.ContainsKey($c)) { $byCanon[$c] = [System.Collections.Generic.List[string]]::new() }
        $byCanon[$c].Add([string]$k)
    }
    $byCanon
}

function Get-T4405GroupSet {
    <#
    .SYNOPSIS
        The ordinal set of every doc that counts as "inside" a group: its canonical, its members and the
        human-reviewed docs joining it (t/4402), used for the 3+-blob outside-group check.
    #>
    [OutputType([System.Collections.Generic.HashSet[string]])]
    param(
        [Parameter(Mandatory)][string]$Canon,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Members,
        [Parameter(Mandatory)][hashtable]$HumanByCanon
    )
    $groupSet = [System.Collections.Generic.HashSet[string]]::new([string[]](@($Canon) + $Members), [StringComparer]::Ordinal)
    if ($HumanByCanon.ContainsKey($Canon)) { foreach ($h in $HumanByCanon[$Canon]) { [void]$groupSet.Add($h) } }
    , $groupSet   # unary comma: return the HashSet itself (ordinal comparer intact), not its enumerated elements
}

function Test-T4405TitleGate {
    <#
    .SYNOPSIS
        The title half of the R1 guards for an identical-raw pair: a review reason string when the titles
        disagree (condition: never a rejection, e/348#5) or weak agreement lacks a second signal
        (condition 2), else $null.
    #>
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][hashtable]$TitleKey,
        [Parameter(Mandatory)][hashtable]$TitleWeak,
        [Parameter(Mandatory)][hashtable]$SecondSignal,
        [Parameter(Mandatory)][string]$Canon,
        [Parameter(Mandatory)][string]$Member
    )
    $weak = Test-T4405WeakPair -TitleKey $TitleKey -TitleWeak $TitleWeak -Canon $Canon -Member $Member
    if (-not $weak -and -not (Test-T4405TitlesAgree ([string]$TitleKey[$Canon]) ([string]$TitleKey[$Member]))) { return 'title-disagreement' }
    if ($weak -and -not $SecondSignal["$Canon|$Member"]) { return 'weak-title-no-second-signal' }
    $null
}

function Get-T4405BlobVerdict {
    <#
    .SYNOPSIS
        Evaluates the 3+-blob guard (SO e/348#12, TL e/348#10) for an identical-raw member, returning
        { Ok; Reason; Records }. Records holds a { blob; docs; group; titles; accepted } row for every 3+
        blob inspected (the recount), in order up to the first failure; the caller records those not yet seen.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Blobs,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$GroupSet,
        [Parameter(Mandatory)][hashtable]$Sharers,
        [Parameter(Mandatory)][hashtable]$TitleKey,
        [Parameter(Mandatory)][hashtable]$TitleWeak,
        [Parameter(Mandatory)][hashtable]$Human,
        [Parameter(Mandatory)][string]$Canon
    )
    $records = [System.Collections.Generic.List[object]]::new()
    $ok = $true
    $reason = $null
    foreach ($blob in $Blobs) {
        $docs = [string[]]@(Get-T4405BlobSharers -Sharers $Sharers -Blob $blob)
        if ($docs.Count -lt 3) { continue }
        $outside = @($docs | Where-Object { -not $GroupSet.Contains($_) })
        $strong = @($docs | Where-Object { -not $TitleWeak[$_] -and $TitleKey[$_] -and -not $Human.ContainsKey($_) })
        $disagree = @($strong | Where-Object { -not (Test-T4405TitlesAgree ([string]$TitleKey[$_]) ([string]$TitleKey[$strong[0]])) })
        # SO e/348#12: agreement must not be vacuous. At least one sharer needs a real (non-null, non-arXiv-id,
        # non-human-reviewed) title; an all-weak set is the .DS_Store shape with a bigger file -> review.
        $blobOk = $outside.Count -eq 0 -and $strong.Count -ge 1 -and $disagree.Count -eq 0
        $records.Add([pscustomobject]@{ blob = $blob; docs = $docs; group = $Canon; titles = [string[]]@($docs | ForEach-Object { [string]$TitleKey[$_] }); accepted = $blobOk })
        if (-not $blobOk) {
            $ok = $false
            $reason = if ($outside.Count) { 'blob-shared-outside-group' } elseif ($strong.Count -eq 0) { 'blob-sharers-no-real-title' } else { 'blob-sharers-titles-disagree' }
            break
        }
    }
    [pscustomobject]@{ Ok = $ok; Reason = $reason; Records = $records }
}

function Get-T4405MemberOutcome {
    <#
    .SYNOPSIS
        The R1 decision for one member against its group canonical: { Reason; Mark; Records }. Reason is a
        review reason string (or $null) with canonical = $Canon, member = $Member; Mark is the r1-same-raw
        mark (or $null); Records holds the 3+-blob rows to record. Reason and Mark are mutually exclusive;
        both $null means the pair is left to the R2 / human phase.
    #>
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory)][string]$Canon,
        [Parameter(Mandatory)][string]$Member,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$GroupSet,
        [Parameter(Mandatory)][hashtable]$Raw,
        [Parameter(Mandatory)][hashtable]$Sharers,
        [Parameter(Mandatory)][hashtable]$TitleKey,
        [Parameter(Mandatory)][hashtable]$TitleWeak,
        [Parameter(Mandatory)][hashtable]$SecondSignal,
        [Parameter(Mandatory)][hashtable]$CanonicalSuspect,
        [Parameter(Mandatory)][hashtable]$Marked,
        [Parameter(Mandatory)][hashtable]$Human,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$R2
    )
    $none = { param($reason, $mark) [pscustomobject]@{ Reason = $reason; Mark = $mark; Records = @() } }
    $a = [string[]]@(Get-T4405SubstantiveBlobs -Raw $Raw -Id $Canon)
    $b = [string[]]@(Get-T4405SubstantiveBlobs -Raw $Raw -Id $Member)
    if ($a.Count -eq 0 -or $b.Count -eq 0) {
        # Not an R1 pair (condition 1); R2 decides it if the PI approved one.
        $reason = if (-not @($R2 | Where-Object { $_.member -ceq $Member }).Count) { 'empty-substantive-raw-set' } else { $null }
        return (& $none $reason $null)
    }
    if ((ConvertTo-T4405BlobSetKey $a) -cne (ConvertTo-T4405BlobSetKey $b)) { return (& $none $null $null) }   # different raw: R2 or human review
    if ($Marked.ContainsKey($Member) -or $Marked.ContainsKey($Canon)) { return (& $none 'applied-mark-would-be-repointed' $null) }
    $titleReason = Test-T4405TitleGate -TitleKey $TitleKey -TitleWeak $TitleWeak -SecondSignal $SecondSignal -Canon $Canon -Member $Member
    if ($titleReason) { return (& $none $titleReason $null) }
    $verdict = Get-T4405BlobVerdict -Blobs $a -GroupSet $GroupSet -Sharers $Sharers -TitleKey $TitleKey -TitleWeak $TitleWeak -Human $Human -Canon $Canon
    if (-not $verdict.Ok) { return [pscustomobject]@{ Reason = $verdict.Reason; Mark = $null; Records = $verdict.Records } }
    if ($CanonicalSuspect.ContainsKey($Canon)) { return [pscustomobject]@{ Reason = "canonical-override-needs-decision: $($CanonicalSuspect[$Canon])"; Mark = $null; Records = $verdict.Records } }
    [pscustomobject]@{ Reason = $null; Mark = [pscustomobject]@{ id = $Member; duplicate_of = $Canon; basis = 'r1-same-raw'; group = $Canon }; Records = $verdict.Records }
}

function Add-T4405R2Outcomes {
    <#
    .SYNOPSIS
        Appends the R2 (PI-approved) and human-reviewed (t/4402) marks to $Marks and their applied-mark
        reviews to $Review, deduping new marks through the shared $Seen set. An R2 entry may name its own
        basis (the t/4337 C9 deferrals, TL e/348#10); a human entry is human-reviewed-t4402.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$R2,
        [Parameter(Mandatory)][hashtable]$Human,
        [Parameter(Mandatory)][hashtable]$Marked,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.HashSet[string]]$Seen,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Marks,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Review
    )
    foreach ($p in @($R2) + @($Human.Keys | ForEach-Object { @{ member = $_; canonical = $Human[$_]; human = $true } })) {
        $m = [string]$p.member; $c = [string]$p.canonical
        if ($Marked.ContainsKey($m) -or $Marked.ContainsKey($c)) {
            $Review.Add([pscustomobject]@{ canonical = $c; member = $m; reason = 'applied-mark-would-be-repointed' }); continue
        }
        $basis = if ($p -is [hashtable] -and $p.ContainsKey('human')) { 'human-reviewed-t4402' }
                 elseif ($p -is [hashtable] -and $p.ContainsKey('basis')) { [string]$p.basis }
                 else { 'r2-pi-approved' }
        if ($Seen.Add($m)) { $Marks.Add([pscustomobject]@{ id = $m; duplicate_of = $c; basis = $basis; group = $c }) }
    }
}

function Resolve-T4405Chains {
    <#
    .SYNOPSIS
        Drops chained marks (a target that is itself marked in this plan) and sends them to review, then
        returns the surviving marks ordinal-sorted by id. No chains: a target must not itself be marked.
    #>
    [OutputType([object[]])]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Marks,
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Review
    )
    $targets = @{}; foreach ($x in $Marks) { $targets[$x.id] = $x.duplicate_of }
    $chained = @($Marks | Where-Object { $targets.ContainsKey($_.duplicate_of) })
    foreach ($x in $chained) { $Review.Add([pscustomobject]@{ canonical = $x.duplicate_of; member = $x.id; reason = 'chain-target-is-marked' }) }
    $final = [object[]]@($Marks | Where-Object { $_.id -notin @($chained | ForEach-Object id) })
    $ids = [string[]]@(foreach ($x in $final) { [string]$x.id })
    [Array]::Sort([Array]$ids, [Array]$final, [System.Collections.IComparer][StringComparer]::Ordinal)   # non-generic overload sorts $final in place
    $final
}

function Get-T4405MarkPlan {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        # Review groups: @{ canonical = <id>; members = <string[]> } (members may include the canonical).
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Groups,
        [Parameter(Mandatory)][hashtable]$Raw,          # id -> string[] substantive blob ids
        [Parameter(Mandatory)][hashtable]$Sharers,      # blob -> string[] every doc whose substantive set holds it
        [Parameter(Mandatory)][hashtable]$TitleKey,     # id -> normalized title key ('' when none)
        [Parameter(Mandatory)][hashtable]$TitleWeak,    # id -> $true for a null / arXiv-id title
        [Parameter(Mandatory)][hashtable]$SecondSignal, # "<canonical>|<member>" -> $true when snapshots near-equal or URLs equal
        [Parameter(Mandatory)][hashtable]$CanonicalSuspect, # canonical id -> reason string when damaged / materially shorter
        [Parameter(Mandatory)][hashtable]$Marked,       # id -> applied duplicate_of target
        [AllowEmptyCollection()][object[]]$R2 = @(),    # @{ member; canonical } (PI-approved)
        [hashtable]$Human = @{}                         # member -> canonical (human-reviewed, t/4402)
    )
    Set-StrictMode -Version Latest   # as the freeze script runs it, so the tests exercise strict mode too
    $marks = [System.Collections.Generic.List[object]]::new()
    $review = [System.Collections.Generic.List[object]]::new()
    $blobs = [ordered]@{}
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $humanByCanon = Get-T4405HumanByCanon -Human $Human

    foreach ($g in @($Groups | Sort-Object { [string]$_.canonical })) {
        $canon = [string]$g.canonical
        $members = [string[]]@($g.members | Where-Object { $_ -cne $canon } | Sort-Object)
        if ($Human.ContainsKey($canon)) { continue }   # the whole group is decided by human review
        $groupSet = Get-T4405GroupSet -Canon $canon -Members $members -HumanByCanon $humanByCanon
        foreach ($m in $members) {
            if ($Human.ContainsKey($m)) { continue }
            $outcome = Get-T4405MemberOutcome -Canon $canon -Member $m -GroupSet $groupSet -Raw $Raw `
                -Sharers $Sharers -TitleKey $TitleKey -TitleWeak $TitleWeak -SecondSignal $SecondSignal `
                -CanonicalSuspect $CanonicalSuspect -Marked $Marked -Human $Human -R2 $R2
            foreach ($rec in $outcome.Records) { if (-not $blobs.Contains($rec.blob)) { $blobs[$rec.blob] = $rec } }
            if ($outcome.Reason) { $review.Add([pscustomobject]@{ canonical = $canon; member = $m; reason = $outcome.Reason }) }
            elseif ($outcome.Mark -and $seen.Add($m)) { $marks.Add($outcome.Mark) }
        }
    }
    Add-T4405R2Outcomes -R2 $R2 -Human $Human -Marked $Marked -Seen $seen -Marks $marks -Review $review
    $final = [object[]]@(Resolve-T4405Chains -Marks $marks -Review $review)
    [pscustomobject]@{
        Marks  = $final
        Review = @($review | Sort-Object canonical, member)
        Blobs  = @($blobs.Values)
    }
}
