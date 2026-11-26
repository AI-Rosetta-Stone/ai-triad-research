# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    The plain-language rationale and the match_meta object of pipeline-written organization edges (t/584).
.DESCRIPTION
    Pins the wording agreed by Comp-Linguist and Design (t/584#8), character for character. A change to
    one of these strings is a change to what researchers read and needs their review.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:Rationale = { param([hashtable]$A) InModuleScope AITriad -Parameters @{ A = $A } { param($A) New-OrgEdgeRationale @A } }
    $script:L = [string][char]0x201C; $script:R = [string][char]0x201D
}

Describe 'New-OrgEdgeRationale: the agreed wording (t/584#8)' -Tag 'organizations' {

    It "quotes the org's own words under 'states', with the document title" {
        & $script:Rationale @{ Kind = 'Matched'; OrgName = 'NIST'; ClaimText = 'Playbook suggestions are voluntary.'; DocumentTitle = 'AI RMF Playbook'; DocumentId = 'ai-rmf-playbook-2026-2' } |
            Should -BeExactly "NIST states: $($script:L)Playbook suggestions are voluntary.$($script:R) (AI RMF Playbook)."
    }

    It 'puts the direction in the sentence for OPPOSES' {
        & $script:Rationale @{ Kind = 'Matched'; OrgName = 'OpenAI'; ClaimText = 'The risk should be plausible.'; DocumentTitle = 'Preparedness Framework'; EdgeType = 'OPPOSES' } |
            Should -BeExactly "OpenAI states, in opposition: $($script:L)The risk should be plausible.$($script:R) (Preparedness Framework)."
    }

    It 'a paraphrase is never in quotation marks and says it is not the org''s words' {
        $Got = & $script:Rationale @{ Kind = 'Matched'; OrgName = 'NIST'; Proposition = 'Evaluators ought to adopt statistical models.'; DocumentTitle = 'NIST AI 800-3' }
        $Got | Should -BeExactly "Matched claim (paraphrase, not the org's words): Evaluators ought to adopt statistical models. (NIST AI 800-3)."
        $Got | Should -Not -Match "[$($script:L)$($script:R)`"]"
        $Got | Should -Not -Match 'states'
    }

    It 'a paraphrase under OPPOSES says it opposes' {
        & $script:Rationale @{ Kind = 'Matched'; OrgName = 'NIST'; Proposition = 'P.'; DocumentTitle = 'D'; EdgeType = 'OPPOSES' } |
            Should -BeExactly "Matched opposing claim (paraphrase, not the org's words): P. (D)."
    }

    It "a claim from a document the org did not publish is not attributed to the org" {
        $Got = & $script:Rationale @{ Kind = 'Matched'; OrgName = 'NIST'; ClaimText = 'NIST will lead evaluations.'; DocumentTitle = 'A third-party paper'; OwnDocument = $false }
        $Got | Should -BeExactly "Matched claim from A third-party paper (not the org's own statement): $($script:L)NIST will lead evaluations.$($script:R)."
        $Got | Should -Not -Match 'NIST states'
    }

    It 'names the document by its id only when it has no title' {
        & $script:Rationale @{ Kind = 'Matched'; OrgName = 'NIST'; ClaimText = 'X.'; DocumentId = 'doc-2026' } | Should -BeExactly "NIST states: $($script:L)X.$($script:R) (doc-2026)."
        & $script:Rationale @{ Kind = 'Matched'; OrgName = 'NIST'; ClaimText = 'X.'; DocumentTitle = '  '; DocumentId = 'doc-2026' } | Should -Match '\(doc-2026\)\.$'
    }

    It 'never cuts the quoted text' {
        $Long = ('A very long claim sentence about evaluation. ' * 40).Trim()
        (& $script:Rationale @{ Kind = 'Matched'; OrgName = 'NIST'; ClaimText = $Long; DocumentTitle = 'D' }).Contains($Long) | Should -BeTrue
    }

    It 'domain seeding stores a status-neutral sentence: what the pipeline saw, no claim of publication' {
        & $script:Rationale @{ Kind = 'SiteListed'; OrgName = 'Electronic Frontier Foundation'; SiteHost = 'en.wikipedia.org' } |
            Should -BeExactly "The document is on en.wikipedia.org, one of the sites listed in Electronic Frontier Foundation's links."
    }

    It 'an approved PUBLISHED edge on the org''s own domain names the site' {
        & $script:Rationale @{ Kind = 'Published'; OrgName = 'RAND'; SiteHost = 'rand.org' } | Should -BeExactly "Published on RAND's own site (rand.org)."
    }

    It 'an edge whose claim was withdrawn says so' {
        & $script:Rationale @{ Kind = 'Withdrawn' } | Should -BeExactly 'Proposed by automated claim matching; the supporting claim was later withdrawn.'
    }

    # The three rejected forms (t/680; table on t/584#20). The expected strings are the ones stored on
    # ai-triad-data main by the t/584 write (PR #89).
    It 'a rejected edge with no recorded reason says where the document is' {
        & $script:Rationale @{ Kind = 'Rejected'; OrgName = 'Electronic Frontier Foundation'; SiteHost = 'en.wikipedia.org' } |
            Should -BeExactly "Rejected: the document is on en.wikipedia.org, one of the sites listed in Electronic Frontier Foundation's links."
    }

    It 'a rejected edge quotes the reviewer''s note whole, as recorded' {
        & $script:Rationale @{ Kind = 'Rejected'; OrgName = 'Electronic Frontier Foundation'; SiteHost = 'en.wikipedia.org'; ReviewNote = 'This should be Org-005' } |
            Should -BeExactly "Rejected: the document is on en.wikipedia.org, one of the sites listed in Electronic Frontier Foundation's links. Reviewer's note: $($script:L)This should be Org-005$($script:R)"
    }

    It 'a rejected marked copy names the canonical document and needs no site or organization' {
        & $script:Rationale @{ Kind = 'Rejected'; CanonicalTitle = 'AI RMF Playbook' } |
            Should -BeExactly 'Rejected: the document is a marked copy of AI RMF Playbook. It is not shown as a publisher of its own.'
    }

    It 'a rejected edge with neither a site nor a canonical document is refused' {
        { & $script:Rationale @{ Kind = 'Rejected'; OrgName = 'RAND' } } | Should -Throw -ExpectedMessage '*site host nor a canonical document*'
        { & $script:Rationale @{ Kind = 'Rejected'; SiteHost = 'rand.org' } } | Should -Throw -ExpectedMessage '*organization name*'
    }

    It 'no rationale is a pipeline diagnostic' {
        foreach ($A in @{ Kind = 'Matched'; OrgName = 'NIST'; ClaimText = 'X.'; DocumentTitle = 'D' }, @{ Kind = 'Published'; OrgName = 'RAND'; SiteHost = 'rand.org' }, @{ Kind = 'Withdrawn' }) {
            & $script:Rationale $A | Should -Not -Match 'match_basis|best_cosine|nli_|families='
        }
    }

    It 'refuses with an actionable error when a needed value is missing' {
        { & $script:Rationale @{ Kind = 'Matched'; OrgName = 'NIST'; DocumentTitle = 'D' } } | Should -Throw -ExpectedMessage '*claim text nor a canonical proposition*'
        { & $script:Rationale @{ Kind = 'Matched'; ClaimText = 'X.'; DocumentTitle = 'D' } } | Should -Throw -ExpectedMessage '*organization name*'
        { & $script:Rationale @{ Kind = 'Published'; OrgName = 'RAND' } } | Should -Throw -ExpectedMessage '*site host*'
    }
}

Describe 'New-OrgEdgeMatchMeta (t/584)' -Tag 'organizations' {

    It 'holds the diagnostics the rationale used to hold, in a fixed key order' {
        $M = InModuleScope AITriad { New-OrgEdgeMatchMeta -Stage 3 -Basis 'high-cosine' -Families 1 -BestCosine 0.65749 -ClaimSourceId 'doc-2026' -ClaimText 'X.' -NliDirection 'opposes' -NliMargin 5.17541 -DirectionalFlip 'ADVOCATES_FOR->OPPOSES' -Endorsement 'none' }
        @($M.Keys) | Should -Be @('stage', 'basis', 'families', 'best_cosine', 'claim_source_id', 'claim_text_sha256', 'nli_direction', 'nli_margin', 'directional_flip', 'endorsement')
        $M.best_cosine | Should -Be 0.657
        $M.nli_margin | Should -Be 5.1754
        $M.claim_text_sha256 | Should -Match '^[0-9a-f]{64}$'
    }

    It 'writes only what was given' {
        $M = InModuleScope AITriad { New-OrgEdgeMatchMeta -Stage 0 -Basis 'domain' }
        @($M.Keys) | Should -Be @('stage', 'basis')
    }
}
