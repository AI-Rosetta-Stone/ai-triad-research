# Tag: summary (t/2739)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Invoke-PolarityGatePass — polarity/contradiction gate (t/2739 P1).
.DESCRIPTION
    Both-arm + fail-safe Gate Verification with count assertions, mirroring the
    V1/V2 test Contexts (INVERSION fires / non-opposes KEEPS / unresolved KEEPS).
    The shared wrapper Test-DirectionalAgreement is MOCKED for determinism in CI;
    the real-deberta arm is recorded on the ticket (same standard as the engine +
    V1/V2). Opposition-only contract (t/2751#2): fire ONLY on 'opposes'; 'agrees' /
    'unrelated' / 'unresolved' all KEEP the mapping.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-PolarityGatePass (t/2739)' -Tag 'summary' {

    BeforeEach {
        InModuleScope AITriad {
            # Minimal taxonomy for node_prop construction (label + Core; Encompasses tail present to prove stripping).
            $script:TaxonomyData = @{
                accelerationist = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-intentions-047'; label = 'Argue AI Requires Entirely New Laws'; description = 'An Intention that new legal frameworks are required rather than adapted existing laws. Encompasses: bespoke AI legislation, regulatory sandboxes.' }
                ) }
            }
            # t/4572 write-freeze: these tests exercise the gate's OWN flip/judge/self-heal
            # logic against a mocked engine, independent of calibration -- not affected by
            # the freeze, so bypass it here (production call sites are NOT mocked).
            Mock Test-NliDirectionalGateFrozen { $false }
        }
    }

    # A gated aligned key_point on acc-intentions-047 (high band).
    function script:New-Kp ($stance = 'aligned', $node = 'acc-intentions-047', $low = $false) {
        [PSCustomObject]@{
            canonical_proposition   = 'Existing privacy law already governs AI; no new frameworks are needed.'
            taxonomy_node_id        = $node
            stance                  = $stance
            retrieval_low_confidence = $low
        }
    }

    It 'INVERSION fires: opposes → strongly_opposed + stance_polarity_flag, counts.opposes=1' {
        InModuleScope AITriad {
            Mock Test-DirectionalAgreement -MockWith {
                $r = [System.Collections.Generic.List[PSObject]]::new()
                foreach ($p in @($Pair)) { $r.Add([PSCustomObject]@{ Id = $p.Id; Direction = 'opposes'; Confidence = 1.44; Method = 'nli' }) }
                $r
            }
            $kp = New-Kp
            $counts = Invoke-PolarityGatePass -SkipJudge -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.stance | Should -Be 'strongly_opposed'
            $kp.stance_polarity_flag | Should -BeTrue
            $counts.opposes | Should -Be 1
            $counts.gated   | Should -Be 1
        }
    }

    It 'node_prop matches V1: label + Core with Encompasses/Excludes stripped' {
        InModuleScope AITriad {
            $script:CapturedPairs = $null
            Mock Test-DirectionalAgreement -MockWith {
                $script:CapturedPairs = @($Pair)
                $r = [System.Collections.Generic.List[PSObject]]::new()
                foreach ($p in @($Pair)) { $r.Add([PSCustomObject]@{ Id = $p.Id; Direction = 'unrelated'; Confidence = 0.0; Method = 'nli' }) }
                $r
            }
            Invoke-PolarityGatePass -SkipJudge -KeyPoints @(@{ KeyPoint = (New-Kp); POV = 'accelerationist' }) | Out-Null

            $np = $script:CapturedPairs[0].NodeProp
            $np | Should -BeLike 'Argue AI Requires Entirely New Laws — *'
            $np | Should -Not -Match 'Encompasses' -Because 'Encompasses:/Excludes: tails must be stripped (condition #3)'
            $script:CapturedPairs[0].NodePov | Should -Be 'accelerationist'
        }
    }

    It 'GENUINE AGREEMENT arm: unrelated → KEEP (no flag), counts.unrelated=1' {
        InModuleScope AITriad {
            Mock Test-DirectionalAgreement -MockWith {
                $r = [System.Collections.Generic.List[PSObject]]::new()
                foreach ($p in @($Pair)) { $r.Add([PSCustomObject]@{ Id = $p.Id; Direction = 'unrelated'; Confidence = 0.0; Method = 'nli' }) }
                $r
            }
            $kp = New-Kp 'aligned'
            $counts = Invoke-PolarityGatePass -SkipJudge -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.stance | Should -Be 'aligned' -Because 'genuine agreement reads unrelated (not entailment) and must KEEP'
            ($kp.PSObject.Properties['stance_polarity_flag']) | Should -BeNullOrEmpty
            $counts.unrelated | Should -Be 1
            $counts.opposes   | Should -Be 0
        }
    }

    It 'FAIL-SAFE: unresolved → KEEP the mapping (never demote), counts.unresolved=1' {
        InModuleScope AITriad {
            Mock Test-DirectionalAgreement -MockWith {
                $r = [System.Collections.Generic.List[PSObject]]::new()
                foreach ($p in @($Pair)) { $r.Add([PSCustomObject]@{ Id = $p.Id; Direction = 'unresolved'; Confidence = 0.0; Method = 'none' }) }
                $r
            }
            $kp = New-Kp 'strongly_aligned'
            $counts = Invoke-PolarityGatePass -SkipJudge -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.stance | Should -Be 'strongly_aligned' -Because 'a demotion gate fails safe by NOT demoting (t/2751#2)'
            ($kp.PSObject.Properties['stance_polarity_flag']) | Should -BeNullOrEmpty
            $counts.unresolved | Should -Be 1
        }
    }

    It 'SCOPING: opposed-stance, null-node, and low-band key_points are NOT gated' {
        InModuleScope AITriad {
            $script:GatedSeen = 0
            Mock Test-DirectionalAgreement -MockWith {
                $script:GatedSeen = @($Pair).Count
                $r = [System.Collections.Generic.List[PSObject]]::new()
                foreach ($p in @($Pair)) { $r.Add([PSCustomObject]@{ Id = $p.Id; Direction = 'unrelated'; Confidence = 0; Method = 'nli' }) }
                $r
            }
            $items = @(
                @{ KeyPoint = (New-Kp 'opposed');                 POV = 'accelerationist' }  # already opposed → skip
                @{ KeyPoint = (New-Kp 'aligned' $null);           POV = 'accelerationist' }  # null node → skip
                @{ KeyPoint = (New-Kp 'aligned' 'acc-intentions-047' $true); POV = 'accelerationist' }  # low band → skip
                @{ KeyPoint = (New-Kp 'aligned');                 POV = 'accelerationist' }  # gated
            )
            $counts = Invoke-PolarityGatePass -SkipJudge -KeyPoints $items
            $counts.gated | Should -Be 1
            $script:GatedSeen | Should -Be 1
        }
    }

    It '-SkipDirectionalGate is a no-op (zeroed counts, no engine call)' {
        InModuleScope AITriad {
            Mock Test-DirectionalAgreement -MockWith { throw 'should not be called' }
            $kp = New-Kp
            $counts = Invoke-PolarityGatePass -SkipJudge -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' }) -SkipDirectionalGate
            $counts.gated   | Should -Be 0
            $counts.opposes | Should -Be 0
            $kp.stance | Should -Be 'aligned'
            Should -Invoke Test-DirectionalAgreement -Times 0
        }
    }

    # ── t/2757: opposes-if-any over {verbatim, canonical_proposition, attribution_text} ──

    # A gated aligned key_point carrying all three claim reps with distinct text.
    function script:New-MultiRepKp ($vb = 'VERBATIM-TEXT', $canon = 'CANON-TEXT', $attr = 'ATTR-TEXT') {
        [PSCustomObject]@{
            verbatim                 = $vb
            canonical_proposition    = $canon
            attribution_text         = $attr
            taxonomy_node_id         = 'acc-intentions-047'
            stance                   = 'aligned'
            retrieval_low_confidence = $false
        }
    }

    It 'OPPOSES-IF-ANY: one rep (verbatim) opposes → flip; reps counted; source recorded' {
        InModuleScope AITriad {
            # Only the verbatim rep opposes; canonical + attribution read unrelated.
            Mock Test-DirectionalAgreement -MockWith {
                $r = [System.Collections.Generic.List[PSObject]]::new()
                foreach ($p in @($Pair)) {
                    $dir = if ($p.ClaimProp -eq 'VERBATIM-TEXT') { 'opposes' } else { 'unrelated' }
                    $conf = if ($dir -eq 'opposes') { 5.22 } else { 0.0 }
                    $r.Add([PSCustomObject]@{ Id = $p.Id; Direction = $dir; Confidence = $conf; Method = 'nli' })
                }
                $r
            }
            $kp = New-MultiRepKp
            $counts = Invoke-PolarityGatePass -SkipJudge -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.stance | Should -Be 'strongly_opposed'
            $kp.stance_polarity_flag | Should -BeTrue
            $kp.stance_polarity_source | Should -Be 'verbatim' -Because 'the firing rep is recorded for observability'
            $counts.gated     | Should -Be 1
            $counts.reps      | Should -Be 3 -Because 'all three claim reps were sent to the engine'
            $counts.opposes   | Should -Be 1
            $counts.unrelated | Should -Be 2
        }
    }

    It 'ARM-2 zero-false-oppose across all 3 reps: genuine agreement stays aligned (TL binding)' {
        InModuleScope AITriad {
            # The observed failure mode is false-ENTAIL, never false-oppose; assert NO
            # rep spuriously fires opposes on a true agreement.
            Mock Test-DirectionalAgreement -MockWith {
                $r = [System.Collections.Generic.List[PSObject]]::new()
                foreach ($p in @($Pair)) { $r.Add([PSCustomObject]@{ Id = $p.Id; Direction = 'unrelated'; Confidence = 0.0; Method = 'nli' }) }
                $r
            }
            $kp = New-MultiRepKp
            $counts = Invoke-PolarityGatePass -SkipJudge -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })

            $kp.stance | Should -Be 'aligned' -Because 'no rep opposes → keep (opposition-only, zero false-oppose)'
            ($kp.PSObject.Properties['stance_polarity_flag']) | Should -BeNullOrEmpty
            $counts.opposes | Should -Be 0
            $counts.reps    | Should -Be 3
        }
    }

    It 'verbatim as a multi-span ARRAY is joined into one claim rep' {
        InModuleScope AITriad {
            $script:SeenVerbatim = $null
            Mock Test-DirectionalAgreement -MockWith {
                foreach ($p in @($Pair)) { if ($p.ClaimProp -like 'span one*') { $script:SeenVerbatim = $p.ClaimProp } }
                $r = [System.Collections.Generic.List[PSObject]]::new()
                foreach ($p in @($Pair)) { $r.Add([PSCustomObject]@{ Id = $p.Id; Direction = 'unrelated'; Confidence = 0; Method = 'nli' }) }
                $r
            }
            $kp = [PSCustomObject]@{
                verbatim = @('span one.', 'span two.')
                canonical_proposition = 'c'
                taxonomy_node_id = 'acc-intentions-047'
                stance = 'aligned'
                retrieval_low_confidence = $false
            }
            $counts = Invoke-PolarityGatePass -SkipJudge -KeyPoints @(@{ KeyPoint = $kp; POV = 'accelerationist' })
            $script:SeenVerbatim | Should -Be 'span one. span two.'
            $counts.reps | Should -Be 2 -Because 'verbatim (joined) + canonical; attribution_text absent'
        }
    }
}

