# Tag: unit (t/1806 Phase 1)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Invoke-EntityExtraction — Phase 1 entity ontology extraction (t/1806).
.DESCRIPTION
    AI is mocked (Invoke-AIByUsage) so tests run offline — never a real AI call.
    -Concurrency 1 everywhere: ForEach-Object -Parallel spins fresh runspaces that
    re-import the real module, so a Pester Mock set in this session would not be
    visible there (same reason Invoke-OrgStanceExtraction's tests pin Concurrency 1).
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Invoke-EntityExtraction (t/1806 Phase 1)' -Tag 'unit' {

    BeforeEach {
        $script:workDir = Join-Path $TestDrive "run-$(Get-Random)"
        $null = New-Item -ItemType Directory -Path $script:workDir -Force
        $script:emptyTaxDir = Join-Path $script:workDir 'taxdir'
        $null = New-Item -ItemType Directory -Path $script:emptyTaxDir -Force
        $script:emptyDataRoot = Join-Path $script:workDir 'dataroot'
        $null = New-Item -ItemType Directory -Path $script:emptyDataRoot -Force

        $script:entPath = Join-Path $script:workDir 'entities.json'
        $script:embPath = Join-Path $script:workDir 'entity_embeddings.json'
        $script:logPath = Join-Path $script:workDir 'entity_extraction_log.json'
        $script:seiPath = Join-Path $script:workDir 'source_evidence_index.json'

        # Default: the embedder returns nothing, so the cosine stages no-op unless a test
        # opts in with its own Get-TextEmbedding mock. Keeps the existing tests hermetic
        # now that per-node batch encoding (t/1880#3 Option A) calls it for every node.
        Mock Get-TextEmbedding -ModuleName AITriad -MockWith { @{} }
    }

    Context 'Runtime guard — UsageID not yet registered (t/1819 dependency)' {
        It 'Throws an ActionableError naming t/1819 when enrichment.entity-extraction does not resolve' {
            InModuleScope AITriad {
                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{} }
                { Invoke-EntityExtraction -Confirm:$false } | Should -Throw -ExpectedMessage '*t/1819*'
            }
        }
    }

    Context 'Model selection (-Model)' {

        BeforeEach {
            $seiContent = @{ 'node-a' = @{ facts = @(@{ claim = 'A claim.'; doc_id = 'doc-1' }) } }
            ($seiContent | ConvertTo-Json -Depth 8) | Set-Content -Path $script:seiPath -Encoding utf8NoBOM
        }

        It 'Does NOT override the model when -Model is omitted — the usage''s configured model wins (t/3123)' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                # t/3123: with -Model omitted, the cmdlet must pass an EMPTY override (no `model` key)
                # so Invoke-AIByUsage falls back to the usage's configured model (claude-sonnet-4-6).
                # Previously it force-injected gemini-3.5-flash-lite, which 400'd the Claude-shaped schema.
                $script:capturedHasModel = 'MOCK-NOT-CALLED'
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    $script:capturedHasModel = [bool]($Override -and $Override.ContainsKey('model'))
                    [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' }
                }

                Invoke-EntityExtraction -NodeId 'node-a' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false | Out-Null

                $script:capturedHasModel | Should -BeFalse
            }
        }

        It 'Passes an explicit -Model through as the per-call override' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    $script:capturedModel = $Override.model
                    [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' }
                }

                Invoke-EntityExtraction -NodeId 'node-a' -Model 'gemini-3.8-flash' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false | Out-Null

                $script:capturedModel | Should -Be 'gemini-3.8-flash'
            }
        }

        It 'Rejects an unregistered -Model at parameter binding (Test-AIModelId validation)' {
            { Invoke-EntityExtraction -Model 'totally-unregistered-model-zzz' -Confirm:$false } | # model-lint:allow-nonselect (negative test: id is deliberately unregistered)
                Should -Throw -ExpectedMessage '*totally-unregistered-model-zzz*'
        }
    }

    Context 'Resolution before minting + confidence gate + person exception' {

        BeforeEach {
            # One pre-existing entity so a proposal can MATCH it (not mint).
            Import-Entity -Proposal @(@{
                name           = 'Existing Corp'
                entity_type    = 'institution'
                dolce_category = 'non-agentive-social-object'
                aliases        = @('ExistingCo')
            }) -Path $script:entPath -SkipEmbedding | Out-Null

            $seiContent = @{
                'node-match' = @{ facts = @(@{ claim = 'Existing Corp published a statement.'; doc_id = 'doc-1' }) }
                'node-mint'  = @{ facts = @(@{ claim = 'A new artifact was announced.'; doc_id = 'doc-2' }) }
                'node-person' = @{ facts = @(@{ claim = 'Jane Analyst authored the report.'; doc_id = 'doc-3' }) }
                'node-gate'  = @{ facts = @(@{ claim = 'Several claims about confidence levels.'; doc_id = 'doc-4' }) }
                'node-invalid' = @{ facts = @(@{ claim = 'A claim about an unclassifiable thing.'; doc_id = 'doc-5' }) }
            }
            ($seiContent | ConvertTo-Json -Depth 8) | Set-Content -Path $script:seiPath -Encoding utf8NoBOM
        }

        It 'Links a proposal that matches an existing entity by name (does NOT mint) and mints an unmatched proposal' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    switch ($Values.node_id) {
                        'node-match' {
                            [PSCustomObject]@{
                                Text = '{"proposals":[{"name":"Existing Corp","entity_type":"institution","aliases":[],"quote":"q","confidence":0.9}],"org_mentions":[]}'
                                Model = 'stub'
                            }
                        }
                        'node-mint' {
                            [PSCustomObject]@{
                                Text = '{"proposals":[{"name":"New Artifact Inc","entity_type":"artifact","aliases":["NAI"],"quote":"q","confidence":0.9}],"org_mentions":[{"name":"Some Org"}]}'
                                Model = 'stub'
                            }
                        }
                        default { [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' } }
                    }
                }

                $r = Invoke-EntityExtraction -NodeId 'node-match', 'node-mint' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false

                $r.Minted | Should -Be 1 -Because 'only the unmatched New Artifact Inc proposal mints'
                $r.Linked | Should -Be 1 -Because 'Existing Corp matches by exact name and links instead'
                $r.DroppedBelowGate | Should -Be 0

                $linked = $r.LinkedDispositions | Where-Object { $_.proposal_name -eq 'Existing Corp' }
                $linked.matched_kind | Should -Be 'entity'
                $linked.matched_id  | Should -Be 'ent-001'

                $minted = $r.MintedEntities | Where-Object { $_.name -eq 'New Artifact Inc' }
                $minted | Should -Not -BeNullOrEmpty
                $minted.entity_type    | Should -Be 'artifact'
                $minted.dolce_category | Should -Be 'non-agentive-functional-artifact'

                $store = Get-Content -Raw -Path $EntPath | ConvertFrom-Json
                @($store.entities).Count | Should -Be 2 -Because 'Existing Corp was not re-minted; New Artifact Inc was added'
            }
        }

        It 'Mints a PERSON proposal with NO description (design invariant — LLM never authors one)' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    if ($Values.node_id -eq 'node-person') {
                        [PSCustomObject]@{
                            Text = '{"proposals":[{"name":"Jane Analyst","entity_type":"person","aliases":[],"quote":"authored the report","confidence":0.9}],"org_mentions":[]}'
                            Model = 'stub'
                        }
                    } else { [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' } }
                }

                $r = Invoke-EntityExtraction -NodeId 'node-person' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false

                $r.Minted | Should -Be 1
                $minted = $r.MintedEntities | Where-Object { $_.name -eq 'Jane Analyst' }
                $minted.entity_type    | Should -Be 'person'
                $minted.dolce_category | Should -Be 'agentive-physical-object'

                $store = Get-Content -Raw -Path $EntPath | ConvertFrom-Json
                $rec = $store.entities | Where-Object { $_.id -eq $minted.id }
                $rec.entity_type | Should -Be 'person'
                [string]::IsNullOrWhiteSpace($rec.description) | Should -BeTrue -Because 'person records are never minted with an LLM-authored description'
            }
        }

        It 'Drops below-gate proposals, mints at/above the gate, and flags near-gate proposals' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    if ($Values.node_id -eq 'node-gate') {
                        [PSCustomObject]@{
                            Text = '{"proposals":[' +
                                   '{"name":"Low Conf Thing","entity_type":"artifact","aliases":[],"quote":"q","confidence":0.4},' +
                                   '{"name":"High Conf Thing","entity_type":"artifact","aliases":[],"quote":"q","confidence":0.8},' +
                                   '{"name":"Near Gate Thing","entity_type":"artifact","aliases":[],"quote":"q","confidence":0.65}' +
                                   '],"org_mentions":[]}'
                            Model = 'stub'
                        }
                    } else { [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' } }
                }

                $r = Invoke-EntityExtraction -NodeId 'node-gate' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false

                $r.DroppedBelowGate | Should -Be 1 -Because 'Low Conf Thing (0.4) is below the 0.6 default threshold'
                $r.Minted           | Should -Be 2 -Because 'High Conf Thing and Near Gate Thing both clear the gate'
                $r.NearGateMinted   | Should -Be 1 -Because 'Near Gate Thing (0.65) is in [0.6, 0.7)'

                $nearGateEntry = $r.MintedEntities | Where-Object { $_.name -eq 'Near Gate Thing' }
                $nearGateEntry.near_gate | Should -BeTrue
                $highConfEntry = $r.MintedEntities | Where-Object { $_.name -eq 'High Conf Thing' }
                $highConfEntry.near_gate | Should -BeFalse
            }
        }

        It 'Drops a proposal with an unrecognized entity_type (shape validation, not a gate drop)' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    if ($Values.node_id -eq 'node-invalid') {
                        [PSCustomObject]@{
                            Text = '{"proposals":[{"name":"Bad Type Thing","entity_type":"alien","aliases":[],"quote":"q","confidence":0.9}],"org_mentions":[]}'
                            Model = 'stub'
                        }
                    } else { [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' } }
                }

                $r = Invoke-EntityExtraction -NodeId 'node-invalid' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false

                $r.InvalidDropped | Should -Be 1
                $r.Minted         | Should -Be 0
                ($r.InvalidItems -join '|') | Should -Match "entity_type 'alien'"
            }
        }
    }

    Context 'Pipeline defect regressions (t/1830, from t/1826 hand-scoring)' {

        BeforeEach {
            $seiContent = @{
                'node-ppo'   = @{ facts = @(@{ claim = 'PPO is a training method.'; doc_id = 'doc-1' }) }
                'node-quote' = @{ facts = @(@{ claim = 'Jane Analyst authored the report.'; doc_id = 'doc-2' }) }
                'node-gate'  = @{ facts = @(@{ claim = 'A low-confidence mention.'; doc_id = 'doc-3' }) }
            }
            ($seiContent | ConvertTo-Json -Depth 8) | Set-Content -Path $script:seiPath -Encoding utf8NoBOM
        }

        It 'Coerces a bare-string aliases value to a single-element array (no char-explosion)' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                # The model emits `aliases` as a BARE STRING (its single-alias habit — 13/37 in the
                # first live batch, t/1826). It must persist as ONE alias, never N single chars.
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    if ($Values.node_id -eq 'node-ppo') {
                        [PSCustomObject]@{ Text = '{"proposals":[{"name":"PPO","entity_type":"artifact","aliases":"Proximal Policy Optimization","quote":"q","confidence":0.9}],"org_mentions":[]}'; Model = 'stub' }
                    } else { [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' } }
                }

                $r = Invoke-EntityExtraction -NodeId 'node-ppo' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false

                $r.Minted | Should -Be 1
                $store = Get-Content -Raw -Path $EntPath | ConvertFrom-Json
                $rec = $store.entities | Where-Object { $_.name -eq 'PPO' }
                @($rec.aliases).Count | Should -Be 1 -Because 'a bare-string alias is ONE alias, not one element per character'
                @($rec.aliases)[0]    | Should -Be 'Proximal Policy Optimization'
            }
        }

        It 'Persists the supporting quote per minted entity in the sidecar log (keyed by id)' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    if ($Values.node_id -eq 'node-quote') {
                        [PSCustomObject]@{ Text = '{"proposals":[{"name":"Jane Analyst","entity_type":"person","aliases":[],"quote":"Jane Analyst authored the report","confidence":0.9}],"org_mentions":[]}'; Model = 'stub' }
                    } else { [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' } }
                }

                $r = Invoke-EntityExtraction -NodeId 'node-quote' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false

                $r.Minted | Should -Be 1
                $mintedId = ($r.MintedEntities | Where-Object { $_.name -eq 'Jane Analyst' }).id

                $log = Get-Content -Raw -Path $LogPath | ConvertFrom-Json
                $node = $log.nodes | Where-Object { $_.node_id -eq 'node-quote' }
                $node.evidence | Should -Not -BeNullOrEmpty -Because 'curation reads the supporting quote from the sidecar'
                $ev = @($node.evidence) | Where-Object { $_.id -eq $mintedId }
                $ev.quote | Should -Be 'Jane Analyst authored the report'
                $ev.name  | Should -Be 'Jane Analyst'
            }
        }

        It 'Records below-gate drops in the sidecar log with name/type/confidence/node_id' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    if ($Values.node_id -eq 'node-gate') {
                        [PSCustomObject]@{ Text = '{"proposals":[{"name":"Faint Signal","entity_type":"artifact","aliases":[],"quote":"q","confidence":0.4}],"org_mentions":[]}'; Model = 'stub' }
                    } else { [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' } }
                }

                $r = Invoke-EntityExtraction -NodeId 'node-gate' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false

                $r.DroppedBelowGate | Should -Be 1
                $r.Minted           | Should -Be 0
                # On the run object
                $dropItem = @($r.DroppedItems) | Where-Object { $_.name -eq 'Faint Signal' }
                $dropItem.entity_type | Should -Be 'artifact'
                $dropItem.confidence  | Should -Be 0.4
                $dropItem.node_id     | Should -Be 'node-gate'
                # And persisted to the sidecar for gate-recall audit
                $log = Get-Content -Raw -Path $LogPath | ConvertFrom-Json
                $node = $log.nodes | Where-Object { $_.node_id -eq 'node-gate' }
                @($node.dropped).Count | Should -Be 1
                @($node.dropped)[0].name       | Should -Be 'Faint Signal'
                @($node.dropped)[0].confidence | Should -Be 0.4
            }
        }
    }

    Context 'Idempotence' {
        BeforeEach {
            $seiContent = @{ 'node-idem' = @{ facts = @(@{ claim = 'A repeatable claim.'; doc_id = 'doc-9' }) } }
            ($seiContent | ConvertTo-Json -Depth 8) | Set-Content -Path $script:seiPath -Encoding utf8NoBOM
        }

        It 'Skips already-processed node ids on re-run unless -Force' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                Mock Invoke-AIByUsage -MockWith {
                    [PSCustomObject]@{ Text = '{"proposals":[{"name":"Repeatable Inc","entity_type":"artifact","aliases":[],"quote":"q","confidence":0.9}],"org_mentions":[]}'; Model = 'stub' }
                }

                $r1 = Invoke-EntityExtraction -Concurrency 1 -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false
                $r1.Minted | Should -Be 1

                $r2 = Invoke-EntityExtraction -Concurrency 1 -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false
                $r2.SkippedAlreadyDone | Should -Be 1
                $r2.NodesProcessed     | Should -Be 0

                $r3 = Invoke-EntityExtraction -Concurrency 1 -Force -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false
                $r3.SkippedAlreadyDone | Should -Be 0
                $r3.NodesProcessed     | Should -Be 1
            }
        }
    }

    Context 'Within-run dedup that exact-name matching missed (t/1880)' {

        BeforeEach {
            # Three fresh proposals minted in the SAME run — no pre-existing store, so
            # nothing is approved and entity_embeddings.json is empty (the live Phase-1
            # state). node-1 sorts first and mints first.
            $seiContent = @{
                'node-1' = @{ facts = @(@{ claim = 'The plan was announced.'; doc_id = 'doc-1' }) }
                'node-2' = @{ facts = @(@{ claim = 'A related announcement.'; doc_id = 'doc-2' }) }
                'node-3' = @{ facts = @(@{ claim = 'An unrelated thing.'; doc_id = 'doc-3' }) }
            }
            ($seiContent | ConvertTo-Json -Depth 8) | Set-Content -Path $script:seiPath -Encoding utf8NoBOM
        }

        It 'Bullet 1 — links a proposal whose NAME equals an earlier within-run mint''s ALIAS (exact, no embeddings)' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                # Embedder returns nothing (BeforeEach default) so the cosine stages CANNOT
                # fire — the link must come from the name-vs-alias exact index (t/1880 bullet 1).
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    switch ($Values.node_id) {
                        'node-1' { [PSCustomObject]@{ Text = '{"proposals":[{"name":"Trump Administration AI Action Plan (July 2025)","entity_type":"legislation","aliases":["AI Action Plan"],"quote":"q","confidence":0.9}],"org_mentions":[]}'; Model = 'stub' } }
                        'node-2' { [PSCustomObject]@{ Text = '{"proposals":[{"name":"AI Action Plan","entity_type":"legislation","aliases":["Trump AI Action Plan"],"quote":"q","confidence":0.9}],"org_mentions":[]}'; Model = 'stub' } }
                        default  { [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' } }
                    }
                }

                $r = Invoke-EntityExtraction -NodeId 'node-1', 'node-2' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false

                $r.Minted | Should -Be 1 -Because '"AI Action Plan" (node-2 name) equals an alias of the node-1 mint and links instead of minting'
                $r.Linked | Should -Be 1

                $linked = $r.LinkedDispositions | Where-Object { $_.proposal_name -eq 'AI Action Plan' }
                $linked           | Should -Not -BeNullOrEmpty
                $linked.reason    | Should -Be 'within-run-dedup'
                $linked.matched_kind | Should -Be 'entity'
                $minted = $r.MintedEntities | Where-Object { $_.name -eq 'Trump Administration AI Action Plan (July 2025)' }
                $linked.matched_id | Should -Be $minted.id

                $store = Get-Content -Raw -Path $EntPath | ConvertFrom-Json
                @($store.entities).Count | Should -Be 1 -Because 'the alias collision minted exactly one entity'
            }
        }

        It 'Bullet 2 / Option A (ADVISORY, t/1881) — a high-cosine SIBLING pair MINTS both and writes one possible_duplicates[] row (never links)' {
            InModuleScope AITriad -Parameters @{ TaxDir = $script:emptyTaxDir; DataRoot = $script:emptyDataRoot; EntPath = $script:entPath; EmbPath = $script:embPath; SeiPath = $script:seiPath; LogPath = $script:logPath } {
                param($TaxDir, $DataRoot, $EntPath, $EmbPath, $SeiPath, $LogPath)

                Mock Get-UsageRegistry -MockWith { [PSCustomObject]@{ 'enrichment.entity-extraction' = @{} } }
                Mock Get-TaxonomyDir -MockWith ({ $TaxDir }.GetNewClosure())
                Mock Get-DataRoot -MockWith ({ $DataRoot }.GetNewClosure())
                # `Gemini 3.5 Flash` <-> `Gemini 3.6 Flash` score 0.97 on the real embedder
                # (TL measurement, t/1881) — a SIBLING pair that must NOT merge: auto-linking
                # would destroy a distinct entity. Controlled mock reproduces the high-cosine
                # shape (both gemini names ~[1,0]; the unrelated entity orthogonal ~[0,1]).
                Mock Get-TextEmbedding -MockWith {
                    param($Texts, $Ids)
                    $out = @{}
                    $t = @($Texts); $ids = @($Ids)
                    for ($k = 0; $k -lt $t.Count; $k++) {
                        $s = ([string]$t[$k]).ToLowerInvariant()
                        $vec = if ($s -match 'gemini') { @(1.0, 0.02) } else { @(0.02, 1.0) }
                        $out[[string]$ids[$k]] = $vec
                    }
                    $out
                }
                Mock Invoke-AIByUsage -MockWith {
                    param($UsageId, $Values, $Override, $ApiKey, $FallbackModels)
                    switch ($Values.node_id) {
                        'node-1' { [PSCustomObject]@{ Text = '{"proposals":[{"name":"Gemini 3.5 Flash","entity_type":"artifact","aliases":[],"quote":"q","confidence":0.9}],"org_mentions":[]}'; Model = 'stub' } }
                        'node-2' { [PSCustomObject]@{ Text = '{"proposals":[{"name":"Gemini 3.6 Flash","entity_type":"artifact","aliases":[],"quote":"q","confidence":0.9}],"org_mentions":[]}'; Model = 'stub' } }
                        'node-3' { [PSCustomObject]@{ Text = '{"proposals":[{"name":"Boeing 737 MAX","entity_type":"artifact","aliases":[],"quote":"q","confidence":0.9}],"org_mentions":[]}'; Model = 'stub' } }
                        default  { [PSCustomObject]@{ Text = '{"proposals":[],"org_mentions":[]}'; Model = 'stub' } }
                    }
                }

                $r = Invoke-EntityExtraction -NodeId 'node-1', 'node-2', 'node-3' -Concurrency 1 `
                    -EntitiesPath $EntPath -EmbeddingsPath $EmbPath -SourceEvidenceIndexPath $SeiPath -OutputPath $LogPath -Confirm:$false

                $r.Minted | Should -Be 3 -Because 'the sibling pair must NOT merge — both mint, plus the unrelated entity'
                $r.Linked | Should -Be 0 -Because 'the near-variant cosine stage is advisory: it surfaces, it never links'

                @($r.PossibleDuplicates).Count | Should -Be 1 -Because 'only the high-cosine sibling pair is surfaced; the orthogonal entity is not'
                $pd = @($r.PossibleDuplicates)[0]
                $pd.proposal_name | Should -Be 'Gemini 3.6 Flash'
                $pd.matched_name  | Should -Be 'Gemini 3.5 Flash'
                $pd.similarity    | Should -BeGreaterThan 0.9
                $g35 = $r.MintedEntities | Where-Object { $_.name -eq 'Gemini 3.5 Flash' }
                $g36 = $r.MintedEntities | Where-Object { $_.name -eq 'Gemini 3.6 Flash' }
                $pd.matched_id   | Should -Be $g35.id -Because 'matched_id points at the earlier-minted sibling'
                $pd.candidate_id | Should -Be $g36.id -Because 'candidate_id is the newly-minted proposal that triggered the surface'

                # Persisted to the sidecar under the NEW proposal's node
                $log = Get-Content -Raw -Path $LogPath | ConvertFrom-Json
                $node2 = $log.nodes | Where-Object { $_.node_id -eq 'node-2' }
                @($node2.possible_duplicates).Count | Should -Be 1
                @($node2.possible_duplicates)[0].matched_name | Should -Be 'Gemini 3.5 Flash'
                $log._schema_version | Should -Be '1.3.0' -Because 'possible_duplicates[] arrived in 1.2.0; existing_entity_candidates[] (t/4075) bumped it to 1.3.0'

                # Both siblings persist as DISTINCT records — nothing was destroyed
                $store = Get-Content -Raw -Path $EntPath | ConvertFrom-Json
                @($store.entities).Count | Should -Be 3
            }
        }
    }
}
