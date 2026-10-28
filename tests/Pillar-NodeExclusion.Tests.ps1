# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for thematic-pillar node exclusion (t/2369).
.DESCRIPTION
    Covers: pillar-set construction (prefix-regex detection, not a hardcoded list),
    fixture regression guard (the 10 known IDs), control-node over-exclusion guard,
    and scoring-loop exclusion in Invoke-RetrievalConfidencePass and
    Invoke-Mechanism5RetrievalPass.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    InModuleScope AITriad {
        # Unit vector along a given axis (3-dim)
        function script:PX-Vec { param([int]$Axis) $v = [double[]]@(0.0, 0.0, 0.0); $v[$Axis] = 1.0; $v }

        # Build a fake taxonomy node
        function script:PX-Node {
            param([string]$Id, [string]$Desc = "A Belief within safetyist discourse that asserts $Id")
            [PSCustomObject]@{ id = $Id; label = $Id; description = $Desc }
        }

        # Build a HashSet of pillar IDs (for directly pre-loading $script:PillarNodeIds)
        function script:PX-PillarSet {
            param([string[]]$Ids)
            $s = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            foreach ($Id in $Ids) { [void]$s.Add($Id) }
            $s
        }

        # Directly run the pillar-set build logic (mirrors the block in Get-RelevantTaxonomyNodes)
        function script:PX-BuildPillarSet {
            $PillarIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            foreach ($PovVal in $script:TaxonomyData.Values) {
                if (-not $PovVal.PSObject.Properties['nodes']) { continue }
                foreach ($N in @($PovVal.nodes)) {
                    if ($N.PSObject.Properties['description'] -and
                        $N.description -match '(?i)^\s*a thematic pillar\b') {
                        [void]$PillarIds.Add([string]$N.id)
                    }
                }
            }
            $script:PillarNodeIds = $PillarIds
        }
    }
}

