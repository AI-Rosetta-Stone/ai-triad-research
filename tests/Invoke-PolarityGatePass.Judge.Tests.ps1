# Tag: summary (t/2900)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Two-stage LLM-judge disposition for the polarity gate (t/2900) — deterministic
    unit tests with BOTH stages mocked (Test-DirectionalAgreement = deberta stage 1,
    Invoke-DirectionalJudge = the LLM judge stage 2). No live AI.
.DESCRIPTION
    Contract (TL design approval t/2900#7):
    - A kp flips to strongly_opposed ONLY if deberta AND the judge both 'opposes'.
    - Judge non-'opposes' (agrees/unrelated/unresolved) → KEEP the LLM mapping.
    - stance_pre_gate persisted write-once on flip (never clobbered on a repeat pass).
    - Judge KEEP over a row that already carries stance_pre_gate → SELF-HEAL: restore
      stance, clear the flip fields + the pre-gate marker.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-PolarityGatePass two-stage judge (t/2900)' -Tag 'summary' {

    BeforeEach {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                accelerationist = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-intentions-047'; label = 'Argue AI Requires Entirely New Laws'; description = 'An Intention that new legal frameworks are required.' }
                ) }
            }
            # Stage 1 (deberta) always proposes 'opposes' so stage 2 is exercised.
            Mock Test-DirectionalAgreement -MockWith {
                $r = [System.Collections.Generic.List[PSObject]]::new()
                foreach ($p in @($Pair)) { $r.Add([PSCustomObject]@{ Id = $p.Id; Direction = 'opposes'; Confidence = 1.61; Method = 'nli' }) }
                $r
            }
            # t/4572 write-freeze: this suite exercises the two-stage judge logic against
            # a mocked engine, independent of calibration -- bypass the freeze here.
            Mock Test-NliDirectionalGateFrozen { $false }
        }
    }

    It 'judge OPPOSES → flip to strongly_opposed + stance_pre_gate written once + judge_flipped=1' {
        InModuleScope AITriad {
            Mock Invoke-DirectionalJudge -MockWith { 'opposes' }
            $kp = [PSCustomObject]@{ canonical_proposition = 'AI needs new laws.'; taxonomy_node_id = 'acc-intentions-047'; stance = 'aligned'; retrieval_low_confidence = $false }
            $counts = Invoke-PolarityGatePass -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.stance | Should -Be 'strongly_opposed'
            $kp.stance_pre_gate | Should -Be 'aligned'
            $kp.stance_polarity_flag | Should -BeTrue
            $counts.judge_flipped | Should -Be 1
            $counts.judge_kept | Should -Be 0
        }
    }

    It 'judge AGREES → KEEP (false-positive caught): no flip, no stance_pre_gate, judge_kept=1' {
        InModuleScope AITriad {
            Mock Invoke-DirectionalJudge -MockWith { 'agrees' }
            $kp = [PSCustomObject]@{ canonical_proposition = 'Existing laws already govern AI.'; taxonomy_node_id = 'acc-intentions-047'; stance = 'aligned'; retrieval_low_confidence = $false }
            $counts = Invoke-PolarityGatePass -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.stance | Should -Be 'aligned'
            $kp.PSObject.Properties['stance_pre_gate'] | Should -BeNullOrEmpty
            $kp.PSObject.Properties['stance_polarity_flag'] | Should -BeNullOrEmpty
            $counts.judge_kept | Should -Be 1
            $counts.judge_flipped | Should -Be 0
        }
    }

    It 'judge fail-safe (unresolved) → KEEP: no flip' {
        InModuleScope AITriad {
            Mock Invoke-DirectionalJudge -MockWith { 'unresolved' }
            $kp = [PSCustomObject]@{ canonical_proposition = 'Some claim.'; taxonomy_node_id = 'acc-intentions-047'; stance = 'aligned'; retrieval_low_confidence = $false }
            $counts = Invoke-PolarityGatePass -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.stance | Should -Be 'aligned'
            $counts.judge_kept | Should -Be 1
        }
    }

    It 'judge KEEP over a PRIOR flip → SELF-HEAL: restore stance, clear flip fields + marker, self_healed=1' {
        InModuleScope AITriad {
            Mock Invoke-DirectionalJudge -MockWith { 'agrees' }
            # A stale false-flip from a prior pass.
            $kp = [PSCustomObject]@{
                canonical_proposition        = 'Existing laws already govern AI.'
                taxonomy_node_id             = 'acc-intentions-047'
                stance                       = 'strongly_opposed'
                stance_pre_gate              = 'aligned'
                stance_polarity_flag         = $true
                stance_polarity_confidence   = 1.61
                stance_polarity_source       = 'canonical_proposition'
                retrieval_low_confidence     = $false
            }
            $counts = Invoke-PolarityGatePass -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.stance | Should -Be 'aligned'                                           # restored
            $kp.PSObject.Properties['stance_pre_gate'] | Should -BeNullOrEmpty           # marker cleared
            $kp.PSObject.Properties['stance_polarity_flag'] | Should -BeNullOrEmpty      # flip fields cleared
            $kp.PSObject.Properties['stance_polarity_source'] | Should -BeNullOrEmpty
            $counts.self_healed | Should -Be 1
        }
    }

    It 'write-once: a re-flip does NOT clobber the pristine stance_pre_gate' {
        InModuleScope AITriad {
            Mock Invoke-DirectionalJudge -MockWith { 'opposes' }
            # Prior flip: pristine original was 'aligned'; a repeat confirmed-opposes pass
            # must keep that original, not overwrite it with the current 'strongly_opposed'.
            $kp = [PSCustomObject]@{
                canonical_proposition      = 'AI needs new laws.'
                taxonomy_node_id           = 'acc-intentions-047'
                stance                     = 'strongly_opposed'
                stance_pre_gate            = 'aligned'
                stance_polarity_flag       = $true
                stance_polarity_confidence = 1.61
                stance_polarity_source     = 'canonical_proposition'
                retrieval_low_confidence   = $false
            }
            $null = Invoke-PolarityGatePass -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.stance_pre_gate | Should -Be 'aligned'          # NOT clobbered to 'strongly_opposed'
            $kp.stance | Should -Be 'strongly_opposed'
        }
    }
}
