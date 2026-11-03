# Tag: unit (t/4742)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4742 (CL spec t/4600#6): the mechanical camp-bridge post-check. Fixtures C03/C07 (bad, must be
    caught) and C02/C04 (genuine, must not be caught) are drawn verbatim from CL's 90-item blind-
    labelled corpus (analyses/t4603-camp-bridge/label_sheet.json + labels.json) so the shipped regex
    matches the calibration it was validated against, not a re-derivation of it.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Test-CampBridgeConstruction (t/4600#6 regex family)' -Tag 'unit' {

    It 'catches a "From a <camp> perspective" bridge (corpus C07, labelled unsupported)' {
        InModuleScope AITriad {
            $Text = "The document disputes that frontier AI risks are inherently irreversible in ways that render post-hoc governance insufficient. From a safetyist perspective, this understates catastrophic tail risk."
            Test-CampBridgeConstruction -Text $Text | Should -Not -BeNullOrEmpty
        }
    }

    It 'catches an "aligns with the <camp>" bridge (corpus C03, labelled stretched)' {
        InModuleScope AITriad {
            $Text = "The document highlights how corporate apology rhetoric functions as a form of coercive communication that stifles deliberation and protects power. This aligns with the safetyist concern that powerful actors evade accountability."
            Test-CampBridgeConstruction -Text $Text | Should -Not -BeNullOrEmpty
        }
    }

    It 'catches a "<camp> would support" bridge' {
        InModuleScope AITriad {
            Test-CampBridgeConstruction -Text 'Accelerationists would support this finding because it reduces compliance overhead.' | Should -Not -BeNullOrEmpty
        }
    }

    It 'catches the degenerate "does not engage with <camp>" non-point' {
        InModuleScope AITriad {
            Test-CampBridgeConstruction -Text 'The document does not engage with skeptic concerns about deployment speed.' | Should -Not -BeNullOrEmpty
        }
    }

    It 'does not catch a genuine on-topic point with no camp name at all (corpus C04)' {
        InModuleScope AITriad {
            $Text = "The document argues against weakening Section 230 protections, suggesting that such efforts create perverse incentives and harmful unintended consequences. It maintains that Section 230 enables platform moderation at scale."
            Test-CampBridgeConstruction -Text $Text | Should -BeNullOrEmpty
        }
    }

    It 'does not catch a genuine point naming a camp as plain subject matter, not as the bridge (corpus C02 baseline + an added camp mention)' {
        InModuleScope AITriad {
            # A camp name appearing as ordinary subject matter -- not as the camp-naming-as-subject
            # construction the regex family targets -- must not false-positive.
            $Text = "The document acknowledges that certain code structures possess inherent complexity. Both accelerationists and safetyists have cited similar maintainability concerns in public comment letters."
            Test-CampBridgeConstruction -Text $Text | Should -BeNullOrEmpty
        }
    }

    It 'returns null for empty or whitespace text' {
        InModuleScope AITriad {
            Test-CampBridgeConstruction -Text '' | Should -BeNullOrEmpty
            Test-CampBridgeConstruction -Text '   ' | Should -BeNullOrEmpty
            Test-CampBridgeConstruction -Text $null | Should -BeNullOrEmpty
        }
    }
}

Describe 'Invoke-SummaryCampBridgeFilter (t/4742)' -Tag 'unit' {

    It 'drops a bridging key_point from an untagged camp and reports the count' {
        InModuleScope AITriad {
            $SummaryObject = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'From a safetyist perspective, this understates catastrophic tail risk.'; category = 'Beliefs' }
                        [PSCustomObject]@{ point = 'The document states regulatory compliance costs delayed deployment by 14 months.'; category = 'Beliefs' }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
            }
            # Document is tagged safetyist/skeptic only -- accelerationist is untagged.
            $Dropped = Invoke-SummaryCampBridgeFilter -SummaryObject $SummaryObject -ThisDocId 'test-doc' -PovTags @('safetyist', 'skeptic')
            $Dropped | Should -Be 1
            @($SummaryObject.pov_summaries.accelerationist.key_points).Count | Should -Be 1
            $SummaryObject.pov_summaries.accelerationist.key_points[0].point | Should -Match 'regulatory compliance'
        }
    }

    It 'never filters a tagged camp, even with bridging text' {
        InModuleScope AITriad {
            $SummaryObject = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'From a safetyist perspective, this understates catastrophic tail risk.'; category = 'Beliefs' }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
            }
            # accelerationist IS tagged here -- the bridging text must survive untouched.
            $Dropped = Invoke-SummaryCampBridgeFilter -SummaryObject $SummaryObject -ThisDocId 'test-doc' -PovTags @('accelerationist')
            $Dropped | Should -Be 0
            @($SummaryObject.pov_summaries.accelerationist.key_points).Count | Should -Be 1
        }
    }

    It 'filters nothing when PovTags is empty (every camp counts as tagged, same convention as Test-SummaryDensity)' {
        InModuleScope AITriad {
            $SummaryObject = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'From a safetyist perspective, this understates catastrophic tail risk.'; category = 'Beliefs' }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @() }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
            }
            $Dropped = Invoke-SummaryCampBridgeFilter -SummaryObject $SummaryObject -ThisDocId 'test-doc' -PovTags @()
            $Dropped | Should -Be 0
            @($SummaryObject.pov_summaries.accelerationist.key_points).Count | Should -Be 1
        }
    }

    It 'sums drops across multiple untagged camps' {
        InModuleScope AITriad {
            $SummaryObject = [PSCustomObject]@{
                pov_summaries = [PSCustomObject]@{
                    accelerationist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'Accelerationists would support this because it cuts friction.'; category = 'Beliefs' }
                    ) }
                    safetyist = [PSCustomObject]@{ key_points = @(
                        [PSCustomObject]@{ point = 'This aligns with the safetyist concern about accountability.'; category = 'Beliefs' }
                    ) }
                    skeptic   = [PSCustomObject]@{ key_points = @() }
                }
            }
            $Dropped = Invoke-SummaryCampBridgeFilter -SummaryObject $SummaryObject -ThisDocId 'test-doc' -PovTags @('skeptic')
            $Dropped | Should -Be 2
        }
    }
}

Describe 'New-SummaryModelInfo camp_bridge_dropped field (t/4742)' -Tag 'unit' {

    It 'defaults to 0 when not passed' {
        InModuleScope AITriad {
            $Info = New-SummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -TaxonomyJson '[]' -ChunkCount 0 -FireStats $null
            $Info['camp_bridge_dropped'] | Should -Be 0
        }
    }

    It 'records the dropped count when passed' {
        InModuleScope AITriad {
            $Info = New-SummaryModelInfo -Model 'gemini-3.5-flash-lite' -Temperature 0.1 -TaxonomyJson '[]' -ChunkCount 0 -FireStats $null -CampBridgeDropped 3
            $Info['camp_bridge_dropped'] | Should -Be 3
        }
    }
}
