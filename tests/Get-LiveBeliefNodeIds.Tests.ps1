# Tag: config (t/4441, SO C4 for the t/4147 leg-c promotion)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# Build-NodeSourceIndex and Test-CitationLinkIntegrity leg-c now share one live-belief-node function, so the
# builder and the gate cannot drift. Covers: the function's sets (superseded, cycle, dangling, missing file), a
# differential against the old inline loop on the real POV files, and SO arms (d) and (e): build, leg-c passes
# on the fresh index, corrupt the index, leg-c fails.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    function script:WriteJson($path, $obj) {
        New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force | Out-Null
        Set-Content -LiteralPath $path -Value ($obj | ConvertTo-Json -Depth 10) -Encoding utf8NoBOM
    }
    function script:New-Fixture {
        $root = Join-Path $TestDrive ("f-" + [guid]::NewGuid().ToString('N'))
        [pscustomobject]@{ Root = $root; Tax = (Join-Path $root 'taxonomy'); Sum = (Join-Path $root 'summaries'); Src = (Join-Path $root 'sources'); Index = (Join-Path $root 'taxonomy' 'source_index.json') }
    }
    function script:Leg($r, $leg) { $r.results | Where-Object { $_.leg -eq $leg } }
    function script:Check($f) {
        Test-CitationLinkIntegrity -SummariesDir $f.Sum -TaxonomyDir $f.Tax -SourceIndexPath $f.Index -SourcesRoot $f.Src -WarningAction SilentlyContinue 6>$null
    }
}

Describe 'Get-LiveBeliefNodeIds (t/4441)' -Tag 'config' {
    BeforeAll {
        $script:F = New-Fixture
        WriteJson (Join-Path $script:F.Tax 'accelerationist.json') @{ nodes = @(
                @{ id = 'acc-old'; superseded_by = 'acc-new' }, @{ id = 'acc-new' },
                @{ id = 'acc-cyc-1'; superseded_by = 'acc-cyc-2' }, @{ id = 'acc-cyc-2'; superseded_by = 'acc-cyc-1' },
                @{ id = 'acc-dangle'; superseded_by = 'acc-gone' }) }
        WriteJson (Join-Path $script:F.Tax 'safetyist.json') @{ nodes = @(@{ id = 'saf-1' }) }
        WriteJson (Join-Path $script:F.Tax 'skeptic.json') @{ nodes = @() }
        $script:Ids = InModuleScope AITriad -Parameters @{ T = $script:F.Tax } { param($T) Get-LiveBeliefNodeIds -TaxonomyDir $T 3>$null }
    }

    It 'keys are resolved ids: a superseded node with a survivor is not live; cycle and dangling members stay live as themselves' {
        @($script:Ids.Live | Sort-Object) | Should -Be @('acc-cyc-1', 'acc-cyc-2', 'acc-dangle', 'acc-new', 'saf-1')
    }

    It 'All keeps every stored id (leg a: a citation of a since-superseded node is still a known node)' {
        $script:Ids.All.Contains('acc-old') | Should -BeTrue
        $script:Ids.All.Count | Should -Be 6
    }

    It 'ResolveMap folds only ids that resolve elsewhere' {
        $script:Ids.ResolveMap['acc-old'] | Should -BeExactly 'acc-new'
        $script:Ids.ResolveMap.ContainsKey('acc-cyc-1') | Should -BeFalse
        $script:Ids.ResolveMap.ContainsKey('acc-dangle') | Should -BeFalse
    }

    It 'a missing POV file throws (fails closed), in both cmdlets' {
        $f = New-Fixture
        WriteJson (Join-Path $f.Tax 'accelerationist.json') @{ nodes = @(@{ id = 'acc-1' }) }
        WriteJson (Join-Path $f.Tax 'safetyist.json') @{ nodes = @() }
        New-Item -ItemType Directory -Path $f.Sum, $f.Src -Force | Out-Null
        { InModuleScope AITriad -Parameters @{ T = $f.Tax } { param($T) Get-LiveBeliefNodeIds -TaxonomyDir $T } } | Should -Throw '*skeptic.json*'
        { Build-NodeSourceIndex -SummariesDir $f.Sum -TaxonomyDir $f.Tax -SourcesDir $f.Src -OutputPath $f.Index -WarningAction SilentlyContinue 6>$null } | Should -Throw '*skeptic.json*'
        { Test-CitationLinkIntegrity -SummariesDir $f.Sum -TaxonomyDir $f.Tax -SourceIndexPath $f.Index -SourcesRoot $f.Src -WarningAction SilentlyContinue 6>$null } | Should -Throw '*skeptic.json*'
    }

    It 'matches the old inline loop on the real POV files (differential)' {
        $tax = InModuleScope AITriad { Get-TaxonomyDir }
        if (-not $tax -or -not (Test-Path (Join-Path $tax 'accelerationist.json'))) { Set-ItResult -Skipped -Because 'no ai-triad-data checkout resolves here (CI has none)'; return }
        $old = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($f in 'accelerationist.json', 'safetyist.json', 'skeptic.json') {
            $doc = Get-Content -Raw -LiteralPath (Join-Path $tax $f) | ConvertFrom-Json
            foreach ($n in @($doc.nodes)) { if ($n.PSObject.Properties['id'] -and $n.id) { [void]$old.Add([string]$n.id) } }
        }
        $new = InModuleScope AITriad -Parameters @{ T = $tax } { param($T) Get-LiveBeliefNodeIds -TaxonomyDir $T 3>$null }
        $new.All.SetEquals($old) | Should -BeTrue
        if ($new.ResolveMap.Count -eq 0) { $new.Live.SetEquals($old) | Should -BeTrue -Because 'with no superseded node the live set is unchanged' }
    }
}

