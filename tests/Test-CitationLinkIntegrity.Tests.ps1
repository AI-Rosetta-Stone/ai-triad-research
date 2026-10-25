# Tag: config (t/3598)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for Test-CitationLinkIntegrity — advisory referential-integrity gate (t/3598).
    Both arms proven per leg (CL-locked predicate): a real dead link / dangling source /
    stale hash / wrong key count FAILS; a clean corpus PASSES. Pure over committed files.
#>

BeforeAll {
    Import-Module "$PSScriptRoot/../scripts/AITriad/AITriad.psm1" -Force

    function script:WriteJson($path, $obj) {
        $dir = Split-Path $path -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Set-Content -LiteralPath $path -Value ($obj | ConvertTo-Json -Depth 12) -Encoding utf8NoBOM
    }

    # Build an isolated fixture data tree. $Opts overrides let each scenario inject a defect.
    function script:New-CliFixture {
        param([hashtable]$Opts = @{})
        $fx  = Join-Path ([System.IO.Path]::GetTempPath()) ("cli-" + [guid]::NewGuid().ToString('N'))
        $tax = Join-Path $fx 'taxonomy'
        $sum = Join-Path $fx 'summaries'
        $src = Join-Path $fx 'sources'
        New-Item -ItemType Directory -Force -Path $tax, $sum, $src | Out-Null

        # Live nodes: 2 belief (acc-beliefs-010, saf-beliefs-201), 1 situation (sit-001)
        script:WriteJson (Join-Path $tax 'accelerationist.json') @{ pov='acc'; nodes=@(@{ id='acc-beliefs-010' }) }
        script:WriteJson (Join-Path $tax 'safetyist.json')       @{ pov='saf'; nodes=@(@{ id='saf-beliefs-201' }) }
        script:WriteJson (Join-Path $tax 'skeptic.json')         @{ pov='skp'; nodes=@() }
        script:WriteJson (Join-Path $tax 'situations.json')      @{ nodes=@(@{ id='sit-001' }) }

        # Clean summaries: all refs live; doc-beta uses a CHUNK-SUFFIXED doc_id (base resolves).
        script:WriteJson (Join-Path $sum 'doc-alpha.json') @{
            doc_id = 'src-alpha'
            pov_summaries = @{ saf = @{ key_points = @(@{ taxonomy_node_id='saf-beliefs-201'; verbatim='q1'; extraction_confidence=0.8 }) } }
            factual_claims = @(@{ claim='c1'; doc_position='p1'; evidence_criteria='strong'; extraction_confidence=0.7; linked_taxonomy_nodes=@('acc-beliefs-010','sit-001') })
        }
        script:WriteJson (Join-Path $sum 'doc-beta.json') @{
            doc_id = 'src-beta-2026-3'   # chunk -3 after year → only BASE src-beta-2026 dir exists → resolves via year-aware strip
            pov_summaries = @{ saf = @{ key_points = @(@{ taxonomy_node_id='saf-beliefs-201'; verbatim='q2'; extraction_confidence=0.6 }) } }
        }
        script:WriteJson (Join-Path $sum 'doc-gamma.json') @{
            doc_id = 'src-gamma-2026-1'  # chunk dir exists on its OWN → resolves as-is (no strip)
            pov_summaries = @{ saf = @{ key_points = @(@{ taxonomy_node_id='saf-beliefs-201'; verbatim='q3'; extraction_confidence=0.5 }) } }
        }
        # Optional defect: an extra summary with dead refs (leg-a fail arm)
        if ($Opts.ContainsKey('DeadRefs') -and $Opts.DeadRefs) {
            script:WriteJson (Join-Path $sum 'doc-dead.json') @{
                doc_id = 'src-alpha'
                pov_summaries = @{ skp = @{ key_points = @(@{ taxonomy_node_id='saf-dead-999'; verbatim='x' }) } }
                factual_claims = @(@{ claim='cx'; linked_taxonomy_nodes=@('sit-999') })
            }
        }
        # Optional defect: a summary whose source base does NOT resolve (leg-b dangle arm)
        if ($Opts.ContainsKey('DangleSource') -and $Opts.DangleSource) {
            script:WriteJson (Join-Path $sum 'doc-gone.json') @{
                doc_id = 'src-gone'
                pov_summaries = @{ saf = @{ key_points = @(@{ taxonomy_node_id='saf-beliefs-201'; verbatim='qz' }) } }
            }
        }
        # Optional: a summary whose doc_id is one of the REAL t/3743 accepted-baseline ids, with
        # no source dir — proves the allowlist against the actual hardcoded list, not an injected one.
        if ($Opts.ContainsKey('AllowlistedDangle') -and $Opts.AllowlistedDangle) {
            script:WriteJson (Join-Path $sum 'doc-allowlisted.json') @{
                doc_id = 'practical-tech-leader-2026'
                pov_summaries = @{ saf = @{ key_points = @(@{ taxonomy_node_id='saf-beliefs-201'; verbatim='qa' }) } }
            }
        }

        # Source dirs: src-alpha + src-beta (base of src-beta-3) resolve; src-gone intentionally absent.
        script:WriteJson (Join-Path $src 'src-alpha/metadata.json')          @{ id='src-alpha';          title='Alpha' }
        script:WriteJson (Join-Path $src 'src-beta-2026/metadata.json')      @{ id='src-beta-2026';      title='Beta (base only)' }   # doc_id src-beta-2026-3 resolves here via strip
        script:WriteJson (Join-Path $src 'src-gamma-2026-1/metadata.json')   @{ id='src-gamma-2026-1';   title='Gamma (chunk dir exists)' } # doc_id src-gamma-2026-1 resolves as-is

        # Build the real source_index so the header inputHash is correct for leg (c).
        $idxPath = Join-Path $tax 'source_index.json'
        Build-NodeSourceIndex -SummariesDir $sum -TaxonomyDir $tax -OutputPath $idxPath | Out-Null

        [pscustomobject]@{ Fx=$fx; Tax=$tax; Sum=$sum; Src=$src; Index=$idxPath }
    }

    function script:RunCli($f, [switch]$SkipSourceResolution) {
        if ($SkipSourceResolution) {
            # Deliberately do NOT pass -SourcesRoot — proves the switch removes the need for it
            # entirely (the t/3745 CI scenario: no ai-triad-sources checkout, so no valid root exists).
            Test-CitationLinkIntegrity -SummariesDir $f.Sum -TaxonomyDir $f.Tax -SourceIndexPath $f.Index -SkipSourceResolution -WarningAction SilentlyContinue
        } else {
            Test-CitationLinkIntegrity -SummariesDir $f.Sum -TaxonomyDir $f.Tax -SourceIndexPath $f.Index -SourcesRoot $f.Src -WarningAction SilentlyContinue
        }
    }
    function script:Leg($r, $leg) { $r.results | Where-Object { $_.leg -eq $leg } }

    $script:Fixtures = [System.Collections.Generic.List[string]]::new()
}