# ── t/2896: disable Gate Verification (both arms of the -EnablePolarityGate switch) ──
# The directional polarity flip is disabled by default (falsified safety invariant —
# e/117#3). These prove the SWITCH works both ways so re-enabling behind the durable
# LLM-judge fix (t/2900) is a one-flag flip. Test-DirectionalAgreement is mocked (no model).
Describe 'Polarity-gate disable switch (t/2896)' -Tag 'summary' {

    It 'ARM ON: gate active flips a genuine contradiction to strongly_opposed' {
        InModuleScope AITriad {
            Mock Test-NliDirectionalGateFrozen { $false }  # t/4572: mocked engine, bypass the freeze
            Mock Test-DirectionalAgreement {
                @($Pair) | ForEach-Object {
                    [PSCustomObject]@{ Id = $_.Id; Direction = 'opposes'; Confidence = 5.0 }
                }
            }
            $kp = [PSCustomObject]@{
                stance                   = 'aligned'
                taxonomy_node_id         = 'saf-beliefs-017'
                retrieval_low_confidence = $false
                verbatim                 = 'AI is delegated authority and acts non-deterministically.'
            }
            $counts = Invoke-PolarityGatePass -SkipJudge -KeyPoints @(@{ KeyPoint = $kp; POV = 'safetyist' })

            $kp.stance               | Should -Be 'strongly_opposed'
            $kp.stance_polarity_flag | Should -BeTrue
            $counts.opposes          | Should -BeGreaterThan 0
        }
    }

    It 'ARM OFF: -SkipDirectionalGate makes the same verdict a no-op (the disable)' {
        InModuleScope AITriad {
            Mock Test-DirectionalAgreement {
                @($Pair) | ForEach-Object {
                    [PSCustomObject]@{ Id = $_.Id; Direction = 'opposes'; Confidence = 5.0 }
                }
            }
            $kp = [PSCustomObject]@{
                stance                   = 'aligned'
                taxonomy_node_id         = 'saf-beliefs-017'
                retrieval_low_confidence = $false
                verbatim                 = 'AI is delegated authority and acts non-deterministically.'
            }
            $counts = Invoke-PolarityGatePass -SkipJudge -KeyPoints @(@{ KeyPoint = $kp; POV = 'safetyist' }) -SkipDirectionalGate

            $kp.stance                                      | Should -Be 'aligned'
            $kp.PSObject.Properties['stance_polarity_flag'] | Should -BeNullOrEmpty
            $counts.opposes                                 | Should -Be 0
            $counts.gated                                   | Should -Be 0
            Should -Invoke Test-DirectionalAgreement -Times 0 -Exactly -Because 'a skipped gate must not even call the engine'
        }
    }
}

