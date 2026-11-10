# Tag: health (t/1492)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Covers Remove-StaleContainerImages GHCR cleanup cmdlet (t/1492).
.DESCRIPTION
    Verifies pagination, untagged filter, keep-latest-N, age cutoff, and
    -WhatIf suppression of DELETE calls. GitHub API is fully mocked.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Remove-StaleContainerImages (t/1492)' -Tag 'health' {

    BeforeEach {
        InModuleScope AITriad {
            $env:GITHUB_TOKEN = 'fake-token'
        }
    }

    It '-WhatIf lists deletable versions without calling DELETE' {
        InModuleScope AITriad {
            $now = Get-Date
            $old = $now.AddDays(-60).ToUniversalTime().ToString('o')
            # 8 untagged, all old — keep 5, delete 3
            $versions = 1..8 | ForEach-Object {
                [PSCustomObject]@{
                    id         = 100 + $_
                    updated_at = $old
                    name       = "sha256:v$_"
                    metadata   = [PSCustomObject]@{
                        container = [PSCustomObject]@{ tags = @() }
                    }
                }
            }

            $script:DeleteCalls = 0
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'GET' } -MockWith { ,$versions }
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'DELETE' } -MockWith {
                $script:DeleteCalls++
            }

            $result = Remove-StaleContainerImages -Package 'test-pkg' -Owner 'test-owner' -WhatIf

            $result.TotalUntagged | Should -Be 8
            $result.KeptCount     | Should -Be 5
            $result.DeletedCount  | Should -Be 0 -Because '-WhatIf must not call DELETE'
            $script:DeleteCalls   | Should -Be 0
        }
    }

    It 'Keeps N most recent untagged versions and deletes the rest older than cutoff' {
        InModuleScope AITriad {
            $now = Get-Date
            $recentIso = $now.AddDays(-5).ToUniversalTime().ToString('o')
            $oldIso    = $now.AddDays(-90).ToUniversalTime().ToString('o')

            # 3 recent (should all be kept) + 4 old (delete all 4 since KeepLatest=3)
            $recent = 1..3 | ForEach-Object {
                [PSCustomObject]@{
                    id = 200 + $_
                    updated_at = $recentIso
                    name = "sha256:new$_"
                    metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @() } }
                }
            }
            $old = 1..4 | ForEach-Object {
                [PSCustomObject]@{
                    id = 300 + $_
                    updated_at = $oldIso
                    name = "sha256:old$_"
                    metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @() } }
                }
            }
            $versions = @($recent) + @($old)

            $script:DeletedIds = [System.Collections.Generic.List[long]]::new()
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'GET' } -MockWith { ,$versions }
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'DELETE' } -MockWith {
                if ($Endpoint -match '/versions/(\d+)$') {
                    $script:DeletedIds.Add([long]$Matches[1])
                }
            }

            $result = Remove-StaleContainerImages -Package 'test-pkg' -Owner 'test-owner' `
                -KeepLatest 3 -OlderThanDays 30 -Confirm:$false

            $result.TotalUntagged | Should -Be 7
            $result.KeptCount     | Should -Be 3
            $result.DeletedCount  | Should -Be 4
            @($script:DeletedIds | Sort-Object) | Should -Be @(301, 302, 303, 304)
        }
    }

    It 'Excludes tagged versions from the delete set' {
        InModuleScope AITriad {
            $oldIso = (Get-Date).AddDays(-90).ToUniversalTime().ToString('o')
            $versions = @(
                [PSCustomObject]@{
                    id = 500
                    updated_at = $oldIso
                    name = 'sha256:tagged'
                    metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @('v1.0.0') } }
                }
                [PSCustomObject]@{
                    id = 501
                    updated_at = $oldIso
                    name = 'sha256:untagged1'
                    metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @() } }
                }
                [PSCustomObject]@{
                    id = 502
                    updated_at = $oldIso
                    name = 'sha256:untagged2'
                    metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @() } }
                }
            )

            $script:DeletedIds = [System.Collections.Generic.List[long]]::new()
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'GET' } -MockWith { ,$versions }
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'DELETE' } -MockWith {
                if ($Endpoint -match '/versions/(\d+)$') {
                    $script:DeletedIds.Add([long]$Matches[1])
                }
            }

            Mock Get-GhcrAuthToken { 'fake-pull-token' }
            Mock Get-GhcrManifestChildDigest { }

            $result = Remove-StaleContainerImages -Package 'test-pkg' -Owner 'test-owner' `
                -KeepLatest 0 -OlderThanDays 30 -Confirm:$false

            $result.TotalUntagged | Should -Be 2 -Because 'the tagged version (500) is excluded'
            @($script:DeletedIds) | Should -Not -Contain 500
        }
    }

    # ── t/4966: known-good and the children of tagged indexes survive cleanup ──
    It 'keeps an old known-good index and its untagged children; still deletes an old orphan (t/4966)' {
        InModuleScope AITriad {
            $oldIso = (Get-Date).AddDays(-90).ToUniversalTime().ToString('o')
            $mk = { param($id, $digest, $tags) [PSCustomObject]@{
                id = $id; updated_at = $oldIso; name = $digest
                metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @($tags) } } } }
            $versions = @(
                & $mk 600 'sha256:kgindex'  @('known-good', 'sha-aaa')
                & $mk 601 'sha256:kgamd64'  @()
                & $mk 602 'sha256:kgattest' @()
                & $mk 603 'sha256:orphan'   @()
            )

            $script:DeletedIds = [System.Collections.Generic.List[long]]::new()
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'GET' } -MockWith { ,$versions }
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'DELETE' } -MockWith {
                if ($Endpoint -match '/versions/(\d+)$') { $script:DeletedIds.Add([long]$Matches[1]) }
            }
            Mock Get-GhcrAuthToken { 'fake-pull-token' }
            Mock Get-GhcrManifestChildDigest -ParameterFilter { $Reference -eq 'sha256:kgindex' } -MockWith {
                'sha256:kgamd64'; 'sha256:kgattest'
            }

            $result = Remove-StaleContainerImages -Package 'taxonomy-editor' -Owner 'test-owner' `
                -KeepLatest 0 -OlderThanDays 30 -Confirm:$false

            @($script:DeletedIds) | Should -Be @(603)
            $result.ProtectedCount | Should -Be 2
            @($result.Failures).Count | Should -Be 0
            Should -Invoke Get-GhcrAuthToken -Times 1 -ParameterFilter { $Scope -eq 'pull' -and $Package -eq 'test-owner/taxonomy-editor' }
        }
    }

    It 'deletes nothing, with a WARN and a Failures entry, when a tagged index cannot be read (t/4966)' {
        InModuleScope AITriad {
            $oldIso = (Get-Date).AddDays(-90).ToUniversalTime().ToString('o')
            $versions = @(
                [PSCustomObject]@{ id = 700; updated_at = $oldIso; name = 'sha256:kgindex'
                    metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @('known-good') } } }
                [PSCustomObject]@{ id = 701; updated_at = $oldIso; name = 'sha256:maybechild'
                    metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @() } } }
            )
            $script:DeleteCalls = 0
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'GET' } -MockWith { ,$versions }
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'DELETE' } -MockWith { $script:DeleteCalls++ }
            Mock Get-GhcrAuthToken { 'fake-pull-token' }
            Mock Get-GhcrManifestChildDigest { throw 'GHCR manifest GET failed: 503' }

            $result = Remove-StaleContainerImages -Package 'taxonomy-editor' -Owner 'test-owner' `
                -KeepLatest 0 -OlderThanDays 30 -Confirm:$false -WarningVariable warn -WarningAction SilentlyContinue

            $script:DeleteCalls | Should -Be 0
            $result.DeletedCount | Should -Be 0
            "$($result.Failures)" | Should -Match 'protection-unresolved'
            "$warn" | Should -Match 'no version was deleted'
        }
    }

    It 'does not read manifests when nothing is a delete candidate' {
        InModuleScope AITriad {
            $newIso = (Get-Date).AddDays(-1).ToUniversalTime().ToString('o')
            $versions = @(
                [PSCustomObject]@{ id = 800; updated_at = $newIso; name = 'sha256:kg'
                    metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @('known-good') } } }
                [PSCustomObject]@{ id = 801; updated_at = $newIso; name = 'sha256:fresh'
                    metadata = [PSCustomObject]@{ container = [PSCustomObject]@{ tags = @() } } }
            )
            Mock Invoke-GitHubApi -ParameterFilter { $Method -eq 'GET' } -MockWith { ,$versions }
            Mock Get-GhcrManifestChildDigest { }
            $null = Remove-StaleContainerImages -Package 'taxonomy-editor' -Owner 'test-owner' `
                -KeepLatest 0 -OlderThanDays 30 -Confirm:$false
            Should -Invoke Get-GhcrManifestChildDigest -Times 0
        }
    }

    It 'Handles missing package gracefully (404)' {
        InModuleScope AITriad {
            Mock Invoke-GitHubApi -MockWith {
                throw [System.Management.Automation.ErrorRecord]::new(
                    [System.Exception]::new('GitHub API error: Resource not found'),
                    'NotFound', 'ObjectNotFound', $null)
            }

            $result = Remove-StaleContainerImages -Package 'nonexistent' -Owner 'test-owner'

            $result.TotalUntagged | Should -Be 0
            $result.DeletedCount  | Should -Be 0
        }
    }
}