AfterAll {
    foreach ($p in $script:Fixtures) { if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue } }
}

Describe 'Test-CitationLinkIntegrity (t/3598)' -Tag 'config' {

    It 'is exported and callable' {
        Get-Command Test-CitationLinkIntegrity -ErrorAction SilentlyContinue | Should -Not -BeNullOrEmpty
    }

    It 'CLEAN corpus PASSES all three legs (incl. chunk-suffixed source_id resolving to base)' {
        $f = script:New-CliFixture; $script:Fixtures.Add($f.Fx)
        $r = script:RunCli $f
        $r.pass | Should -BeTrue
        (script:Leg $r 'a').pass | Should -BeTrue
        (script:Leg $r 'b').pass | Should -BeTrue   # src-beta-3 → src-beta resolves
        (script:Leg $r 'c').pass | Should -BeTrue
    }

    It 'LEG C carries liveKeysChecked, the live-node key-set size its staleness check runs against (t/4444)' {
        $f = script:New-CliFixture; $script:Fixtures.Add($f.Fx)
        $r = script:RunCli $f
        (script:Leg $r 'c').liveKeysChecked | Should -Be 2 -Because 'the fixture has 2 live belief nodes (acc-beliefs-010, saf-beliefs-201); situations are not in this set'
    }

    It 'LEG A FAILS on a dead belief id AND a dead situation id (class-aware)' {
        $f = script:New-CliFixture @{ DeadRefs = $true }; $script:Fixtures.Add($f.Fx)
        $r = script:RunCli $f
        $a = script:Leg $r 'a'
        $a.pass | Should -BeFalse
        @($a.offenders.ref) | Should -Contain 'saf-dead-999'
        @($a.offenders.ref) | Should -Contain 'sit-999'
        ($a.offenders | Where-Object ref -eq 'sit-999').class | Should -Be 'situation'
        # legs b/c still pass (index rebuilt over this summary set)
        (script:Leg $r 'b').pass | Should -BeTrue
        (script:Leg $r 'c').pass | Should -BeTrue
    }

    It 'LEG B FAILS on a dangling source (base dir absent) but not on chunk-suffixed ones' {
        $f = script:New-CliFixture @{ DangleSource = $true }; $script:Fixtures.Add($f.Fx)
        $r = script:RunCli $f
        $b = script:Leg $r 'b'
        $b.pass | Should -BeFalse
        @($b.offenders.source_id) | Should -Contain 'src-gone'
        @($b.offenders.source_id) | Should -Not -Contain 'src-beta-2026-3'    # resolves via year-aware base strip
        @($b.offenders.source_id) | Should -Not -Contain 'src-gamma-2026-1'   # resolves as-is (chunk dir exists)
        @($b.offenders.source_id) | Should -Not -Contain 'src-alpha'
    }

    It 'LEG C FAILS (stale hash) when a summary changes after the index was built' {
        $f = script:New-CliFixture; $script:Fixtures.Add($f.Fx)
        # mutate a summary AFTER the index was built → stored inputHash != recomputed
        script:WriteJson (Join-Path $f.Sum 'doc-alpha.json') @{
            doc_id='src-alpha'; pov_summaries=@{ saf=@{ key_points=@(@{ taxonomy_node_id='saf-beliefs-201'; verbatim='MUTATED' }) } }
        }
        $r = script:RunCli $f
        $c = script:Leg $r 'c'
        $c.pass | Should -BeFalse
        @($c.offenders.kind) | Should -Contain 'stale-hash'
    }

    It 'LEG C FAILS (missing-key) when a key is removed from the index but the node is still live (pure remove)' {
        $f = script:New-CliFixture; $script:Fixtures.Add($f.Fx)
        # drop a key from the built index — the live node still exists, so this is a missing-key,
        # not a dead-key (t/3896: set comparison, not count).
        $ix = Get-Content -Raw -LiteralPath $f.Index | ConvertFrom-Json
        $ix.index.PSObject.Properties.Remove('acc-beliefs-010')
        Set-Content -LiteralPath $f.Index -Value ($ix | ConvertTo-Json -Depth 12) -Encoding utf8NoBOM
        $r = script:RunCli $f
        $c = script:Leg $r 'c'
        $c.pass | Should -BeFalse
        @($c.offenders.kind) | Should -Contain 'missing-key'
        @($c.offenders.kind) | Should -Not -Contain 'dead-key'
        (@($c.offenders) | Where-Object { $_.kind -eq 'missing-key' }).nodes | Should -Contain 'acc-beliefs-010'
    }

    It 'LEG C FAILS (dead-key) when the index carries an extra key for a non-live node (pure add of a stale key)' {
        $f = script:New-CliFixture; $script:Fixtures.Add($f.Fx)
        # add a key to the index for a node that doesn't exist live — keyCount(3) > liveNodes(2).
        $ix = Get-Content -Raw -LiteralPath $f.Index | ConvertFrom-Json
        $ix.index | Add-Member -NotePropertyName 'acc-beliefs-999' -NotePropertyValue @() -Force
        Set-Content -LiteralPath $f.Index -Value ($ix | ConvertTo-Json -Depth 12) -Encoding utf8NoBOM
        $r = script:RunCli $f
        $c = script:Leg $r 'c'
        $c.pass | Should -BeFalse
        @($c.offenders.kind) | Should -Contain 'dead-key'
        @($c.offenders.kind) | Should -Not -Contain 'missing-key'
        (@($c.offenders) | Where-Object { $_.kind -eq 'dead-key' }).keys | Should -Contain 'acc-beliefs-999'
    }

    It 'LEG C FAILS with BOTH dead-key and missing-key on a swap (remove one key, add an unrelated one) -- same key count throughout (t/3896)' {
        $f = script:New-CliFixture; $script:Fixtures.Add($f.Fx)
        # Swap: remove acc-beliefs-010's key, add a key for a non-live node. keyCount stays 2 ==
        # liveNodes(2) -- the old count-only check would have PASSED this; it must now FAIL both arms.
        $ix = Get-Content -Raw -LiteralPath $f.Index | ConvertFrom-Json
        $ix.index.PSObject.Properties.Remove('acc-beliefs-010')
        $ix.index | Add-Member -NotePropertyName 'acc-beliefs-999' -NotePropertyValue @() -Force
        Set-Content -LiteralPath $f.Index -Value ($ix | ConvertTo-Json -Depth 12) -Encoding utf8NoBOM
        $r = script:RunCli $f
        $c = script:Leg $r 'c'
        $c.pass | Should -BeFalse
        @($c.offenders.kind) | Should -Contain 'dead-key'
        @($c.offenders.kind) | Should -Contain 'missing-key'
        (@($c.offenders) | Where-Object { $_.kind -eq 'dead-key' }).keys | Should -Contain 'acc-beliefs-999'
        (@($c.offenders) | Where-Object { $_.kind -eq 'missing-key' }).nodes | Should -Contain 'acc-beliefs-010'
        # Prove the test's own premise (CL review note, p/23#472): the swap must actually leave
        # keyCount == liveNodes, or this isn't exercising the count-equal blind spot at all.
        (@($c.offenders) | Where-Object { $_.kind -eq 'dead-key' }).keyCount | Should -Be (@($c.offenders) | Where-Object { $_.kind -eq 'dead-key' }).liveNodes
    }

    It 'LEG B: accepted-baseline allowlist PASSES a known orphan while a NEW dangle still FAILS (t/3743)' {
        $f = script:New-CliFixture @{ DangleSource = $true; AllowlistedDangle = $true }; $script:Fixtures.Add($f.Fx)
        $r = script:RunCli $f
        $b = script:Leg $r 'b'
        $b.pass | Should -BeFalse   # src-gone is NOT allowlisted — still an offender, leg-b still fails overall
        @($b.offenders.source_id) | Should -Contain 'src-gone'
        @($b.offenders.source_id) | Should -Not -Contain 'practical-tech-leader-2026'   # allowlisted → not an offender
        @($b.accepted.source_id) | Should -Contain 'practical-tech-leader-2026'
        (@($b.accepted) | Where-Object { $_.source_id -eq 'practical-tech-leader-2026' }).reason | Should -Match 't/3598#8'
    }

    It 'LEG B PASSES entirely when the only dangle present is accepted-baseline' {
        $f = script:New-CliFixture @{ AllowlistedDangle = $true }; $script:Fixtures.Add($f.Fx)
        $r = script:RunCli $f
        $b = script:Leg $r 'b'
        $b.pass | Should -BeTrue
        @($b.offenders).Count | Should -Be 0
        @($b.accepted.source_id) | Should -Contain 'practical-tech-leader-2026'
    }

    It '-SkipSourceResolution: leg-b reports SKIPPED (pass, no offenders) even with a real dangle present (t/3745)' {
        $f = script:New-CliFixture @{ DangleSource = $true }; $script:Fixtures.Add($f.Fx)   # src-gone would normally FAIL leg-b
        $r = script:RunCli $f -SkipSourceResolution
        $b = script:Leg $r 'b'
        $b.pass | Should -BeTrue          # NOT evaluated — src-gone's would-be failure never runs
        $b.skipped | Should -BeTrue
        @($b.offenders).Count | Should -Be 0
        @($b.accepted).Count | Should -Be 0
        $b.checked | Should -Be 0
        $r.pass | Should -BeTrue           # leg-b skip does not drag down overall pass
    }

    It '-SkipSourceResolution: legs a+c still run normally (a+c-now CI split, t/3745)' {
        $f = script:New-CliFixture @{ DeadRefs = $true }; $script:Fixtures.Add($f.Fx)   # leg-a SHOULD still fail
        $r = script:RunCli $f -SkipSourceResolution
        $a = script:Leg $r 'a'
        $a.pass | Should -BeFalse
        @($a.offenders.ref) | Should -Contain 'saf-dead-999'
        $c = script:Leg $r 'c'
        $c.pass | Should -BeTrue           # index rebuilt over this summary set — leg-c unaffected by the skip
        (script:Leg $r 'b').skipped | Should -BeTrue
    }

    It '-SkipSourceResolution never touches SourcesRoot — no throw even with no sources dir at all' {
        $f = script:New-CliFixture; $script:Fixtures.Add($f.Fx)
        Remove-Item -Recurse -Force $f.Src   # simulate the t/3745 CI scenario: no ai-triad-sources checkout
        { Test-CitationLinkIntegrity -SummariesDir $f.Sum -TaxonomyDir $f.Tax -SourceIndexPath $f.Index -SkipSourceResolution -WarningAction SilentlyContinue } |
            Should -Not -Throw
    }

    It 'never throws on offenders, and reports the blocking toggle state' {
        $f = script:New-CliFixture @{ DeadRefs = $true; DangleSource = $true }; $script:Fixtures.Add($f.Fx)
        { script:RunCli $f } | Should -Not -Throw
        (script:RunCli $f).blocking | Should -BeTrue   # leg-a promoted (t/4042); enforcement lives in the data workflow
    }
}

