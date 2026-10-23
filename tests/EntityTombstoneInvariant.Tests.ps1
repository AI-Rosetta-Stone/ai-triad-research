# Tag: unit (t/4450)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4450: merged_into set => status 'deprecated' (CL t/4450#2). The writer enforces it, the report flags
# records written before it, extraction links tombstone names to the canonical, and one predicate scopes
# both the extraction vector index and the orphan-vector check.

#Requires -Module Pester

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue

    function script:New-Store([object[]]$Entities, [string]$Dir) {
        $p = Join-Path $Dir 'entities.json'
        [IO.File]::WriteAllText($p, ([ordered]@{ _schema_version = '1.0.0'; entity_count = @($Entities).Count; entities = @($Entities) } | ConvertTo-Json -Depth 8))
        $p
    }
    function script:New-Emb([string[]]$Ids, [string]$Dir) {
        $v = [ordered]@{}; $h = [ordered]@{}
        foreach ($i in $Ids) { $v[$i] = [ordered]@{ name_vector = @(1.0, 0.0, 0.0) }; $h[$i] = "hash-$i" }
        $p = Join-Path $Dir 'entity_embeddings.json'
        [IO.File]::WriteAllText($p, ([ordered]@{ _schema_version = '2.0.0'; vectors = $v; _src_hashes = $h } | ConvertTo-Json -Depth 8))
        $p
    }
    function script:Ent([string]$Id, [string]$Name, [string]$Status = 'approved', [string]$MergedInto, [string[]]$Aliases = @()) {
        $e = [ordered]@{ id = $Id; name = $Name; aliases = $Aliases; entity_type = 'artifact'; dolce_category = 'non-agentive-functional-artifact'; description = "A thing called $Name."; status = $Status; created_at = '2026-01-01'; last_modified = '2026-01-01' }
        if ($MergedInto) { $e.merged_into = $MergedInto }
        [pscustomobject]$e
    }
}

