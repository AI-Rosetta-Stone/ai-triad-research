# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/214: write CL's hand-labelled disagreement_type for the 9 frozen situations (sit-486 excluded).
.DESCRIPTION
    The classifier fails re-validation (t/246), so the source is CL's rubric hand labels
    (research/comp-linguist/analyses/t246-dtype-revalidation/t214_hand_labels.json, p/70#37), not
    classifier output. Reads ONLY frozen-t214-hand-labels.json (/data-mutation element 1).

    Writes through the canonical writer (Read-PovTaxonomyFile -> set field -> Write-PovTaxonomyFile),
    NOT Save-JsonNodeFieldEdits: its absent-key insert splices "disagreement_type": ..., onto the
    node's opening-brace line, the non-canonical pattern that broke CI in t/4836 (element 6a).

    -Mode DryRun (default): runs on a copy under a temp data root (registered path layout, so the
      writer's file-writers.json lookup resolves), then checks: pre sha256-lf, the label set equals
      the frozen one, every target lacks the field, exactly the 9 targets gain exactly
      disagreement_type (deep compare of every other node and top-level key), the output is
      canonical (writer round-trip), and the post sha. Writes nothing in ai-triad-data.
    -Mode Apply: the same checks on the temp copy first; refuses if any fails; then writes the real
      file with -RequireCleanTree and re-hashes it against post_sha256. Requires -FrozenSha.

    Revert: one commit in ai-triad-data; `git revert` it.
.PARAMETER DataRoot
    The ai-triad-data checkout.
.PARAMETER Mode
    DryRun (default) or Apply.
.PARAMETER FrozenSha
    The authorized sha256-lf (or a 16+ character prefix) of the frozen file; required for Apply.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$DataRoot,
    [ValidateSet('DryRun', 'Apply')][string]$Mode = 'DryRun',
    [string]$FrozenSha
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..' 'FreezeHash.ps1')
$FrozenPath = Join-Path $PSScriptRoot 'frozen-t214-hand-labels.json'
$Rel = 'taxonomy/Origin/situations.json'

function Stop-T214([string]$Problem, [string]$Next) {
    throw "ERROR`n  Goal: write the frozen t/214 hand labels with zero collateral`n  Problem: $Problem`n  Location: Invoke-T214HandLabelApply.ps1`n  Next Steps: $Next"
}

$FrozenBytes = [System.IO.File]::ReadAllBytes($FrozenPath)
$Actual = Get-FreezeSha256 -Bytes $FrozenBytes
if ($Mode -eq 'Apply' -and (-not $FrozenSha -or $FrozenSha.Length -lt 16 -or -not $Actual.StartsWith($FrozenSha))) {
    Stop-T214 "-FrozenSha '$FrozenSha' does not match the frozen file ($($Actual.Substring(0,16))...)" 'Pass the sha256-lf authorized on t/214.'
}
$Frozen = [System.Text.Encoding]::UTF8.GetString($FrozenBytes) | ConvertFrom-Json
if ($Frozen.hash_basis -ne 'sha256-lf') { Stop-T214 "hash_basis '$($Frozen.hash_basis)'" 'Re-freeze with FreezeHash.ps1.' }
$Labels = [ordered]@{}
foreach ($l in $Frozen.labels) { $Labels[[string]$l.id] = [string]$l.disagreement_type }
$Excluded = @($Frozen.excluded | ForEach-Object { [string]$_.id })

$Real = Join-Path $DataRoot $Rel
$RealBytes = [System.IO.File]::ReadAllBytes($Real)
if ((Get-FreezeSha256 -Bytes $RealBytes) -ne $Frozen.situations_pre_sha256) {
    Stop-T214 "$Rel differs from situations_pre_sha256 (changed since the freeze)" 'Nothing was written. Re-freeze against the current tree.'
}

# Build the candidate on a temp data root that mirrors the registered path.
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("t214-" + [guid]::NewGuid().ToString('N'))
$TempFile = Join-Path $TempRoot $Rel
New-Item -ItemType Directory -Force -Path (Split-Path $TempFile) | Out-Null
[System.IO.File]::WriteAllBytes($TempFile, $RealBytes)
$SavedRoot = $env:AI_TRIAD_DATA_ROOT
try {
    $env:AI_TRIAD_DATA_ROOT = $TempRoot
    Import-Module (Join-Path $PSScriptRoot '..' '..' 'AITriad' 'AITriad.psd1') -Force -WarningAction SilentlyContinue
    $Result = & (Get-Module AITriad) {
        param($TempFile, $Labels, $Excluded)
        $Before = Read-PovTaxonomyFile -Path $TempFile
        $Data = Read-PovTaxonomyFile -Path $TempFile
        $Problems = [System.Collections.Generic.List[string]]::new()
        $Seen = @{}
        foreach ($n in $Data.nodes) {
            $id = [string]$n.id
            if ($id -in $Excluded -and $n.PSObject.Properties['disagreement_type']) { $Problems.Add("$id is excluded but carries disagreement_type") }
            if (-not $Labels.Contains($id)) { continue }
            if ($n.PSObject.Properties['disagreement_type']) { $Problems.Add("$id already has disagreement_type '$($n.disagreement_type)'"); continue }
            $n | Add-Member -NotePropertyName disagreement_type -NotePropertyValue $Labels[$id]
            $Seen[$id] = $true
        }
        foreach ($id in $Labels.Keys) { if (-not $Seen.ContainsKey($id)) { $Problems.Add("$id not found") } }
        Write-PovTaxonomyFile -Path $TempFile -Data $Data -AllowDirty
        # Zero collateral: every other node and top-level key is deep-equal; targets differ by exactly the one field.
        $After = Read-PovTaxonomyFile -Path $TempFile
        $j = { param($o) $o | ConvertTo-Json -Depth 64 -Compress }
        foreach ($p in $Before.PSObject.Properties.Name) {
            if ($p -ne 'nodes' -and (& $j $Before.$p) -ne (& $j $After.$p)) { $Problems.Add("top-level '$p' changed") }
        }
        if (@($Before.nodes).Count -ne @($After.nodes).Count) { $Problems.Add('node count changed') }
        for ($i = 0; $i -lt @($Before.nodes).Count; $i++) {
            $b = $Before.nodes[$i]; $a = $After.nodes[$i]
            if ([string]$a.id -ne [string]$b.id) { $Problems.Add("node order changed at $i"); break }
            if ($Labels.Contains([string]$a.id)) {
                $a2 = $a | Select-Object -Property * -ExcludeProperty disagreement_type
                if ((& $j $a2) -ne (& $j $b) -or [string]$a.disagreement_type -ne $Labels[[string]$a.id]) { $Problems.Add("$($a.id): more than disagreement_type changed") }
            } elseif ((& $j $a) -ne (& $j $b)) { $Problems.Add("$($a.id): an untouched node changed") }
        }
        # Canonical bytes (element 6a): the writer reproduces its own output.
        $Out = [System.IO.File]::ReadAllBytes($TempFile)
        Write-PovTaxonomyFile -Path $TempFile -Data (Read-PovTaxonomyFile -Path $TempFile) -AllowDirty
        if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$Out, [byte[]][System.IO.File]::ReadAllBytes($TempFile))) { $Problems.Add('output is not canonical') }
        [pscustomobject]@{ Problems = @($Problems); Bytes = $Out }
    } $TempFile $Labels $Excluded
} finally {
    $env:AI_TRIAD_DATA_ROOT = $SavedRoot
    Remove-Item -Recurse -Force -LiteralPath $TempRoot -ErrorAction SilentlyContinue
}
if ($Result.Problems.Count) { Stop-T214 ("candidate checks failed:`n    " + ($Result.Problems -join "`n    ")) 'Nothing was written. Fix the freeze or the data.' }
$PostSha = Get-FreezeSha256 -Bytes $Result.Bytes
if ($Frozen.PSObject.Properties['situations_post_sha256'] -and $Frozen.situations_post_sha256 -and $PostSha -ne $Frozen.situations_post_sha256) {
    Stop-T214 "candidate hashes to $PostSha, frozen post is $($Frozen.situations_post_sha256)" 'Nothing was written. Re-freeze.'
}
Write-Host "frozen $($Actual.Substring(0,16)): $($Labels.Count) labels pass every check; candidate post sha256-lf $PostSha"
if ($Mode -eq 'DryRun') { return }

if (-not $Frozen.situations_post_sha256) { Stop-T214 'the freeze has no situations_post_sha256' 'Record the dry-run post sha in the freeze before applying.' }
Import-Module (Join-Path $PSScriptRoot '..' '..' 'AITriad' 'AITriad.psd1') -Force -WarningAction SilentlyContinue
& (Get-Module AITriad) {
    param($Real, $Labels)
    $Data = Read-PovTaxonomyFile -Path $Real
    foreach ($n in $Data.nodes) { if ($Labels.Contains([string]$n.id)) { $n | Add-Member -NotePropertyName disagreement_type -NotePropertyValue $Labels[[string]$n.id] } }
    Write-PovTaxonomyFile -Path $Real -Data $Data -RequireCleanTree
} $Real $Labels
$Written = Get-FreezeSha256 -Bytes ([System.IO.File]::ReadAllBytes($Real))
if ($Written -ne $Frozen.situations_post_sha256) { Stop-T214 "written file hashes to $Written, frozen post is $($Frozen.situations_post_sha256)" "Revert with git checkout -- $Rel in ai-triad-data and investigate." }
Write-Host "wrote $Rel; matches situations_post_sha256"
