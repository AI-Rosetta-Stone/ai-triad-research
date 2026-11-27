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

Describe 'Get-DeactivatePreviousDecision (t/588)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/GatedRollback.ps1"
        $script:Shifted = [pscustomobject]@{ Action = 'shifted'; Verified = $true }
    }

    It 'DEFAULT OFF: without -DeactivatePrevious nothing is deactivated, whatever else is true' {
        $d = Get-DeactivatePreviousDecision -Result $script:Shifted -PreviousRevisions @('rev-old')
        $d.Skip | Should -BeTrue
        $d.Reason | Should -Match 'not given'
        @($d.Revisions).Count | Should -Be 0
    }

    It 'a verified shift with the switch deactivates the previous revisions it read before the shift, never the target' {
        $d = Get-DeactivatePreviousDecision -Result $script:Shifted -PreviousRevisions @('rev-old', 'rev-target', 'rev-old', '') -TargetRevision 'rev-target' -DeactivatePrevious
        $d.Skip | Should -BeFalse
        @($d.Revisions) | Should -Be @('rev-old')
    }

    It 'already-serving + verified is allowed too (the list is then normally empty and it skips for that reason)' {
        $ok = [pscustomobject]@{ Action = 'already-serving'; Verified = $true }
        (Get-DeactivatePreviousDecision -Result $ok -PreviousRevisions @('rev-old') -TargetRevision 'rev-t' -DeactivatePrevious).Skip | Should -BeFalse
        $d = Get-DeactivatePreviousDecision -Result $ok -PreviousRevisions @() -TargetRevision 'rev-t' -DeactivatePrevious
        $d.Skip | Should -BeTrue
        $d.Reason | Should -Match 'no other revision'
    }

    It 'FAILING ARMS: a refused, measured, unverified or errored run deactivates nothing' {
        foreach ($r in @(
                [pscustomobject]@{ Action = 'refused'; Verified = $false },
                [pscustomobject]@{ Action = 'measured'; Verified = $false },
                [pscustomobject]@{ Action = 'shifted'; Verified = $false },
                [pscustomobject]@{ Action = 'already-serving'; Verified = $false },
                [pscustomobject]@{ Action = 'shifted'; Verified = $null })) {
            $d = Get-DeactivatePreviousDecision -Result $r -PreviousRevisions @('rev-old') -TargetRevision 'rev-t' -DeactivatePrevious
            $d.Skip | Should -BeTrue -Because "$($r.Action) verified=$($r.Verified)"
            $d.Reason | Should -Match 'not a verified shift'
            @($d.Revisions).Count | Should -Be 0
        }
    }

    It 'an unreadable pre-shift read deactivates nothing (never read as "none carried traffic" and acted on)' {
        $d = Get-DeactivatePreviousDecision -Result $script:Shifted -PreviousRevisions @('rev-old') -TargetRevision 'rev-t' -ReadFailed -DeactivatePrevious
        $d.Skip | Should -BeTrue
        $d.Reason | Should -Match 'could not be read'
    }
}

