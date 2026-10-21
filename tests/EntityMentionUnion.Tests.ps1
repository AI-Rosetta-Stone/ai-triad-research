# Tag: evidence-union (t/4337, docs/specs/source-identity.md section 7.7)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# The entity-mention index's duplicate-group union (spec 7.7, key form TL p/360#661): the shared
# fixture's mention_key_cases and derived_key_cases, then the index builder end to end.

BeforeDiscovery {
    $fx = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'fixtures' 'evidence-union-cases.json') | ConvertFrom-Json -AsHashtable
    $script:MentionCases = @($fx.mention_key_cases)
    $script:DerivedCases = @($fx.derived_key_cases)
}

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    $script:FxObj = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'fixtures' 'evidence-union-cases.json') | ConvertFrom-Json
}

Describe 'Mention-container union (spec 7.7, fixture v2)' -Tag 'evidence-union' {
    It '<name>' -ForEach $script:MentionCases {
        $case = @($script:FxObj.mention_key_cases) | Where-Object name -eq $name
        $got = InModuleScope AITriad -Parameters @{ C = $case } {
            param($C)
            $containers = [ordered]@{}
            $copies = [System.Collections.Generic.List[object]]::new()
            foreach ($s in @($C.summaries)) {
                if ($s.id -ceq $C.canonical) {
                    Add-EmiKeyPointContainers -Summary $s.summary -DocId $s.id -Containers $containers
                    Add-EmiFactualClaimContainers -Summary $s.summary -DocId $s.id -Containers $containers
                } else {
                    $copies.Add([pscustomobject]@{ CopyId = $s.id; CanonicalId = $C.canonical; Summary = $s.summary })   # deliberately unsorted
                }
            }
            $before = @($containers.Keys)
            Add-EmiUnionContainers -Copies $copies.ToArray() -Containers $containers
            $added = [ordered]@{}
            foreach ($k in $containers.Keys) { if ($k -notin $before) { $added[$k] = $containers[$k] } }
            $added
        }
        @($got.Keys | Sort-Object) | Should -Be @($expected_containers.Keys | Sort-Object)
        foreach ($k in $expected_containers.Keys) { $got[$k] | Should -BeExactly $expected_containers[$k] }
    }

    It 'derived key <key> -> <derived>' -ForEach $script:DerivedCases {
        InModuleScope AITriad -Parameters @{ K = $key } { param($K) Test-EmiDerivedContainerKey -Cid $K } | Should -Be $derived
    }
}

