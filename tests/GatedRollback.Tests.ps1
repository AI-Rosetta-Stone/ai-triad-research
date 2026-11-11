# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

<#
.SYNOPSIS
    t/266 (b) SO condition 1: the gated rollback shifts traffic ONLY onto a revision that is
    Provisioned and healthy + warm on its own FQDN. Every refusal arm proves ShiftTraffic was never
    called. All Azure/HTTP calls are fakes.
#>

Describe 'Invoke-GatedRollbackCore (t/266 b, SO condition 1)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/GatedRollback.ps1"
        $script:Warm = @{ StatusCode = 200; Body = '{"status":"ready","nodeCount":4144}' }
        function New-Args([hashtable]$Over = @{}) {
            $script:Shifted = 0
            $a = @{
                RevisionName  = 'taxonomy-editor--deploy-prev-1'
                Activate      = { }
                GetState      = { @{ Provisioning = 'Provisioned'; Running = 'Running'; Fqdn = 'prev.example' } }
                ProbeHealth   = { param($u) $true }
                ProbeReadyz   = { param($u) $script:Warm }
                ShiftTraffic  = { $script:Shifted++ }
                VerifyServing = { $true }
                ProvisionTimeoutSec = 1; WarmTimeoutSec = 1; PollIntervalSec = 0
            }
            foreach ($k in $Over.Keys) { $a[$k] = $Over[$k] }
            $a
        }
    }

    It 'SHIFT arm: provisioned + healthy + warm on the FQDN -> shifts once and verifies' {
        $a = New-Args; $r = Invoke-GatedRollbackCore @a
        $r.Action | Should -Be 'shifted'
        $r.Verified | Should -BeTrue
        $script:Shifted | Should -Be 1
        $r.Fqdn | Should -Be 'prev.example'
        $r.ActivateToWarmSec | Should -Not -BeNullOrEmpty
    }

    It 'probes the revision''s OWN FQDN, not the app URL' {
        $script:Seen = @()
        $a = New-Args @{ ProbeHealth = { param($u) $script:Seen += $u; $true } }; $r = Invoke-GatedRollbackCore @a
        $script:Seen | Should -Contain 'https://prev.example'
    }

    It 'REFUSE arm: <Case> -> never shifts' -ForEach @(
        @{ Case = 'activate throws';              Over = @{ Activate = { throw 'boom' } } }
        @{ Case = 'revision Failed';              Over = @{ GetState = { @{ Provisioning = 'Provisioned'; Running = 'Failed'; Fqdn = 'x' } } } }
        @{ Case = 'provisioning Failed';          Over = @{ GetState = { @{ Provisioning = 'Failed'; Running = 'Activating'; Fqdn = 'x' } } } }
        @{ Case = 'still Provisioning (timeout)'; Over = @{ GetState = { @{ Provisioning = 'Provisioning'; Running = 'Activating'; Fqdn = '' } } } }
        @{ Case = 'state unreadable (timeout)';   Over = @{ GetState = { $null } } }
        @{ Case = 'no FQDN (timeout)';            Over = @{ GetState = { @{ Provisioning = 'Provisioned'; Running = 'Running'; Fqdn = '' } } } }
        @{ Case = 'unhealthy (timeout)';          Over = @{ ProbeHealth = { param($u) $false } } }
        @{ Case = 'cold: readyz 503 warming';     Over = @{ ProbeReadyz = { param($u) @{ StatusCode = 503; Body = '{"status":"warming"}' } } } }
        @{ Case = 'readyz definitive failure';    Over = @{ ProbeReadyz = { param($u) @{ StatusCode = 503; Body = '{"status":"failed","reason":"data-root-failed"}' } } } }
        @{ Case = 'readyz SPA html 200';          Over = @{ ProbeReadyz = { param($u) @{ StatusCode = 200; Body = '<html></html>' } } } }
        @{ Case = 'readyz probe throws';          Over = @{ ProbeReadyz = { param($u) throw 'conn refused' } } }
        @{ Case = 'shift throws';                 Over = @{ ShiftTraffic = { throw 'az failed' } } }
    ) {
        $a = New-Args $Over; $r = Invoke-GatedRollbackCore @a
        $r.Action | Should -Be 'refused'
        $r.Reason | Should -Not -BeNullOrEmpty
        if ($Case -ne 'shift throws') { $script:Shifted | Should -Be 0 }
    }

    It 'post-shift verification failure is reported, not hidden' {
        $a = New-Args @{ VerifyServing = { $false } }; $r = Invoke-GatedRollbackCore @a
        $r.Action | Should -Be 'shifted'
        $r.Verified | Should -BeFalse
        $r.Reason | Should -Match 'FAILED'
    }

    It 'MeasureOnly (staging drill): ready -> measured with timings, never shifts' {
        $a = New-Args; $r = Invoke-GatedRollbackCore @a -MeasureOnly
        $r.Action | Should -Be 'measured'
        $script:Shifted | Should -Be 0
        $r.ActivateToProvisionedSec | Should -Not -BeNullOrEmpty
        $r.ActivateToWarmSec | Should -Not -BeNullOrEmpty
    }
}
