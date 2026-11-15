# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/353: both arms of Get-RestoredRevisionVerdict. Healthy only when the restored revision is
    positively active, at weight 100, with /health passing; every unknown is NOT healthy.
#>

Describe 'Get-RestoredRevisionVerdict (t/353)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/Get-RestoredRevisionVerdict.ps1"
        $script:Ok = @{ RestoredRevision = 'taxonomy-editor--deploy-aaa-1'; Active = $true; Weight = 100; HealthOk = $true }
    }

    It 'HEALTHY arm: active, weight 100, /health ok' {
        $v = Get-RestoredRevisionVerdict @script:Ok
        $v.Healthy | Should -BeTrue
    }

    It 'NOT-HEALTHY arm: <Case>' -ForEach @(
        @{ Case = 'no restored revision name';   Over = @{ RestoredRevision = '' } }
        @{ Case = 'active unreadable';           Over = @{ Active = $null } }
        @{ Case = 'not active';                  Over = @{ Active = $false } }
        @{ Case = 'weight unreadable';           Over = @{ Weight = $null } }
        @{ Case = 'weight 0';                    Over = @{ Weight = 0 } }
        @{ Case = 'canary-like split';           Over = @{ Weight = 50 } }
        @{ Case = 'health check did not run';    Over = @{ HealthOk = $null } }
        @{ Case = 'health failed';               Over = @{ HealthOk = $false } }
    ) {
        $p = $script:Ok.Clone()
        foreach ($k in $Over.Keys) { $p[$k] = $Over[$k] }
        $v = Get-RestoredRevisionVerdict @p
        $v.Healthy | Should -BeFalse
        $v.Reason | Should -Not -BeNullOrEmpty
    }
}