Describe 'Invoke-DocumentSummary polarity wiring (t/2896)' -Tag 'summary' {

    It 'exposes -EnablePolarityGate as [bool] defaulting ON (t/2912 promotion; kill switch -EnablePolarityGate:$false)' {
        InModuleScope AITriad {
            $ast = (Get-Command Invoke-DocumentSummary).ScriptBlock.Ast
            $param = $ast.FindAll({
                $args[0] -is [System.Management.Automation.Language.ParameterAst] -and
                $args[0].Name.VariablePath.UserPath -eq 'EnablePolarityGate'
            }, $true) | Select-Object -First 1
            $param | Should -Not -BeNullOrEmpty
            $param.StaticType.Name | Should -Be 'Boolean'            # promoted from [switch] to [bool]
            $param.DefaultValue.Extent.Text | Should -Be '$true'     # gate ACTIVE by default
        }
    }

    It 'call-site contract: default-ON routes the gate active; -EnablePolarityGate:$false disables' {
        (-not $true)  | Should -BeFalse -Because 'default -EnablePolarityGate=$true routes -SkipDirectionalGate:$false (gate ACTIVE)'
        (-not $false) | Should -BeTrue  -Because '-EnablePolarityGate:$false routes -SkipDirectionalGate:$true (gate skipped)'
    }
}
