# Tag: taxonomy (t/3431)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# Regression tests for Update-PolicyRegistry -Fix (t/3431). The bug: a whole-file rewrite PER
# unregistered action inside the assign loop self-dirtied the file, so the BLOCK-tier dirty-tree guard
# false-blocked the 2nd write and aborted mid-run, leaving the file referencing an unpersisted pol-id.
# Fix: accumulate edits and write ONCE per file after the loop, plus MaxId over registry∪referenced ids
# so a re-run can't re-mint an already-referenced (but unpersisted) id.
#
# The dirty-tree guard is git-based and inert in a non-git TestDrive, so the distinguishing signal is
# the WRITE COUNT (1 per file with the fix vs N without). POV files go through Write-PovTaxonomyFile
# (the canonical funnel, t/4356), spied as a counting pass-through to the real funnel, and the registry
# through Write-Utf8NoBom (real Set-Content), so the cmdlet's post-fix re-scan still sees the persisted edits.

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
}

Describe 'Update-PolicyRegistry -Fix (t/3431 batched write + idempotent MaxId)' -Tag 'taxonomy' {

    It 'batches >=2 unregistered actions in one file into a SINGLE write (no self-block, no partial state)' {
        InModuleScope AITriad {
            $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "polreg-batch-$(Get-Random)"
            New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
            try {
                # situations.json: sit-keep references the existing registry ids (so they survive orphan
                # removal — keeping the registry max at 3); sit-477 has THREE unregistered actions (repro).
                @{ _schema_version = '1.0.0'; last_modified = '2026-09-12'; nodes = @(
                        @{ id = 'sit-keep'; graph_attributes = @{ policy_actions = @(
                                    @{ action = 'p1'; framing = 'f'; policy_id = 'pol-001' }
                                    @{ action = 'p2'; framing = 'f'; policy_id = 'pol-002' }
                                    @{ action = 'p3'; framing = 'f'; policy_id = 'pol-003' }
                                ) } }
                        @{ id = 'sit-477'; graph_attributes = @{ policy_actions = @(
                                    @{ action = 'Action Alpha'; framing = 'fa' }
                                    @{ action = 'Action Bravo'; framing = 'fb' }
                                    @{ action = 'Action Charlie'; framing = 'fc' }
                                ) } }
                    ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $TempDir 'situations.json')
                @{ _schema_version = '1.0.0'; _doc = 'x'; policy_count = 3; policies = @(
                        @{ id = 'pol-001'; action = 'p1'; source_povs = @('situations'); member_count = 1; status = 'active' }
                        @{ id = 'pol-002'; action = 'p2'; source_povs = @('situations'); member_count = 1; status = 'active' }
                        @{ id = 'pol-003'; action = 'p3'; source_povs = @('situations'); member_count = 1; status = 'active' }
                    ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $TempDir 'policy_actions.json')

                . (Join-Path $PSScriptRoot 'PolicyPovFixture.ps1'); Add-PolicyPovFillers -Dir $TempDir
                Mock Get-TaxonomyDir { $TempDir }
                Mock Write-Utf8NoBom { Set-Content -Path $Path -Value $Value -Encoding utf8 }
                # POV files go through the canonical funnel (t/4356): a counting pass-through to the real one.
                $script:RealFunnel = ${function:Write-PovTaxonomyFile}
                Mock Write-PovTaxonomyFile { & $script:RealFunnel -Path $Path -Data $Data -RequireCleanTree:$RequireCleanTree -AllowDirty:$AllowDirty }

                { Update-PolicyRegistry -Fix } | Should -Not -Throw

                # THE regression assertion: exactly ONE write for situations.json (old code = 3, one per action).
                Should -Invoke Write-PovTaxonomyFile -Times 1 -Exactly -ParameterFilter { $Path -like '*situations.json' }

                # All 3 actions now carry ids in the file; ids are the next 3 after the registry max.
                $sit = Get-Content -Raw -Path (Join-Path $TempDir 'situations.json') | ConvertFrom-Json
                $sit477 = $sit.nodes | Where-Object { $_.id -eq 'sit-477' }
                $pas = @($sit477.graph_attributes.policy_actions)
                @($pas | Where-Object { $_.PSObject.Properties['policy_id'] -and $_.policy_id }).Count | Should -Be 3
                @($pas.policy_id | Sort-Object) | Should -Be @('pol-004', 'pol-005', 'pol-006')

                # Registry is CONSISTENT — every freshly-referenced id is persisted (no partial state).
                $reg = Get-Content -Raw -Path (Join-Path $TempDir 'policy_actions.json') | ConvertFrom-Json
                $regIds = @($reg.policies.id)
                foreach ($id in @('pol-004', 'pol-005', 'pol-006')) { $regIds | Should -Contain $id }
            } finally {
                Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    It 'does not re-mint an id already referenced-but-unregistered on disk (idempotent MaxId collision-proof)' {
        InModuleScope AITriad {
            $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "polreg-idem-$(Get-Random)"
            New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
            try {
                # sit-A already references pol-005 (a prior partial run wrote the ref but not the registry);
                # pol-005 is NOT in the registry (max there is pol-004). sit-B has an unregistered action.
                @{ _schema_version = '1.0.0'; nodes = @(
                        # sit-keep references the registry ids so they survive orphan removal (max stays 4).
                        @{ id = 'sit-keep'; graph_attributes = @{ policy_actions = @(
                                    @{ action = 'a'; framing = 'f'; policy_id = 'pol-001' }
                                    @{ action = 'b'; framing = 'f'; policy_id = 'pol-002' }
                                    @{ action = 'c'; framing = 'f'; policy_id = 'pol-003' }
                                    @{ action = 'd'; framing = 'f'; policy_id = 'pol-004' }
                                ) } }
                        @{ id = 'sit-A'; graph_attributes = @{ policy_actions = @(
                                    @{ action = 'already assigned'; framing = 'f'; policy_id = 'pol-005' }
                                ) } }
                        @{ id = 'sit-B'; graph_attributes = @{ policy_actions = @(
                                    @{ action = 'needs an id'; framing = 'f' }
                                ) } }
                    ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $TempDir 'situations.json')
                @{ _schema_version = '1.0.0'; _doc = 'x'; policy_count = 4; policies = @(
                        @{ id = 'pol-001'; action = 'a'; source_povs = @('situations'); member_count = 1; status = 'active' }
                        @{ id = 'pol-002'; action = 'b'; source_povs = @('situations'); member_count = 1; status = 'active' }
                        @{ id = 'pol-003'; action = 'c'; source_povs = @('situations'); member_count = 1; status = 'active' }
                        @{ id = 'pol-004'; action = 'd'; source_povs = @('situations'); member_count = 1; status = 'active' }
                    ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $TempDir 'policy_actions.json')

                . (Join-Path $PSScriptRoot 'PolicyPovFixture.ps1'); Add-PolicyPovFillers -Dir $TempDir
                Mock Get-TaxonomyDir { $TempDir }
                Mock Write-Utf8NoBom { Set-Content -Path $Path -Value $Value -Encoding utf8 }
                # POV files go through the canonical funnel (t/4356): a counting pass-through to the real one.
                $script:RealFunnel = ${function:Write-PovTaxonomyFile}
                Mock Write-PovTaxonomyFile { & $script:RealFunnel -Path $Path -Data $Data -RequireCleanTree:$RequireCleanTree -AllowDirty:$AllowDirty }

                Update-PolicyRegistry -Fix | Out-Null

                $sit = Get-Content -Raw -Path (Join-Path $TempDir 'situations.json') | ConvertFrom-Json
                $bNode = $sit.nodes | Where-Object { $_.id -eq 'sit-B' }
                $bId = $bNode.graph_attributes.policy_actions[0].policy_id
                # max(registry 004, referenced-on-disk 005) + 1 = pol-006 — NOT pol-005 (that would collide
                # with sit-A's existing reference). Registry-only MaxId would have re-minted pol-005.
                $bId | Should -Be 'pol-006'
                $bId | Should -Not -Be 'pol-005'
            } finally {
                Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    It 'writes no POV file when there are no unregistered actions' {
        InModuleScope AITriad {
            $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "polreg-clean-$(Get-Random)"
            New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
            try {
                @{ _schema_version = '1.0.0'; nodes = @(
                        @{ id = 'sit-C'; graph_attributes = @{ policy_actions = @(
                                    @{ action = 'registered'; framing = 'f'; policy_id = 'pol-001' }
                                ) } }
                    ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $TempDir 'situations.json')
                @{ _schema_version = '1.0.0'; _doc = 'x'; policy_count = 1; policies = @(
                        @{ id = 'pol-001'; action = 'registered'; source_povs = @('situations'); member_count = 1; status = 'active' }
                    ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $TempDir 'policy_actions.json')

                . (Join-Path $PSScriptRoot 'PolicyPovFixture.ps1'); Add-PolicyPovFillers -Dir $TempDir
                Mock Get-TaxonomyDir { $TempDir }
                Mock Write-Utf8NoBom { Set-Content -Path $Path -Value $Value -Encoding utf8 }
                # POV files go through the canonical funnel (t/4356): a counting pass-through to the real one.
                $script:RealFunnel = ${function:Write-PovTaxonomyFile}
                Mock Write-PovTaxonomyFile { & $script:RealFunnel -Path $Path -Data $Data -RequireCleanTree:$RequireCleanTree -AllowDirty:$AllowDirty }

                { Update-PolicyRegistry -Fix } | Should -Not -Throw
                # No unregistered actions → no POV-file rewrite at all (only the registry may be rewritten).
                Should -Invoke Write-PovTaxonomyFile -Times 0 -Exactly -ParameterFilter { $Path -like '*situations.json' }
            } finally {
                Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    It 're-adds a "missing from registry" id from the node action; registry-only; idempotent (t/3435)' {
        InModuleScope AITriad {
            $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "polreg-missing-$(Get-Random)"
            New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
            try {
                # sit-A references pol-005, which a prior partial run wrote onto the node but NEVER persisted
                # to the registry (the pol-3368/9 class). sit-keep references pol-001 so it survives orphan removal.
                @{ _schema_version = '1.0.0'; nodes = @(
                        @{ id = 'sit-keep'; graph_attributes = @{ policy_actions = @(
                                    @{ action = 'kept'; framing = 'f'; policy_id = 'pol-001' }
                                ) } }
                        @{ id = 'sit-A'; graph_attributes = @{ policy_actions = @(
                                    @{ action = 'Orphaned reference action'; framing = 'fx'; policy_id = 'pol-005' }
                                ) } }
                    ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $TempDir 'situations.json')
                @{ _schema_version = '1.0.0'; _doc = 'x'; policy_count = 1; policies = @(
                        @{ id = 'pol-001'; action = 'kept'; source_povs = @('situations'); member_count = 1; status = 'active' }
                    ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $TempDir 'policy_actions.json')

                . (Join-Path $PSScriptRoot 'PolicyPovFixture.ps1'); Add-PolicyPovFillers -Dir $TempDir
                Mock Get-TaxonomyDir { $TempDir }
                Mock Write-Utf8NoBom { Set-Content -Path $Path -Value $Value -Encoding utf8 }
                # POV files go through the canonical funnel (t/4356): a counting pass-through to the real one.
                $script:RealFunnel = ${function:Write-PovTaxonomyFile}
                Mock Write-PovTaxonomyFile { & $script:RealFunnel -Path $Path -Data $Data -RequireCleanTree:$RequireCleanTree -AllowDirty:$AllowDirty }

                { Update-PolicyRegistry -Fix } | Should -Not -Throw
                $reg = Get-Content -Raw (Join-Path $TempDir 'policy_actions.json') | ConvertFrom-Json
                $readded = $reg.policies | Where-Object { $_.id -eq 'pol-005' }
                $readded | Should -Not -BeNullOrEmpty                             # re-added to the registry
                $readded.action | Should -Be 'Orphaned reference action'         # action sourced from the node
                @($readded.source_povs) | Should -Contain 'situations'
                # Registry-only: the node already carries pol-005, so no POV-file rewrite.
                Should -Invoke Write-PovTaxonomyFile -Times 0 -Exactly -ParameterFilter { $Path -like '*situations.json' }

                # Idempotent: a second -Fix now reports Missing 0.
                $r2 = Update-PolicyRegistry -Fix -PassThru
                $r2.Missing | Should -Be 0
            } finally {
                Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    It 'skips the registry rewrite when already consistent, so a dirty registry does not block' {
        InModuleScope AITriad {
            $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) "polreg-noop-$(Get-Random)"
            New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
            try {
                # Repro: Invoke-BatchSummary adds policies (uncommitted) then runs -Fix. Nothing needs fixing,
                # but the unconditional rewrite hit the dirty-tree guard and reported a consolidation failure.
                @{ _schema_version = '1.0.0'; nodes = @(
                        @{ id = 'sit-C'; graph_attributes = @{ policy_actions = @(
                                    @{ action = 'registered'; framing = 'f'; policy_id = 'pol-001' }
                                ) } }
                    ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $TempDir 'situations.json')
                @{ _schema_version = '1.0.0'; _doc = 'x'; policy_count = 1; policies = @(
                        @{ id = 'pol-001'; action = 'registered'; source_povs = @('situations'); member_count = 1; status = 'active' }
                    ) } | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $TempDir 'policy_actions.json')

                . (Join-Path $PSScriptRoot 'PolicyPovFixture.ps1'); Add-PolicyPovFillers -Dir $TempDir
                Mock Get-TaxonomyDir { $TempDir }
                Mock Write-Utf8NoBom { Set-Content -Path $Path -Value $Value -Encoding utf8 }
                # POV files go through the canonical funnel (t/4356): a counting pass-through to the real one.
                $script:RealFunnel = ${function:Write-PovTaxonomyFile}
                Mock Write-PovTaxonomyFile { & $script:RealFunnel -Path $Path -Data $Data -RequireCleanTree:$RequireCleanTree -AllowDirty:$AllowDirty }
                Update-PolicyRegistry -Fix | Out-Null   # normalize to canonical serialization

                $regPath = Join-Path $TempDir 'policy_actions.json'
                $before = (Get-FileHash $regPath).Hash
                # Simulate the BLOCK-tier guard on a dirty file: any write now throws.
                Mock Write-Utf8NoBom { throw 'dirty-tree guard: target already carries uncommitted changes' }

                { Update-PolicyRegistry -Fix } | Should -Not -Throw
                (Get-FileHash $regPath).Hash | Should -Be $before
            } finally {
                Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