Describe 'Invoke-GuardedDeactivate (t/588)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/GatedRollback.ps1"
        $script:Deactivated = @()
    }
    BeforeEach { $script:Deactivated = @() }

    It 'a guard that says deactivate: the revision is deactivated once, and reported' {
        $r = Invoke-GuardedDeactivate -RevisionName 'rev-old' `
            -GetVerdict { param($n) [pscustomobject]@{ Action = 'deactivate'; Reason = 'ok'; RevisionName = $n } } `
            -Deactivate { param($n) $script:Deactivated += $n }
        $r.Deactivated | Should -BeTrue
        $script:Deactivated | Should -Be @('rev-old')
        $r.Warning | Should -BeNullOrEmpty
    }

    It 'a guard that says skip (it carries traffic): nothing is deactivated, with the guard reason, and no warning' {
        $r = Invoke-GuardedDeactivate -RevisionName 'rev-old' `
            -GetVerdict { param($n) [pscustomobject]@{ Action = 'skip'; Reason = 'nonzero-traffic-weight'; RevisionName = $n } } `
            -Deactivate { param($n) $script:Deactivated += $n }
        $r.Deactivated | Should -BeFalse
        $script:Deactivated.Count | Should -Be 0
        $r.Reason | Should -Match 'nonzero-traffic-weight'
        $r.Warning | Should -BeNullOrEmpty
    }

    It 'a guard that cannot be read, or returns nothing: nothing is deactivated, never thrown' {
        $r = Invoke-GuardedDeactivate -RevisionName 'rev-old' -GetVerdict { throw 'az failed' } -Deactivate { param($n) $script:Deactivated += $n }
        $r.Deactivated | Should -BeFalse
        $r.Warning | Should -Match 'could not be read: az failed'
        $script:Deactivated.Count | Should -Be 0
        $n = Invoke-GuardedDeactivate -RevisionName 'rev-old' -GetVerdict { $null } -Deactivate { param($n) $script:Deactivated += $n }
        $n.Deactivated | Should -BeFalse
        $n.Reason | Should -Match 'returned nothing'
    }

    It 'a failed deactivation is a WARN and never throws or touches traffic (no rollback of the rollback)' {
        $touched = 0
        $r = Invoke-GuardedDeactivate -RevisionName 'rev-old' `
            -GetVerdict { param($n) [pscustomobject]@{ Action = 'deactivate'; Reason = 'ok'; RevisionName = $n } } `
            -Deactivate { param($n) $script:touched = 1; throw 'az containerapp revision deactivate exited 1' }
        $r.Deactivated | Should -BeFalse
        $r.Warning | Should -Match 'deactivation failed: az containerapp revision deactivate exited 1'
    }
}

Describe 'Invoke-GatedRollback.ps1 wiring of -DeactivatePrevious (t/588)' -Tag 'devops' {

    BeforeAll {
        $script:Wrapper = Get-Content -Raw "$PSScriptRoot/../operations/devops/Invoke-GatedRollback.ps1"
    }

    It 'the switch exists, is a plain [switch] (default off) and is used by the decision before anything is deactivated' {
        $script:Wrapper | Should -Match '\[switch\] \$DeactivatePrevious,'
        $script:Wrapper | Should -Match 'Get-DeactivatePreviousDecision -Result \$r'
        $script:Wrapper | Should -Match 'Invoke-GuardedDeactivate -RevisionName \$prevRev'
    }

    It 'the revisions carrying traffic are read only when the switch is given, and BEFORE the shift (before Invoke-GatedRollbackCore)' {
        $read = $script:Wrapper.IndexOf('az containerapp revision list')
        $core = $script:Wrapper.IndexOf('$r = Invoke-GatedRollbackCore')
        $read | Should -BeGreaterThan 0
        $read | Should -BeLessThan $core
        # inside Get-PreviousRevisionsSafely's -Read block, under the switch (SO p/136#135)
        $script:Wrapper.Substring(0, $read) | Should -Match 'if \(\$DeactivatePrevious\) \{\s*\r?\n\s*\$pre = Get-PreviousRevisionsSafely -TargetRevision \$RevisionName -Read \{\s*\r?\n\s*\$names = $'
    }

    It 'the deactivation block runs after the core result and before the exit-code line, and never changes the exit code' {
        $dec = $script:Wrapper.IndexOf('Get-DeactivatePreviousDecision -Result $r')
        $core = $script:Wrapper.IndexOf('$r = Invoke-GatedRollbackCore')
        $exit = $script:Wrapper.IndexOf('exit (Get-GatedRollbackExitCode -Result $r)')
        $dec | Should -BeGreaterThan $core
        $dec | Should -BeLessThan $exit
        $block = $script:Wrapper.Substring($dec, $exit - $dec)
        $block | Should -Not -Match '\bexit\b'
        $block | Should -Not -Match 'traffic set|ShiftTraffic'
    }

    It 'the guard passes the same double-sourced facts as the drill (own weight AND ingress config) and protects the serving target' {
        $script:Wrapper | Should -Match 'Get-IngressTrafficWeightForRevision -RevisionName \$Rev'
        $script:Wrapper | Should -Match '-ServingRevisionName \$RevisionName'
    }
}

