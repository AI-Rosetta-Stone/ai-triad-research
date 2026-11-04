# Tag: unit (t/4833)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4833: Invoke-IssueTypeClassification writes proposals only (taxonomy/Origin/issue-type-
    proposals.json), never node files. Mocks Invoke-AIApi -- no real AI calls, no spend.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-IssueTypeClassification (t/4833)' -Tag 'unit' {

    It 'rejects an out-of-enum response and skips the node without writing it' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-001'; label = 'Test node'; description = 'A test description.'; category = 'Beliefs' }
                ) }
            }
            Mock Invoke-AIApi {
                [PSCustomObject]@{ Text = '{"types":["not_a_real_type"],"confidence":{},"rationale":"x"}'; Usage = $null }
            }
            $OutPath = Join-Path $TestDrive 'reject-enum-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-001') -SkipCrossCheck -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
            $Result.Skipped | Should -Be 1
            $Result.Proposed | Should -Be 0
            $Written = Get-Content $OutPath -Raw | ConvertFrom-Json
            @($Written.proposals).Count | Should -Be 0
        }
    }

    It 'rejects more than 3 types and skips the node' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-002'; label = 'Test node 2'; description = 'Another description.'; category = 'Beliefs' }
                ) }
            }
            Mock Invoke-AIApi {
                [PSCustomObject]@{ Text = '{"types":["misuse","social","political","economic"],"confidence":{},"rationale":"x"}'; Usage = $null }
            }
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-002') -SkipCrossCheck -WarningAction SilentlyContinue
            $Result.Skipped | Should -Be 1
        }
    }

    It 'rejects a duplicate type and skips the node' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-003'; label = 'Test node 3'; description = 'A third description.'; category = 'Beliefs' }
                ) }
            }
            Mock Invoke-AIApi {
                [PSCustomObject]@{ Text = '{"types":["misuse","misuse"],"confidence":{},"rationale":"x"}'; Usage = $null }
            }
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-003') -SkipCrossCheck -WarningAction SilentlyContinue
            $Result.Skipped | Should -Be 1
        }
    }

    It 'accepts a valid 0-tag ([]) response' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-004'; label = 'Build system'; description = 'A build-system refactor, no stated stake.'; category = 'Beliefs' }
                ) }
            }
            Mock Invoke-AIApi {
                [PSCustomObject]@{ Text = '{"types":[],"confidence":{},"rationale":"method-only, no issue area"}'; Usage = $null }
            }
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-004') -SkipCrossCheck -WarningAction SilentlyContinue
            $Result.Proposed | Should -Be 1
            $Result.EmptyCount | Should -Be 1
        }
    }

    It 'writes ONLY the proposals file -- a node file in the taxonomy dir is byte-identical after the run' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-005'; label = 'Power node'; description = 'About who holds power.'; category = 'Beliefs' }
                ) }
            }
            Mock Invoke-AIApi {
                [PSCustomObject]@{ Text = '{"types":["power_concentration"],"confidence":{"power_concentration":0.9},"rationale":"about power"}'; Usage = $null }
            }
            $NodeFilePath = Join-Path $TestDrive 'accelerationist.json'
            $NodeFileContent = '{"nodes":[{"id":"acc-beliefs-005","label":"Power node"}]}'
            Set-Content -Path $NodeFilePath -Value $NodeFileContent -NoNewline -Encoding utf8
            $BeforeHash = (Get-FileHash -Path $NodeFilePath -Algorithm SHA256).Hash

            $OutPath = Join-Path $TestDrive 'node-file-isolation-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-005') -SkipCrossCheck -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue

            $AfterHash = (Get-FileHash -Path $NodeFilePath -Algorithm SHA256).Hash
            $AfterHash | Should -Be $BeforeHash
            Test-Path $OutPath | Should -BeTrue
            $Written = Get-Content $OutPath -Raw | ConvertFrom-Json
            $Written.proposals.Count | Should -Be 1
            $Written.proposals[0].node_id | Should -Be 'acc-beliefs-005'
            $Written.proposals[0].proposed | Should -Be @('power_concentration')
            $Result.Written | Should -Be 1
        }
    }

    It 'dry-run (no -WriteProposals) reports but does not write the file' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-006'; label = 'Dry run node'; description = 'Something economic.'; category = 'Beliefs' }
                ) }
            }
            Mock Invoke-AIApi {
                [PSCustomObject]@{ Text = '{"types":["economic"],"confidence":{"economic":0.8},"rationale":"economic effects"}'; Usage = $null }
            }
            $OutPath = Join-Path $TestDrive 'dry-run-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-006') -SkipCrossCheck -OutputPath $OutPath -WarningAction SilentlyContinue
            $Result.Proposed | Should -Be 1
            $Result.Written | Should -Be 0
            Test-Path $OutPath | Should -BeFalse
        }
    }

    It 'resume: a second run with the same RunId skips an already-classified node' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-007'; label = 'Resume node A'; description = 'About misuse of AI.'; category = 'Beliefs' }
                    [PSCustomObject]@{ id = 'acc-beliefs-008'; label = 'Resume node B'; description = 'About social effects.'; category = 'Beliefs' }
                ) }
            }
            $script:CallCount = 0
            Mock Invoke-AIApi {
                $script:CallCount++
                [PSCustomObject]@{ Text = '{"types":["misuse"],"confidence":{"misuse":0.9},"rationale":"misuse"}'; Usage = $null }
            }
            $OutPath = Join-Path $TestDrive 'resume-proposals.json'
            $Rid = 'resume-test-run-1'

            $null = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-007') -SkipCrossCheck -OutputPath $OutPath -WriteProposals -RunId $Rid -WarningAction SilentlyContinue
            Should -Invoke Invoke-AIApi -Times 1 -Exactly

            $Result2 = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-007', 'acc-beliefs-008') -SkipCrossCheck -OutputPath $OutPath -WriteProposals -RunId $Rid -WarningAction SilentlyContinue
            Should -Invoke Invoke-AIApi -Times 2 -Exactly    # 1 (first run) + 1 (only the NEW node this run)
            $Result2.Proposed | Should -Be 1
            $Written = Get-Content $OutPath -Raw | ConvertFrom-Json
            $Written.proposals.Count | Should -Be 2
            @($Written.proposals.node_id) | Should -Contain 'acc-beliefs-007'
            @($Written.proposals.node_id) | Should -Contain 'acc-beliefs-008'
        }
    }

    It 'refuses to continue into an existing file from a DIFFERENT run_id without -Force' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-009'; label = 'Conflict node'; description = 'Something.'; category = 'Beliefs' }
                ) }
            }
            Mock Invoke-AIApi {
                [PSCustomObject]@{ Text = '{"types":[],"confidence":{},"rationale":"x"}'; Usage = $null }
            }
            $OutPath = Join-Path $TestDrive 'conflict-proposals.json'
            $null = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-009') -SkipCrossCheck -OutputPath $OutPath -WriteProposals -RunId 'run-a' -WarningAction SilentlyContinue
            { Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-009') -SkipCrossCheck -OutputPath $OutPath -WriteProposals -RunId 'run-b' -WarningAction SilentlyContinue } | Should -Throw
        }
    }

    It 'cross-check: disagreement between the two models sends the item to the review queue' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-010'; label = 'Disagreement node'; description = 'Ambiguous content.'; category = 'Beliefs' }
                ) }
            }
            $script:callN = 0
            Mock Invoke-AIApi {
                $script:callN++
                if ($script:callN -eq 1) {
                    [PSCustomObject]@{ Text = '{"types":["misuse"],"confidence":{"misuse":0.9},"rationale":"primary"}'; Usage = $null }
                } else {
                    [PSCustomObject]@{ Text = '{"types":["social"],"confidence":{"social":0.9},"rationale":"second"}'; Usage = $null }
                }
            }
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-010') -Model 'gemini-3.5-flash-lite' -SecondModel 'groq-openai-gpt-oss-20b' -WarningAction SilentlyContinue
            $Result.ReviewQueueCount | Should -Be 1
            $Result.AgreementRate | Should -Be 0
        }
    }

    It 'cross-check: agreement auto-accepts (no review queue) when confidence is >= 0.5' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-011'; label = 'Agreement node'; description = 'Clear content.'; category = 'Beliefs' }
                ) }
            }
            Mock Invoke-AIApi {
                [PSCustomObject]@{ Text = '{"types":["misuse"],"confidence":{"misuse":0.9},"rationale":"agreement"}'; Usage = $null }
            }
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-011') -Model 'gemini-3.5-flash-lite' -SecondModel 'groq-openai-gpt-oss-20b' -WarningAction SilentlyContinue
            $Result.ReviewQueueCount | Should -Be 0
            $Result.AgreementRate | Should -Be 1
        }
    }

    It 'retries once on a failed/invalid response and succeeds on the retry (TL condition, t/4833#5)' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-012'; label = 'Retry-success node'; description = 'About misuse.'; category = 'Beliefs' }
                ) }
            }
            $script:retryCallN = 0
            Mock Invoke-AIApi {
                $script:retryCallN++
                if ($script:retryCallN -eq 1) {
                    [PSCustomObject]@{ Text = '{"types":["not_a_real_type"],"confidence":{},"rationale":"bad"}'; Usage = $null }
                } else {
                    [PSCustomObject]@{ Text = '{"types":["misuse"],"confidence":{"misuse":0.9},"rationale":"good on retry"}'; Usage = $null }
                }
            }
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-012') -SkipCrossCheck -WarningAction SilentlyContinue
            Should -Invoke Invoke-AIApi -Times 2 -Exactly
            $Result.Skipped | Should -Be 0
            $Result.Proposed | Should -Be 1
        }
    }

    It 'skips only after BOTH the original attempt and the retry fail, with exactly 2 calls made' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-013'; label = 'Retry-fail node'; description = 'Always invalid.'; category = 'Beliefs' }
                ) }
            }
            Mock Invoke-AIApi {
                [PSCustomObject]@{ Text = '{"types":["not_a_real_type"],"confidence":{},"rationale":"bad"}'; Usage = $null }
            }
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-013') -SkipCrossCheck -WarningAction SilentlyContinue
            Should -Invoke Invoke-AIApi -Times 2 -Exactly
            $Result.Skipped | Should -Be 1
            $Result.Failed | Should -Contain 'acc-beliefs-013'
            # The TL's invariant: every requested node ends up either proposed or skipped.
            ($Result.Proposed + $Result.Skipped) | Should -Be 1
        }
    }
}
