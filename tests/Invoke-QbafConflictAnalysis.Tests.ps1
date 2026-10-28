# Tag: enrichment (t/1403)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Regression coverage for the QBAF conflict-analysis two-stage detector (t/1403).
.DESCRIPTION
    The critical property this suite guards (AC#3): the edge count is
    MONOTONIC — turning Stage B on (embedding + LLM confirmation) can only
    grow the edge count vs. the node-overlap-only baseline. Never shrinks
    it, never rewrites Stage A output.

    Fixtures: 4 synthetic factual claims across 2 documents.
      - (A1, B1): share a linked_taxonomy_node with opposing positions
                  -> Stage A edge (attacks).
      - (A2, B2): share NO taxonomy nodes but are topically identical
                  (embedding will surface them) -> Stage B candidate.
    Both Get-TextEmbedding and Invoke-AIByUsage are mocked, so no Python
    or live AI calls are required.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    # Scratch data dir with fixture summaries. Tests override Get-SummariesDir
    # so the cmdlet reads from here instead of the real data root.
    $script:FixtureDir   = Join-Path ([System.IO.Path]::GetTempPath()) "qbaf-t1403-$(Get-Random)"
    $script:SummariesDir = Join-Path $script:FixtureDir 'summaries'
    $null = New-Item -ItemType Directory -Path $script:SummariesDir -Force

    # DOC A: two claims (A1 shares a taxonomy node with B1; A2 shares none)
    @{
        factual_claims = @(
            @{
                claim = 'Federal AI regulation should mandate third-party safety audits for frontier models.'
                claim_label = 'A1'
                linked_taxonomy_nodes = @('saf-desires-001')
                doc_position = 'supports'
            }
            @{
                claim = 'Open-source model weights should be broadly available so researchers can audit them independently.'
                claim_label = 'A2'
                linked_taxonomy_nodes = @()
                doc_position = 'supports'
            }
        )
    } | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:SummariesDir 'docA.json') -Encoding utf8NoBOM

    # DOC B: two claims (B1 shares saf-desires-001 with A1; B2 topically matches A2)
    @{
        factual_claims = @(
            @{
                claim = 'Mandatory third-party audits for frontier AI models would slow deployment without measurable safety gains.'
                claim_label = 'B1'
                linked_taxonomy_nodes = @('saf-desires-001')
                doc_position = 'disputes'
            }
            @{
                claim = 'Broad availability of open-source model weights lets independent researchers audit them freely.'
                claim_label = 'B2'
                linked_taxonomy_nodes = @()
                doc_position = 'supports'
            }
        )
    } | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:SummariesDir 'docB.json') -Encoding utf8NoBOM
}

AfterAll {
    if ($script:FixtureDir -and (Test-Path $script:FixtureDir)) {
        Remove-Item -Recurse -Force -Path $script:FixtureDir -ErrorAction SilentlyContinue
    }
}

