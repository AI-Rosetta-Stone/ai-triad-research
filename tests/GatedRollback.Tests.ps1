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

    It 'a stale Stopped/Deprovisioned read right after activate is transient: waits, then shifts once Running (DevOps Lead p/107#7)' {
        $script:Polls = 0
        $a = New-Args @{
            GetState = {
                $script:Polls++
                if ($script:Polls -le 2) { @{ Provisioning = 'Provisioned'; Running = 'Stopped'; Fqdn = 'prev.example' } }
                else { @{ Provisioning = 'Provisioned'; Running = 'Running'; Fqdn = 'prev.example' } }
            }
            ProvisionTimeoutSec = 30
        }
        $r = Invoke-GatedRollbackCore @a
        $r.Action | Should -Be 'shifted'
        $script:Polls | Should -BeGreaterThan 2
        $script:Shifted | Should -Be 1
    }

    It 'a revision that stays Stopped refuses at the timeout, never shifts' {
        $a = New-Args @{ GetState = { @{ Provisioning = 'Provisioned'; Running = 'Stopped'; Fqdn = 'prev.example' } } }
        $r = Invoke-GatedRollbackCore @a
        $r.Action | Should -Be 'refused'
        $r.Reason | Should -Match 'within'
        $script:Shifted | Should -Be 0
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

    # ── t/513 (Lead t/513#4): an already-active target skips activate; every gate still runs ──
    Context 'already-active target (t/513)' {
        BeforeEach {
            $script:Activated = 0
            # Real-az behaviour on an already-active revision: activate refuses (RevisionAlreadyInRequestedState).
            $script:RefusingActivate = { $script:Activated++; throw 'az containerapp revision activate exited 1 (RevisionAlreadyInRequestedState)' }
        }

        It 'active at weight 0 (staging shape): activate is skipped, the gates run, then it shifts once and verifies' {
            $a = New-Args @{ Activate = $script:RefusingActivate; GetActive = { @{ Active = $true; Weight = 0 } } }
            $r = Invoke-GatedRollbackCore @a
            $r.Action | Should -Be 'shifted'
            $r.Verified | Should -BeTrue
            $r.AlreadyActive | Should -BeTrue
            $script:Activated | Should -Be 0
            $script:Shifted | Should -Be 1
            $r.ActivateToWarmSec | Should -Not -BeNullOrEmpty
        }

        It 'already at 100%: success with no shift, after the health and readyz gates pass' {
            $script:Probed = 0
            $a = New-Args @{
                Activate = $script:RefusingActivate; GetActive = { @{ Active = $true; Weight = 100 } }
                ProbeHealth = { param($u) $script:Probed++; $true }
            }
            $r = Invoke-GatedRollbackCore @a
            $r.Action | Should -Be 'already-serving'
            $r.Verified | Should -BeTrue
            $r.Reason | Should -Match 'already serving 100%; nothing shifted'
            $script:Shifted | Should -Be 0
            $script:Activated | Should -Be 0
            $script:Probed | Should -BeGreaterThan 0
        }

        It 'already active but unhealthy: still refuses and never shifts, at 0% or at 100% (<Weight>)' -ForEach @(@{ Weight = 0 }, @{ Weight = 100 }) {
            $w = $Weight
            $a = New-Args @{ Activate = $script:RefusingActivate; GetActive = { @{ Active = $true; Weight = $w } }.GetNewClosure(); ProbeHealth = { param($u) $false } }
            $r = Invoke-GatedRollbackCore @a
            $r.Action | Should -Be 'refused'
            $r.Reason | Should -Match 'not healthy\+warm'
            $script:Shifted | Should -Be 0
        }

        It 'prod shape: an INACTIVE target runs activate exactly once, as before, then shifts' {
            $script:Calls = 0
            $a = New-Args @{ Activate = { $script:Calls++ }; GetActive = { @{ Active = $false; Weight = 0 } } }
            $r = Invoke-GatedRollbackCore @a
            $script:Calls | Should -Be 1
            $r.AlreadyActive | Should -BeFalse
            $r.Action | Should -Be 'shifted'
        }

        It 'an unreadable active state (GetActive throws or returns nothing) falls back to activating, as before' {
            foreach ($ga in @({ throw 'az failed' }, { $null })) {
                $script:Calls = 0
                $a = New-Args @{ Activate = { $script:Calls++ }; GetActive = $ga }
                $r = Invoke-GatedRollbackCore @a
                $script:Calls | Should -Be 1
                $r.Action | Should -Be 'shifted'
            }
        }

        It 'Quality p/262#9: a -MeasureOnly -DeactivateAfterMeasure drill on an already-active standby never deactivates it' {
            $a = New-Args @{ Activate = $script:RefusingActivate; GetActive = { @{ Active = $true; Weight = 0 } } }
            $r = Invoke-GatedRollbackCore @a -MeasureOnly
            $r.Action | Should -Be 'measured'
            $d = Get-DrillDeactivateDecision -Result $r -DeactivateAfterMeasure
            $d.Skip | Should -BeTrue
            $d.Reason | Should -Match 'already active before the drill'
        }

        It 'a drill that activated the revision itself still deactivates it again; no switch or no measure never does' {
            $a = New-Args @{ GetActive = { @{ Active = $false; Weight = 0 } } }
            $r = Invoke-GatedRollbackCore @a -MeasureOnly
            (Get-DrillDeactivateDecision -Result $r -DeactivateAfterMeasure).Skip | Should -BeFalse
            (Get-DrillDeactivateDecision -Result $r).Skip | Should -BeTrue
            $b = New-Args; $shifted = Invoke-GatedRollbackCore @b
            (Get-DrillDeactivateDecision -Result $shifted -DeactivateAfterMeasure).Skip | Should -BeTrue
        }

        It 'the wrapper deactivates only when Get-DrillDeactivateDecision says so' {
            $src = Get-Content "$PSScriptRoot/../operations/devops/Invoke-GatedRollback.ps1" -Raw
            # The SO round 2 outer block stays (DeployAzureRetirePreviousRevision.Tests.ps1 pins it); the
            # decision is its first act, and the double-sourced guard sits in its else branch.
            $block = [regex]::Match($src, '(?s)if \(\$r\.Action -eq ''measured'' -and \$DeactivateAfterMeasure\) \{.*?\n\}').Value
            $block | Should -Not -BeNullOrEmpty
            $decide = $block.IndexOf('$drill = Get-DrillDeactivateDecision -Result $r -DeactivateAfterMeasure:$DeactivateAfterMeasure')
            $decide | Should -BeGreaterThan -1
            $skip = $block.IndexOf('if ($drill.Skip) {')
            $skip | Should -BeGreaterThan $decide
            $skip | Should -BeLessThan $block.IndexOf('Get-RevisionDeactivationVerdict -RevisionName')
            $skip | Should -BeLessThan $block.IndexOf('az containerapp revision deactivate')
        }

        It 'no -GetActive at all (older callers): activate runs as before' {
            $script:Calls = 0
            $a = New-Args @{ Activate = { $script:Calls++ } }
            $r = Invoke-GatedRollbackCore @a
            $script:Calls | Should -Be 1
        }
    }
}