Describe 'Update-EntityMentionIndex with a duplicate group (spec 7.7)' -Tag 'evidence-union' {
    BeforeEach {
        $script:Root = Join-Path ([IO.Path]::GetTempPath()) "ait-emu-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        $script:Src = Join-Path $script:Root 'src'; $script:Sum = Join-Path $script:Root 'sum'; $script:Tax = Join-Path $script:Root 'tax'
        New-Item -ItemType Directory -Force -Path $script:Src, $script:Sum, $script:Tax | Out-Null
        $u = [Text.UTF8Encoding]::new($false); $long = ((1..120 | ForEach-Object { "word$_" }) -join ' ')
        foreach ($p in @(@('report-2026', [ordered]@{ id = 'report-2026'; title = 'Report' }), @('report-2026-1', [ordered]@{ id = 'report-2026-1'; title = 'Report'; duplicate_of = 'report-2026' }))) {
            $d = Join-Path $script:Src $p[0]; New-Item -ItemType Directory -Force -Path $d | Out-Null
            [IO.File]::WriteAllText((Join-Path $d 'metadata.json'), ($p[1] | ConvertTo-Json), $u)
            [IO.File]::WriteAllText((Join-Path $d 'snapshot.md'), "# Report`n`n$long`n", $u)
        }
        $sum = { param($id, $claims) [IO.File]::WriteAllText((Join-Path $script:Sum "$id.json"), (@{ doc_id = $id; pov_summaries = @{ safetyist = @{ key_points = @() } }; factual_claims = @($claims | ForEach-Object { @{ claim = $_ } }) } | ConvertTo-Json -Depth 6), $u) }
        & $sum 'report-2026' @('Apollo Project funding rose.')
        & $sum 'report-2026-1' @('Apollo Project funding rose', 'The Manhattan Project is cited as a precedent.')
        $script:Ent = Join-Path $script:Tax 'entities.json'
        [IO.File]::WriteAllText($script:Ent, (@{ schema_version = 1; entities = @(
            @{ id = 'ent-001'; name = 'Apollo Project'; entity_type = 'project'; dolce_category = 'event'; aliases = @(); status = 'approved' }
            @{ id = 'ent-002'; name = 'Manhattan Project'; entity_type = 'project'; dolce_category = 'event'; aliases = @(); status = 'approved' }) } | ConvertTo-Json -Depth 6), $u)
        $script:Sei = Join-Path $script:Tax 'sei.json'; [IO.File]::WriteAllText($script:Sei, '{}', $u)
        $script:Out = Join-Path $script:Tax 'entity_mentions.json'
        Mock Get-SummariesDir -ModuleName AITriad { $script:Sum }
        Mock Get-SourcesDir   -ModuleName AITriad { $script:Src }
        $script:Run = { Update-EntityMentionIndex -EntitiesPath $script:Ent -SourceEvidenceIndexPath $script:Sei -OutputPath $script:Out -Confirm:$false 3>$null 6>$null | Out-Null; (Get-Content -Raw $script:Out | ConvertFrom-Json).containers }
    }
    AfterEach { Remove-Item $script:Root -Recurse -Force -ErrorAction SilentlyContinue }

    It 'adds the copy''s distinct claim under the canonical''s via- key, never a summary:<copy> key' {
        $c = & $script:Run
        $keys = @($c.PSObject.Properties.Name)
        $keys | Should -Contain 'summary:report-2026#fc-0'
        $keys | Should -Contain 'summary:report-2026#via-report-2026-1-fc-1'
        @($keys | Where-Object { $_ -like 'summary:report-2026-1#*' }).Count | Should -Be 0
        @($keys | Where-Object { $_ -like '*#via-report-2026-1-fc-0' }).Count | Should -Be 0 -Because 'near-equal to the canonical''s claim'
        $c.'summary:report-2026#via-report-2026-1-fc-1'.mentions[0].entity_ref | Should -BeExactly 'ent-002'
    }

    It 'is derived: removing the mark removes the via- key on the next build (stability, TL condition 2)' {
        [void](& $script:Run)
        [IO.File]::WriteAllText((Join-Path $script:Src 'report-2026-1' 'metadata.json'), (@{ id = 'report-2026-1'; title = 'Report' } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        $keys = @((& $script:Run).PSObject.Properties.Name)
        @($keys | Where-Object { $_ -like '*#via-*' }).Count | Should -Be 0
        $keys | Should -Contain 'summary:report-2026-1#fc-1' -Because 'unmarked, the copy is its own doc again'
    }

    It 'drops a human mention on a derived key with a WARN, never silently' {
        [void](& $script:Run)
        $doc = Get-Content -Raw $script:Out | ConvertFrom-Json
        $cid = 'summary:report-2026#via-report-2026-1-fc-1'
        $doc.containers.$cid.mentions = @([pscustomobject]@{ offset = 4; quote = 'Manhattan Project'; entity_ref = 'ent-002'; discovered_by = 'human' })
        [IO.File]::WriteAllText($script:Out, ($doc | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
        $w = $null
        Update-EntityMentionIndex -EntitiesPath $script:Ent -SourceEvidenceIndexPath $script:Sei -OutputPath $script:Out -Confirm:$false -WarningVariable w -WarningAction SilentlyContinue 6>$null | Out-Null
        ($w -join "`n") | Should -Match "dropped 1 human mention\(s\) on derived container 'summary:report-2026#via-report-2026-1-fc-1'"
        $after = (Get-Content -Raw $script:Out | ConvertFrom-Json).containers.$cid.mentions
        @($after | Where-Object { $_.discovered_by -eq 'human' }).Count | Should -Be 0
    }
}