Describe 'SO arm (d): a superseded node, builder and leg-c agree (t/4441)' -Tag 'config' {
    BeforeAll {
        $script:D = New-Fixture
        WriteJson (Join-Path $script:D.Tax 'accelerationist.json') @{ nodes = @(@{ id = 'acc-old'; superseded_by = 'acc-new' }, @{ id = 'acc-new' }, @{ id = 'acc-other' }) }
        WriteJson (Join-Path $script:D.Tax 'safetyist.json') @{ nodes = @() }
        WriteJson (Join-Path $script:D.Tax 'skeptic.json') @{ nodes = @() }
        WriteJson (Join-Path $script:D.Sum 'doc-one.json') @{ doc_id = 'doc-one'; pov_summaries = @{ acc = @{ key_points = @(
                        @{ taxonomy_node_id = 'acc-old'; verbatim = 'cites the retired node' },
                        @{ taxonomy_node_id = 'acc-other'; verbatim = 'cites a live node' }) } } }
        WriteJson (Join-Path $script:D.Src 'doc-one' 'metadata.json') @{ id = 'doc-one'; title = 'Doc one' }
        $script:IxD = Build-NodeSourceIndex -SummariesDir $script:D.Sum -TaxonomyDir $script:D.Tax -SourcesDir $script:D.Src -OutputPath $script:D.Index -PassThru -WarningAction SilentlyContinue 6>$null
    }

    It 'the builder keys the survivor, not the superseded node, and folds its link there' {
        @($script:IxD.index.PSObject.Properties.Name | Sort-Object) | Should -Be @('acc-new', 'acc-other')
        @($script:IxD.index.'acc-new').Count | Should -Be 1
        $script:IxD.index.'acc-new'[0].quote | Should -BeExactly 'cites the retired node'
    }

    It 'leg-c passes on the fresh index, and leg a accepts the citation of the superseded node' {
        $r = Check $script:D
        (Leg $r 'c').pass | Should -BeTrue
        (Leg $r 'a').pass | Should -BeTrue
    }

    It 'leg-c fails when the index is corrupted with a key for the superseded node' {
        $ix = Get-Content -Raw -LiteralPath $script:D.Index | ConvertFrom-Json
        $ix.index | Add-Member -NotePropertyName 'acc-old' -NotePropertyValue @()
        $bad = New-Fixture; Copy-Item -Recurse $script:D.Root $bad.Root
        Set-Content -LiteralPath $bad.Index -Value ($ix | ConvertTo-Json -Depth 10) -Encoding utf8NoBOM
        (Leg (Check $bad) 'c').pass | Should -BeFalse
    }
}

Describe 'SO arm (e): a duplicate_of-marked summary, builder and leg-c agree (t/4441)' -Tag 'config' {
    BeforeAll {
        $script:E = New-Fixture
        WriteJson (Join-Path $script:E.Tax 'accelerationist.json') @{ nodes = @(@{ id = 'acc-1' }, @{ id = 'acc-2' }) }
        WriteJson (Join-Path $script:E.Tax 'safetyist.json') @{ nodes = @() }
        WriteJson (Join-Path $script:E.Tax 'skeptic.json') @{ nodes = @() }
        WriteJson (Join-Path $script:E.Sum 'canon.json') @{ doc_id = 'canon'; pov_summaries = @{ acc = @{ key_points = @(@{ taxonomy_node_id = 'acc-1'; verbatim = 'canonical point' }) } } }
        WriteJson (Join-Path $script:E.Sum 'copy.json') @{ doc_id = 'copy'; pov_summaries = @{ acc = @{ key_points = @(@{ taxonomy_node_id = 'acc-2'; verbatim = 'copy-only point' }) } } }
        WriteJson (Join-Path $script:E.Src 'canon' 'metadata.json') @{ id = 'canon'; title = 'The work' }
        WriteJson (Join-Path $script:E.Src 'copy' 'metadata.json') @{ id = 'copy'; title = 'The work'; duplicate_of = 'canon' }
        $script:IxE = Build-NodeSourceIndex -SummariesDir $script:E.Sum -TaxonomyDir $script:E.Tax -SourcesDir $script:E.Src -OutputPath $script:E.Index -PassThru -WarningAction SilentlyContinue 6>$null
    }

    It 'the builder attributes the copy''s link to the canonical (evidence union)' {
        @($script:IxE.index.'acc-2'.source_id) | Should -Be @('canon')
    }

    It 'leg-c passes on the fresh index' {
        (Leg (Check $script:E) 'c').pass | Should -BeTrue
    }

    It 'leg-c fails when a live node''s key is removed from the index' {
        $ix = Get-Content -Raw -LiteralPath $script:E.Index | ConvertFrom-Json
        $ix.index.PSObject.Properties.Remove('acc-2')
        $bad = New-Fixture; Copy-Item -Recurse $script:E.Root $bad.Root
        Set-Content -LiteralPath $bad.Index -Value ($ix | ConvertTo-Json -Depth 10) -Encoding utf8NoBOM
        (Leg (Check $bad) 'c').pass | Should -BeFalse
    }
}
