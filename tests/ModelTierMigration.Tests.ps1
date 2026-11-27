# Tag: config (t/3572)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Phase-2 migration guard (t/3572): every hardcoded model-id default that was
    replaced with Get-AITierModel is proven behavior-preserving — the resolved tier
    value equals the literal it replaced, and each site routes through the helper.
    Satisfies the TL condition "one assertion per migration that resolved == literal".
#>

# Top-level (discovery-time) so -TestCases can see it — Pester 6 evaluates TestCases
# during discovery, before BeforeAll runs.
# (relative path, tier, literal-it-replaced, expected # of helper invocations)
$script:MigratedSites = @(
        @{ Path = 'Private/Get-DocumentPovClassification.ps1'; Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Get-ConflictEvolution.ps1';          Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Import-AITriadDocument.ps1';         Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-AttributeExtraction.ps1';     Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-EdgeDiscovery.ps1';           Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 2 }
        @{ Path = 'Public/Invoke-EdgeRationaleBackfill.ps1';   Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-EdgeWeightEvaluation.ps1';    Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-GraphQuery.ps1';              Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-HierarchyProposal.ps1';       Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Repair-PovAttributes.ps1';           Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Repair-PovDescriptions.ps1';         Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Repair-PovLineage.ps1';              Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Show-TriadDialogue.ps1';             Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Test-EdgeDirection.ps1';             Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-DebateGroundingBatch.ps1';    Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-VernacularBatch.ps1';         Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-POVSummary.ps1';              Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-TaxonomyProposal.ps1';        Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Test-ExtractionQuality.ps1';         Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 2 }
        @{ Path = 'Public/Find-PolicyAction.ps1';              Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Find-PossibleFallacy.ps1';           Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Private/FindSituationCandidatesSteps.ps1';  Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }  # moved from Public/ by the t/3910 refactor (#3087)
        @{ Path = 'Public/Get-IngestionPriority.ps1';          Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Get-TopicFrequency.ps1';             Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-PolicyRefinement.ps1';        Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
        @{ Path = 'Public/Invoke-AITDebate.ps1';               Tier = 'basic';    Literal = 'gemini-3.5-flash-lite'; Count = 1 }
    )

BeforeAll {
    Import-Module "$PSScriptRoot/../scripts/AITriad/AITriad.psm1" -Force
    $script:AITriadRoot = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad'
}

Describe 'Phase-2 model-default migration (t/3572)' -Tag 'config' {

    Context 'tier resolution invariants (the resolved == literal proof)' {
        It 'Get-AITierModel -Tier basic resolves to gemini-3.5-flash-lite' {
            Get-AITierModel -Tier basic | Should -Be 'gemini-3.5-flash-lite'
        }
        It 'Get-AITierModel -Tier advanced resolves to gemini-4-hydrogen (t/781: the human moved the Advanced Gemini tier off gemini-3.1-pro-preview)' {
            Get-AITierModel -Tier advanced | Should -Be 'gemini-4-hydrogen'
        }
    }

    Context 'each migrated site routes through the helper AND resolves to the literal it replaced' {
        It '<Path> (-Tier <Tier>) resolves to <Literal> and uses the helper <Count>x' -TestCases $script:MigratedSites {
            # Pester injects $Path/$Tier/$Literal/$Count from the testcase hashtable — no param() block.

            # (a) resolved == literal it replaced — behavior-preserving at time of migration.
            Get-AITierModel -Tier $Tier | Should -Be $Literal

            # (b) the site actually routes through the helper (not still a hardcoded literal).
            $full = Join-Path $script:AITriadRoot $Path
            $content = Get-Content -Raw -Path $full
            $needle  = "(Get-AITierModel -Tier $Tier)"
            $hits = ([regex]::Matches($content, [regex]::Escape($needle))).Count
            $hits | Should -Be $Count -Because "$Path should reference $needle $Count time(s)"
        }
    }
}

Describe 'Research judges are pinned, not tier-following (t/781, Comp-Linguist)' -Tag 'config' {
    # Invoke-DirectionalJudge and Invoke-PolarityGatePass are research instruments: their frozen gates were validated on
    # gemini-3.1-pro-preview, so a change of the Advanced tier (Hydrogen, t/781) must not change the judge.
    It '<Path> defaults to the literal gemini-3.1-pro-preview and does not use the Advanced tier lookup' -TestCases @(
        @{ Path = 'Private/Invoke-DirectionalJudge.ps1' }
        @{ Path = 'Private/Invoke-PolarityGatePass.ps1' }
    ) {
        $content = Get-Content -Raw -Path (Join-Path $script:AITriadRoot $Path)
        $content | Should -Match '\$(Model|JudgeModel) = ''gemini-3\.1-pro-preview'''
        $content | Should -Not -Match '\$(Model|JudgeModel) = \(Get-AITierModel'
    }
    It 'the pinned judge model is still registered in ai-models.json' {
        $registry = Get-Content -Raw -Path (Join-Path $PSScriptRoot '..' 'ai-models.json') | ConvertFrom-Json
        $registry.models.id | Should -Contain 'gemini-3.1-pro-preview'
    }
}
