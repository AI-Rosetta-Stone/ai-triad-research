# Tag: entities (t/4404)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# Per-entity source attribution (design v2, t/4404#6; CL decisions t/4404#8). An entity's source_refs are the docs
# whose facts hold its stored quote, plus listed docs whose snapshot names it; never a node's whole batch list.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:Snaps = @{
        'doc-ibm'   = 'In 2024 IBM acquired HashiCorp for $6.4 billion, folding Terraform into its cloud unit.'
        'doc-hc'    = 'HashiCorp released a new Terraform licence this year.'
        'doc-other' = 'An unrelated report on chip export controls.'
        'doc-hashi' = 'The Hashi family of tools is popular.'
        'doc-okeefe' = "A profile of Georgia O$([char]0x2019)Keefe and her later work."
        'doc-loose' = 'Policies for open model weights release were debated at length.'
    }
    function script:Attr([string[]]$Names, [string[]]$Quotes, [object[]]$Facts, [string[]]$Docs, [hashtable]$Summaries = @{}) {
        $snaps = $script:Snaps
        InModuleScope AITriad -Parameters @{ N = $Names; Q = $Quotes; F = $Facts; D = $Docs; S = $snaps; M = $Summaries } {
            param($N, $Q, $F, $D, $S, $M)
            Get-EntitySourceAttribution -Names $N -Quotes $Q -Facts $F -CandidateDocs $D `
                -GetSnapshotText { param($id) $S[$id] }.GetNewClosure() -GetSummaryText { param($id) $M[$id] }.GetNewClosure()
        }
    }
}

AfterAll { Remove-Module AITriad -Force -ErrorAction SilentlyContinue }

Describe 'Get-EntitySourceAttribution (t/4404)' -Tag 'entities' {
    It 'attributes the doc whose fact holds the stored quote, even when the doc never names the entity (ent-040 shape)' {
        $r = Attr -Names @('IBM acquisition of HashiCorp') -Quotes @('IBM acquired HashiCorp for $6.4 billion') `
            -Facts @(@{ doc_id = 'doc-ibm'; claim = 'In 2024 IBM acquired HashiCorp for $6.4 billion.' }, @{ doc_id = 'doc-other'; claim = 'Chip export controls tightened.' }) `
            -Docs @('doc-ibm', 'doc-other')
        @($r.source_refs) | Should -Be @('doc-ibm')
        $r.source_refs_basis['doc-ibm'] | Should -BeExactly 'quote-attributed'
        $r.source_refs_status | Should -BeExactly 'attributed'
    }

    It 'adds listed docs whose snapshot names the entity (strict whole words), quote docs first' {
        $r = Attr -Names @('HashiCorp') -Quotes @('IBM acquired HashiCorp for $6.4 billion') `
            -Facts @(@{ doc_id = 'doc-ibm'; claim = 'IBM acquired HashiCorp for $6.4 billion.' }) -Docs @('doc-other', 'doc-hc', 'doc-ibm', 'doc-hashi')
        @($r.source_refs) | Should -Be @('doc-ibm', 'doc-hc')
        $r.source_refs_basis['doc-hc'] | Should -BeExactly 'mention-verified'
        $r.source_refs_basis.Contains('doc-hashi') | Should -BeFalse -Because '"Hashi" is not the whole word "HashiCorp"'
    }

    It 'never adds a doc from outside the current list' {
        $r = Attr -Names @('HashiCorp') -Quotes @('IBM acquired HashiCorp') -Facts @(@{ doc_id = 'doc-ibm'; claim = 'IBM acquired HashiCorp.' }) -Docs @('doc-hc')
        @($r.source_refs) | Should -Be @('doc-hc')
    }

    It 'matches across typography (spec 7.2 key: curly apostrophe vs straight)' {
        $r = Attr -Names @("Georgia O'Keefe") -Quotes @() -Facts @() -Docs @('doc-okeefe')
        @($r.source_refs) | Should -Be @('doc-okeefe')
    }

    It 'uses the recall steps only when quote and mention found nothing' {
        $loose = Attr -Names @('open model weights release policy') -Quotes @() -Facts @() -Docs @('doc-loose', 'doc-other')
        @($loose.source_refs) | Should -Be @('doc-loose')
        $loose.source_refs_basis['doc-loose'] | Should -BeExactly 'mention-verified-loose'

        $summ = Attr -Names @('Frontier Model Forum') -Quotes @() -Facts @() -Docs @('doc-other') -Summaries @{ 'doc-other' = 'The Frontier Model Forum published guidance.' }
        $summ.source_refs_basis['doc-other'] | Should -BeExactly 'summary-mention'

        $both = Attr -Names @('HashiCorp', 'open model weights release policy') -Quotes @() -Facts @() -Docs @('doc-hc', 'doc-loose')
        @($both.source_refs) | Should -Be @('doc-hc') -Because 'a strict mention exists, so the loose step does not run'
    }

    It 'never attributes on a sub-word match, in either direction (CL fix 1)' {
        # Reverse: a short claim key "ai" must not match inside the quote word "said".
        $r = Attr -Names @('Nobody') -Quotes @('he said the model was ready') -Facts @(@{ doc_id = 'doc-other'; claim = 'AI' }) -Docs @('doc-other')
        @($r.source_refs).Count | Should -Be 0
        # Forward: a quote key "ai" must not match inside the claim word "said".
        $r2 = Attr -Names @('Nobody') -Quotes @('AI') -Facts @(@{ doc_id = 'doc-other'; claim = 'He said the model was ready.' }) -Docs @('doc-other')
        @($r2.source_refs).Count | Should -Be 0
        # Reverse with a long enough claim still attributes.
        $r3 = Attr -Names @('Nobody') -Quotes @('Officials said the new chip export rules take effect in May.') `
            -Facts @(@{ doc_id = 'doc-other'; claim = 'the new chip export rules' }) -Docs @('doc-other')
        @($r3.source_refs) | Should -Be @('doc-other')
    }

    It 'loose step: needs 2+ content tokens over 3 characters (CL fix 2: ent-043 "AI+ plan", "The Guardian")' {
        $script:Snaps['doc-plan'] = 'The White House released its AI Action Plan in July.'
        $script:Snaps['doc-guard'] = 'Reporting by the guardian of the archive, not the newspaper.'
        $plan = Attr -Names @('AI+ plan') -Quotes @() -Facts @() -Docs @('doc-plan')
        $plan.source_refs_status | Should -BeExactly 'none-matched' -Because '"AI+ plan" has one content token over 3 characters'
        $guard = Attr -Names @('Morning Guardian') -Quotes @() -Facts @() -Docs @('doc-guard')
        $guard.source_refs_status | Should -BeExactly 'none-matched' -Because '"morning" is absent, and a single content token never loose-matches'
        $one = Attr -Names @('The Guardian') -Quotes @() -Facts @() -Docs @('doc-guard')
        $one.source_refs_basis.Contains('doc-guard') | Should -BeTrue -Because 'the strict whole-word match still finds "the guardian"; only the loose step requires 2 tokens'
        $one.source_refs_basis['doc-guard'] | Should -BeExactly 'mention-verified'
    }

    It 'loose step: singular and plural match both ways (CL fix 3)' {
        $script:Snaps['doc-rel1'] = 'Several model releases were delayed by the new export rule.'
        $script:Snaps['doc-rel2'] = 'The model release was delayed by the new export rules.'
        # Singular name, plural text; then plural name, singular text. Strict fails both ways, so only the loose
        # step can match, and it must.
        (Attr -Names @('model release') -Quotes @() -Facts @() -Docs @('doc-rel1')).source_refs_basis['doc-rel1'] | Should -BeExactly 'mention-verified-loose'
        (Attr -Names @('model releases') -Quotes @() -Facts @() -Docs @('doc-rel2')).source_refs_basis['doc-rel2'] | Should -BeExactly 'mention-verified-loose'
    }

    It 'returns none-matched with an empty list when nothing holds the quote or names the entity' {
        $r = Attr -Names @('Quantum Entanglement Treaty') -Quotes @('a treaty on entanglement') -Facts @(@{ doc_id = 'doc-other'; claim = 'Chip export controls.' }) -Docs @('doc-other', 'doc-hc')
        @($r.source_refs).Count | Should -Be 0
        $r.source_refs_status | Should -BeExactly 'none-matched'
    }
}

Describe 'Get-EntityReport: none-matched is its own category (t/4404)' -Tag 'entities' {
    It 'reports a none-matched entity under NoneMatched, not as a provenance orphan' {
        $p = Join-Path $TestDrive 'entities.json'
        @{ entities = @(
                @{ id = 'ent-001'; name = 'Checked and empty'; entity_type = 'event'; aliases = @(); source_refs = @(); source_refs_status = 'none-matched'; status = 'proposed' }
                @{ id = 'ent-002'; name = 'Never computed'; entity_type = 'event'; aliases = @(); source_refs = @(); status = 'proposed' }
                @{ id = 'ent-003'; name = 'Attributed'; entity_type = 'event'; aliases = @(); source_refs = @('doc-1'); source_refs_status = 'attributed'; status = 'proposed' }
            ) } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $p -Encoding utf8NoBOM
        $r = Get-EntityReport -Report all -EntitiesPath $p -EmbeddingsPath (Join-Path $TestDrive 'none.json') -DictionaryRoot (Join-Path $TestDrive 'dict') -WarningAction SilentlyContinue 6>$null
        @($r.ProvenanceOrphan.Entities.Id) | Should -Be @('ent-002')
        @($r.NoneMatched.Entities.Id) | Should -Be @('ent-001')
    }
}

Describe 'Mint attributes source_refs instead of the batch doc list (t/4404)' -Tag 'entities' {
    It 'passes attributed source_refs, basis and status to Import-Entity' {
        $src = Join-Path $TestDrive 'sources'
        foreach ($d in 'doc-ibm', 'doc-hc', 'doc-other') {
            New-Item -ItemType Directory -Path (Join-Path $src $d) -Force | Out-Null
            Set-Content -LiteralPath (Join-Path $src $d 'snapshot.md') -Value $script:Snaps[$d] -Encoding utf8NoBOM
        }
        InModuleScope AITriad -Parameters @{ Src = $src } {
            param($Src)
            Mock Get-SourcesDir { $Src }
            Mock Get-SummariesDir { Join-Path $Src 'no-summaries' }
            $script:Captured = $null
            Mock Import-Entity { $script:Captured = @($Proposal); @($Proposal | ForEach-Object { [pscustomobject]@{ Id = 'ent-900' } }) }
            $set = [System.Collections.Generic.HashSet[string]]::new([string[]]@('doc-ibm', 'doc-hc', 'doc-other'), [StringComparer]::OrdinalIgnoreCase)
            $cand = [pscustomobject]@{
                Name = 'HashiCorp'; EntityType = 'organization'; Dolce = 'SocialObject'; Aliases = @(); Confidence = 0.9; Model = 'm'
                DocIdSet = $set; Quotes = [System.Collections.Generic.List[string]]::new([string[]]@('IBM acquired HashiCorp for $6.4 billion'))
                Facts = [System.Collections.Generic.List[object]]::new([object[]]@(@{ doc_id = 'doc-ibm'; claim = 'IBM acquired HashiCorp for $6.4 billion.' }))
                MintedId = $null
            }
            Invoke-EntityCandidateMint -MintCandidates ([System.Collections.Generic.List[PSObject]]@($cand)) -UsageId 'u' -EntPath 'x' -EmbPath 'y'
            @($script:Captured[0].source_refs) | Should -Be @('doc-ibm', 'doc-hc') -Because 'doc-other is in the batch list but neither holds the quote nor names the entity'
            $script:Captured[0].source_refs_basis['doc-ibm'] | Should -BeExactly 'quote-attributed'
            $script:Captured[0].source_refs_status | Should -BeExactly 'attributed'
            $cand.MintedId | Should -BeExactly 'ent-900'
        }
    }

    It 'reaches the summary-mention step through the real readers (module functions, not closures)' {
        $src = Join-Path $TestDrive 'sources2'; $sum = Join-Path $TestDrive 'summaries2'
        New-Item -ItemType Directory -Path (Join-Path $src 'doc-s'), $sum -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $src 'doc-s' 'snapshot.md') -Value 'A report with no mention of the body.' -Encoding utf8NoBOM
        @{ factual_claims = @(@{ claim = 'The Frontier Model Forum issued guidance.' }) } | ConvertTo-Json -Depth 5 |
            Set-Content -LiteralPath (Join-Path $sum 'doc-s.json') -Encoding utf8NoBOM
        InModuleScope AITriad -Parameters @{ Src = $src; Sum = $sum } {
            param($Src, $Sum)
            Mock Get-SourcesDir { $Src }
            Mock Get-SummariesDir { $Sum }
            $script:Captured = $null
            Mock Import-Entity { $script:Captured = @($Proposal); @($Proposal | ForEach-Object { [pscustomobject]@{ Id = 'ent-901' } }) }
            $cand = [pscustomobject]@{
                Name = 'Frontier Model Forum'; EntityType = 'organization'; Dolce = 'SocialObject'; Aliases = @(); Confidence = 0.9; Model = 'm'
                DocIdSet = [System.Collections.Generic.HashSet[string]]::new([string[]]@('doc-s'), [StringComparer]::OrdinalIgnoreCase)
                Quotes = [System.Collections.Generic.List[string]]::new(); Facts = [System.Collections.Generic.List[object]]::new(); MintedId = $null
            }
            Invoke-EntityCandidateMint -MintCandidates ([System.Collections.Generic.List[PSObject]]@($cand)) -UsageId 'u' -EntPath 'x' -EmbPath 'y'
            $script:Captured[0].source_refs_basis['doc-s'] | Should -BeExactly 'summary-mention'
        }
    }
}
