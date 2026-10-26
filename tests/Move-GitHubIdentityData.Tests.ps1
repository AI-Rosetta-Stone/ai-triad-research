# Tag: health (t/4440)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    Tests for Move-GitHubIdentityData — admin GitHub-identity data migration (t/4440).
.DESCRIPTION
    All `az` calls are mocked; no live Azure access. The mock dispatches on $args so one
    fixture can stand in for the whole az CLI surface this cmdlet calls, same pattern as
    TaxEditorBlob.Tests.ps1.
#>

#Requires -Module Pester

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Move-GitHubIdentityData' -Tag 'health' {

    It 'Throws when az CLI is not found' {
        Mock Get-Command { $null } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        { Move-GitHubIdentityData -FromId 'a' -ToId 'b' -PreferencesShare 'shared' -Confirm:$false 2>$null } | Should -Throw
    }

    It 'Throws when -FromId equals -ToId' {
        { Move-GitHubIdentityData -FromId 'same' -ToId 'same' -PreferencesShare 'shared' -Confirm:$false } | Should -Throw
    }

    It 'Copies each user-content blob to the new id, polls to success, and verifies by size' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'account' -and $args -contains 'show') { return '{"id":"sub-123"}' }
            if ($args -contains 'account' -and $args -contains 'list') { return '["staitriadabc123"]' }
            if ($args -contains 'blob' -and $args -contains 'list' -and ($args -join ' ') -match 'user-content') {
                if ((($args -join ' ')) -match "prefix users/old-name/") {
                    return '[{"name":"users/old-name/debates/abc.json","properties":{"contentLength":1024}}]'
                }
                return '[]'
            }
            if ($args -contains 'blob' -and $args -contains 'copy' -and $args -contains 'start') { return $null }
            if ($args -contains 'blob' -and $args -contains 'show') {
                if ($args -contains 'properties.copy.status') { return 'success' }
                return '{"properties":{"contentLength":1024}}'
            }
            if ($args -contains 'file' -and $args -contains 'list') { return '[]' }
            return '[]'
        } -ModuleName AITriad

        $r = Move-GitHubIdentityData -FromId 'old-name' -ToId 'github-48213099' -PreferencesShare 'shared' -StorageAccount 'staitriadabc123' -Confirm:$false

        $r.Copies.Count | Should -Be 1
        $r.Copies[0].Store | Should -Be 'user-content'
        $r.Copies[0].Dest | Should -Be 'users/github-48213099/debates/abc.json'
        $r.Copies[0].CopyStatus | Should -Be 'success'
        $r.Copies[0].Verified | Should -BeTrue
        $r.AllVerified | Should -BeTrue
        $r.Warnings.Count | Should -Be 0
    }

    It 'Flags a copy unverified when the copy status never reaches success' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'account' -and $args -contains 'show') { return '{"id":"sub-123"}' }
            if ($args -contains 'blob' -and $args -contains 'list' -and ($args -join ' ') -match 'user-content') {
                if ((($args -join ' ')) -match "prefix users/old-name/") {
                    return '[{"name":"users/old-name/debates/abc.json","properties":{"contentLength":1024}}]'
                }
                return '[]'
            }
            if ($args -contains 'blob' -and $args -contains 'copy' -and $args -contains 'start') { return $null }
            if ($args -contains 'blob' -and $args -contains 'show') {
                if ($args -contains 'properties.copy.status') { return 'failed' }
                return '{"properties":{"contentLength":1024}}'
            }
            if ($args -contains 'file' -and $args -contains 'list') { return '[]' }
            return '[]'
        } -ModuleName AITriad

        $r = Move-GitHubIdentityData -FromId 'old-name' -ToId 'github-48213099' -PreferencesShare 'shared' `
            -StorageAccount 'staitriadabc123' -TimeoutSeconds 1 -Confirm:$false 3>$null

        $r.Copies[0].CopyStatus | Should -Be 'failed'
        $r.Copies[0].Verified | Should -BeFalse
        $r.AllVerified | Should -BeFalse
    }

    It 'Copies the preferences file when one exists for -FromId' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'account' -and $args -contains 'show') { return '{"id":"sub-123"}' }
            if ($args -contains 'blob' -and $args -contains 'list') { return '[]' }
            if ($args -contains 'file' -and $args -contains 'list') { return '[{"name":"old-name.json"}]' }
            if ($args -contains 'file' -and $args -contains 'copy' -and $args -contains 'start') { return $null }
            if ($args -contains 'file' -and $args -contains 'show') {
                if ($args -contains 'copy.status') { return 'success' }
                return '{"name":"github-48213099.json"}'
            }
            return '[]'
        } -ModuleName AITriad

        $r = Move-GitHubIdentityData -FromId 'old-name' -ToId 'github-48213099' -PreferencesShare 'shared' `
            -StorageAccount 'staitriadabc123' -Confirm:$false

        $prefCopy = $r.Copies | Where-Object Store -eq 'preferences'
        $prefCopy | Should -Not -BeNullOrEmpty
        $prefCopy.Dest | Should -Be 'preferences/github-48213099.json'
        $prefCopy.Verified | Should -BeTrue
    }

    It 'Skips the preferences store entirely when no file exists for -FromId (no copy attempted)' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'account' -and $args -contains 'show') { return '{"id":"sub-123"}' }
            if ($args -contains 'blob' -and $args -contains 'list') { return '[]' }
            if ($args -contains 'file' -and $args -contains 'list') { return '[]' }
            if ($args -contains 'file' -and $args -contains 'copy') { throw 'should not copy a nonexistent preferences file' }
            return '[]'
        } -ModuleName AITriad

        $r = Move-GitHubIdentityData -FromId 'old-name' -ToId 'github-48213099' -PreferencesShare 'shared' `
            -StorageAccount 'staitriadabc123' -Confirm:$false

        @($r.Copies | Where-Object Store -eq 'preferences') | Should -BeNullOrEmpty
    }

    It 'calibration/users with data is WARNed and surfaced, never copied (Quality, t/4440#2 item 2)' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'account' -and $args -contains 'show') { return '{"id":"sub-123"}' }
            if ($args -contains 'blob' -and $args -contains 'list' -and ($args -join ' ') -match 'calibration') {
                return '[{"name":"users/old-name/profile.json"}]'
            }
            if ($args -contains 'blob' -and $args -contains 'list') { return '[]' }
            if ($args -contains 'file' -and $args -contains 'list') { return '[]' }
            if ($args -contains 'blob' -and $args -contains 'copy' -and ($args -join ' ') -match 'calibration') { throw 'calibration must never be copied' }
            return '[]'
        } -ModuleName AITriad

        $r = Move-GitHubIdentityData -FromId 'old-name' -ToId 'github-48213099' -PreferencesShare 'shared' `
            -StorageAccount 'staitriadabc123' -Confirm:$false 3>$null

        @($r.Warnings | Where-Object { $_ -match 'calibration' -and $_ -match 'old-name' }) | Should -Not -BeNullOrEmpty
        @($r.Copies | Where-Object Store -eq 'calibration') | Should -BeNullOrEmpty
    }

    It 'Never calls -WhatIf through to az (dry-run makes no real changes)' {
        Mock Get-Command { @{ Name = 'az' } } -ParameterFilter { $Name -eq 'az' } -ModuleName AITriad
        Mock -CommandName 'az' -MockWith {
            param()
            $global:LASTEXITCODE = 0
            if ($args -contains 'account' -and $args -contains 'show') { return '{"id":"sub-123"}' }
            if ($args -contains 'blob' -and $args -contains 'copy') { throw 'should not copy under -WhatIf' }
            if ($args -contains 'file' -and $args -contains 'copy') { throw 'should not copy under -WhatIf' }
            return '[]'
        } -ModuleName AITriad

        { Move-GitHubIdentityData -FromId 'old-name' -ToId 'github-48213099' -PreferencesShare 'shared' -StorageAccount 'staitriadabc123' -WhatIf } | Should -Not -Throw
    }
}

Describe 'Wait-AzStorageCopyComplete (t/4440)' -Tag 'health' {
    It 'returns success immediately when the first poll reports success' {
        InModuleScope AITriad {
            $script:calls = 0
            $r = Wait-AzStorageCopyComplete -GetStatus { $script:calls++; 'success' } -TimeoutSeconds 5 -PollIntervalSeconds 1
            $r | Should -Be 'success'
        }
    }

    It 'returns failed when the status settles to failed (no false success)' {
        InModuleScope AITriad {
            $r = Wait-AzStorageCopyComplete -GetStatus { 'failed' } -TimeoutSeconds 5 -PollIntervalSeconds 1
            $r | Should -Be 'failed'
        }
    }

    It 'returns timeout when the status never settles within the budget' {
        InModuleScope AITriad {
            $r = Wait-AzStorageCopyComplete -GetStatus { 'pending' } -TimeoutSeconds 1 -PollIntervalSeconds 1
            $r | Should -Be 'timeout'
        }
    }
}