Describe 'Format-DeactivatePreviousRecord and the help text (t/588, DeployAzure p/227#53)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/GatedRollback.ps1"
        $script:Wrapper = Get-Content -Raw "$PSScriptRoot/../operations/devops/Invoke-GatedRollback.ps1"
        function script:Res($name, $done, $reason) { [pscustomobject]@{ RevisionName = $name; Deactivated = $done; Reason = $reason; Warning = $null } }
    }

    It 'a deactivated revision gets a line naming it, and the summary line names it too' {
        $rec = Format-DeactivatePreviousRecord -Results @((Res 'rev-old' $true 'deactivated after the verified shift'))
        $rec.Lines[0] | Should -Be "deactivate-previous: deactivated 'rev-old' (deactivated after the verified shift)"
        $rec.Lines[-1] | Should -Be "deactivate-previous: record: deactivated 1 ('rev-old'); not deactivated 0 (none)"
        @($rec.Deactivated) | Should -Be @('rev-old')
        @($rec.NotDeactivated).Count | Should -Be 0
    }

    It 'a revision that was not deactivated says so with its reason, in the same record' {
        $rec = Format-DeactivatePreviousRecord -Results @((Res 'rev-a' $true 'ok'), (Res 'rev-b' $false 'traffic guard: nonzero-traffic-weight'))
        $rec.Lines[1] | Should -Be "deactivate-previous: NOT deactivated 'rev-b': traffic guard: nonzero-traffic-weight"
        $rec.Lines[-1] | Should -Be "deactivate-previous: record: deactivated 1 ('rev-a'); not deactivated 1 ('rev-b')"
        @($rec.Deactivated) | Should -Be @('rev-a')
        @($rec.NotDeactivated) | Should -Be @('rev-b')
    }

    It 'a run that deactivated nothing still leaves a summary line saying so' {
        $rec = Format-DeactivatePreviousRecord -Results @()
        $rec.Lines.Count | Should -Be 1
        $rec.Lines[0] | Should -Be 'deactivate-previous: record: deactivated 0 (none); not deactivated 0 (none)'
    }

    It 'the wrapper prints the record, appends it to the GitHub step summary when there is one, and keeps it on the returned object' {
        $script:Wrapper | Should -Match 'Format-DeactivatePreviousRecord -Results \$deactResults'
        $script:Wrapper | Should -Match 'foreach \(\$line in \$rec\.Lines\) \{ Write-Host'
        $script:Wrapper | Should -Match 'if \(\$env:GITHUB_STEP_SUMMARY\) \{ Add-Content -LiteralPath \$env:GITHUB_STEP_SUMMARY'
        $script:Wrapper | Should -Match "Add-Member -NotePropertyName PreviousDeactivated"
        $script:Wrapper | Should -Match "Add-Member -NotePropertyName PreviousNotDeactivated"
        # a failed deactivation is still a WARN-level line
        $script:Wrapper | Should -Match 'Write-Warning "WARN: deactivate-previous:'
    }

    It 'the help text says: drill or planned rollback only, NOT after an incident rollback, and why' {
        $help = Get-Help (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Invoke-GatedRollback.ps1') -Parameter DeactivatePrevious | Out-String
        $help | Should -Match 'USE IT for a drill or a PLANNED rollback'
        $help | Should -Match 'DO NOT USE IT after an INCIDENT rollback'
        $help | Should -Match 'suspect one'
        $help | Should -Match 'exec'
        $help | Should -Match 'live replica state'
        $help | Should -Match 'Log Analytics'
        $help | Should -Match 'can be reactivated'
        # and the same warning sits next to the parameter itself, where someone adding a caller will read it
        $script:Wrapper | Should -Match '(?s)NOT after an INCIDENT rollback.*?\[switch\] \$DeactivatePrevious'
    }
}

