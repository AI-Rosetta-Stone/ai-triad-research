# Tag: taxonomy (t/1553 Stages 2+3)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Invoke-OrgClaimMatching — Stages 2+3 of t/1553.
.DESCRIPTION
    Focus: the family-independence rule (t/1553#12), the two-part gate
    (multi-agreement OR high-cosine), polarity→edge-type mapping,
    per-org cap accounting, negation-slice reporting (t/1553#18), and
    the existing-edge skip. The python subprocess for batch-encode is
    stubbed via a function shadow that echoes canned unit vectors keyed
    to the claim's index — the test controls cosine outcomes by choosing
    which unit vector each claim gets versus which unit vector each node
    gets. Live embed_taxonomy.py path was smoke-verified against the
    real corpus (81 claims → 29 dry-run proposals) before this suite
    landed.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue

    # Two orthogonal 384-d unit vectors — dot product = 1 (identical) or 0
    # (orthogonal). Ensures we can drive cosine deterministically.
    $script:dim = 384
    $script:vecA = @(0) * $script:dim; $script:vecA[0] = 1.0
    $script:vecB = @(0) * $script:dim; $script:vecB[1] = 1.0
    # Diagonal mid-vector — dot with vecA is 0.7071 (below 0.60 gate? no,
    # above), dot with a rotated-close vector we craft below.
    $script:vecC = @(0) * $script:dim; $script:vecC[0] = 0.5; $script:vecC[1] = 0.5
    $script:vecCn = @($script:vecC | ForEach-Object { $_ / [math]::Sqrt(0.5) })  # unit-norm
}

Describe 'Invoke-OrgClaimMatching (t/1553 Stages 2+3)' -Tag 'taxonomy' {

    BeforeEach {
        $script:workDir = Join-Path ([System.IO.Path]::GetTempPath()) "orgmatch-t1553-$(Get-Random)"
        $null = New-Item -ItemType Directory -Path $script:workDir -Force
        $script:claimsPath     = Join-Path $script:workDir 'claims.json'
        $script:embeddingsPath = Join-Path $script:workDir 'embeddings.json'

        # Synthetic embeddings for nodes: node-1 gets vecA, node-2 gets vecB,
        # node-3 gets vecC-normalized. Everything else in the file is
        # non-pov-taxonomy junk to prove the id-filter works.
        $embStore = [ordered]@{
            metadata = @{ dim = $script:dim; note = 'test-fixture' }
            nodes = [ordered]@{
                'acc-beliefs-001'    = @{ pov = 'acc'; vector = $script:vecA }
                'saf-desires-002'    = @{ pov = 'saf'; vector = $script:vecB }
                # No node at VecCn — the family tests feed VecCn as the claim
                # so cosine with any node caps at 1/sqrt(2)=0.7071 (below the
                # 0.75 test threshold), letting us isolate the multi-agreement
                # gate from the high-cosine gate.
                'skp-intentions-003' = @{ pov = 'skp'; vector = $script:vecA }
                'pol-999'            = @{ vector = $script:vecA }   # ignored: not a POV node id
                'sit-100'            = @{ vector = $script:vecA }   # ignored: not a POV node id
            }
        }
        $embStore | ConvertTo-Json -Depth 6 | Set-Content -Path $script:embeddingsPath -Encoding utf8NoBOM
    }

    AfterEach {
        if ($script:workDir -and (Test-Path $script:workDir)) {
            Remove-Item -Recurse -Force $script:workDir -ErrorAction SilentlyContinue
        }
    }

    Context 'Family-independence rule (t/1553#12)' {

        It 'Two variants of the same doc (rmf-1.0-2024 vs rmf-1.0-2024-1) collapse to ONE family — sub-threshold cosine, so no proposal without multi-agreement' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:embeddingsPath
                VecA       = [double[]]$script:vecA
                VecC       = [double[]]$script:vecCn
            } {
                param($ClaimsPath, $EmbPath, $VecA, $VecC)

                # Two claims from the same doc family, both point at acc-beliefs-001,
                # both sub-threshold cosine (0.7071 < the 0.75 test threshold).
                $claims = @(
                    [PSCustomObject]@{
                        org_id = 'org-014'; source_id = 'rmf-1.0-2024'
                        polarity = 'asserts'; canonical_proposition = 'p0'
                        extraction_confidence = 0.9
                    }
                    [PSCustomObject]@{
                        org_id = 'org-014'; source_id = 'rmf-1.0-2024-1'
                        polarity = 'asserts'; canonical_proposition = 'p1'
                        extraction_confidence = 0.9
                    }
                )
                @{ claims = $claims } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                # Shadow python + Get-OrganizationEdgesStore.
                $vecCref = $VecC
                function python {
                    process {
                        $payload = $input | Out-String | ConvertFrom-Json
                        $out = [ordered]@{}
                        foreach ($item in $payload) { $out[$item.id] = $vecCref }
                        $out | ConvertTo-Json -Depth 5 -Compress
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.75 -MinAgreement 2 -SkipDirectionalGate -SkipEndorsementGate -Verbose:$false 6>$null

                $r.ClaimsProcessed    | Should -Be 2
                $r.ProposalsWouldEmit | Should -Be 0 -Because 'both claims collapse to family "rmf-1.0" — only 1 independent family, so multi-agreement fails; and cosine 0.7071 < threshold 0.75'
            }
        }

        It 'Two DIFFERENT doc families with matching (node, polarity) DO propose under multi-agreement, even sub-threshold' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:embeddingsPath
                VecC       = [double[]]$script:vecCn
            } {
                param($ClaimsPath, $EmbPath, $VecC)

                $claims = @(
                    [PSCustomObject]@{
                        org_id = 'org-014'; source_id = 'rmf-1.0-2024'
                        polarity = 'asserts'; canonical_proposition = 'p0'; extraction_confidence = 0.9
                    }
                    [PSCustomObject]@{
                        org_id = 'org-014'; source_id = 'ai-usages-2023'
                        polarity = 'asserts'; canonical_proposition = 'p1'; extraction_confidence = 0.9
                    }
                )
                @{ claims = $claims } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $vecCref = $VecC
                function python {
                    process {
                        $payload = $input | Out-String | ConvertFrom-Json
                        $out = [ordered]@{}
                        foreach ($item in $payload) { $out[$item.id] = $vecCref }
                        $out | ConvertTo-Json -Depth 5 -Compress
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.75 -MinAgreement 2 -SkipDirectionalGate -SkipEndorsementGate -Verbose:$false 6>$null

                $r.ProposalsWouldEmit           | Should -Be 1
                $r.Proposals[0].Reason          | Should -Be 'multi-claim-agreement'
                $r.Proposals[0].Independent     | Should -Be 2 -Because 'rmf-1.0 and ai-usages are distinct families'
                $r.Proposals[0].EdgeType        | Should -Be 'ADVOCATES_FOR'
            }
        }
    }

    Context 'Gate rule: single-claim high-cosine floor' {

        It 'One claim above -MatchThreshold produces one proposal — high-cosine rule' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:embeddingsPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                $claims = @(
                    [PSCustomObject]@{
                        org_id = 'org-002'; source_id = 'src-x'
                        polarity = 'opposes'; canonical_proposition = 'p0'; extraction_confidence = 0.8
                    }
                )
                @{ claims = $claims } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $vecAref = $VecA
                function python {
                    process {
                        $payload = $input | Out-String | ConvertFrom-Json
                        $out = [ordered]@{}
                        foreach ($item in $payload) { $out[$item.id] = $vecAref }
                        $out | ConvertTo-Json -Depth 5 -Compress
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -SkipDirectionalGate -SkipEndorsementGate -Verbose:$false 6>$null

                $r.ProposalsWouldEmit    | Should -Be 1
                $r.Proposals[0].Reason   | Should -Match 'high-cosine'
                $r.Proposals[0].EdgeType | Should -Be 'OPPOSES' -Because 'polarity=opposes → OPPOSES'
                $r.Proposals[0].NodeId   | Should -Be 'acc-beliefs-001' -Because 'vecA lives at acc-beliefs-001'
                $r.Proposals[0].BestCosine | Should -BeGreaterOrEqual 0.99
            }
        }
    }

    Context 'Existing-edge skip' {

        It 'Skips (org, node, type) tuples that already exist in any status unless -Force' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:embeddingsPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                $claims = @(
                    [PSCustomObject]@{
                        org_id = 'org-014'; source_id = 'src-x'
                        polarity = 'asserts'; canonical_proposition = 'p0'; extraction_confidence = 0.9
                    }
                )
                @{ claims = $claims } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $vecAref = $VecA
                function python {
                    process {
                        $payload = $input | Out-String | ConvertFrom-Json
                        $out = [ordered]@{}
                        foreach ($item in $payload) { $out[$item.id] = $vecAref }
                        $out | ConvertTo-Json -Depth 5 -Compress
                    }
                }
                Mock Get-OrganizationEdgesStore {
                    [PSCustomObject]@{ edges = @(
                        [PSCustomObject]@{ source='org-014'; target='acc-beliefs-001'; type='ADVOCATES_FOR'; status='proposed' }
                    )}
                }

                # Default: skipped
                $r1 = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -SkipDirectionalGate -SkipEndorsementGate -Verbose:$false 6>$null
                $r1.ProposalsWouldEmit | Should -Be 0 -Because 'tuple already exists — default skip'

                # -Force: emitted
                $r2 = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Force -SkipDirectionalGate -SkipEndorsementGate -Verbose:$false 6>$null
                $r2.ProposalsWouldEmit | Should -Be 1 -Because '-Force overrides the skip'
            }
        }
    }

    Context 'Negation-slice (t/1553#18)' {

        It 'Every claim with a negated-deontic or oppose-lexicon token lands in .NegationSlice regardless of polarity' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:embeddingsPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                $claims = @(
                    [PSCustomObject]@{
                        org_id='org-x'; source_id='src-1'
                        polarity='asserts'
                        canonical_proposition='Foreign governments ought not to impose regulations'
                        extraction_confidence=0.9
                    }
                    [PSCustomObject]@{
                        org_id='org-x'; source_id='src-2'
                        polarity='asserts'
                        canonical_proposition='CAISI ought to oppose implementation of foreign regulations'
                        extraction_confidence=0.9
                    }
                    [PSCustomObject]@{
                        org_id='org-x'; source_id='src-3'
                        polarity='asserts'
                        canonical_proposition='Mandatory pre-deployment safety evaluations should be required'
                        extraction_confidence=0.9
                    }
                )
                @{ claims = $claims } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $vecAref = $VecA
                function python {
                    process {
                        $payload = $input | Out-String | ConvertFrom-Json
                        $out = [ordered]@{}
                        foreach ($item in $payload) { $out[$item.id] = $vecAref }
                        $out | ConvertTo-Json -Depth 5 -Compress
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -SkipDirectionalGate -SkipEndorsementGate -Verbose:$false 6>$null

                @($r.NegationSlice).Count | Should -Be 2 -Because 'the two negation/oppose-lexicon claims land in the slice; the clean "should be required" one does not'
                ($r.NegationSlice.Proposition -join '|') | Should -Match 'ought not to impose'
                ($r.NegationSlice.Proposition -join '|') | Should -Match 'oppose implementation'
                ($r.NegationSlice.Proposition -join '|') | Should -Not -Match 'pre-deployment'
            }
        }
    }

    Context 'Per-org cap' {

        It 'Respects -PerOrgCap and reports the drop count' {
            # Override the default embeddings fixture: this test needs 3
            # distinct-argmax nodes to produce 3 buckets, so we put a real
            # VecC node in place of the family-tests' placeholder.
            $capEmbPath = Join-Path $script:workDir 'embeddings-captest.json'
            @{
                metadata = @{ dim = $script:dim }
                nodes = [ordered]@{
                    'acc-beliefs-001'    = @{ vector = $script:vecA }
                    'saf-desires-002'    = @{ vector = $script:vecB }
                    'skp-intentions-003' = @{ vector = $script:vecCn }
                }
            } | ConvertTo-Json -Depth 6 | Set-Content -Path $capEmbPath -Encoding utf8NoBOM

            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $capEmbPath
                VecA       = [double[]]$script:vecA
                VecB       = [double[]]$script:vecB
                VecC       = [double[]]$script:vecCn
            } {
                param($ClaimsPath, $EmbPath, $VecA, $VecB, $VecC)

                # 3 claims → 3 (org, node, polarity) buckets, all above threshold.
                $claims = @(
                    [PSCustomObject]@{ org_id='org-014'; source_id='s1'; polarity='asserts'; canonical_proposition='p1'; extraction_confidence=0.9 }
                    [PSCustomObject]@{ org_id='org-014'; source_id='s2'; polarity='asserts'; canonical_proposition='p2'; extraction_confidence=0.9 }
                    [PSCustomObject]@{ org_id='org-014'; source_id='s3'; polarity='asserts'; canonical_proposition='p3'; extraction_confidence=0.9 }
                )
                @{ claims = $claims } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                # Route each claim to a different node's vector by keying on index
                # (embed_taxonomy.py's real batch-encode does this via the id).
                $vA = $VecA; $vB = $VecB; $vC = $VecC
                function python {
                    process {
                        $payload = $input | Out-String | ConvertFrom-Json
                        $out = [ordered]@{}
                        for ($i = 0; $i -lt $payload.Count; $i++) {
                            $vec = switch ($i) { 0 { $vA } 1 { $vB } 2 { $vC } }
                            $out[$payload[$i].id] = $vec
                        }
                        $out | ConvertTo-Json -Depth 5 -Compress
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -PerOrgCap 2 -SkipDirectionalGate -SkipEndorsementGate -Verbose:$false 6>$null

                $r.ProposalsWouldEmit | Should -Be 2 -Because '3 candidates → PerOrgCap 2 keeps top 2 by cosine'
                @($r.DroppedByCap).Count | Should -Be 1
            }
        }
    }

    Context 'Directional gate (t/2745 V1, shared engine t/2751) — opposition-only' {

        # A single-claim proposal that lands (cosine argmax) on a node whose
        # proposition the claim NEGATES. The claim vector == node vector (an
        # inversion is topically identical), so the embedding gate greens it; only
        # the NLI direction distinguishes assert-P from assert-¬P. The python
        # shadow serves BOTH callees: embed_taxonomy batch-encode (items carry
        # .text → returns vectors) and the nli_classify engine (items carry
        # .claim_prop → returns [{id,direction,...}]).
        BeforeEach {
            $script:invEmbPath = Join-Path $script:workDir 'embeddings-inv.json'
            @{
                metadata = @{ dim = $script:dim }
                nodes = [ordered]@{ 'acc-intentions-999' = @{ pov = 'acc'; vector = $script:vecA } }
            } | ConvertTo-Json -Depth 6 | Set-Content -Path $script:invEmbPath -Encoding utf8NoBOM
        }

        It 'INVERSION ARM: opposes flips the provisional ADVOCATES_FOR to OPPOSES (edge kept, not dropped)' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:invEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-014'; source_id='src-inv'; polarity='asserts'
                        canonical_proposition='Ordinary privacy law already applies to AI; no new legal regime is needed'
                        extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $script:TaxonomyData['invtest-pov'] = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id='acc-intentions-999'; label='AI requires entirely new laws'
                        description='Emerging technologies require entirely new legal frameworks rather than adapted existing laws' }
                )}

                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        if ($payload.Count -gt 0 -and $payload[0].PSObject.Properties['claim_prop']) {
                            $out = foreach ($it in $payload) {
                                [pscustomobject]@{ id=$it.id; direction='opposes'; confidence=1.5; method='nli' }
                            }
                            ConvertTo-Json -InputObject @($out) -Depth 5
                        } else {
                            $o = [ordered]@{}
                            foreach ($it in $payload) { $o[$it.id] = $vecAref }
                            $o | ConvertTo-Json -Depth 5 -Compress
                        }
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Verbose:$false 6>$null

                $r.ProposalsWouldEmit     | Should -Be 1 -Because 'the edge survives — flipped, not dropped'
                $r.Proposals[0].EdgeType  | Should -Be 'OPPOSES' -Because 'org asserts a claim that negates the node → OPPOSES'
                $r.Proposals[0].Direction | Should -Be 'opposes'
                $r.DirectionalFlipped     | Should -Be 1
                $r.DirectionalCounts.opposes | Should -Be 1

                $script:TaxonomyData.Remove('invtest-pov')
            }
        }

        It 'KEEP ARM: a non-opposes verdict (unrelated) keeps ADVOCATES_FOR — no flip, no drop (recall preserved)' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:invEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-014'; source_id='src-agree'; polarity='asserts'
                        canonical_proposition='AI requires entirely new legal frameworks'
                        extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $script:TaxonomyData['invtest-pov'] = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id='acc-intentions-999'; label='AI requires entirely new laws'
                        description='Emerging technologies require entirely new legal frameworks rather than adapted existing laws' }
                )}

                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        if ($payload.Count -gt 0 -and $payload[0].PSObject.Properties['claim_prop']) {
                            # Realistic: framing suppresses entailment, genuine agreement reads 'unrelated'.
                            $out = foreach ($it in $payload) {
                                [pscustomobject]@{ id=$it.id; direction='unrelated'; confidence=0.1; method='nli' }
                            }
                            ConvertTo-Json -InputObject @($out) -Depth 5
                        } else {
                            $o = [ordered]@{}
                            foreach ($it in $payload) { $o[$it.id] = $vecAref }
                            $o | ConvertTo-Json -Depth 5 -Compress
                        }
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Verbose:$false 6>$null

                $r.ProposalsWouldEmit     | Should -Be 1
                $r.Proposals[0].EdgeType  | Should -Be 'ADVOCATES_FOR' -Because 'no opposition detected → provisional edge stands'
                $r.Proposals[0].Direction | Should -Be 'unrelated'
                $r.DirectionalFlipped     | Should -Be 0
                $r.DirectionalCounts.unrelated | Should -Be 1

                $script:TaxonomyData.Remove('invtest-pov')
            }
        }

        It 'FAIL-SAFE ARM: an unresolved direction KEEPS the edge (never falsely demotes) and records the count' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:invEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-014'; source_id='src-unres'; polarity='asserts'
                        canonical_proposition='Some claim'; extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $script:TaxonomyData['invtest-pov'] = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id='acc-intentions-999'; label='N'; description='node text' }
                )}

                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        if ($payload.Count -gt 0 -and $payload[0].PSObject.Properties['claim_prop']) {
                            # Engine unavailable → emit nothing → wrapper fails safe to unresolved.
                            $null = $payload
                        } else {
                            $o = [ordered]@{}
                            foreach ($it in $payload) { $o[$it.id] = $vecAref }
                            $o | ConvertTo-Json -Depth 5 -Compress
                        }
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Verbose:$false 6>$null

                $r.ProposalsWouldEmit        | Should -Be 1 -Because 'unresolved → keep (never a false demote)'
                $r.Proposals[0].EdgeType     | Should -Be 'ADVOCATES_FOR'
                $r.Proposals[0].Direction    | Should -Be 'unresolved'
                $r.DirectionalFlipped        | Should -Be 0
                $r.DirectionalCounts.unresolved | Should -Be 1

                $script:TaxonomyData.Remove('invtest-pov')
            }
        }

        It 'CLAIM TEXT: the gate is fed the VERBATIM text (claim.text), not the canonical proposition (t/2744#9)' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:invEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                # Distinct text vs canonical, so we can tell which one reached the gate.
                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-014'; source_id='src-vb'; polarity='asserts'
                        text='VERBATIM org sentence with the full polarity-bearing phrasing'
                        canonical_proposition='over-abstracted canonical'
                        extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $script:TaxonomyData['invtest-pov'] = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id='acc-intentions-999'; label='N'; description='node text' }
                )}

                $script:capturedClaimProp = $null
                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        if ($payload.Count -gt 0 -and $payload[0].PSObject.Properties['claim_prop']) {
                            $script:capturedClaimProp = [string]$payload[0].claim_prop
                            # Genuine-agreement-style control fed via verbatim → not opposes.
                            $out = foreach ($it in $payload) {
                                [pscustomobject]@{ id=$it.id; direction='unrelated'; confidence=0.1; method='nli' }
                            }
                            ConvertTo-Json -InputObject @($out) -Depth 5
                        } else {
                            $o = [ordered]@{}
                            foreach ($it in $payload) { $o[$it.id] = $vecAref }
                            $o | ConvertTo-Json -Depth 5 -Compress
                        }
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Verbose:$false 6>$null

                $script:capturedClaimProp | Should -Be 'VERBATIM org sentence with the full polarity-bearing phrasing' -Because 'the gate feeds claim.text (verbatim), not canonical_proposition (t/2744#9)'
                $r.Proposals[0].Direction | Should -Be 'unrelated'
                $r.DirectionalCounts.opposes | Should -Be 0 -Because 'no false-opposes on the verbatim-fed control'

                $script:TaxonomyData.Remove('invtest-pov')
            }
        }

        It 'TEXT_VERBATIM=true: an explicitly-verbatim claim still reaches the gate as text (t/4395)' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:invEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-014'; source_id='src-tv'; polarity='asserts'
                        text='VERBATIM org sentence, confirmed by t/4382'
                        canonical_proposition='over-abstracted canonical'
                        text_verbatim=$true
                        extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $script:TaxonomyData['invtest-pov'] = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id='acc-intentions-999'; label='N'; description='node text' }
                )}

                $script:capturedClaimProp = $null
                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        if ($payload.Count -gt 0 -and $payload[0].PSObject.Properties['claim_prop']) {
                            $script:capturedClaimProp = [string]$payload[0].claim_prop
                            $out = foreach ($it in $payload) {
                                [pscustomobject]@{ id=$it.id; direction='unrelated'; confidence=0.1; method='nli' }
                            }
                            ConvertTo-Json -InputObject @($out) -Depth 5
                        } else {
                            $o = [ordered]@{}
                            foreach ($it in $payload) { $o[$it.id] = $vecAref }
                            $o | ConvertTo-Json -Depth 5 -Compress
                        }
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Verbose:$false -WarningVariable warnings -WarningAction SilentlyContinue 6>$null

                $script:capturedClaimProp | Should -Be 'VERBATIM org sentence, confirmed by t/4382' -Because 'text_verbatim=true keeps the existing text-fed behavior'
                @($warnings | Where-Object { "$_" -match 't/4395' }).Count | Should -Be 0 -Because 'no substitution happened'

                $script:TaxonomyData.Remove('invtest-pov')
            }
        }

        It 'TEXT_VERBATIM=false: a flagged paraphrase reaches the gate as canonical_proposition, not text (t/4395)' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:invEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-014'; source_id='src-nv'; polarity='asserts'
                        text='a paraphrase the model wrote, mislabeled as a quote'
                        canonical_proposition='the real canonical proposition'
                        text_verbatim=$false
                        extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $script:TaxonomyData['invtest-pov'] = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id='acc-intentions-999'; label='N'; description='node text' }
                )}

                $script:capturedClaimProp = $null
                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        if ($payload.Count -gt 0 -and $payload[0].PSObject.Properties['claim_prop']) {
                            $script:capturedClaimProp = [string]$payload[0].claim_prop
                            $out = foreach ($it in $payload) {
                                [pscustomobject]@{ id=$it.id; direction='unrelated'; confidence=0.1; method='nli' }
                            }
                            ConvertTo-Json -InputObject @($out) -Depth 5
                        } else {
                            $o = [ordered]@{}
                            foreach ($it in $payload) { $o[$it.id] = $vecAref }
                            $o | ConvertTo-Json -Depth 5 -Compress
                        }
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Verbose:$false -WarningVariable warnings -WarningAction SilentlyContinue 6>$null

                $script:capturedClaimProp | Should -Be 'the real canonical proposition' -Because 'text_verbatim=false must not feed the paraphrase to the gate as if it were a quote'
                $substitutionWarn = @($warnings | Where-Object { "$_" -match 't/4395' })
                $substitutionWarn.Count | Should -Be 1
                "$($substitutionWarn[0])" | Should -Match '1 claim'

                $script:TaxonomyData.Remove('invtest-pov')
            }
        }

        It 'MULTI-REP OR: an inversion caught by ONLY the canonical rep still flips the edge (opposes-if-any, t/2744#10)' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:invEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-014'; source_id='src-mr'; polarity='asserts'
                        text='VERBATIM rep that reads neutral to the model'
                        canonical_proposition='CANONICAL rep that contradicts the node'
                        extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $script:TaxonomyData['invtest-pov'] = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id='acc-intentions-999'; label='N'; description='node text' }
                )}

                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        if ($payload.Count -gt 0 -and $payload[0].PSObject.Properties['claim_prop']) {
                            # verbatim rep → unrelated; canonical rep → opposes. OR must fire.
                            $out = foreach ($it in $payload) {
                                $dir = if ([string]$it.claim_prop -match 'CANONICAL') { 'opposes' } else { 'unrelated' }
                                [pscustomobject]@{ id=$it.id; direction=$dir; confidence=1.4; method='nli' }
                            }
                            ConvertTo-Json -InputObject @($out) -Depth 5
                        } else {
                            $o = [ordered]@{}
                            foreach ($it in $payload) { $o[$it.id] = $vecAref }
                            $o | ConvertTo-Json -Depth 5 -Compress
                        }
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Verbose:$false 6>$null

                $r.ProposalsWouldEmit        | Should -Be 1
                $r.Proposals[0].Direction    | Should -Be 'opposes' -Because 'opposes-if-ANY: the canonical rep fires'
                $r.Proposals[0].EdgeType     | Should -Be 'OPPOSES'
                $r.DirectionalFlipped        | Should -Be 1
                $r.DirectionalCounts.opposes | Should -Be 1

                $script:TaxonomyData.Remove('invtest-pov')
            }
        }

        It 'MULTI-REP arm-2: genuine agreement across BOTH reps keeps the edge with zero false-opposes (TL binding condition)' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:invEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-014'; source_id='src-agree2'; polarity='asserts'
                        text='VERBATIM rep, genuinely aligned'
                        canonical_proposition='CANONICAL rep, genuinely aligned'
                        extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $script:TaxonomyData['invtest-pov'] = [PSCustomObject]@{ nodes = @(
                    [PSCustomObject]@{ id='acc-intentions-999'; label='N'; description='node text' }
                )}

                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        if ($payload.Count -gt 0 -and $payload[0].PSObject.Properties['claim_prop']) {
                            # Both reps read unrelated (genuine agreement reads 'unrelated' under the gate).
                            $out = foreach ($it in $payload) {
                                [pscustomobject]@{ id=$it.id; direction='unrelated'; confidence=0.2; method='nli' }
                            }
                            ConvertTo-Json -InputObject @($out) -Depth 5
                        } else {
                            $o = [ordered]@{}
                            foreach ($it in $payload) { $o[$it.id] = $vecAref }
                            $o | ConvertTo-Json -Depth 5 -Compress
                        }
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Verbose:$false 6>$null

                $r.ProposalsWouldEmit        | Should -Be 1
                $r.Proposals[0].EdgeType     | Should -Be 'ADVOCATES_FOR' -Because 'no rep opposes → edge kept'
                $r.DirectionalFlipped        | Should -Be 0
                $r.DirectionalCounts.opposes | Should -Be 0 -Because 'zero false-opposes across both reps (TL binding condition)'

                $script:TaxonomyData.Remove('invtest-pov')
            }
        }
    }

    Context 'Endorsement-confirmation gate (t/4475 7b / t/4523) — tags, reorders, never drops' {

        BeforeEach {
            $script:endEmbPath = Join-Path $script:workDir 'embeddings-endorse.json'
            @{
                metadata = @{ dim = $script:dim }
                nodes = [ordered]@{
                    'acc-intentions-991' = @{ pov = 'acc'; vector = $script:vecA }   # high-cosine claim lands here
                    'saf-beliefs-992'    = @{ pov = 'saf'; vector = $script:vecB }   # lower-cosine claim lands here
                }
            } | ConvertTo-Json -Depth 6 | Set-Content -Path $script:endEmbPath -Encoding utf8NoBOM
        }

        It 'tags each proposal with the best verdict over its reps, and never drops a "none" proposal' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:endEmbPath
                VecA       = [double[]]$script:vecA
                VecB       = [double[]]$script:vecB
            } {
                param($ClaimsPath, $EmbPath, $VecA, $VecB)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-700'; source_id='src-topiconly'; polarity='asserts'
                        text='TOPIC-ONLY verbatim'; canonical_proposition='TOPIC-ONLY canonical'; extraction_confidence=0.9 }
                    [PSCustomObject]@{ org_id='org-700'; source_id='src-endorsed'; polarity='asserts'
                        text='ENDORSED verbatim'; canonical_proposition='ENDORSED canonical'; extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $vecAref = $VecA; $vecBref = $VecB
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        $o = [ordered]@{}
                        foreach ($it in $payload) {
                            $o[$it.id] = if ([string]$it.text -like 'TOPIC-ONLY*') { $vecAref } else { $vecBref }
                        }
                        $o | ConvertTo-Json -Depth 5 -Compress
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }
                Mock Test-OrgEndorsement {
                    foreach ($p in @($Pair)) {
                        $verdict = if ([string]$p.ClaimProp -like 'TOPIC-ONLY*') { 'topic_only' } else { 'endorses' }
                        [PSCustomObject]@{ Id = $p.Id; Verdict = $verdict; Reason = 'test' }
                    }
                }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -SkipDirectionalGate -PerOrgCap 10 -Verbose:$false 6>$null

                $r.ProposalsWouldEmit | Should -Be 2 -Because 'the gate tags and reorders, it never drops'
                $topicOnly = $r.Proposals | Where-Object { $_.RepProp -like 'TOPIC-ONLY*' }
                $endorsed  = $r.Proposals | Where-Object { $_.RepProp -like 'ENDORSED*' }
                $topicOnly.Endorsement | Should -Be 'none'
                $endorsed.Endorsement  | Should -Be 'endorses'
                $r.EndorsementCounts.none     | Should -Be 1
                $r.EndorsementCounts.endorses | Should -Be 1
            }
        }

        It 'reorders the per-org cap so a "none" proposal is dropped before an "endorses" proposal of lower cosine' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:endEmbPath
                VecA       = [double[]]$script:vecA
                VecB       = [double[]]$script:vecB
            } {
                param($ClaimsPath, $EmbPath, $VecA, $VecB)

                @{ claims = @(
                    # Lands on acc-intentions-991 (vecA — identical vector, cosine 1.0, the HIGHER cosine).
                    [PSCustomObject]@{ org_id='org-701'; source_id='src-high-cosine-none'; polarity='asserts'
                        text='TOPIC-ONLY verbatim'; canonical_proposition='TOPIC-ONLY canonical'; extraction_confidence=0.9 }
                    # Lands on saf-beliefs-992 (vecB — identical vector, also cosine 1.0, but endorsed).
                    [PSCustomObject]@{ org_id='org-701'; source_id='src-endorsed-lower'; polarity='asserts'
                        text='ENDORSED verbatim'; canonical_proposition='ENDORSED canonical'; extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $vecAref = $VecA; $vecBref = $VecB
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        $o = [ordered]@{}
                        foreach ($it in $payload) {
                            $o[$it.id] = if ([string]$it.text -like 'TOPIC-ONLY*') { $vecAref } else { $vecBref }
                        }
                        $o | ConvertTo-Json -Depth 5 -Compress
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }
                Mock Test-OrgEndorsement {
                    foreach ($p in @($Pair)) {
                        $verdict = if ([string]$p.ClaimProp -like 'TOPIC-ONLY*') { 'topic_only' } else { 'endorses' }
                        [PSCustomObject]@{ Id = $p.Id; Verdict = $verdict; Reason = 'test' }
                    }
                }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -SkipDirectionalGate -PerOrgCap 1 -Verbose:$false 6>$null

                $r.ProposalsWouldEmit    | Should -Be 1 -Because 'the per-org cap still caps at 1 — only the GATE never drops'
                $r.Proposals[0].Endorsement | Should -Be 'endorses' -Because 'endorsement outranks cosine in the cap ordering'
                $r.DroppedByCap[0].Endorsement | Should -Be 'none'
            }
        }

        It 'tags "unknown" (not "none") on a gate backend failure — WARN, never a silent demotion' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:endEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-702'; source_id='src-backend-down'; polarity='asserts'
                        text='SOME verbatim'; canonical_proposition='SOME canonical'; extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        $o = [ordered]@{}
                        foreach ($it in $payload) { $o[$it.id] = $vecAref }
                        $o | ConvertTo-Json -Depth 5 -Compress
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }
                Mock Test-OrgEndorsement {
                    foreach ($p in @($Pair)) { [PSCustomObject]@{ Id = $p.Id; Verdict = 'unknown'; Reason = '' } }
                }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -SkipDirectionalGate -Verbose:$false 6>$null

                $r.ProposalsWouldEmit        | Should -Be 1 -Because 'never dropped on gate failure either'
                $r.Proposals[0].Endorsement  | Should -Be 'unknown'
                $r.EndorsementCounts.unknown | Should -Be 1
            }
        }

        It 'sets DirectionConflict when endorsement says endorses/partial but the directional gate flips the edge to OPPOSES (CL t/4523#5)' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:endEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-703'; source_id='src-conflict'; polarity='asserts'
                        text='CONFLICTED verbatim'; canonical_proposition='CONFLICTED canonical'; extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        if ($payload.Count -gt 0 -and $payload[0].PSObject.Properties['claim_prop']) {
                            # Directional gate (NLI engine): claim opposes the node.
                            $out = foreach ($it in $payload) {
                                [pscustomobject]@{ id = $it.id; direction = 'opposes'; confidence = 1.5; method = 'nli' }
                            }
                            ConvertTo-Json -InputObject @($out) -Depth 5
                        } else {
                            $o = [ordered]@{}
                            foreach ($it in $payload) { $o[$it.id] = $vecAref }
                            $o | ConvertTo-Json -Depth 5 -Compress
                        }
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }
                # Endorsement gate (LLM): the position favours the node — the two gates disagree.
                Mock Test-OrgEndorsement {
                    foreach ($p in @($Pair)) { [PSCustomObject]@{ Id = $p.Id; Verdict = 'endorses'; Reason = 'favours the node' } }
                }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Verbose:$false 6>$null

                $r.Proposals[0].EdgeType          | Should -Be 'OPPOSES' -Because 'the directional gate flipped it'
                $r.Proposals[0].Endorsement       | Should -Be 'endorses'
                $r.Proposals[0].DirectionConflict | Should -BeTrue -Because 'endorses + OPPOSES is exactly the unresolved conflict a reviewer must see'
                $r.Proposals[0].Rationale         | Should -Match 'direction_conflict=true'
                $r.DirectionConflicts             | Should -Be 1
            }
        }

        It 'does NOT set DirectionConflict when endorsement and the final edge type agree' {
            InModuleScope AITriad -Parameters @{
                ClaimsPath = $script:claimsPath
                EmbPath    = $script:endEmbPath
                VecA       = [double[]]$script:vecA
            } {
                param($ClaimsPath, $EmbPath, $VecA)

                @{ claims = @(
                    [PSCustomObject]@{ org_id='org-704'; source_id='src-agree'; polarity='asserts'
                        text='AGREED verbatim'; canonical_proposition='AGREED canonical'; extraction_confidence=0.9 }
                ) } | ConvertTo-Json -Depth 5 | Set-Content -Path $ClaimsPath -Encoding utf8NoBOM

                $vecAref = $VecA
                function python {
                    process {
                        $payload = @($input | Out-String | ConvertFrom-Json)
                        if ($payload.Count -gt 0 -and $payload[0].PSObject.Properties['claim_prop']) {
                            $out = foreach ($it in $payload) {
                                [pscustomobject]@{ id = $it.id; direction = 'unrelated'; confidence = 0.1; method = 'nli' }
                            }
                            ConvertTo-Json -InputObject @($out) -Depth 5
                        } else {
                            $o = [ordered]@{}
                            foreach ($it in $payload) { $o[$it.id] = $vecAref }
                            $o | ConvertTo-Json -Depth 5 -Compress
                        }
                    }
                }
                Mock Get-OrganizationEdgesStore { [PSCustomObject]@{ edges = @() } }
                Mock Test-OrgEndorsement {
                    foreach ($p in @($Pair)) { [PSCustomObject]@{ Id = $p.Id; Verdict = 'endorses'; Reason = 'test' } }
                }

                $r = Invoke-OrgClaimMatching -ClaimsPath $ClaimsPath -EmbeddingsPath $EmbPath `
                    -MatchThreshold 0.60 -Verbose:$false 6>$null

                $r.Proposals[0].EdgeType          | Should -Be 'ADVOCATES_FOR' -Because 'no opposition detected, no flip'
                $r.Proposals[0].DirectionConflict | Should -BeFalse
                $r.DirectionConflicts             | Should -Be 0
            }
        }
    }
}
