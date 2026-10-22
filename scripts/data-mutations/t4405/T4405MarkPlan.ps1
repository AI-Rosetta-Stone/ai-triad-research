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
          a human-reviewed doc joining it) and their non-weak titles agree; else review. Every 3+
          blob is recorded (docs, group, titles) for the recount (TL e/348#10);
        - a damaged or materially shorter canonical snapshot -> review: overriding the C6 canonical
          needs a decision and may re-point applied marks (condition 3);
        - an applied mark on either side -> review (never re-point, condition 3).
      R2: the PI-approved pairs (t/4398#4/#5), with the same applied-mark check.
      Human: t/4402's decisions (text-2026 and -1 into the WEO group), with the same check.
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
    $addReview = { param($c, $m, $r) $review.Add([pscustomobject]@{ canonical = $c; member = $m; reason = $r }) }
    $setKey = { param([string[]]$b) $a = [string[]]$b.Clone(); [Array]::Sort($a, [StringComparer]::Ordinal); $a -join ',' }
    $titlesAgree = { param([string]$a, [string]$b) $a -and $b -and ($a -ceq $b -or $a.Contains($b) -or $b.Contains($a)) }
    # A missing id must read as EMPTY: @($null) would be a one-element array and defeat condition 1.
    $blobsOf = { param([string]$id) if ($Raw.ContainsKey($id) -and $null -ne $Raw[$id]) { [string[]]@($Raw[$id] | Where-Object { $_ }) } else { [string[]]@() } }
    $sharersOf = { param([string]$b) if ($Sharers.ContainsKey($b)) { [string[]]@($Sharers[$b] | Where-Object { $_ } | Sort-Object) } else { [string[]]@() } }

    $humanByCanon = @{}
    foreach ($k in $Human.Keys) { $c = [string]$Human[$k]; if (-not $humanByCanon.ContainsKey($c)) { $humanByCanon[$c] = [System.Collections.Generic.List[string]]::new() }; $humanByCanon[$c].Add([string]$k) }

    foreach ($g in @($Groups | Sort-Object { [string]$_.canonical })) {
        $canon = [string]$g.canonical
        $members = [string[]]@($g.members | Where-Object { $_ -cne $canon } | Sort-Object)
        if ($Human.ContainsKey($canon)) { continue }   # the whole group is decided by human review
        $groupSet = [System.Collections.Generic.HashSet[string]]::new([string[]](@($canon) + $members), [StringComparer]::Ordinal)
        if ($humanByCanon.ContainsKey($canon)) { foreach ($h in $humanByCanon[$canon]) { [void]$groupSet.Add($h) } }
        foreach ($m in $members) {
            if ($Human.ContainsKey($m)) { continue }
            # @() because & unrolls a one-element array to a bare string (no .Count under strict mode).
            $a = [string[]]@(& $blobsOf $canon); $b = [string[]]@(& $blobsOf $m)
            if ($a.Count -eq 0 -or $b.Count -eq 0) {
                # Not an R1 pair (condition 1); R2 decides it if the PI approved one.
                if (-not @($R2 | Where-Object { $_.member -ceq $m }).Count) { & $addReview $canon $m 'empty-substantive-raw-set' }
                continue
            }
            if ((& $setKey $a) -cne (& $setKey $b)) { continue }   # different raw: R2 or human review
            if ($Marked.ContainsKey($m) -or $Marked.ContainsKey($canon)) { & $addReview $canon $m 'applied-mark-would-be-repointed'; continue }
            $weak = $TitleWeak[$canon] -or $TitleWeak[$m] -or -not $TitleKey[$canon] -or -not $TitleKey[$m]
            if (-not $weak -and -not (& $titlesAgree ([string]$TitleKey[$canon]) ([string]$TitleKey[$m]))) { & $addReview $canon $m 'title-disagreement'; continue }
            if ($weak -and -not $SecondSignal["$canon|$m"]) { & $addReview $canon $m 'weak-title-no-second-signal'; continue }
            $blobOk = $true
            foreach ($blob in $a) {
                $docs = [string[]]@(& $sharersOf $blob)
                if ($docs.Count -lt 3) { continue }
                $outside = @($docs | Where-Object { -not $groupSet.Contains($_) })
                $strong = @($docs | Where-Object { -not $TitleWeak[$_] -and $TitleKey[$_] -and -not $Human.ContainsKey($_) })
                $disagree = @($strong | Where-Object { -not (& $titlesAgree ([string]$TitleKey[$_]) ([string]$TitleKey[$strong[0]])) })
                $ok = $outside.Count -eq 0 -and $disagree.Count -eq 0
                if (-not $blobs.Contains($blob)) {
                    $blobs[$blob] = [pscustomobject]@{ blob = $blob; docs = $docs; group = $canon; titles = [string[]]@($docs | ForEach-Object { [string]$TitleKey[$_] }); accepted = $ok }
                }
                if (-not $ok) { $blobOk = $false; & $addReview $canon $m $(if ($outside.Count) { 'blob-shared-outside-group' } else { 'blob-sharers-titles-disagree' }); break }
            }
            if (-not $blobOk) { continue }
            if ($CanonicalSuspect.ContainsKey($canon)) { & $addReview $canon $m "canonical-override-needs-decision: $($CanonicalSuspect[$canon])"; continue }
            if ($seen.Add($m)) { $marks.Add([pscustomobject]@{ id = $m; duplicate_of = $canon; basis = 'r1-same-raw'; group = $canon }) }
        }
    }
    foreach ($p in @($R2) + @($Human.Keys | ForEach-Object { @{ member = $_; canonical = $Human[$_]; human = $true } })) {
        $m = [string]$p.member; $c = [string]$p.canonical
        if ($Marked.ContainsKey($m) -or $Marked.ContainsKey($c)) { & $addReview $c $m 'applied-mark-would-be-repointed'; continue }
        $basis = if ($p -is [hashtable] -and $p.ContainsKey('human')) { 'human-reviewed-t4402' } else { 'r2-pi-approved' }
        if ($seen.Add($m)) { $marks.Add([pscustomobject]@{ id = $m; duplicate_of = $c; basis = $basis; group = $c }) }
    }
    # No chains: a target must not itself be marked in this plan.
    $targets = @{}; foreach ($x in $marks) { $targets[$x.id] = $x.duplicate_of }
    $chained = @($marks | Where-Object { $targets.ContainsKey($_.duplicate_of) })
    foreach ($x in $chained) { & $addReview $x.duplicate_of $x.id 'chain-target-is-marked' }
    $final = [object[]]@($marks | Where-Object { $_.id -notin @($chained | ForEach-Object id) })
    $ids = [string[]]@(foreach ($x in $final) { [string]$x.id })
    [Array]::Sort([Array]$ids, [Array]$final, [System.Collections.IComparer][StringComparer]::Ordinal)   # non-generic overload sorts $final in place
    [pscustomobject]@{
        Marks  = $final
        Review = @($review | Sort-Object canonical, member)
        Blobs  = @($blobs.Values)
    }
}
