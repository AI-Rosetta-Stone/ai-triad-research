# Tag: taxonomy (t/1553 Stage 0)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Invoke-OrgPublishedSeeding — Stage 0 of the org edge-proposal pipeline (t/1553).
.DESCRIPTION
    Verifies the exact_url and domain match ladder, PROPOSED status output,
    idempotence against existing edges, and -Org / -MaxProposalsPerOrg
    filtering. Synthetic sources + mocked org / edge stores keep the tests
    fast and offline.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    # Build a scratch sources dir with three synthetic sources:
    #   src-anthropic  → https://www.anthropic.com/news/rsp   (exact_url match)
    #   src-openai     → https://openai.com/research/foo      (domain match)
    #   src-nomatch    → https://example.org/paper            (no match)
    $script:SourcesDir = Join-Path ([System.IO.Path]::GetTempPath()) "orgpub-t1553-$(Get-Random)"
    $null = New-Item -ItemType Directory -Path $script:SourcesDir -Force

    $samples = @(
        @{ id = 'src-anthropic'; url = 'https://www.anthropic.com/news/anthropics-responsible-scaling-policy' }
        @{ id = 'src-openai';    url = 'https://openai.com/research/preparedness-framework' }
        @{ id = 'src-nomatch';   url = 'https://example.org/paper.pdf' }
    )
    foreach ($s in $samples) {
        $dir = Join-Path $script:SourcesDir $s.id
        $null = New-Item -ItemType Directory -Path $dir -Force
        @{
            id = $s.id
            title = $s.id
            url = $s.url
            resolved_url = $s.url
            authors = @()
        } | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $dir 'metadata.json') -Encoding utf8NoBOM
    }
}

AfterAll {
    if ($script:SourcesDir -and (Test-Path $script:SourcesDir)) {
        Remove-Item -Recurse -Force -Path $script:SourcesDir -ErrorAction SilentlyContinue
    }
}

