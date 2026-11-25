# Characterization tests for the two refactored helpers in
# scripts/AITriad/Private/InvokeEntityExtractionSteps.ps1 (CC reduction, behavior-preserving).
# Race-safe: dot-sources ONLY this Private file (pure function defs), never Import-Module the
# batch worktree module. External deps (Test-SourceSelectable, Test-EntityVectorEligible) are
# stubbed in script scope so the in-file functions resolve them at call time.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'Private' 'InvokeEntityExtractionSteps.ps1')

    # Stub external dep used by Get-EntityVectorIndex / eligible-set building.
    function Test-EntityVectorEligible { param($Entity) $true }
    # Stub external dep used by ConvertTo-EntityExtractionWorkItem when a Resolution is passed.
    function Test-SourceSelectable { param($Resolution, $Id) $Id -ne 'dropdoc' }
}

Describe 'ConvertTo-EntityExtractionWorkItem' {
    It 'returns $null when there are no facts' {
        $r = ConvertTo-EntityExtractionWorkItem -NodeId 'acc-foo-001' -Entry @{} -Resolution $null
        $r | Should -BeNullOrEmpty
    }

    It 'returns $null when facts have no claims' {
        $entry = @{ facts = @(@{ doc_id = 'd1' }) }
        $r = ConvertTo-EntityExtractionWorkItem -NodeId 'n1' -Entry $entry -Resolution $null
        $r | Should -BeNullOrEmpty
    }

    It 'builds claims, unique doc ids and fact pairs' {
        $entry = @{ facts = @(
            @{ doc_id = 'd1'; claim = 'c1' },
            @{ doc_id = 'd1'; claim = 'c2' },
            @{ doc_id = 'd2'; claim = 'c3' }
        ) }
        $r = ConvertTo-EntityExtractionWorkItem -NodeId 'n1' -Entry $entry -Resolution $null
        $r.NodeId | Should -Be 'n1'
        $r.FactsText | Should -Be "- c1`n- c2`n- c3"
        @($r.DocIds) | Should -Be @('d1', 'd2')
        @($r.Facts).Count | Should -Be 3
        $r.Facts[0].doc_id | Should -Be 'd1'
        $r.Facts[0].claim | Should -Be 'c1'
    }

    It 'skips non-hashtable facts' {
        $entry = @{ facts = @('notahash', @{ claim = 'keep' }) }
        $r = ConvertTo-EntityExtractionWorkItem -NodeId 'n1' -Entry $entry -Resolution $null
        $r.FactsText | Should -Be '- keep'
    }

    It 'includes a claim with no doc_id but adds no doc id or fact pair' {
        $entry = @{ facts = @(@{ claim = 'only-claim' }) }
        $r = ConvertTo-EntityExtractionWorkItem -NodeId 'n1' -Entry $entry -Resolution $null
        $r.FactsText | Should -Be '- only-claim'
        @($r.DocIds).Count | Should -Be 0
        @($r.Facts).Count | Should -Be 0
    }

    It 'drops facts whose doc_id is not selectable when a Resolution is given' {
        $entry = @{ facts = @(
            @{ doc_id = 'dropdoc'; claim = 'gone' },
            @{ doc_id = 'keepdoc'; claim = 'stays' }
        ) }
        $r = ConvertTo-EntityExtractionWorkItem -NodeId 'n1' -Entry $entry -Resolution ([pscustomobject]@{})
        $r.FactsText | Should -Be '- stays'
        @($r.DocIds) | Should -Be @('keepdoc')
    }
}

Describe 'Get-EntityVectorIndex' {
    It 'reports a missing file via Problem and empty vectors' {
        $idx = Get-EntityVectorIndex -Path (Join-Path $TestDrive 'missing.json') -Entities @()
        $idx.Problem | Should -Be 'entity_embeddings.json not found'
        $idx.Vectors.Count | Should -Be 0
    }

    It 'loads eligible name vectors (v1 flat + v2 object), records model, keyed by id' {
        $store = [ordered]@{
            model   = 'all-MiniLM-L6-v2'
            vectors = [ordered]@{
                'ent-1' = @(0.1, 0.2, 0.3)
                'ent-2' = @{ name_vector = @(0.4, 0.5) }
            }
        }
        $p = Join-Path $TestDrive 'emb.json'
        $store | ConvertTo-Json -Depth 6 | Set-Content -Path $p -Encoding utf8
        $ents = @([pscustomobject]@{ id = 'ent-1' }, [pscustomobject]@{ id = 'ent-2' })
        $idx = Get-EntityVectorIndex -Path $p -Entities $ents
        $idx.Model | Should -Be 'all-MiniLM-L6-v2'
        $idx.Vectors.Count | Should -Be 2
        $idx.Vectors['ent-1'].Length | Should -Be 3
        $idx.Vectors['ent-2'].Length | Should -Be 2
        $idx.Problem | Should -BeNullOrEmpty
    }

    It 'skips vectors whose id is not in the eligible set' {
        $store = [ordered]@{
            model   = 'm'
            vectors = [ordered]@{ 'ent-1' = @(0.1); 'orphan' = @(0.9) }
        }
        $p = Join-Path $TestDrive 'emb2.json'
        $store | ConvertTo-Json -Depth 6 | Set-Content -Path $p -Encoding utf8
        $ents = @([pscustomobject]@{ id = 'ent-1' })
        $idx = Get-EntityVectorIndex -Path $p -Entities $ents -WarningAction SilentlyContinue
        $idx.Vectors.Count | Should -Be 1
        $idx.Vectors.ContainsKey('ent-1') | Should -BeTrue
    }

    It 'sets Problem when the store has no vectors field' {
        $p = Join-Path $TestDrive 'emb3.json'
        [ordered]@{ model = 'm' } | ConvertTo-Json | Set-Content -Path $p -Encoding utf8
        $idx = Get-EntityVectorIndex -Path $p -Entities @()
        $idx.Problem | Should -Be 'entity_embeddings.json has no entity vectors'
    }
}

Describe 'Get-EntityVectorEligibleSet' {
    It 'returns an empty HashSet (never $null) when no entity is eligible (t/4450 warning path)' {
        # Regression guard: a bare `return $eligible` enumerates the set, so an empty result
        # reached the caller as $null and the skipped-vector WARN became a null-method error.
        function Test-EntityVectorEligible { param($Entity) $false }
        $r = Get-EntityVectorEligibleSet -Entities @([pscustomobject]@{ id = 'a' }, [pscustomobject]@{ id = 'b' })
        $null -ne $r | Should -BeTrue
        $r.GetType().Name | Should -BeExactly 'HashSet`1'
        $r.Count | Should -Be 0
        $r.Contains('a') | Should -BeFalse
    }

    It 'returns the eligible ids as an ordinal HashSet' {
        function Test-EntityVectorEligible { param($Entity) $Entity.id -ne 'skip' }
        $r = Get-EntityVectorEligibleSet -Entities @([pscustomobject]@{ id = 'keep' }, [pscustomobject]@{ id = 'skip' })
        $r.GetType().Name | Should -BeExactly 'HashSet`1'
        $r.Contains('keep') | Should -BeTrue
        $r.Contains('skip') | Should -BeFalse
    }
}