Describe 'Pillar-node exclusion (t/2369)' -Tag 'pillar','retrieval' {

    # ── Pillar set construction ──────────────────────────────────────────────

    Context 'Pillar set construction — prefix-regex detection' {

        It 'Includes a node whose description starts with "A thematic pillar"' {
            InModuleScope AITriad {
                $script:TaxonomyData = @{
                    safetyist = [PSCustomObject]@{
                        nodes = @(PX-Node 'saf-beliefs-210' 'A thematic pillar within safetyist discourse grouping beliefs about accountability')
                    }
                }
                PX-BuildPillarSet
                $script:PillarNodeIds.Contains('saf-beliefs-210') | Should -BeTrue `
                    -Because 'nodes with "A thematic pillar" prefix must be in the exclusion set'
            }
        }

        It 'Does NOT include a node whose description starts with "A Belief within"' {
            InModuleScope AITriad {
                $script:TaxonomyData = @{
                    safetyist = [PSCustomObject]@{
                        nodes = @(PX-Node 'saf-beliefs-001' 'A Belief within safetyist discourse that asserts something specific')
                    }
                }
                PX-BuildPillarSet
                $script:PillarNodeIds.Contains('saf-beliefs-001') | Should -BeFalse `
                    -Because 'genuine claim nodes must never be excluded'
            }
        }

        It 'Match is case-insensitive ("a THEMATIC PILLAR" also qualifies)' {
            InModuleScope AITriad {
                $script:TaxonomyData = @{
                    safetyist = [PSCustomObject]@{
                        nodes = @(PX-Node 'saf-beliefs-211' 'a THEMATIC PILLAR within safetyist discourse grouping beliefs')
                    }
                }
                PX-BuildPillarSet
                $script:PillarNodeIds.Contains('saf-beliefs-211') | Should -BeTrue `
                    -Because 'the regex is case-insensitive'
            }
        }

        It 'Match allows leading whitespace ("  A thematic pillar" also qualifies)' {
            InModuleScope AITriad {
                $script:TaxonomyData = @{
                    safetyist = [PSCustomObject]@{
                        nodes = @(PX-Node 'saf-beliefs-210' '  A thematic pillar within safetyist discourse')
                    }
                }
                PX-BuildPillarSet
                $script:PillarNodeIds.Contains('saf-beliefs-210') | Should -BeTrue `
                    -Because 'the regex uses ^\s* to allow leading whitespace'
            }
        }

        It 'A node with children but a "A Belief" description is NOT excluded (over-exclusion guard)' {
            InModuleScope AITriad {
                # saf-beliefs-097 pattern: root node with many children, but a genuine claim
                $ControlNode = [PSCustomObject]@{
                    id          = 'saf-beliefs-097'
                    label       = 'AI Architectural Complexity'
                    description = "A Belief within safetyist discourse that asserts AI's architectural complexity generates new security risks"
                    children    = @('saf-beliefs-097a', 'saf-beliefs-097b')
                }
                $script:TaxonomyData = @{
                    safetyist = [PSCustomObject]@{ nodes = @($ControlNode) }
                }
                PX-BuildPillarSet
                $script:PillarNodeIds.Contains('saf-beliefs-097') | Should -BeFalse `
                    -Because 'a root node with children is not automatically a pillar — description must match'
            }
        }

        It 'Fixture: all 10 known pillar IDs are in the set when descriptions match (regression guard)' {
            InModuleScope AITriad {
                $PillarDesc = 'A thematic pillar within discourse grouping beliefs'
                $KnownPillars = @(
                    @{ id = 'saf-beliefs-210';  desc = $PillarDesc }
                    @{ id = 'saf-beliefs-211';  desc = $PillarDesc }
                    @{ id = 'saf-intentions-210'; desc = $PillarDesc }
                    @{ id = 'saf-intentions-211'; desc = $PillarDesc }
                    @{ id = 'skp-beliefs-210';  desc = $PillarDesc }
                    @{ id = 'skp-beliefs-211';  desc = $PillarDesc }
                    @{ id = 'skp-beliefs-212';  desc = $PillarDesc }
                    @{ id = 'skp-beliefs-213';  desc = $PillarDesc }
                    @{ id = 'skp-beliefs-214';  desc = $PillarDesc }
                    @{ id = 'skp-beliefs-215';  desc = $PillarDesc }
                )
                $AllNodes = @($KnownPillars | ForEach-Object { PX-Node $_.id $_.desc })
                $script:TaxonomyData = @{
                    safetyist = [PSCustomObject]@{ nodes = @($AllNodes | Where-Object { $_.id -like 'saf-*' }) }
                    skeptic   = [PSCustomObject]@{ nodes = @($AllNodes | Where-Object { $_.id -like 'skp-*' }) }
                }
                PX-BuildPillarSet
                $Missing = $KnownPillars | Where-Object { -not $script:PillarNodeIds.Contains($_.id) }
                @($Missing).Count | Should -Be 0 -Because "all 10 adjudication-identified pillar IDs must be excluded"
            }
        }
    }

    # ── Scoring loop — Invoke-RetrievalConfidencePass ────────────────────────

    Context 'Invoke-RetrievalConfidencePass — pillar excluded from candidates' {

        It 'Pillar node does NOT appear in taxonomy_node_candidates' {
            InModuleScope AITriad {
                $script:CachedEmbeddings = @{
                    'saf-beliefs-001' = PX-Vec 0   # normal node — assigned and first candidate
                    'saf-beliefs-210' = PX-Vec 0   # pillar node — same direction, would rank #1 without exclusion
                    'saf-beliefs-002' = PX-Vec 1   # normal node — second candidate
                }
                $script:TaxonomyData = @{}
                $script:PillarNodeIds = PX-PillarSet @('saf-beliefs-210')

                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = PX-Vec 0 } } -ModuleName AITriad

                $kp = [PSCustomObject]@{
                    taxonomy_node_id = 'saf-beliefs-001'
                    attribution_text = 'some attribution text'
                }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'safetyist' }) -Threshold 0.45

                $Candidates = @($kp.taxonomy_node_candidates)
                $HasPillar = @($Candidates | Where-Object { $_.id -eq 'saf-beliefs-210' }).Count -gt 0
                $HasPillar | Should -BeFalse -Because 'pillar nodes must not appear in taxonomy_node_candidates'
            }
        }

        It 'Normal nodes ARE present in taxonomy_node_candidates after pillar exclusion' {
            InModuleScope AITriad {
                $script:CachedEmbeddings = @{
                    'saf-beliefs-001' = PX-Vec 0
                    'saf-beliefs-210' = PX-Vec 0
                    'saf-beliefs-002' = PX-Vec 1
                }
                $script:TaxonomyData = @{}
                $script:PillarNodeIds = PX-PillarSet @('saf-beliefs-210')

                Mock Invoke-BatchEmbedAttribution { @{ 'kp_0' = PX-Vec 0 } } -ModuleName AITriad

                $kp = [PSCustomObject]@{
                    taxonomy_node_id = 'saf-beliefs-001'
                    attribution_text = 'some attribution text'
                }
                Invoke-RetrievalConfidencePass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'safetyist' }) -Threshold 0.45

                $Candidates = @($kp.taxonomy_node_candidates)
                $HasNormal = @($Candidates | Where-Object { $_.id -eq 'saf-beliefs-001' }).Count -gt 0
                $HasNormal | Should -BeTrue -Because 'non-pillar nodes must still appear in candidates'
            }
        }
    }

    # ── Scoring loop — Invoke-Mechanism5RetrievalPass ────────────────────────

    Context 'Invoke-Mechanism5RetrievalPass — pillar excluded from mechanism5_candidates' {

        BeforeEach {
            InModuleScope AITriad {
                $script:TaxonomyData = @{
                    safetyist = [PSCustomObject]@{
                        nodes = @(
                            PX-Node 'saf-beliefs-001'
                            PX-Node 'saf-beliefs-002'
                        )
                    }
                }
            }
        }

        It 'Pillar node does NOT appear in mechanism5_candidates' {
            InModuleScope AITriad {
                $script:CachedEmbeddings = @{
                    'saf-beliefs-001' = PX-Vec 0   # assigned node
                    'saf-beliefs-002' = PX-Vec 0   # normal alternative
                    'saf-beliefs-210' = PX-Vec 0   # pillar — excluded
                }
                $script:PillarNodeIds = PX-PillarSet @('saf-beliefs-210')

                Mock Invoke-BatchEmbedAttribution { @{ 'm5_0' = PX-Vec 0 } } -ModuleName AITriad

                $kp = [PSCustomObject]@{
                    taxonomy_node_id         = 'saf-beliefs-001'
                    retrieval_confidence     = 0.2
                    attribution_text         = 'some attribution text'
                    taxonomy_node_candidates = @([PSCustomObject]@{ id = 'saf-beliefs-002'; score = 0.9 })
                }
                Invoke-Mechanism5RetrievalPass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'safetyist' })

                $Cands = @($kp.PSObject.Properties['mechanism5_candidates'] | ForEach-Object { $_.Value })
                $HasPillar = @($Cands | Where-Object { $_.id -eq 'saf-beliefs-210' }).Count -gt 0
                $HasPillar | Should -BeFalse -Because 'pillar nodes must not appear in mechanism5_candidates'
            }
        }

        It 'Non-pillar nodes ARE present in mechanism5_candidates' {
            InModuleScope AITriad {
                $script:CachedEmbeddings = @{
                    'saf-beliefs-001' = PX-Vec 0
                    'saf-beliefs-002' = PX-Vec 0
                    'saf-beliefs-210' = PX-Vec 0
                }
                $script:PillarNodeIds = PX-PillarSet @('saf-beliefs-210')

                Mock Invoke-BatchEmbedAttribution { @{ 'm5_0' = PX-Vec 0 } } -ModuleName AITriad

                $kp = [PSCustomObject]@{
                    taxonomy_node_id         = 'saf-beliefs-001'
                    retrieval_confidence     = 0.2
                    attribution_text         = 'some attribution text'
                    taxonomy_node_candidates = @([PSCustomObject]@{ id = 'saf-beliefs-002'; score = 0.9 })
                }
                Invoke-Mechanism5RetrievalPass -KeyPointItems @(@{ KeyPoint = $kp; POV = 'safetyist' })

                $kp.PSObject.Properties['mechanism5_candidates'] | Should -Not -BeNullOrEmpty
                $Cands = @($kp.mechanism5_candidates)
                $HasNormal = @($Cands | Where-Object { $_.id -ne 'saf-beliefs-210' }).Count -gt 0
                $HasNormal | Should -BeTrue -Because 'non-pillar candidates must still be surfaced'
            }
        }
    }
}