Describe 'Test-CitationLinkIntegrity leg-a statistic-provenance (t/4042)' -Tag 'config' {

    It 'leg-a reports summariesScanned and refsChecked on the clean fixture (3 summaries, 5 refs)' {
        $f = script:New-CliFixture; $script:Fixtures.Add($f.Fx)
        $a = script:Leg (script:RunCli $f) 'a'
        $a.summariesScanned | Should -Be 3
        $a.refsChecked | Should -Be 5   # alpha: 1 key point + 2 linked; beta: 1; gamma: 1
        $a.pass | Should -BeTrue
    }

    It 'dead refs are still counted (refsChecked counts what was resolved, not what passed); pass/fail unchanged' {
        $f = script:New-CliFixture @{ DeadRefs = $true }; $script:Fixtures.Add($f.Fx)
        $a = script:Leg (script:RunCli $f) 'a'
        $a.summariesScanned | Should -Be 4
        $a.refsChecked | Should -Be 7
        $a.pass | Should -BeFalse
        @($a.offenders).Count | Should -Be 2
    }

    It 'blank and null refs are not counted' {
        $f = script:New-CliFixture; $script:Fixtures.Add($f.Fx)
        script:WriteJson (Join-Path $f.Sum 'doc-blank.json') @{
            doc_id = 'src-alpha'
            pov_summaries = @{ saf = @{ key_points = @(@{ taxonomy_node_id = $null; verbatim = 'n' }, @{ taxonomy_node_id = '  '; verbatim = 'b' }) } }
            factual_claims = @(@{ claim = 'c'; linked_taxonomy_nodes = @('', 'sit-001') })
        }
        $a = script:Leg (script:RunCli $f -SkipSourceResolution) 'a'
        $a.summariesScanned | Should -Be 4
        $a.refsChecked | Should -Be 6   # 5 + the one non-blank 'sit-001'
    }

    It 'an empty summaries dir gives 0/0 and leg-a is still present' {
        $f = script:New-CliFixture; $script:Fixtures.Add($f.Fx)
        Get-ChildItem -LiteralPath $f.Sum -Filter '*.json' | Remove-Item -Force
        $r = script:RunCli $f -SkipSourceResolution
        $a = script:Leg $r 'a'
        $a | Should -Not -BeNullOrEmpty
        $a.summariesScanned | Should -Be 0
        $a.refsChecked | Should -Be 0
        $a.PSObject.Properties.Name | Should -Contain 'summariesScanned'
        $a.PSObject.Properties.Name | Should -Contain 'refsChecked'
    }
}