Describe 'The optional -DeactivatePrevious steps can never stop a rollback or change its exit code (t/588, SO p/136#135)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/GatedRollback.ps1"
        $script:Wrapper = Get-Content -Raw "$PSScriptRoot/../operations/devops/Invoke-GatedRollback.ps1"
        function script:Verified { [pscustomobject]@{ Action = 'shifted'; Verified = $true; Reason = 'ok' } }
    }

    # The wrapper runs with $ErrorActionPreference = 'Stop': every test below runs under it too.
    BeforeEach { $script:SavedEap = $ErrorActionPreference; $ErrorActionPreference = 'Stop' }
    AfterEach { $ErrorActionPreference = $script:SavedEap }

    Context 'Get-PreviousRevisionsSafely (the pre-shift read)' {
        It 'an az read that THROWS (az missing, a native error) does not throw: it WARNs with the message and deactivates nothing' {
            $r = Get-PreviousRevisionsSafely -TargetRevision 'rev-t' -Read { throw 'The term az is not recognized' } -WarningVariable w -WarningAction SilentlyContinue
            $r.Failed | Should -BeTrue
            @($r.Revisions).Count | Should -Be 0
            ($w -join ' ') | Should -Match 'pre-shift read of the revisions carrying traffic threw \(The term az is not recognized\)'
            ($w -join ' ') | Should -Match 'deactivate nothing and the rollback carries on'
        }

        It 'a non-zero az exit, or a read that returns nothing, is a WARN and Failed' {
            $bad = Get-PreviousRevisionsSafely -TargetRevision 'rev-t' -Read { @{ ExitCode = 3; Names = @('rev-old') } } -WarningVariable w1 -WarningAction SilentlyContinue
            $bad.Failed | Should -BeTrue
            @($bad.Revisions).Count | Should -Be 0 -Because 'a failed read never yields revisions to deactivate'
            ($w1 -join ' ') | Should -Match 'az exit 3'
            (Get-PreviousRevisionsSafely -TargetRevision 'rev-t' -Read { $null } -WarningAction SilentlyContinue).Failed | Should -BeTrue
        }

        It 'a good read returns the revisions with traffic minus the target, and no warning' {
            $r = Get-PreviousRevisionsSafely -TargetRevision 'rev-t' -Read { @{ ExitCode = 0; Names = @('rev-old', 'rev-t', '', 'rev-old2') } } -WarningVariable w
            $r.Failed | Should -BeFalse
            @($r.Revisions) | Should -Be @('rev-old', 'rev-old2')
            @($w).Count | Should -Be 0
        }

        It 'a failed read feeds the decision, which then deactivates nothing' {
            $r = Get-PreviousRevisionsSafely -TargetRevision 'rev-t' -Read { throw 'boom' } -WarningAction SilentlyContinue
            $d = Get-DeactivatePreviousDecision -Result (Verified) -PreviousRevisions @($r.Revisions) -TargetRevision 'rev-t' -ReadFailed:$r.Failed -DeactivatePrevious
            $d.Skip | Should -BeTrue
            $d.Reason | Should -Match 'could not be read'
        }
    }

    Context 'Invoke-PostShiftStepSafely (the post-shift block)' {
        It 'each throw point inside the block (dot-source, Add-Content to the summary, Add-Member) is a WARN, never a throw, and the exit code equals the run without the switch' {
            $baseline = Get-GatedRollbackExitCode -Result (Verified)
            $cases = [ordered]@{
                'dot-sourcing the verdict script' = { . (Join-Path $TestDrive 'does-not-exist' 'Get-RevisionDeactivationVerdict.ps1') }
                'Add-Content to the step summary' = { Add-Content -LiteralPath (Join-Path $TestDrive 'no-such-dir' 'summary.md') -Value 'x' }
                'Add-Member on the result'        = { $o = [pscustomobject]@{ PreviousDeactivated = 1 }; $o | Add-Member -NotePropertyName PreviousDeactivated -NotePropertyValue 2 }
                'a thrown az error'               = { throw 'az containerapp revision show exited 1' }
            }
            foreach ($name in $cases.Keys) {
                $r = Verified
                $before = $r | ConvertTo-Json -Compress
                $threw = $false
                try { Invoke-PostShiftStepSafely -Name 'deactivate-previous' -Block $cases[$name] -WarningVariable w -WarningAction SilentlyContinue } catch { $threw = $true }
                $threw | Should -BeFalse -Because "$name must not escape"
                ($w -join ' ') | Should -Match '(?s)deactivate-previous failed after the shift \(.+\)\. The shift stands and the exit code is unchanged' -Because $name
                ($r | ConvertTo-Json -Compress) | Should -Be $before -Because "$name must not change the result"
                Get-GatedRollbackExitCode -Result $r | Should -Be $baseline -Because "${name}: the exit code equals the run without the switch"
            }
        }

        It 'a block that succeeds is run as is, with no warning' {
            $script:ran = 0
            Invoke-PostShiftStepSafely -Block { $script:ran++ } -WarningVariable w
            $script:ran | Should -Be 1
            @($w).Count | Should -Be 0
        }

        It 'the exit code comes from the result alone: shifted/already-serving verified and measured are 0, everything else 1' {
            Get-GatedRollbackExitCode -Result ([pscustomobject]@{ Action = 'shifted'; Verified = $true }) | Should -Be 0
            Get-GatedRollbackExitCode -Result ([pscustomobject]@{ Action = 'already-serving'; Verified = $true }) | Should -Be 0
            Get-GatedRollbackExitCode -Result ([pscustomobject]@{ Action = 'measured'; Verified = $false }) | Should -Be 0
            foreach ($r in @(
                    [pscustomobject]@{ Action = 'shifted'; Verified = $false },
                    [pscustomobject]@{ Action = 'already-serving'; Verified = $false },
                    [pscustomobject]@{ Action = 'refused'; Verified = $false },
                    [pscustomobject]@{ Action = 'refused'; Verified = $true })) {
                Get-GatedRollbackExitCode -Result $r | Should -Be 1 -Because "$($r.Action) verified=$($r.Verified)"
            }
        }
    }

    Context 'the wrapper wiring' {
        It 'the pre-shift read goes through Get-PreviousRevisionsSafely and sets previousReadFailed from it' {
            $script:Wrapper | Should -Match 'Get-PreviousRevisionsSafely -TargetRevision \$RevisionName -Read \{'
            $script:Wrapper | Should -Match '\$previousReadFailed = \[bool\]\$pre\.Failed'
            $script:Wrapper | Should -Not -Match 'LASTEXITCODE -eq 0\) \{ \$previousRevisions'
        }

        It 'the WHOLE post-shift deactivate-previous block is inside Invoke-PostShiftStepSafely: the decision, the dot-source, the summary append and both Add-Member calls' {
            $open = $script:Wrapper.IndexOf("Invoke-PostShiftStepSafely -Name 'deactivate-previous' -Block {")
            $close = $script:Wrapper.IndexOf('exit (Get-GatedRollbackExitCode -Result $r)')
            $open | Should -BeGreaterThan 0
            $close | Should -BeGreaterThan $open
            $inside = $script:Wrapper.Substring($open, $close - $open)
            foreach ($needle in 'Get-DeactivatePreviousDecision -Result $r', "Get-RevisionDeactivationVerdict.ps1')", 'Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY', 'Add-Member -NotePropertyName PreviousDeactivated', 'Add-Member -NotePropertyName PreviousNotDeactivated') {
                $inside.IndexOf($needle) | Should -BeGreaterThan 0 -Because "$needle is inside the safe block"
            }
            # and none of those calls sits OUTSIDE it, before the block
            $before = $script:Wrapper.Substring(0, $open)
            $before | Should -Not -Match 'Add-Member -NotePropertyName PreviousDeactivated'
            $before | Should -Not -Match 'Add-Content -LiteralPath \$env:GITHUB_STEP_SUMMARY'
        }

        It 'the script exits through Get-GatedRollbackExitCode, with no second copy of the exit condition' {
            $script:Wrapper | Should -Match 'exit \(Get-GatedRollbackExitCode -Result \$r\)'
            $script:Wrapper | Should -Not -Match "if \(\$r\.Action -eq 'measured' -or \(\$r\.Action -in @\('shifted', 'already-serving'\) -and \$r\.Verified\)\) \{ exit 0 \}"
        }
    }
}
