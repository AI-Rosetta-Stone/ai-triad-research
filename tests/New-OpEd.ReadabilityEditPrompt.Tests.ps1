# Tag: oped (t/202)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    New-OpEd's readability-edit prompt is filled from the outlet's own targets (t/202).
.DESCRIPTION
    lib/oped/prompts/op-ed-readability-edit.prompt gains six placeholders (FK_MAX, MAX_SENT_WORDS,
    MAX_PARA_WORDS, STYLE_SENTENCE, STYLE_PARAGRAPH, STYLE_JARGON) in Shared Lib's #4912. The PS path
    must fill them like lib/oped assembleReadabilityEditPrompt, or literal {{...}} reaches the model.
    The real-prompt cases hold on main and after #4912. The templated cases render a copy of #4912's
    prompt (fixtures/oped/op-ed-readability-edit.t202.txt, stored as .txt so the prompt-catalog lint
    doesn't discover it) and check the numbers and style strings, so they don't depend on merge order.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:RealPromptsDir = Join-Path $PSScriptRoot '..' 'lib' 'oped' 'prompts'
    $script:TemplatedDir = Join-Path $TestDrive 't202-prompts'
    New-Item -ItemType Directory -Path $script:TemplatedDir -Force | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'fixtures' 'oped' 'op-ed-readability-edit.t202.txt') `
        (Join-Path $script:TemplatedDir 'op-ed-readability-edit.prompt')
}

Describe 'Get-OpEdEditPrompt (t/202)' -Tag 'oped' {

    It 'leaves no {{ in the real prompt for <Outlet>' -TestCases @(
        @{ Outlet = 'WashingtonPost' }, @{ Outlet = 'TechPolicyPress' }
    ) {
        param($Outlet)
        InModuleScope AITriad -Parameters @{ Outlet = $Outlet; Dir = $script:RealPromptsDir } {
            param($Outlet, $Dir)
            $Info = Resolve-OpEdOutlet -Outlet $Outlet
            $Ctx = [pscustomobject]@{
                Body = 'Body text.'; Violations = 'Longest sentence: 50 words'; PromptsDir = $Dir
                Limits = Get-OpEdReadabilityLimit -OutletInfo $Info; Style = Get-OpEdEditStyle -OutletInfo $Info
            }
            (Get-OpEdEditPrompt -Ctx $Ctx) | Should -Not -Match '\{\{'
        }
    }

    It 'fills Tech Policy Press targets (16/40/120) and its own vocabulary rule into the templated prompt' {
        InModuleScope AITriad -Parameters @{ Dir = $script:TemplatedDir } {
            param($Dir)
            $Info = Resolve-OpEdOutlet -Outlet 'TechPolicyPress'
            $Ctx = [pscustomobject]@{
                Body = 'Body text.'; Violations = 'v'; PromptsDir = $Dir
                Limits = Get-OpEdReadabilityLimit -OutletInfo $Info; Style = Get-OpEdEditStyle -OutletInfo $Info
            }
            $P = Get-OpEdEditPrompt -Ctx $Ctx
            $P | Should -Not -Match '\{\{'
            $P | Should -Match 'grade no higher than 16\.'
            $P | Should -Match 'no sentence over 40 words'
            $P | Should -Match 'no paragraph over ~120 words'
            $P | Should -Not -Match 'no higher than 1[01]\b'
            $P.Contains("Vocabulary: $($Info.Entry.style.jargonGuidance)") | Should -BeTrue
        }
    }

    It 'fills a default-styled outlet from styleDefaults (11/30/90) into the templated prompt' {
        InModuleScope AITriad -Parameters @{ Dir = $script:TemplatedDir } {
            param($Dir)
            $Info = Resolve-OpEdOutlet -Outlet 'WashingtonPost'
            $Ctx = [pscustomobject]@{
                Body = 'Body text.'; Violations = 'v'; PromptsDir = $Dir
                Limits = Get-OpEdReadabilityLimit -OutletInfo $Info; Style = Get-OpEdEditStyle -OutletInfo $Info
            }
            $P = Get-OpEdEditPrompt -Ctx $Ctx
            $P | Should -Not -Match '\{\{'
            $P | Should -Match 'grade no higher than 11\.'
            $P | Should -Match 'no sentence over 30 words'
            $P | Should -Match 'no paragraph over ~90 words'
            $P.Contains("House style: $($Info.Data.styleDefaults.sentenceMechanics)") | Should -BeTrue
            $P.Contains("House style: $($Info.Data.styleDefaults.paragraphMechanics)") | Should -BeTrue
            $P.Contains("Vocabulary: $($Info.Data.styleDefaults.jargonGuidance)") | Should -BeTrue
        }
    }

    It 'renders numbers culture-invariant (10.5, not 10,5) under de-DE' {
        InModuleScope AITriad -Parameters @{ Dir = $script:TemplatedDir } {
            param($Dir)
            $Saved = [cultureinfo]::CurrentCulture
            try {
                [cultureinfo]::CurrentCulture = [cultureinfo]::GetCultureInfo('de-DE')
                $Ctx = [pscustomobject]@{
                    Body = 'b'; Violations = 'v'; PromptsDir = $Dir
                    Limits = [pscustomobject]@{ FkMax = 10.5; SentWords = 30; ParaWords = 90 }
                    Style = [pscustomobject]@{ Sentence = 's.'; Paragraph = 'p.'; Jargon = 'j.' }
                }
                $P = Get-OpEdEditPrompt -Ctx $Ctx
            } finally { [cultureinfo]::CurrentCulture = $Saved }
            $P | Should -Match 'grade no higher than 10\.5\.'
            $P | Should -Not -Match '10,5'
        }
    }
}

Describe 'Invoke-OpEdEditAttempt sends a fully filled prompt (t/202)' -Tag 'oped' {

    It 'the prompt sent to the model has no {{ and carries the outlet targets' {
        InModuleScope AITriad -Parameters @{ Dir = $script:TemplatedDir } {
            param($Dir)
            $script:SentPrompt = $null
            Mock Invoke-AIApi {
                $script:SentPrompt = $Prompt
                [pscustomobject]@{ Text = (@{ body_markdown = 'one two three four five'; changed = $true; edit_notes = 'n' } | ConvertTo-Json) }
            }
            $Info = Resolve-OpEdOutlet -Outlet 'TechPolicyPress'
            $Ctx = [pscustomobject]@{
                Body = 'one two three four five'; Violations = 'v'; PromptsDir = $Dir; OrigWordCount = 5
                Model = 'gemini-3.5-flash-lite'; MaxTokens = 100
                Limits = Get-OpEdReadabilityLimit -OutletInfo $Info; Style = Get-OpEdEditStyle -OutletInfo $Info
            }
            Invoke-OpEdEditAttempt -Ctx $Ctx -Temperature 0.3 | Should -Be 'one two three four five'
            $script:SentPrompt | Should -Not -BeNullOrEmpty
            $script:SentPrompt | Should -Not -Match '\{\{'
            $script:SentPrompt | Should -Match 'grade no higher than 16\.'
        }
    }
}

Describe 'Get-OpEdEditStyle (t/202)' -Tag 'oped' {

    It 'falls back field by field to styleDefaults, and refuses when both lack a field' {
        InModuleScope AITriad {
            $Info = [pscustomobject]@{
                Entry = [pscustomobject]@{ style = [pscustomobject]@{ sentenceMechanics = 'Own sentence.' } }
                Data  = [pscustomobject]@{ styleDefaults = [pscustomobject]@{
                    sentenceMechanics = 'Default sentence.'; paragraphMechanics = 'Default paragraph.'; jargonGuidance = 'Default jargon.' } }
            }
            $S = Get-OpEdEditStyle -OutletInfo $Info
            $S.Sentence  | Should -Be 'Own sentence.'
            $S.Paragraph | Should -Be 'Default paragraph.'
            $S.Jargon    | Should -Be 'Default jargon.'

            $Info.Data.styleDefaults.PSObject.Properties.Remove('jargonGuidance')
            { Get-OpEdEditStyle -OutletInfo $Info } | Should -Throw '*jargonGuidance*'
        }
    }
}
