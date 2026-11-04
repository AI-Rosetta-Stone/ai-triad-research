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
                [PSCustomObject]@{ Text = '{"types":[{"type":"not_a_real_type","confidence":0.0}],"rationale":"x"}'; Usage = $null }
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
                [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.0},{"type":"social","confidence":0.0},{"type":"political","confidence":0.0},{"type":"economic","confidence":0.0}],"rationale":"x"}'; Usage = $null }
            }
            $OutPath = Join-Path $TestDrive 'reject-toomany-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-002') -SkipCrossCheck -OutputPath $OutPath -WarningAction SilentlyContinue
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
                [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.0},{"type":"misuse","confidence":0.0}],"rationale":"x"}'; Usage = $null }
            }
            $OutPath = Join-Path $TestDrive 'reject-dupe-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-003') -SkipCrossCheck -OutputPath $OutPath -WarningAction SilentlyContinue
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
                [PSCustomObject]@{ Text = '{"types":[],"rationale":"method-only, no issue area"}'; Usage = $null }
            }
            $OutPath = Join-Path $TestDrive 'accept-zerotag-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-004') -SkipCrossCheck -OutputPath $OutPath -WarningAction SilentlyContinue
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
                [PSCustomObject]@{ Text = '{"types":[{"type":"power_concentration","confidence":0.9}],"rationale":"about power"}'; Usage = $null }
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
                [PSCustomObject]@{ Text = '{"types":[{"type":"economic","confidence":0.8}],"rationale":"economic effects"}'; Usage = $null }
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
                [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.9}],"rationale":"misuse"}'; Usage = $null }
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
                [PSCustomObject]@{ Text = '{"types":[],"rationale":"x"}'; Usage = $null }
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
                    [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.9}],"rationale":"primary"}'; Usage = $null }
                } else {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"social","confidence":0.9}],"rationale":"second"}'; Usage = $null }
                }
            }
            $OutPath = Join-Path $TestDrive 'crosscheck-disagree-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-010') -Model 'gemini-3.5-flash-lite' -SecondModel 'groq-openai-gpt-oss-20b' -OutputPath $OutPath -WarningAction SilentlyContinue
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
                [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.9}],"rationale":"agreement"}'; Usage = $null }
            }
            $OutPath = Join-Path $TestDrive 'crosscheck-agree-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-011') -Model 'gemini-3.5-flash-lite' -SecondModel 'groq-openai-gpt-oss-20b' -OutputPath $OutPath -WarningAction SilentlyContinue
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
                    [PSCustomObject]@{ Text = '{"types":[{"type":"not_a_real_type","confidence":0.0}],"rationale":"bad"}'; Usage = $null }
                } else {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.9}],"rationale":"good on retry"}'; Usage = $null }
                }
            }
            $OutPath = Join-Path $TestDrive 'retry-success-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-012') -SkipCrossCheck -OutputPath $OutPath -WarningAction SilentlyContinue
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
                [PSCustomObject]@{ Text = '{"types":[{"type":"not_a_real_type","confidence":0.0}],"rationale":"bad"}'; Usage = $null }
            }
            $OutPath = Join-Path $TestDrive 'retry-fail-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-013') -SkipCrossCheck -OutputPath $OutPath -WarningAction SilentlyContinue
            Should -Invoke Invoke-AIApi -Times 2 -Exactly
            $Result.Skipped | Should -Be 1
            $Result.Failed | Should -Contain 'acc-beliefs-013'
            # The TL's invariant: every requested node ends up either proposed or skipped.
            ($Result.Proposed + $Result.Skipped) | Should -Be 1
        }
    }

    It 'accepts a 0-tag response and writes final=[] (not null) for the accepted proposal' {
        InModuleScope AITriad {
            $script:TaxonomyData = @{
                acc = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id = 'acc-beliefs-014'; label = 'Build node'; description = 'A build-system refactor, no stated stake.'; category = 'Beliefs' }
                ) }
            }
            Mock Invoke-AIApi {
                [PSCustomObject]@{ Text = '{"types":[],"rationale":"method-only"}'; Usage = $null }
            }
            $OutPath = Join-Path $TestDrive 'zero-tag-final-proposals.json'
            $Result = Invoke-IssueTypeClassification -NodeIds @('acc-beliefs-014') -SkipCrossCheck -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
            $Result.Proposed | Should -Be 1
            # Check the raw JSON TEXT, not a re-parsed object: ConvertFrom-Json on an empty JSON
            # array can itself come back as $null (the same collapse this suite guards against
            # inside the cmdlet), so round-tripping through it here would mask the real bug this
            # test exists to catch. "final":[] (not "final":null) proves accepted+0-tags wrote an
            # empty array, not null -- t/4832: null means "not yet classified".
            $RawJson = Get-Content $OutPath -Raw
            $RawJson | Should -Match '"status"\s*:\s*"accepted"'
            $RawJson | Should -Match '"final"\s*:\s*\[\s*\]' -Because 'final must be [] for an accepted 0-tag proposal, never null'
        }
    }

    Context '-AdjudicateQueue (t/4835#4)' {

        BeforeAll {
            # Describe/Context bodies run at Pester's DISCOVERY phase, not the RUN phase that It
            # blocks execute in -- a bare `function` statement here would only exist during
            # discovery and vanish by the time any It runs. BeforeAll's body runs in Run phase,
            # so a function defined here stays visible to every It in this Context.
            #
            # Runs OUTSIDE InModuleScope -- pure JSON file I/O, no module internals needed. Passing
            # a scriptblock or function INTO InModuleScope via -Parameters doesn't survive the hop
            # (comes back invalid for '&'), so the file is written here and only its path (a plain
            # string) crosses into the module's session state.
            function New-AdjQueueFile {
                param($Path)
                $Queue = [ordered]@{
                    version = 1
                    run_id  = 'issue-types-full-2026-11-04'
                    proposals = @(
                        [ordered]@{ node_id = 'acc-adj-001'; proposed = @('misuse'); status = 'pending'; final = $null; reviewed_by = $null; reviewed_at = $null; confidence = [ordered]@{ misuse = 0.4 }; rationale = 'r1'; provenance = [ordered]@{ method = 'llm'; model = 'gemini-3.5-flash-lite'; second_model = 'groq-openai-gpt-oss-20b'; second_types = @('social'); agree = $false } }
                        [ordered]@{ node_id = 'acc-adj-002'; proposed = @('misuse'); status = 'pending'; final = $null; reviewed_by = $null; reviewed_at = $null; confidence = [ordered]@{ misuse = 0.4 }; rationale = 'r2'; provenance = [ordered]@{ method = 'llm'; model = 'gemini-3.5-flash-lite'; second_model = 'groq-openai-gpt-oss-20b'; second_types = @('social'); agree = $false } }
                        [ordered]@{ node_id = 'acc-adj-003'; proposed = @('misuse'); status = 'pending'; final = $null; reviewed_by = $null; reviewed_at = $null; confidence = [ordered]@{ misuse = 0.4 }; rationale = 'r3'; provenance = [ordered]@{ method = 'llm'; model = 'gemini-3.5-flash-lite'; second_model = 'groq-openai-gpt-oss-20b'; second_types = @('social'); agree = $false } }
                        [ordered]@{ node_id = 'acc-adj-004'; proposed = @(); status = 'pending'; final = $null; reviewed_by = $null; reviewed_at = $null; confidence = [ordered]@{}; rationale = 'r4'; provenance = [ordered]@{ method = 'llm'; model = 'gemini-3.5-flash-lite'; second_model = 'groq-openai-gpt-oss-20b'; second_types = @(); agree = $false } }
                        [ordered]@{ node_id = 'acc-adj-005'; proposed = @('economic'); status = 'pending'; final = $null; reviewed_by = $null; reviewed_at = $null; confidence = [ordered]@{ economic = 0.4 }; rationale = 'r5'; provenance = [ordered]@{ method = 'llm'; model = 'gemini-3.5-flash-lite'; second_model = 'groq-openai-gpt-oss-20b'; second_types = @('power_concentration'); agree = $false } }
                    )
                }
                $Queue | ConvertTo-Json -Depth 10 | Set-Content -Path $Path -Encoding utf8NoBOM
            }
        }

        BeforeEach {
            # Shared taxonomy, reused (with per-test overrides) across the adjudication tests below.
            InModuleScope AITriad {
                $script:TaxonomyData = @{
                    acc = [PSCustomObject]@{ nodes = @(
                        [PSCustomObject]@{ id = 'acc-adj-001'; label = 'Match node'; description = 'd'; category = 'Beliefs' }
                        [PSCustomObject]@{ id = 'acc-adj-002'; label = 'No-match node'; description = 'd'; category = 'Beliefs' }
                        [PSCustomObject]@{ id = 'acc-adj-003'; label = 'Low-confidence node'; description = 'd'; category = 'Beliefs' }
                        [PSCustomObject]@{ id = 'acc-adj-004'; label = 'No-tag-agreement node'; description = 'd'; category = 'Beliefs' }
                        [PSCustomObject]@{ id = 'acc-adj-005'; label = 'Untouched node'; description = 'd'; category = 'Beliefs' }
                    ) }
                }
            }
        }

        It 'auto-accepts when the adjudicator matches a prior primary at confidence >= 0.6' {
            $OutPath = Join-Path $TestDrive 'adj-match-proposals.json'
            New-AdjQueueFile -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.8}],"rationale":"adjudicated"}'; Usage = $null }
                }
                $Result = Invoke-IssueTypeClassification -AdjudicateQueue -AdjudicatorModel 'claude-sonnet-5' -NodeIds @('acc-adj-001') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Result.AdjudicatedAccepted | Should -Be 1
                $Result.AdjudicatedStillPending | Should -Be 0
                $Written = Get-Content $OutPath -Raw | ConvertFrom-Json
                $Entry = $Written.proposals | Where-Object { $_.node_id -eq 'acc-adj-001' }
                $Entry.status | Should -Be 'accepted'
                @($Entry.final) | Should -Be @('misuse')
                $Entry.provenance.adjudicator_matched_prior | Should -Be 'primary'
            }
        }

        It 'leaves the entry pending when the adjudicator matches neither prior model' {
            $OutPath = Join-Path $TestDrive 'adj-nomatch-proposals.json'
            New-AdjQueueFile -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"economic","confidence":0.9}],"rationale":"adjudicated"}'; Usage = $null }
                }
                $Result = Invoke-IssueTypeClassification -AdjudicateQueue -AdjudicatorModel 'claude-sonnet-5' -NodeIds @('acc-adj-002') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Result.AdjudicatedAccepted | Should -Be 0
                $Result.AdjudicatedStillPending | Should -Be 1
                $Entry = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-adj-002' }
                $Entry.status | Should -Be 'pending'
                $Entry.provenance.adjudicator_matched_prior | Should -Be 'none'
            }
        }

        It 'leaves the entry pending when the adjudicator matches a prior primary but confidence is below 0.6' {
            $OutPath = Join-Path $TestDrive 'adj-lowconf-proposals.json'
            New-AdjQueueFile -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.5}],"rationale":"adjudicated"}'; Usage = $null }
                }
                $Result = Invoke-IssueTypeClassification -AdjudicateQueue -AdjudicatorModel 'claude-sonnet-5' -NodeIds @('acc-adj-003') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Result.AdjudicatedAccepted | Should -Be 0
                $Result.AdjudicatedStillPending | Should -Be 1
                $Entry = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-adj-003' }
                $Entry.status | Should -Be 'pending'
            }
        }

        It 'auto-accepts a no-tag agreement (adjudicator picks no tag, matching a no-tag prior) with no confidence gate' {
            $OutPath = Join-Path $TestDrive 'adj-notag-proposals.json'
            New-AdjQueueFile -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[],"rationale":"adjudicated"}'; Usage = $null }
                }
                $Result = Invoke-IssueTypeClassification -AdjudicateQueue -AdjudicatorModel 'claude-sonnet-5' -NodeIds @('acc-adj-004') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Result.AdjudicatedAccepted | Should -Be 1
                $Entry = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-adj-004' }
                $Entry.status | Should -Be 'accepted'
                $RawJson = Get-Content $OutPath -Raw
                ($RawJson | Select-String -Pattern '"node_id"\s*:\s*"acc-adj-004"').Matches.Count | Should -Be 1
            }
        }

        It 'leaves the entry pending (unresolved) when the adjudicator call fails twice, and does not touch other entries' {
            $OutPath = Join-Path $TestDrive 'adj-callfail-proposals.json'
            New-AdjQueueFile -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"not_a_real_type","confidence":0.0}],"rationale":"bad"}'; Usage = $null }
                }
                $Result = Invoke-IssueTypeClassification -AdjudicateQueue -AdjudicatorModel 'claude-sonnet-5' -NodeIds @('acc-adj-005') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Result.AdjudicatedStillPending | Should -Be 1
                $Written = Get-Content $OutPath -Raw | ConvertFrom-Json
                @($Written.proposals).Count | Should -Be 5
                $Entry = $Written.proposals | Where-Object { $_.node_id -eq 'acc-adj-005' }
                $Entry.status | Should -Be 'pending'
                $Entry.provenance.adjudicator_matched_prior | Should -Be 'call_failed'
                # Every OTHER entry's status/proposed is untouched (in-place mutation hit only the target).
                $Others = $Written.proposals | Where-Object { $_.node_id -ne 'acc-adj-005' }
                foreach ($o in $Others) { $o.status | Should -Be 'pending' }
            }
        }

        It 'dry run (no -WriteProposals) does not mutate the file on disk' {
            $OutPath = Join-Path $TestDrive 'adj-dryrun-proposals.json'
            New-AdjQueueFile -Path $OutPath
            $Before = Get-Content $OutPath -Raw
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.9}],"rationale":"adjudicated"}'; Usage = $null }
                }
                $null = Invoke-IssueTypeClassification -AdjudicateQueue -AdjudicatorModel 'claude-sonnet-5' -NodeIds @('acc-adj-001') -OutputPath $OutPath -WarningAction SilentlyContinue
            }
            (Get-Content $OutPath -Raw) | Should -Be $Before
        }
    }
}
