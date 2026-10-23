# Tag: unit (t/1806 §7)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Get-EntityReport — entity ontology maintenance reports (t/1806 §7).
.DESCRIPTION
    No AI calls in this cmdlet at all; every test uses explicit -EntitiesPath /
    -EmbeddingsPath / -DictionaryRoot fixtures under $TestDrive, so no mocking of
    Private path-resolution helpers is needed.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Get-EntityReport (t/1806 §7)' -Tag 'unit' {

    Context 'near-duplicate' {
        It 'Flags a pair at/above -NearDuplicateThreshold and excludes an orthogonal pair' {
            $entPath = Join-Path $TestDrive 'nd-entities.json'
            $embPath = Join-Path $TestDrive 'nd-embeddings.json'

            Import-Entity -Proposal @(
                @{ name = 'Alpha Corp'; entity_type = 'institution'; dolce_category = 'non-agentive-social-object' },
                @{ name = 'Alpha Corporation'; entity_type = 'institution'; dolce_category = 'non-agentive-social-object' },
                @{ name = 'Orthogonal Thing'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact' }
            ) -Path $entPath -SkipEmbedding | Out-Null

            $embStore = [PSCustomObject]@{
                _schema_version = '1.0.0'
                model           = 'all-MiniLM-L6-v2'
                dim             = 3
                last_modified   = '2026-01-01'
                vectors         = [PSCustomObject]@{
                    'ent-001' = @(1.0, 0.0, 0.0)
                    'ent-002' = @(0.99, 0.01, 0.0)
                    'ent-003' = @(0.0, 1.0, 0.0)
                }
            }
            ($embStore | ConvertTo-Json -Depth 6) | Set-Content -Path $embPath -Encoding utf8NoBOM

            $r = Get-EntityReport -Report near-duplicate -EntitiesPath $entPath -EmbeddingsPath $embPath -NearDuplicateThreshold 0.60

            $r.NearDuplicate.Threshold | Should -Be 0.60
            @($r.NearDuplicate.Pairs).Count | Should -Be 1
            $pair = $r.NearDuplicate.Pairs[0]
            @($pair.EntityIdA, $pair.EntityIdB) | Should -Contain 'ent-001'
            @($pair.EntityIdA, $pair.EntityIdB) | Should -Contain 'ent-002'
        }

        It 'Reads a schema-2.0.0 store (name_vector records), and -Report all returns every section (t/4456)' {
            $entPath = Join-Path $TestDrive 'nd2-entities.json'
            $embPath = Join-Path $TestDrive 'nd2-embeddings.json'
            Import-Entity -Proposal @(
                @{ name = 'Beta Corp'; entity_type = 'institution'; dolce_category = 'non-agentive-social-object' },
                @{ name = 'Beta Corporation'; entity_type = 'institution'; dolce_category = 'non-agentive-social-object' },
                @{ name = 'Unrelated Thing'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact' }
            ) -Path $entPath -SkipEmbedding | Out-Null
            $embStore = [PSCustomObject]@{
                _schema_version = '2.0.0'
                vectors         = [PSCustomObject]@{
                    'ent-001' = [PSCustomObject]@{ name_vector = @(1.0, 0.0, 0.0); description_vector = @(0.0, 0.0, 1.0) }
                    'ent-002' = [PSCustomObject]@{ name_vector = @(0.99, 0.01, 0.0) }
                    'ent-003' = [PSCustomObject]@{ name_vector = @(0.0, 1.0, 0.0) }
                }
            }
            ($embStore | ConvertTo-Json -Depth 6) | Set-Content -Path $embPath -Encoding utf8NoBOM

            $r = Get-EntityReport -EntitiesPath $entPath -EmbeddingsPath $embPath -DictionaryRoot (Join-Path $TestDrive 'no-dict') -NearDuplicateThreshold 0.60
            @($r.NearDuplicate.Pairs).Count | Should -Be 1
            @($r.NearDuplicate.Pairs[0].EntityIdA, $r.NearDuplicate.Pairs[0].EntityIdB) | Should -Be @('ent-001', 'ent-002')
            foreach ($section in 'ProvenanceOrphan', 'NoneMatched', 'MergeChainDefects', 'RelationDag', 'TombstoneStatus', 'OrphanVector') {
                $r.PSObject.Properties[$section] | Should -Not -BeNullOrEmpty -Because "-Report all must reach the $section section"
            }
            $r.TombstoneStatus | Should -Not -BeNullOrEmpty
            $r.OrphanVector | Should -Not -BeNullOrEmpty
        }
    }

    Context 'provenance-orphan' {
        It 'Flags entities with empty source_refs and labels the section exactly (NOT mention-orphan)' {
            $entPath = Join-Path $TestDrive 'po-entities.json'

            Import-Entity -Proposal @(
                @{ name = 'Has Refs'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact'; source_refs = @('doc-1') },
                @{ name = 'No Refs'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact' }
            ) -Path $entPath -SkipEmbedding | Out-Null

            $r = Get-EntityReport -Report provenance-orphan -EntitiesPath $entPath -EmbeddingsPath (Join-Path $TestDrive 'po-embeddings-absent.json')

            $r.ProvenanceOrphan.Label | Should -Be 'provenance-orphan (empty source_refs) — NOT mention-orphan; true mention-orphan lands Phase 2.'
            @($r.ProvenanceOrphan.Entities).Count | Should -Be 1
            $r.ProvenanceOrphan.Entities[0].Name | Should -Be 'No Refs'
        }
    }

    Context 'dictionary-candidate' {
        It 'Flags entities whose name/alias exactly collides with a standardized or colloquial term' {
            $entPath = Join-Path $TestDrive 'dc-entities.json'
            $dictRoot = Join-Path $TestDrive 'dc-dictionary'
            $stdDir = Join-Path $dictRoot 'standardized'
            $collDir = Join-Path $dictRoot 'colloquial'
            $null = New-Item -ItemType Directory -Path $stdDir -Force
            $null = New-Item -ItemType Directory -Path $collDir -Force

            ([PSCustomObject]@{ canonical_form = 'Frontier Lab'; display_form = 'frontier lab' } | ConvertTo-Json) |
                Set-Content -Path (Join-Path $stdDir 'frontier-lab.json') -Encoding utf8NoBOM
            ([PSCustomObject]@{ colloquial_term = 'AI Safety'; status = 'do_not_use_bare' } | ConvertTo-Json) |
                Set-Content -Path (Join-Path $collDir 'ai-safety.json') -Encoding utf8NoBOM

            Import-Entity -Proposal @(
                @{ name = 'Frontier Lab'; entity_type = 'institution'; dolce_category = 'non-agentive-social-object' },
                @{ name = 'Some Institution'; entity_type = 'institution'; dolce_category = 'non-agentive-social-object'; aliases = @('AI Safety') },
                @{ name = 'Unrelated Name'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact' }
            ) -Path $entPath -SkipEmbedding | Out-Null

            $r = Get-EntityReport -Report dictionary-candidate -EntitiesPath $entPath `
                -EmbeddingsPath (Join-Path $TestDrive 'dc-embeddings-absent.json') -DictionaryRoot $dictRoot

            @($r.DictionaryCandidate).Count | Should -Be 2
            ($r.DictionaryCandidate | Where-Object { $_.Name -eq 'Frontier Lab' }).MatchedKind | Should -Be 'standardized'
            ($r.DictionaryCandidate | Where-Object { $_.Name -eq 'Some Institution' }).MatchedKind | Should -Be 'colloquial'
            ($r.DictionaryCandidate | Where-Object { $_.Name -eq 'Unrelated Name' }) | Should -BeNullOrEmpty
        }
    }

    Context 'merge-chain defects' {
        It 'Surfaces a cycle and a dangling merged_into pointer' {
            $entPath = Join-Path $TestDrive 'mc-entities.json'

            # Hand-authored fixture (a real cycle can't be produced through Import-Entity's
            # own path-compression — that is the point of this defensive report).
            $store = [PSCustomObject]@{
                _schema_version = '1.0.0'
                entity_count    = 4
                last_modified   = '2026-01-01'
                entities        = @(
                    [PSCustomObject]@{ id = 'ent-001'; name = 'Cycle A'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact'; description = ''; aliases = @(); source_refs = @(); external_refs = @(); status = 'proposed'; created_at = '2026-01-01'; last_modified = '2026-01-01'; merged_into = 'ent-002' },
                    [PSCustomObject]@{ id = 'ent-002'; name = 'Cycle B'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact'; description = ''; aliases = @(); source_refs = @(); external_refs = @(); status = 'proposed'; created_at = '2026-01-01'; last_modified = '2026-01-01'; merged_into = 'ent-001' },
                    [PSCustomObject]@{ id = 'ent-003'; name = 'Dangling'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact'; description = ''; aliases = @(); source_refs = @(); external_refs = @(); status = 'proposed'; created_at = '2026-01-01'; last_modified = '2026-01-01'; merged_into = 'ent-999' },
                    [PSCustomObject]@{ id = 'ent-004'; name = 'Canonical'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact'; description = ''; aliases = @(); source_refs = @(); external_refs = @(); status = 'proposed'; created_at = '2026-01-01'; last_modified = '2026-01-01' }
                )
            }
            ($store | ConvertTo-Json -Depth 8) | Set-Content -Path $entPath -Encoding utf8NoBOM

            $r = Get-EntityReport -Report merge-chain -EntitiesPath $entPath -EmbeddingsPath (Join-Path $TestDrive 'mc-embeddings-absent.json')

            @($r.MergeChainDefects).Count | Should -Be 3 -Because 'ent-001 and ent-002 each independently detect the cycle; ent-003 is dangling'
            $cycleDefects = @($r.MergeChainDefects | Where-Object { $_.DefectType -eq 'cycle' })
            @($cycleDefects.Id | Sort-Object) | Should -Be @('ent-001', 'ent-002')
            $dangling = $r.MergeChainDefects | Where-Object { $_.Id -eq 'ent-003' }
            $dangling.DefectType | Should -Be 'dangling'
            $dangling.Target     | Should -Be 'ent-999'
        }
    }

    Context '-Report all (default)' {
        It 'Populates all four sections when -Report is not specified' {
            $entPath = Join-Path $TestDrive 'all-entities.json'
            Import-Entity -Proposal @(@{ name = 'Solo'; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact' }) -Path $entPath -SkipEmbedding | Out-Null

            $r = Get-EntityReport -EntitiesPath $entPath -EmbeddingsPath (Join-Path $TestDrive 'all-embeddings-absent.json') -DictionaryRoot (Join-Path $TestDrive 'all-dictionary-absent')

            $r.NearDuplicate | Should -Not -BeNullOrEmpty
            $r.ProvenanceOrphan | Should -Not -BeNullOrEmpty
            # DictionaryCandidate/MergeChainDefects are legitimately EMPTY arrays here (no
            # collisions, no tombstones). Pester's -BeNull assertion rejects ANY collection
            # actual-value (even empty) as "invalid" rather than false — use the "$null on
            # the left" PowerShell idiom instead, which correctly distinguishes a real $null
            # from a non-null empty array.
            ($null -eq $r.DictionaryCandidate) | Should -BeFalse
            ($null -eq $r.MergeChainDefects) | Should -BeFalse
        }
    }
}
