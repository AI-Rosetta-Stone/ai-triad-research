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

    # Hermetic default OutputPath. Without -OutputPath the cmdlet writes beside the REAL data
    # repo's taxonomy (Join-Path (Get-TaxonomyDir) 'issue-type-proposals.json'), and once the
    # full run committed that file (2026-11-04) every CI run failed with "already holds run_id
    # ...". Point Get-TaxonomyDir at a fresh per-test directory instead. (PSDefaultParameterValues
    # does not reach calls made inside InModuleScope, so it can't be used here.) Tests that pass
    # -OutputPath explicitly are unaffected.
    BeforeEach {
        $script:HermeticTaxDir = Join-Path $TestDrive "tax-$([guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:HermeticTaxDir -Force | Out-Null
        $dir = $script:HermeticTaxDir
        Mock Get-TaxonomyDir -ModuleName AITriad { $dir }.GetNewClosure()
    }

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
                # Explicit flatness check: `Should -Be` on a single-element array is too lenient to
                # catch a one-level-too-deep nest (PowerShell's array `-eq` filters rather than
                # strictly compares), which is exactly how this shipped broken -- every accepted
                # adjudication came out as e.g. [["political","misuse"]] instead of
                # ["political","misuse"] (TL-caught via t/4835's spot-check). Count + element type
                # together can't be fooled the same way.
                @($Entry.final).Count | Should -Be 1
                $Entry.final[0] | Should -BeOfType [string]
                $Entry.provenance.adjudicator_matched_prior | Should -Be 'primary'
            }
        }

        It 'writes a FLAT final array, not nested, when the adjudicator proposes multiple tags' {
            $OutPath = Join-Path $TestDrive 'adj-flatness-proposals.json'
            New-AdjQueueFile -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.8},{"type":"political","confidence":0.7}],"rationale":"adjudicated"}'; Usage = $null }
                }
                # acc-adj-001's prior primary is 'misuse' (New-AdjQueueFile's fixture), so a
                # 2-type adjudicator response with 'misuse' first still auto-accepts -- the point
                # of this test is the SHAPE of the written array, not the accept/pending decision.
                $null = Invoke-IssueTypeClassification -AdjudicateQueue -AdjudicatorModel 'claude-sonnet-5' -NodeIds @('acc-adj-001') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Entry = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-adj-001' }
                $Entry.status | Should -Be 'accepted'
                @($Entry.final).Count | Should -Be 2 -Because 'a nested [["misuse","political"]] would report Count 1, not 2'
                foreach ($t in @($Entry.final)) { $t | Should -BeOfType [string] }
                @($Entry.final) | Should -Be @('misuse', 'political')
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

    Context '-FinalAdjudication (t/4920, Quality-approved design at t/4920#2)' {

        BeforeAll {
            function New-AdjQueueFileWithPriorAdjudication {
                # acc-fin-002's prior adjudication (claude-sonnet-5, from an earlier t/4835#4 run)
                # already left it 'pending' (no-match, matched_prior='none') -- t/4920's whole point
                # is a SECOND, final pass over exactly this shape of entry.
                param($Path)
                $Queue = [ordered]@{
                    version = 1
                    run_id  = 'issue-types-full-2026-11-04'
                    proposals = @(
                        [ordered]@{ node_id = 'acc-fin-001'; proposed = @('misuse'); status = 'pending'; final = $null; reviewed_by = $null; reviewed_at = $null; confidence = [ordered]@{ misuse = 0.4 }; rationale = 'r1'; provenance = [ordered]@{ method = 'llm'; model = 'gemini-3.5-flash-lite'; second_model = 'groq-openai-gpt-oss-20b'; second_types = @('social'); agree = $false } }
                        [ordered]@{ node_id = 'acc-fin-002'; proposed = @('misuse'); status = 'pending'; final = $null; reviewed_by = $null; reviewed_at = $null; confidence = [ordered]@{ misuse = 0.4 }; rationale = 'r2'; provenance = [ordered]@{ method = 'llm'; model = 'gemini-3.5-flash-lite'; second_model = 'groq-openai-gpt-oss-20b'; second_types = @('social'); agree = $false; adjudicator_model = 'claude-sonnet-5'; adjudicator_types = @('economic'); adjudicator_confidence = [ordered]@{ economic = 0.9 }; adjudicator_rationale = 'prior sonnet pass'; adjudicator_matched_prior = 'none' } }
                        [ordered]@{ node_id = 'acc-fin-003'; proposed = @('misuse'); status = 'pending'; final = $null; reviewed_by = $null; reviewed_at = $null; confidence = [ordered]@{ misuse = 0.4 }; rationale = 'r3'; provenance = [ordered]@{ method = 'llm'; model = 'gemini-3.5-flash-lite'; second_model = 'groq-openai-gpt-oss-20b'; second_types = @('social'); agree = $false } }
                        [ordered]@{ node_id = 'acc-fin-004'; proposed = @('misuse'); status = 'pending'; final = $null; reviewed_by = $null; reviewed_at = $null; confidence = [ordered]@{ misuse = 0.4 }; rationale = 'r4'; provenance = [ordered]@{ method = 'llm'; model = 'gemini-3.5-flash-lite'; second_model = 'groq-openai-gpt-oss-20b'; second_types = @('social'); agree = $false } }
                    )
                }
                $Queue | ConvertTo-Json -Depth 10 | Set-Content -Path $Path -Encoding utf8NoBOM
            }
        }

        BeforeEach {
            InModuleScope AITriad {
                $script:TaxonomyData = @{
                    acc = [PSCustomObject]@{ nodes = @(
                        [PSCustomObject]@{ id = 'acc-fin-001'; label = 'Low-confidence match node'; description = 'd'; category = 'Beliefs' }
                        [PSCustomObject]@{ id = 'acc-fin-002'; label = 'Prior-adjudicated no-match node'; description = 'd'; category = 'Beliefs' }
                        [PSCustomObject]@{ id = 'acc-fin-003'; label = 'No-tag final node'; description = 'd'; category = 'Beliefs' }
                        [PSCustomObject]@{ id = 'acc-fin-004'; label = 'Invalid-answer node'; description = 'd'; category = 'Beliefs' }
                    ) }
                }
            }
        }

        It 'fails with an actionable error when passed without -AdjudicateQueue' {
            { Invoke-IssueTypeClassification -FinalAdjudication -AdjudicatorModel 'claude-opus-5-5' } |
                Should -Throw '*-FinalAdjudication*-AdjudicateQueue*'
        }

        It 'accepts unconditionally: a low-confidence match (would stay pending under the normal gate) is still accepted' {
            $OutPath = Join-Path $TestDrive 'fin-lowconf-proposals.json'
            New-AdjQueueFileWithPriorAdjudication -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.5}],"rationale":"final"}'; Usage = $null }
                }
                $Result = Invoke-IssueTypeClassification -AdjudicateQueue -FinalAdjudication -AdjudicatorModel 'claude-opus-5-5' -NodeIds @('acc-fin-001') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Result.AdjudicatedAccepted | Should -Be 1
                $Entry = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-fin-001' }
                $Entry.status | Should -Be 'accepted'
                $Entry.provenance.method | Should -Be 'llm-final-adjudication'
            }
        }

        It 'preserves the prior adjudication under provenance.prior_adjudication instead of overwriting it' {
            $OutPath = Join-Path $TestDrive 'fin-prior-proposals.json'
            New-AdjQueueFileWithPriorAdjudication -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"political","confidence":0.7}],"rationale":"opus final"}'; Usage = $null }
                }
                $null = Invoke-IssueTypeClassification -AdjudicateQueue -FinalAdjudication -AdjudicatorModel 'claude-opus-5-5' -NodeIds @('acc-fin-002') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Entry = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-fin-002' }
                $Entry.status | Should -Be 'accepted'
                $Entry.provenance.method | Should -Be 'llm-final-adjudication'
                # The NEW (opus) adjudicator_* fields are at the top level, as before.
                $Entry.provenance.adjudicator_model | Should -Be 'claude-opus-5-5'
                @($Entry.final) | Should -Be @('political')
                # The OLD (sonnet) adjudication is preserved, not lost.
                $Entry.provenance.prior_adjudication.model | Should -Be 'claude-sonnet-5'
                @($Entry.provenance.prior_adjudication.types) | Should -Be @('economic')
                $Entry.provenance.prior_adjudication.matched_prior | Should -Be 'none'
            }
        }

        It 'a resumed run never loses the ORIGINAL prior adjudication to a failed intermediate attempt (Quality, t/4920#4)' {
            $OutPath = Join-Path $TestDrive 'fin-resume-proposals.json'
            New-AdjQueueFileWithPriorAdjudication -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                # Run 1: the Opus call itself fails -- the entry stays pending, and
                # $SetAdjudicatorFields writes a FAILED Opus attempt into the top-level
                # adjudicator_* fields (matched_prior = 'call_failed'). Pre-fix, this failed
                # attempt was then the one copied into prior_adjudication on the resume below.
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = $null; Usage = $null }
                }
                $Run1 = Invoke-IssueTypeClassification -AdjudicateQueue -FinalAdjudication -AdjudicatorModel 'claude-opus-5-5' -NodeIds @('acc-fin-002') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Run1.AdjudicatedStillPending | Should -Be 1
                $AfterRun1 = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-fin-002' }
                $AfterRun1.status | Should -Be 'pending'
                $AfterRun1.provenance.prior_adjudication.model | Should -Be 'claude-sonnet-5' -Because 'the snapshot must already be taken on run 1, before the failed opus attempt overwrites adjudicator_model'

                # Run 2 (the resume t/4920's design plans for): a valid answer this time.
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"loss_of_control","confidence":0.75}],"rationale":"resumed final"}'; Usage = $null }
                }
                $Run2 = Invoke-IssueTypeClassification -AdjudicateQueue -FinalAdjudication -AdjudicatorModel 'claude-opus-5-5' -NodeIds @('acc-fin-002') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Run2.AdjudicatedAccepted | Should -Be 1
                $Final = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-fin-002' }
                $Final.status | Should -Be 'accepted'
                $Final.provenance.adjudicator_model | Should -Be 'claude-opus-5-5'
                @($Final.final) | Should -Be @('loss_of_control')
                # The ORIGINAL sonnet record must still be intact, not the failed-run-1 opus attempt.
                $Final.provenance.prior_adjudication.model | Should -Be 'claude-sonnet-5'
                @($Final.provenance.prior_adjudication.types) | Should -Be @('economic')
            }
        }

        It 'accepts an empty ([]) final answer, including when the file already carries a prior adjudication' {
            $OutPath = Join-Path $TestDrive 'fin-empty-proposals.json'
            New-AdjQueueFileWithPriorAdjudication -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[],"rationale":"nothing here"}'; Usage = $null }
                }
                $null = Invoke-IssueTypeClassification -AdjudicateQueue -FinalAdjudication -AdjudicatorModel 'claude-opus-5-5' -NodeIds @('acc-fin-003') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Written = Get-Content $OutPath -Raw
                $Written | Should -Match '"status"\s*:\s*"accepted"'
                $Entry = ($Written | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-fin-003' }
                $Entry.status | Should -Be 'accepted'
                @($Entry.final).Count | Should -Be 0
            }
        }

        It 'an unknown slug leaves the entry pending even under -FinalAdjudication (unconditional accept is not unconditional validity)' {
            $OutPath = Join-Path $TestDrive 'fin-unknown-proposals.json'
            New-AdjQueueFileWithPriorAdjudication -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"not_a_real_type","confidence":0.9}],"rationale":"bad"}'; Usage = $null }
                }
                $Result = Invoke-IssueTypeClassification -AdjudicateQueue -FinalAdjudication -AdjudicatorModel 'claude-opus-5-5' -NodeIds @('acc-fin-004') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Result.AdjudicatedStillPending | Should -Be 1
                $Entry = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-fin-004' }
                $Entry.status | Should -Be 'pending'
            }
        }

        It 'a fourth tag (>3) leaves the entry pending even under -FinalAdjudication' {
            $OutPath = Join-Path $TestDrive 'fin-fourtag-proposals.json'
            New-AdjQueueFileWithPriorAdjudication -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.9},{"type":"social","confidence":0.8},{"type":"political","confidence":0.7},{"type":"economic","confidence":0.6}],"rationale":"too many"}'; Usage = $null }
                }
                $Result = Invoke-IssueTypeClassification -AdjudicateQueue -FinalAdjudication -AdjudicatorModel 'claude-opus-5-5' -NodeIds @('acc-fin-004') -OutputPath $OutPath -WriteProposals -WarningAction SilentlyContinue
                $Result.AdjudicatedStillPending | Should -Be 1
                $Entry = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals | Where-Object { $_.node_id -eq 'acc-fin-004' }
                $Entry.status | Should -Be 'pending'
            }
        }

        It 'rejects an unregistered -AdjudicatorModel id via ValidateScript' {
            { Invoke-IssueTypeClassification -AdjudicateQueue -FinalAdjudication -AdjudicatorModel 'not-a-real-model-id' -OutputPath (Join-Path $TestDrive 'unused.json') } |
                Should -Throw
        }

        It '-CostCeiling stops the run before a second node once the running cost exceeds it (Quality condition 4, t/4920#2)' {
            $OutPath = Join-Path $TestDrive 'fin-ceiling-proposals.json'
            New-AdjQueueFileWithPriorAdjudication -Path $OutPath
            InModuleScope AITriad -Parameters @{ OutPath = $OutPath } {
                # claude-opus-5-5 is $20/1M output tokens (ai-models.json) -- 10,000 output tokens
                # on the first call alone costs $0.20, already over a $0.10 ceiling, so the second
                # target node must never be called.
                Mock Invoke-AIApi {
                    [PSCustomObject]@{ Text = '{"types":[{"type":"misuse","confidence":0.8}],"rationale":"final"}'; Usage = [PSCustomObject]@{ InputTokens = 0; OutputTokens = 10000 } }
                }
                $Result = Invoke-IssueTypeClassification -AdjudicateQueue -FinalAdjudication -AdjudicatorModel 'claude-opus-5-5' -NodeIds @('acc-fin-001', 'acc-fin-003') -OutputPath $OutPath -WriteProposals -CostCeiling 0.10 -WarningAction SilentlyContinue
                $Result.CostCeilingHit | Should -BeTrue
                $Result.ActualCost | Should -BeGreaterThan 0.10
                Should -Invoke Invoke-AIApi -Times 1 -Exactly
                $Written = (Get-Content $OutPath -Raw | ConvertFrom-Json).proposals
                ($Written | Where-Object { $_.node_id -eq 'acc-fin-001' }).status | Should -Be 'accepted'
                # Never reached -- the ceiling broke the loop before this node's call.
                ($Written | Where-Object { $_.node_id -eq 'acc-fin-003' }).status | Should -Be 'pending'
            }
        }
    }
}
