# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Metadata-less twins (t/213, Orca t/4403): 17 duplicate sets in the corpus each have a twin
# folder with no metadata.json (null title) whose snapshot.md is byte-identical to the titled
# member's. They join through the section 4.2 hash edge on the computed snapshot hash. The Tech
# Lead ruled no corpus write (SO C10 stays); this file locks that join in, plus the cases that
# must NOT join. Synthetic fixtures only: set membership comes from
# scripts/data-mutations/t4337/frozen-t4337-marks.json (marks_without_metadata), never the corpus.
# Rules: docs/specs/source-identity.md.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'SourceIdentity.ps1')

    $script:MarksPath = Join-Path $PSScriptRoot '..' 'scripts' 'data-mutations' 't4337' 'frozen-t4337-marks.json'

    # A snapshot body over the 100-word floor (spec 1.3), distinct per seed.
    function script:New-TwinSnapshot {
        param([Parameter(Mandatory)][string]$Seed)
        $words = 1..120 | ForEach-Object { "word$_" }
        "# Synthetic snapshot $Seed`n`n" + ($words -join ' ') + "`n`nSeed: $Seed`n"
    }

    function script:New-TwinDoc {
        param([Parameter(Mandatory)][string]$Id, [string]$Title, [string]$Snapshot, [string]$RecordedSha256)
        $meta = [pscustomobject]@{}
        if ($Title) { $meta | Add-Member -NotePropertyName title -NotePropertyValue $Title }
        if ($RecordedSha256) { $meta | Add-Member -NotePropertyName content_sha256 -NotePropertyValue $RecordedSha256 }
        $hash = if ($null -ne $Snapshot -and $Snapshot -ne '') { Get-SourceContentHash -Text $Snapshot } else { $null }
        [pscustomobject]@{ Id = $Id; Metadata = $meta; SnapshotSha256 = $hash }
    }
}

Describe 'Metadata-less twins join their titled member via section 4.2 (t/213)' -Tag 'source-identity' {

    BeforeAll {
        $marks = @((Get-Content -Raw -LiteralPath $script:MarksPath | ConvertFrom-Json).marks_without_metadata)
        $script:Twins = @($marks | ForEach-Object { [string]$_.id })
        $script:Sets = [ordered]@{}
        foreach ($m in $marks) {
            $target = [string]$m.duplicate_of
            if (-not $script:Sets.Contains($target)) { $script:Sets[$target] = [System.Collections.Generic.List[string]]::new() }
            $script:Sets[$target].Add([string]$m.id)
        }
        $docs = [System.Collections.Generic.List[object]]::new()
        foreach ($target in $script:Sets.Keys) {
            $snap = New-TwinSnapshot -Seed $target
            $docs.Add((New-TwinDoc -Id $target -Title "Titled member $target" -Snapshot $snap))
            foreach ($twin in $script:Sets[$target]) { $docs.Add((New-TwinDoc -Id $twin -Snapshot $snap)) }
        }
        $script:Result = Get-SourceIdentityGroup -Documents $docs.ToArray()
    }

    It 'covers exactly 17 sets and 20 metadata-less twins (guards the frozen marks file)' {
        $script:Sets.Count | Should -Be 17
        $script:Twins.Count | Should -Be 20
        @($script:Twins | Sort-Object -Unique).Count | Should -Be 20
        @($script:Twins | Where-Object { $script:Sets.Contains($_) }).Count | Should -Be 0 -Because 'a twin is never also a titled target'
    }

    It 'puts every member of each set under one canonical' {
        foreach ($target in $script:Sets.Keys) {
            $members = @($target) + @($script:Sets[$target])
            $canon = @($members | ForEach-Object { $script:Result.Canonical[$_] } | Sort-Object -Unique)
            $canon.Count | Should -Be 1 -Because "set '$target' must join via the 4.2 hash edge"
        }
    }

    It 'keeps the 17 sets apart (one distinct canonical per set)' {
        $canons = @($script:Sets.Keys | ForEach-Object { $script:Result.Canonical[$_] } | Sort-Object -Unique)
        $canons.Count | Should -Be 17
    }
}

Describe 'Metadata-less folders that must NOT join (t/213)' -Tag 'source-identity' {

    It 'rejects a metadata-less -1 folder whose snapshot differs by one character' {
        $snap = New-TwinSnapshot -Seed 'onechar'
        $diff = $snap.Replace('word77 ', 'word7X ')
        $diff | Should -Not -Be $snap
        $r = Get-SourceIdentityGroup -Documents @(
            (New-TwinDoc -Id 'some-paper-2026' -Title 'Some Paper' -Snapshot $snap),
            (New-TwinDoc -Id 'some-paper-2026-1' -Snapshot $diff))
        $r.Canonical['some-paper-2026-1'] | Should -Not -Be $r.Canonical['some-paper-2026']
    }

    It 'rejects a metadata-less folder with no snapshot (SnapshotSha256 null)' {
        $r = Get-SourceIdentityGroup -Documents @(
            (New-TwinDoc -Id 'no-snap-2026' -Title 'No Snap' -Snapshot (New-TwinSnapshot -Seed 'nosnap')),
            (New-TwinDoc -Id 'no-snap-2026-1'))
        $r.Canonical['no-snap-2026-1'] | Should -Not -Be $r.Canonical['no-snap-2026']
    }

    It 'rejects two metadata-less folders (base, base-1) with null titles and different snapshots' {
        $r = Get-SourceIdentityGroup -Documents @(
            (New-TwinDoc -Id 'untitled-2026' -Snapshot (New-TwinSnapshot -Seed 'a')),
            (New-TwinDoc -Id 'untitled-2026-1' -Snapshot (New-TwinSnapshot -Seed 'b')))
        $r.Canonical['untitled-2026-1'] | Should -Not -Be $r.Canonical['untitled-2026'] -Because 'the 4.4 suffix edge needs equal non-empty titles'
    }

    It 'rejects when the titled member records a content_sha256 that differs from the twin snapshot hash' {
        $snap = New-TwinSnapshot -Seed 'recorded'
        $other = Get-SourceContentHash -Text (New-TwinSnapshot -Seed 'recorded-other')
        $other | Should -Not -Be (Get-SourceContentHash -Text $snap)
        $r = Get-SourceIdentityGroup -Documents @(
            (New-TwinDoc -Id 'recorded-2026' -Title 'Recorded' -Snapshot $snap -RecordedSha256 $other),
            (New-TwinDoc -Id 'recorded-2026-1' -Snapshot $snap))
        $r.Canonical['recorded-2026-1'] | Should -Not -Be $r.Canonical['recorded-2026'] -Because 'the recorded hash wins over the computed one'
    }
}