Describe 'Invoke-OrgPublishedSeeding (t/1553 Stage 0)' -Tag 'taxonomy' {

    BeforeEach {
        InModuleScope AITriad {
            $script:capturedProposals = [System.Collections.Generic.List[object]]::new()
            $orgs = @(
                [PSCustomObject]@{
                    id = 'org-001'; name = 'Anthropic'; type = 'corporate'
                    external_links = @(
                        [PSCustomObject]@{ type = 'website'; url = 'https://www.anthropic.com' }
                        [PSCustomObject]@{ type = 'position_paper'; url = 'https://www.anthropic.com/news/anthropics-responsible-scaling-policy' }
                    )
                }
                [PSCustomObject]@{
                    id = 'org-002'; name = 'OpenAI'; type = 'corporate'
                    external_links = @(
                        [PSCustomObject]@{ type = 'website'; url = 'https://openai.com' }
                    )
                }
            )
            Mock Get-OrganizationsStore -MockWith ({
                [PSCustomObject]@{ organizations = $orgs }
            }.GetNewClosure())
            Mock Get-OrganizationEdgesStore -MockWith {
                [PSCustomObject]@{ edges = @() }
            }
            Mock Import-OrganizationEdge -MockWith {
                param($InputObject)
                $script:capturedProposals.Add($InputObject)
            }
        }
    }

    It 'exact_url beats domain: Anthropic RSP source matched by exact_url' {
        InModuleScope AITriad -Parameters @{ Dir = $script:SourcesDir } {
            param($Dir)
            $r = Invoke-OrgPublishedSeeding -SourcesPath $Dir -Confirm:$false 3>$null

            $anthropicProposal = $script:capturedProposals | Where-Object { $_.source -eq 'org-001' -and $_.target -eq 'src-anthropic' } | Select-Object -First 1
            $anthropicProposal            | Should -Not -BeNullOrEmpty
            $anthropicProposal.type       | Should -Be 'PUBLISHED'
            $anthropicProposal.status     | Should -Be 'proposed'
            $anthropicProposal.match_meta.basis | Should -Be 'exact_url'
            $anthropicProposal.match_meta.stage | Should -Be 0
            $anthropicProposal.rationale  | Should -Match "^Published on .+'s own site \(.+\)\.$" -Because 'the rationale is a sentence, not a diagnostic (t/584)'
            $anthropicProposal.rationale  | Should -Not -Match 'match_basis'
            $anthropicProposal.source_refs | Should -Contain 'src-anthropic'
        }
    }

    It 'domain match records match_basis=domain (OpenAI preparedness)' {
        InModuleScope AITriad -Parameters @{ Dir = $script:SourcesDir } {
            param($Dir)
            $null = Invoke-OrgPublishedSeeding -SourcesPath $Dir -Confirm:$false 3>$null

            $openaiProposal = $script:capturedProposals | Where-Object { $_.source -eq 'org-002' -and $_.target -eq 'src-openai' } | Select-Object -First 1
            $openaiProposal             | Should -Not -BeNullOrEmpty
            $openaiProposal.match_meta.basis | Should -Be 'domain'
            $openaiProposal.rationale   | Should -Not -Match 'match_basis'
            $openaiProposal.status      | Should -Be 'proposed'
        }
    }

    It 'Sources with no matching org or domain produce no proposal' {
        InModuleScope AITriad -Parameters @{ Dir = $script:SourcesDir } {
            param($Dir)
            $r = Invoke-OrgPublishedSeeding -SourcesPath $Dir -Confirm:$false 3>$null

            $noMatch = $script:capturedProposals | Where-Object { $_.target -eq 'src-nomatch' }
            @($noMatch).Count            | Should -Be 0
            $r.SourcesNoMatch            | Should -BeGreaterOrEqual 1
        }
    }

    It 'All proposals land with status=proposed (never approved, per AC #5)' {
        InModuleScope AITriad -Parameters @{ Dir = $script:SourcesDir } {
            param($Dir)
            $null = Invoke-OrgPublishedSeeding -SourcesPath $Dir -Confirm:$false 3>$null
            @($script:capturedProposals | Where-Object { $_.status -ne 'proposed' }).Count | Should -Be 0
        }
    }

    It 'Skips (org, source, PUBLISHED) tuples already present in the edge store (idempotence)' {
        InModuleScope AITriad -Parameters @{ Dir = $script:SourcesDir } {
            param($Dir)
            Mock Get-OrganizationEdgesStore -MockWith {
                [PSCustomObject]@{
                    edges = @(
                        [PSCustomObject]@{ source = 'org-001'; target = 'src-anthropic'; type = 'PUBLISHED'; status = 'approved' }
                    )
                }
            }
            $r = Invoke-OrgPublishedSeeding -SourcesPath $Dir -Confirm:$false 3>$null

            @($script:capturedProposals | Where-Object { $_.target -eq 'src-anthropic' }).Count | Should -Be 0
            $r.SkippedExisting | Should -BeGreaterOrEqual 1
        }
    }

    It '-Org filter restricts to specific org(s)' {
        InModuleScope AITriad -Parameters @{ Dir = $script:SourcesDir } {
            param($Dir)
            $null = Invoke-OrgPublishedSeeding -SourcesPath $Dir -Org 'org-002' -Confirm:$false 3>$null

            @($script:capturedProposals | Where-Object { $_.source -eq 'org-001' }).Count | Should -Be 0
            @($script:capturedProposals | Where-Object { $_.source -eq 'org-002' }).Count | Should -BeGreaterOrEqual 1
        }
    }

    It '-MaxProposalsPerOrg caps proposals per org' {
        InModuleScope AITriad -Parameters @{ Dir = $script:SourcesDir } {
            param($Dir)
            # Give org-001 two matches by adding another anthropic-domain source.
            $extra = Join-Path $Dir 'src-anthropic-blog'
            $null = New-Item -ItemType Directory -Path $extra -Force
            @{ id='src-anthropic-blog'; title='blog'; url='https://www.anthropic.com/news/other'; resolved_url='https://www.anthropic.com/news/other'; authors=@() } |
                ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $extra 'metadata.json') -Encoding utf8NoBOM

            try {
                $null = Invoke-OrgPublishedSeeding -SourcesPath $Dir -MaxProposalsPerOrg 1 -Confirm:$false 3>$null
                @($script:capturedProposals | Where-Object { $_.source -eq 'org-001' }).Count | Should -Be 1
            } finally {
                Remove-Item -Recurse -Force $extra -ErrorAction SilentlyContinue
            }
        }
    }
}

Describe 'ConvertTo-EdgeSeedUrl normalization (t/1553)' -Tag 'taxonomy' {

    It 'Strips www. from host and trailing slash from url' {
        InModuleScope AITriad {
            $u = ConvertTo-EdgeSeedUrl -Url 'https://www.anthropic.com/news/rsp/'
            $u.Host | Should -Be 'anthropic.com'
            $u.Url  | Should -Be 'https://www.anthropic.com/news/rsp'
        }
    }

    It 'Handles malformed URLs without throwing' {
        InModuleScope AITriad {
            $u = ConvertTo-EdgeSeedUrl -Url 'not a url'
            $u.Host | Should -BeNullOrEmpty
        }
    }
}