Describe 'Import-Entity writes every tombstone as deprecated (t/4450)' -Tag 'unit' {
    BeforeEach {
        $script:dir = Join-Path ([IO.Path]::GetTempPath()) ("t4450-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force $script:dir | Out-Null
        $script:ent = New-Store @((Ent 'ent-001' 'Canonical'), (Ent 'ent-002' 'Copy')) $script:dir
        $script:emb = New-Emb @('ent-001', 'ent-002') $script:dir
        Mock Assert-DataWriteAllowed -ModuleName AITriad { }
    }
    AfterEach { Remove-Item -Recurse -Force $script:dir -ErrorAction SilentlyContinue }

    It 'a merge with no status writes deprecated and drops the tombstone''s vector and fingerprint' {
        $r = Import-Entity -Proposal @(@{ id = 'ent-002'; merged_into = 'ent-001' }) -Path $ent -EmbeddingsPath $emb -SkipEmbedding -Confirm:$false
        $r.Status | Should -Be 'deprecated'
        $rec = (Get-Content -Raw $ent | ConvertFrom-Json).entities | Where-Object id -eq 'ent-002'
        $rec.status | Should -Be 'deprecated'
        $rec.merged_into | Should -Be 'ent-001'
        $e = Get-Content -Raw $emb | ConvertFrom-Json
        $e.vectors.PSObject.Properties.Name | Should -Be @('ent-001')
        $e._src_hashes.PSObject.Properties.Name | Should -Be @('ent-001')
    }

    It 'refuses an explicit approved status alongside merged_into, and writes nothing' {
        $before = [IO.File]::ReadAllText($ent)
        { Import-Entity -Proposal @(@{ id = 'ent-002'; merged_into = 'ent-001'; status = 'approved' }) -Path $ent -EmbeddingsPath $emb -SkipEmbedding -Confirm:$false } |
            Should -Throw -ExpectedMessage "*sets status 'approved' on a merge tombstone*"
        [IO.File]::ReadAllText($ent) | Should -BeExactly $before
    }

    It 'accepts an explicit deprecated status alongside merged_into' {
        (Import-Entity -Proposal @(@{ id = 'ent-002'; merged_into = 'ent-001'; status = 'deprecated' }) -Path $ent -EmbeddingsPath $emb -SkipEmbedding -Confirm:$false).Status | Should -Be 'deprecated'
    }

    It 'an update of an existing tombstone (no merged_into on the proposal) stays deprecated' {
        $ent = New-Store @((Ent 'ent-001' 'Canonical'), (Ent 'ent-002' 'Copy' 'approved' 'ent-001')) $dir
        (Import-Entity -Proposal @(@{ id = 'ent-002'; description = 'Edited.' }) -Path $ent -EmbeddingsPath $emb -SkipEmbedding -Confirm:$false).Status | Should -Be 'deprecated'
        { Import-Entity -Proposal @(@{ id = 'ent-002'; status = 'approved' }) -Path $ent -EmbeddingsPath $emb -SkipEmbedding -Confirm:$false } | Should -Throw -ExpectedMessage '*merge tombstone*'
    }

    It 'a non-tombstone approval is unchanged (control)' {
        (Import-Entity -Proposal @(@{ id = 'ent-002'; status = 'approved' }) -Path $ent -EmbeddingsPath $emb -SkipEmbedding -Confirm:$false).Status | Should -Be 'approved'
        @((Get-Content -Raw $emb | ConvertFrom-Json).vectors.PSObject.Properties.Name) | Should -Contain 'ent-002'
    }
}

Describe 'Get-EntityReport tombstone-status and orphan-vector (t/4450)' -Tag 'unit' {
    BeforeAll {
        $script:dir = Join-Path ([IO.Path]::GetTempPath()) ("t4450r-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force $script:dir | Out-Null
        $script:ent = New-Store @(
            (Ent 'ent-001' 'Canonical')
            (Ent 'ent-002' 'Approved tombstone' 'approved' 'ent-001')
            (Ent 'ent-003' 'Good tombstone' 'deprecated' 'ent-001')
            (Ent 'ent-004' 'Proposed' 'proposed')
        ) $script:dir
        $script:emb = New-Emb @('ent-001', 'ent-002', 'ent-004', 'ent-999') $script:dir
    }
    AfterAll { Remove-Item -Recurse -Force $script:dir -ErrorAction SilentlyContinue }

    It 'tombstone-status lists only the merged record that is not deprecated' {
        $r = Get-EntityReport -Report tombstone-status -EntitiesPath $ent -EmbeddingsPath $emb
        @($r.TombstoneStatus.Entities).Id | Should -Be @('ent-002')
        $r.TombstoneStatus.Entities[0].MergedInto | Should -Be 'ent-001'
    }

    It 'orphan-vector lists the tombstone, the non-approved and the absent record, each with its reason' {
        $v = @((Get-EntityReport -Report orphan-vector -EntitiesPath $ent -EmbeddingsPath $emb).OrphanVector.Vectors)
        ($v | ForEach-Object { "$($_.Id)=$($_.Reason)" }) | Should -Be @('ent-002=tombstone', 'ent-004=status-proposed', 'ent-999=record-absent')
    }

    It 'the extraction vector index and orphan-vector partition the same vectors (one shared predicate)' {
        $orph = @((Get-EntityReport -Report orphan-vector -EntitiesPath $ent -EmbeddingsPath $emb).OrphanVector.Vectors.Id)
        $entities = @((Get-Content -Raw $ent | ConvertFrom-Json).entities)
        $indexed = & (Get-Module AITriad) { param($p, $e) @((Get-EntityVectorIndex -Path $p -Entities $e 3>$null).Vectors.Keys) } $emb $entities
        @($indexed) | Should -Be @('ent-001')
        @(@($indexed) + $orph | Sort-Object) | Should -Be @('ent-001', 'ent-002', 'ent-004', 'ent-999')
    }
}

Describe 'Extraction indexes link tombstone names to the canonical (t/4450 (d))' -Tag 'unit' {
    It 'a tombstone''s name and aliases map to the chain''s end; a live name wins a collision' {
        $r = InModuleScope AITriad {
            $es = @(
                [pscustomobject]@{ id = 'ent-001'; name = 'Final'; aliases = @() ; status = 'approved' }
                [pscustomobject]@{ id = 'ent-002'; name = 'Middle'; aliases = @('Shared name'); status = 'deprecated'; merged_into = 'ent-001' }
                [pscustomobject]@{ id = 'ent-003'; name = 'Start'; aliases = @('Start alias'); status = 'approved'; merged_into = 'ent-002' }
                [pscustomobject]@{ id = 'ent-004'; name = 'Shared name'; aliases = @(); status = 'approved' }
            )
            $ix = @{}
            Add-EntityStoreMatch -Index $ix -Entities $es
            $ix
        }
        $r['start'].Id | Should -Be 'ent-001'
        $r['start alias'].Id | Should -Be 'ent-001'
        $r['start alias'].Label | Should -Be 'Final'
        $r['middle'].Id | Should -Be 'ent-001'
        $r['shared name'].Id | Should -Be 'ent-004' -Because 'a live name beats a tombstone alias, whatever the file order'
    }

    It 'a cycle or a dangling target keeps the tombstone itself, with a WARN' {
        $out = InModuleScope AITriad {
            $es = @(
                [pscustomobject]@{ id = 'ent-010'; name = 'Loop A'; aliases = @(); status = 'deprecated'; merged_into = 'ent-011' }
                [pscustomobject]@{ id = 'ent-011'; name = 'Loop B'; aliases = @(); status = 'deprecated'; merged_into = 'ent-010' }
                [pscustomobject]@{ id = 'ent-012'; name = 'Dangling'; aliases = @(); status = 'deprecated'; merged_into = 'ent-404' }
            )
            $ix = @{}
            $w = @(Add-EntityStoreMatch -Index $ix -Entities $es 3>&1 | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
            [pscustomobject]@{ Ix = $ix; W = $w }
        }
        $out.Ix['loop a'].Id | Should -Be 'ent-010'
        $out.Ix['dangling'].Id | Should -Be 'ent-012'
        @($out.W | Where-Object { "$_" -match 'broken' }).Count | Should -Be 2
        @($out.W | Where-Object { "$_" -match "ent-404', which is not in the store" }).Count | Should -Be 1
    }

    It 'an empty store adds nothing and does not throw' {
        InModuleScope AITriad { $ix = @{}; Add-EntityStoreMatch -Index $ix -Entities $null; $ix.Count } | Should -Be 0
    }

    It 'the vector index skips ineligible vectors with a WARN' {
        $dir = Join-Path ([IO.Path]::GetTempPath()) ("t4450v-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force $dir | Out-Null
        try {
            $emb = New-Emb @('ent-001', 'ent-002') $dir
            $es = @((Ent 'ent-001' 'Live'), (Ent 'ent-002' 'Tomb' 'approved' 'ent-001'))
            $res = & (Get-Module AITriad) {
                param($p, $e)
                $all = @(Get-EntityVectorIndex -Path $p -Entities $e 3>&1)
                $ix = $all | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }
                [pscustomobject]@{ Keys = @($ix.Vectors.Keys); W = @($all | Where-Object { $_ -is [System.Management.Automation.WarningRecord] }) }
            } $emb $es
            $res.Keys | Should -Be @('ent-001')
            @($res.W | Where-Object { "$_" -match 'skipped 1 entity vector' }).Count | Should -Be 1
        } finally { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
    }
}