Describe 'Invoke-QbafConflictAnalysis Stage A/B monotonicity (t/1403 AC#3)' -Tag 'enrichment' {

    # Common wiring: pipe fixture paths + embedding shape into the module scope
    # via -Parameters on InModuleScope; Mock scriptblocks close over them via
    # GetNewClosure so the mocked helpers return fixture values instead of
    # live filesystem or Python results.
    BeforeEach {
        InModuleScope AITriad -Parameters @{
            SD = $script:SummariesDir
            FD = $script:FixtureDir
        } {
            param($SD, $FD)
            Mock Get-SummariesDir -MockWith ({ $SD }.GetNewClosure())
            Mock Get-DataRoot     -MockWith ({ $FD }.GetNewClosure())
        }
    }

    Context 'Baseline: embedding subsystem down, Stage A only' {
        BeforeEach {
            InModuleScope AITriad {
                Mock Get-TextEmbedding -MockWith { $null }
            }
        }

        It 'Detects the node-overlap A1/B1 attack and nothing from Stage B' {
            $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null
            $r                       | Should -Not -BeNullOrEmpty
            $r.ClaimCount            | Should -Be 4
            $r.EmbeddingEnabled      | Should -Be $false
            $r.NodeOverlapEdges      | Should -Be 1
            $r.EmbeddingEdges        | Should -Be 0
            $r.EdgeCount             | Should -Be 1
            $r.AttackCount           | Should -Be 1
            $r.SupportCount          | Should -Be 0
        }
    }

    Context 'Stage B on, LLM confirms A2/B2 as supports — total edges GROWS' {
        BeforeEach {
            InModuleScope AITriad {
                # Vectors: qc-2 (A2) == qc-4 (B2) at cosine 1.0 → will be
                # a Stage B candidate; everything else orthogonal (cosine 0).
                Mock Get-TextEmbedding -MockWith {
                    $result = @{}
                    foreach ($id in $Ids) {
                        if ($id -eq 'qc-2' -or $id -eq 'qc-4') {
                            $result[$id] = [double[]]@(1.0, 0.0, 0.0)
                        } elseif ($id -eq 'qc-1') {
                            $result[$id] = [double[]]@(0.0, 1.0, 0.0)
                        } else {
                            $result[$id] = [double[]]@(0.0, 0.0, 1.0)
                        }
                    }
                    return $result
                }
                Mock Get-Prompt        -MockWith { 'stub prompt' }
                Mock Invoke-AIByUsage  -MockWith {
                    [PSCustomObject]@{
                        Text = '{"relation":"supports","confidence":0.85,"rationale":"Both endorse open weights."}'
                    }
                }
            }
        }

        It 'Edge count exceeds baseline: Stage A preserved + Stage B adds one confirmed edge' {
            $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null
            $r.EmbeddingEnabled      | Should -Be $true
            $r.StageBCandidates      | Should -Be 1
            $r.NodeOverlapEdges      | Should -Be 1
            $r.EmbeddingEdges        | Should -Be 1
            $r.EdgeCount             | Should -Be 2
            $r.StageBConfirmed       | Should -Be 1
            $r.StageBRejected        | Should -Be 0
        }
    }

    Context 'Stage B on, LLM rejects A2/B2 as unrelated — total edges stays at Stage A baseline' {
        BeforeEach {
            InModuleScope AITriad {
                Mock Get-TextEmbedding -MockWith {
                    param($Texts, $Ids)
                    $result = @{}
                    foreach ($id in $Ids) {
                        if ($id -eq 'qc-2' -or $id -eq 'qc-4') {
                            $result[$id] = [double[]]@(1.0, 0.0, 0.0)
                        } elseif ($id -eq 'qc-1') {
                            $result[$id] = [double[]]@(0.0, 1.0, 0.0)
                        } else {
                            $result[$id] = [double[]]@(0.0, 0.0, 1.0)
                        }
                    }
                    return $result
                }
                Mock Get-Prompt        -MockWith { 'stub prompt' }
                Mock Invoke-AIByUsage  -MockWith {
                    [PSCustomObject]@{
                        Text = '{"relation":"unrelated","confidence":0.9,"rationale":"Different topics."}'
                    }
                }
            }
        }

        It 'Candidate seen and rejected — no edge added' {
            $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null
            $r.EmbeddingEnabled      | Should -Be $true
            $r.NodeOverlapEdges      | Should -Be 1
            $r.EmbeddingEdges        | Should -Be 0
            $r.EdgeCount             | Should -Be 1
            $r.StageBCandidates      | Should -Be 1
            $r.StageBConfirmed       | Should -Be 0
            $r.StageBRejected        | Should -Be 1
        }
    }

    Context 'Low-confidence LLM response treated as rejection' {
        BeforeEach {
            InModuleScope AITriad {
                Mock Get-TextEmbedding -MockWith {
                    param($Texts, $Ids)
                    $result = @{}
                    foreach ($id in $Ids) {
                        if ($id -eq 'qc-2' -or $id -eq 'qc-4') { $result[$id] = [double[]]@(1.0, 0.0, 0.0) }
                        else { $result[$id] = [double[]]@(0.0, 0.0, 1.0) }
                    }
                    return $result
                }
                Mock Get-Prompt       -MockWith { 'stub prompt' }
                Mock Invoke-AIByUsage -MockWith {
                    [PSCustomObject]@{
                        Text = '{"relation":"supports","confidence":0.4,"rationale":"weak signal"}'
                    }
                }
            }
        }

        It 'Does not add an edge when confidence < 0.6 floor' {
            $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null
            $r.EmbeddingEdges  | Should -Be 0
            $r.StageBRejected  | Should -Be 1
            $r.StageBConfirmed | Should -Be 0
        }
    }

    Context 'Stage A directional gate (t/2745 V2, shared engine t/2751) — opposition-only' {
        # Two cross-doc claims sharing a node, BOTH doc_position=supports. The
        # legacy rule emits a `supports` edge from position-equality alone; the
        # gate instead judges the actual claim↔claim direction via the shared
        # engine (opposition-only: opposes→attacks, everything else keeps the
        # support edge). Get-TextEmbedding is mocked null (Stage B off) so the
        # only python call is the nli_classify engine, which the shadow controls
        # (items carry .claim_prop; the shadow returns [{id,direction,...}]).
        BeforeEach {
            $script:V2Dir       = Join-Path ([System.IO.Path]::GetTempPath()) "qbaf-v2-$(Get-Random)"
            $script:V2Summaries = Join-Path $script:V2Dir 'summaries'
            $null = New-Item -ItemType Directory -Path $script:V2Summaries -Force
            @{ factual_claims = @(@{ claim='Third-party audits improve frontier-model safety.'
                claim_label='C1'; linked_taxonomy_nodes=@('saf-desires-002'); doc_position='supports' }) } |
                ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:V2Summaries 'docC.json') -Encoding utf8NoBOM
            @{ factual_claims = @(@{ claim='Third-party audits do NOT improve frontier-model safety.'
                claim_label='D1'; linked_taxonomy_nodes=@('saf-desires-002'); doc_position='supports' }) } |
                ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:V2Summaries 'docD.json') -Encoding utf8NoBOM

            InModuleScope AITriad -Parameters @{ SD = $script:V2Summaries; FD = $script:V2Dir } {
                param($SD, $FD)
                Mock Get-SummariesDir -MockWith ({ $SD }.GetNewClosure())
                Mock Get-DataRoot     -MockWith ({ $FD }.GetNewClosure())
                Mock Get-TextEmbedding -MockWith { $null }   # Stage B off
                # t/4572 write-freeze: this Context shadows the python subprocess itself to
                # control the engine's verdict deterministically -- bypass the freeze so the
                # gate's OWN opposition-only logic still runs against that shadow.
                Mock Test-NliDirectionalGateFrozen { $false }
            }
        }
        AfterEach {
            if ($script:V2Dir -and (Test-Path $script:V2Dir)) {
                Remove-Item -Recurse -Force -Path $script:V2Dir -ErrorAction SilentlyContinue
            }
        }

        It 'INVERSION ARM: opposes flips the equal-doc_position support to an attack' {
            InModuleScope AITriad {
                function python {
                    process {
                        $items = @($input | Out-String | ConvertFrom-Json)
                        $out = foreach ($it in $items) {
                            [pscustomobject]@{ id=$it.id; direction='opposes'; confidence=1.5; method='nli' }
                        }
                        ConvertTo-Json -InputObject @($out) -Depth 5
                    }
                }
                $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null
                $r.SupportCount             | Should -Be 0 -Because 'the false support is caught'
                $r.AttackCount              | Should -Be 1 -Because 'contradicting claims become an attack'
                $r.EdgeCount                | Should -Be 1
                $r.DirectionalCounts.opposes | Should -Be 1
            }
        }

        It 'KEEP ARM: a non-opposes verdict (unrelated) keeps the support edge' {
            InModuleScope AITriad {
                function python {
                    process {
                        $items = @($input | Out-String | ConvertFrom-Json)
                        $out = foreach ($it in $items) {
                            [pscustomobject]@{ id=$it.id; direction='unrelated'; confidence=0.1; method='nli' }
                        }
                        ConvertTo-Json -InputObject @($out) -Depth 5
                    }
                }
                $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null
                $r.SupportCount               | Should -Be 1
                $r.AttackCount                | Should -Be 0
                $r.EdgeCount                  | Should -Be 1
                $r.DirectionalCounts.unrelated | Should -Be 1
            }
        }

        It 'FAIL-SAFE ARM: unresolved KEEPS the support edge (never a false attack) and records the count' {
            InModuleScope AITriad {
                function python { process { $null = $input } }   # engine unavailable
                $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null
                $r.SupportCount                | Should -Be 1 -Because 'unresolved → keep (no false demotion)'
                $r.AttackCount                 | Should -Be 0
                $r.EdgeCount                   | Should -Be 1
                $r.DirectionalCounts.unresolved | Should -Be 1
            }
        }

        It 'LEGACY ARM: -SkipDirectionalGate restores the polarity-blind supports edge' {
            InModuleScope AITriad {
                function python { process { throw 'gate must not call python when skipped' } }
                $r = Invoke-QbafConflictAnalysis -DryRun -PassThru -SkipDirectionalGate 6>$null
                $r.SupportCount | Should -Be 1 -Because 'gate off → equal doc_position emits supports'
                $r.EdgeCount    | Should -Be 1
            }
        }

        It 'TEMPORAL GATE (t/4474): opposes with non-overlapping temporal bounds is held, not an attack' {
            # Overwrite the shared fixture (constructed): same opposing claims, but now with
            # disjoint temporal windows -- "audits improve safety by 2026" vs "audits do NOT
            # improve safety, 2030-2035" are about different eras, not necessarily in tension.
            @{ factual_claims = @(@{ claim='Third-party audits improve frontier-model safety by 2026.'
                claim_label='C1'; linked_taxonomy_nodes=@('saf-desires-002'); doc_position='supports'
                temporal_bound = 'by 2026' }) } |
                ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:V2Summaries 'docC.json') -Encoding utf8NoBOM
            @{ factual_claims = @(@{ claim='Third-party audits will NOT improve frontier-model safety, 2030-2035.'
                claim_label='D1'; linked_taxonomy_nodes=@('saf-desires-002'); doc_position='supports'
                temporal_bound = '2030-2035' }) } |
                ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:V2Summaries 'docD.json') -Encoding utf8NoBOM

            InModuleScope AITriad {
                function python {
                    process {
                        $items = @($input | Out-String | ConvertFrom-Json)
                        $out = foreach ($it in $items) {
                            [pscustomobject]@{ id=$it.id; direction='opposes'; confidence=1.5; method='nli' }
                        }
                        ConvertTo-Json -InputObject @($out) -Depth 5
                    }
                }
                $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null
                $r.SupportCount      | Should -Be 0 -Because 'held, not the provisional support -- the two claims are not confirmed comparable'
                $r.AttackCount       | Should -Be 0 -Because 'disjoint temporal windows -- not confirmed as a rebut'
                $r.EdgeCount         | Should -Be 0
                $r.TemporalGateHeld  | Should -Be 1
            }
        }

        It 'TEMPORAL GATE (t/4474): overlapping temporal bounds still confirm the attack as before' {
            @{ factual_claims = @(@{ claim='Third-party audits improve frontier-model safety, 2023-2027.'
                claim_label='C1'; linked_taxonomy_nodes=@('saf-desires-002'); doc_position='supports'
                temporal_bound = '2023-2027' }) } |
                ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:V2Summaries 'docC.json') -Encoding utf8NoBOM
            @{ factual_claims = @(@{ claim='Third-party audits will NOT improve frontier-model safety, 2026-2030.'
                claim_label='D1'; linked_taxonomy_nodes=@('saf-desires-002'); doc_position='supports'
                temporal_bound = '2026-2030' }) } |
                ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $script:V2Summaries 'docD.json') -Encoding utf8NoBOM

            InModuleScope AITriad {
                function python {
                    process {
                        $items = @($input | Out-String | ConvertFrom-Json)
                        $out = foreach ($it in $items) {
                            [pscustomobject]@{ id=$it.id; direction='opposes'; confidence=1.5; method='nli' }
                        }
                        ConvertTo-Json -InputObject @($out) -Depth 5
                    }
                }
                $r = Invoke-QbafConflictAnalysis -DryRun -PassThru 6>$null
                $r.AttackCount      | Should -Be 1 -Because '2023-2027 and 2026-2030 overlap -- confirmed as before'
                $r.TemporalGateHeld | Should -Be 0
            }
        }
    }

    Context 'Temporal-bound gate on the hard node-overlap conflict (t/4474)' {
        # The doc_position-only hard-conflict path (before the directional gate even runs):
        # opposing doc_position on a shared node, with disjoint temporal_bound windows.
        AfterEach {
            if ($script:TDir -and (Test-Path $script:TDir)) {
                Remove-Item -Recurse -Force -Path $script:TDir -ErrorAction SilentlyContinue
            }
        }

        It 'CONSTRUCTED: opposing doc_position with non-overlapping temporal bounds is held, not confirmed as a rebut' {
            $script:TDir = Join-Path ([System.IO.Path]::GetTempPath()) "qbaf-temporal-$(Get-Random)"
            $summaries = Join-Path $script:TDir 'summaries'
            $null = New-Item -ItemType Directory -Path $summaries -Force
            @{ factual_claims = @(@{ claim='Compute governance treaties will be adopted by 2027.'
                claim_label='E1'; linked_taxonomy_nodes=@('saf-intentions-201'); doc_position='supports'
                temporal_bound = 'by 2027' }) } |
                ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $summaries 'docE.json') -Encoding utf8NoBOM
            @{ factual_claims = @(@{ claim='Compute governance treaties will not be adopted, 2040-2045.'
                claim_label='F1'; linked_taxonomy_nodes=@('saf-intentions-201'); doc_position='disputes'
                temporal_bound = '2040-2045' }) } |
                ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $summaries 'docF.json') -Encoding utf8NoBOM

            InModuleScope AITriad -Parameters @{ SD = $summaries; FD = $script:TDir } {
                param($SD, $FD)
                Mock Get-SummariesDir -MockWith ({ $SD }.GetNewClosure())
                Mock Get-DataRoot     -MockWith ({ $FD }.GetNewClosure())
                Mock Get-TextEmbedding -MockWith { $null }
                $r = Invoke-QbafConflictAnalysis -DryRun -PassThru -SkipDirectionalGate 6>$null
                $r.AttackCount      | Should -Be 0 -Because 'disjoint temporal windows -- not confirmed as a rebut'
                $r.EdgeCount        | Should -Be 0
                $r.TemporalGateHeld | Should -Be 1
            }
        }
    }
}
