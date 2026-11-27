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

    It 'the switch exists, is a plain [switch] (default off) and the post-shift step is ONE call to Invoke-DeactivatePreviousStep' {
        $script:Wrapper | Should -Match '\[switch\] \$DeactivatePrevious,'
        $script:Wrapper | Should -Match 'Invoke-DeactivatePreviousStep -Result \$r'
        $script:Wrapper | Should -Not -Match 'Invoke-GuardedDeactivate'
        $script:Wrapper | Should -Not -Match '-ServingRevisionName'
    }

    It 'the revisions carrying traffic are read only when the switch is given, and BEFORE the shift (before Invoke-GatedRollbackCore)' {
        $read = $script:Wrapper.IndexOf('az containerapp revision list')
        $core = $script:Wrapper.IndexOf('$r = Invoke-GatedRollbackCore')
        $read | Should -BeGreaterThan 0
        $read | Should -BeLessThan $core
        # inside Get-PreviousRevisionsSafely's -Read block, under the switch (SO p/136#135)
        $script:Wrapper.Substring(0, $read) | Should -Match 'if \(\$DeactivatePrevious\) \{\s*\r?\n\s*\$pre = Get-PreviousRevisionsSafely -TargetRevision \$RevisionName -Read \{\s*\r?\n\s*\$names = $'
    }

    It 'the deactivation step runs after the core result and before the exit-code line, and never changes the exit code' {
        $dec = $script:Wrapper.IndexOf('Invoke-DeactivatePreviousStep -Result $r')
        $core = $script:Wrapper.IndexOf('$r = Invoke-GatedRollbackCore')
        $exit = $script:Wrapper.IndexOf('exit (Get-GatedRollbackExitCode -Result $r)')
        $dec | Should -BeGreaterThan $core
        $dec | Should -BeLessThan $exit
        $block = $script:Wrapper.Substring($dec, $exit - $dec)
        $block | Should -Not -Match '\bexit\b'
        $block | Should -Not -Match 'traffic set|ShiftTraffic'
    }

    It 'the guard reads the same double-sourced facts as the drill (own weight AND ingress config) and is told the REAL rollback target' {
        $fn = Get-Content -Raw "$PSScriptRoot/../operations/devops/GatedRollback.ps1"
        $fn | Should -Match 'Get-IngressTrafficWeightForRevision -RevisionName \$Rev'
        $fn | Should -Match '-ServingRevisionName \$guardServingTarget'
        $fn | Should -Not -Match '-ServingRevisionName \$RevisionName'
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

    It 'the step prints the record, appends it to the GitHub step summary when there is one, and keeps it on the returned object' {
        $fn = Get-Content -Raw "$PSScriptRoot/../operations/devops/GatedRollback.ps1"
        $fn | Should -Match 'Format-DeactivatePreviousRecord -Results \$deactResults'
        $fn | Should -Match 'foreach \(\$line in \$rec\.Lines\) \{ Write-Host'
        $fn | Should -Match 'if \(\$env:GITHUB_STEP_SUMMARY\) \{ Add-Content -LiteralPath \$env:GITHUB_STEP_SUMMARY'
        $fn | Should -Match 'Add-Member -NotePropertyName PreviousDeactivated'
        $fn | Should -Match 'Add-Member -NotePropertyName PreviousNotDeactivated'
        # a failed deactivation is still a WARN-level line
        $fn | Should -Match 'Write-Warning "WARN: deactivate-previous:'
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

        It 'the WHOLE post-shift step runs inside Invoke-PostShiftStepSafely: the call, its arguments, the verdict-script dot-source path' {
            $open = $script:Wrapper.IndexOf("Invoke-PostShiftStepSafely -Name 'deactivate-previous' -Block {")
            $close = $script:Wrapper.IndexOf('exit (Get-GatedRollbackExitCode -Result $r)')
            $open | Should -BeGreaterThan 0
            $close | Should -BeGreaterThan $open
            $inside = $script:Wrapper.Substring($open, $close - $open)
            foreach ($needle in 'Invoke-DeactivatePreviousStep -Result $r', "Get-RevisionDeactivationVerdict.ps1')") {
                $inside.IndexOf($needle) | Should -BeGreaterThan 0 -Because "$needle is inside the safe block"
            }
            # none of the step's effects sits OUTSIDE the safe block in the script
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

Describe 'Invoke-DeactivatePreviousStep with the PRODUCTION wiring, only az stubbed (t/588 scoping bug, DeployAzure staging test)' -Tag 'devops' {

    # The earlier tests mocked the function under test and pinned its pieces: they never ran the real binding of the scriptblocks, so they could not see
    # that a scriptblock run under Invoke-GuardedDeactivate read ITS $RevisionName (the revision being deactivated) instead of the rollback target, and
    # -DeactivatePrevious deactivated nothing. These tests run the real Invoke-DeactivatePreviousStep -> Invoke-PreviousRevisionDeactivation ->
    # Invoke-GuardedDeactivate -> the real Get-RevisionDeactivationVerdict chain with the SAME arguments the script passes. Only `az` is a stub.

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/GatedRollback.ps1"
        $script:RealVerdictScript = (Resolve-Path "$PSScriptRoot/../operations/devops/Get-RevisionDeactivationVerdict.ps1").Path
        # A verdict script that loads the REAL guard and records the ServingRevisionName it is called with.
        $script:SpyVerdictScript = Join-Path $TestDrive 'spy-verdict.ps1'
        @"
. '$($script:RealVerdictScript)'
`$global:RealVerdict = (Get-Command Get-RevisionDeactivationVerdict -CommandType Function).ScriptBlock
function Get-RevisionDeactivationVerdict {
    param([string]`$RevisionName, `$TrafficWeight, [bool]`$Active = `$true, `$IngressWeight, [bool]`$IsLatestRevisionWithTraffic = `$false, [string]`$ServingRevisionName, [string[]]`$ProtectedNames = @())
    `$global:SeenServing = `$ServingRevisionName
    `$global:SeenRevision = `$RevisionName
    & `$global:RealVerdict @PSBoundParameters
}
"@ | Set-Content -LiteralPath $script:SpyVerdictScript

        # The az stub. Scenarios are set per test in $script:Az.
        function script:az {
            $joined = $args -join ' '
            $script:AzCalls += $joined
            if ($script:Az.ThrowOn -and $joined -match $script:Az.ThrowOn) { throw "az failed: $joined" }
            $global:LASTEXITCODE = 0
            if ($joined -match '^containerapp revision show .*--revision (\S+) -o json') {
                [pscustomobject]@{ properties = [pscustomobject]@{ active = $true; trafficWeight = $script:Az.PreviousWeight } } | ConvertTo-Json -Depth 5
            } elseif ($joined -match '^containerapp show ') {
                $traffic = @([pscustomobject]@{ revisionName = $script:Az.Target; weight = $script:Az.TargetWeight })
                if ($script:Az.PreviousIngressWeight -gt 0) { $traffic += [pscustomobject]@{ revisionName = $script:Az.Previous; weight = $script:Az.PreviousIngressWeight } }
                [pscustomobject]@{ properties = [pscustomobject]@{ latestRevisionName = $script:Az.Target; configuration = [pscustomobject]@{ ingress = [pscustomobject]@{ traffic = $traffic } } } } | ConvertTo-Json -Depth 8
            } elseif ($joined -match '^containerapp revision deactivate ') {
                if ($script:Az.DeactivateExit) { $global:LASTEXITCODE = $script:Az.DeactivateExit }
            }
        }
        function script:NewAz([hashtable]$Over = @{}) {
            $script:AzCalls = @()
            $script:Az = @{ Target = 'rev-target'; Previous = 'rev-old'; PreviousWeight = 0; PreviousIngressWeight = 0; TargetWeight = 100; ThrowOn = $null; DeactivateExit = 0 }
            foreach ($k in $Over.Keys) { $script:Az[$k] = $Over[$k] }
            $global:SeenServing = $null; $global:SeenRevision = $null
        }
        function script:Shifted { [pscustomobject]@{ Action = 'shifted'; Verified = $true; Reason = 'ok' } }
        # EXACTLY the arguments Invoke-GatedRollback.ps1 passes (target from its own $RevisionName), through the same safe wrapper.
        function script:RunStep($Result, [string[]]$Previous, [string]$Target = 'rev-target', [switch]$ReadFailed, [switch]$Switch, [string]$VerdictScript = $script:SpyVerdictScript) {
            $script:Rec = $null
            Invoke-PostShiftStepSafely -Name 'deactivate-previous' -WarningAction SilentlyContinue -Block {
                $script:Rec = Invoke-DeactivatePreviousStep -Result $Result -PreviousRevisions $Previous -TargetRevision $Target `
                    -AppName 'taxonomy-editor-staging' -ResourceGroup 'ai-triad' -ReadFailed:$ReadFailed -DeactivatePrevious:$Switch -VerdictScriptPath $VerdictScript
            }
            $script:Rec
        }
        function script:DeactivateCalls { @($script:AzCalls | Where-Object { $_ -match '^containerapp revision deactivate ' }) }
    }
    BeforeEach { $script:SavedEap = $ErrorActionPreference; $ErrorActionPreference = 'Stop'; NewAz }
    AfterEach { $ErrorActionPreference = $script:SavedEap }

    It 'a previous revision that is NOT serving IS deactivated: the deactivate call is made, the record line names it, and the guard is told the TARGET as the serving revision' {
        $r = Shifted
        $rec = RunStep $r @('rev-old') -Switch
        @(DeactivateCalls).Count | Should -Be 1
        @(DeactivateCalls)[0] | Should -Be 'containerapp revision deactivate -n taxonomy-editor-staging -g ai-triad --revision rev-old -o none'
        $rec.Lines[0] | Should -Be "deactivate-previous: deactivated 'rev-old' (deactivated after the verified shift)"
        @($r.PreviousDeactivated) | Should -Be @('rev-old')
        # THE ASSERTION THAT WOULD HAVE FAILED ON THE BUG: the guard's ServingRevisionName is the rollback target, not the revision being deactivated
        $global:SeenServing | Should -Be 'rev-target'
        $global:SeenRevision | Should -Be 'rev-old'
        $global:SeenServing | Should -Not -Be $global:SeenRevision
    }

    It 'a previous revision that IS the serving target is NOT deactivated, through the step (the decision drops it) and through the guard itself (is-serving-revision)' {
        $rec = RunStep (Shifted) @('rev-target') -Switch
        @(DeactivateCalls).Count | Should -Be 0
        $rec | Should -BeNullOrEmpty -Because 'the decision skipped: no other revision carried traffic'
        # bypass the decision: hand the target to the guard as the "previous" revision; the REAL guard must refuse it
        # TargetWeight 0 isolates the serving-name check: no other rule (weight, ingress) can refuse it, so only ServingRevisionName == the revision does
        NewAz @{ Previous = 'rev-target'; TargetWeight = 0 }
        . $script:SpyVerdictScript
        $out = Invoke-PreviousRevisionDeactivation -PreviousRevision 'rev-target' -ServingTarget 'rev-target' -AppName 'a' -ResourceGroup 'g'
        $out.Deactivated | Should -BeFalse
        $out.Reason | Should -Match 'is-serving-revision'
        @(DeactivateCalls).Count | Should -Be 0
    }

    It 'the guard still protects a previous revision that carries traffic (weight or ingress), so the fix did not weaken it' {
        NewAz @{ PreviousWeight = 30 }
        (RunStep (Shifted) @('rev-old') -Switch).NotDeactivated | Should -Contain 'rev-old'
        @(DeactivateCalls).Count | Should -Be 0
        NewAz @{ PreviousIngressWeight = 20 }
        $rec = RunStep (Shifted) @('rev-old') -Switch
        $rec.Lines[0] | Should -Match 'nonzero-ingress-weight'
        @(DeactivateCalls).Count | Should -Be 0
    }

    It 'the failure arms hold through the production wiring and the exit code equals the no-switch run: unreadable read, non-verified run, no switch' {
        $baseline = Get-GatedRollbackExitCode -Result (Shifted)
        # unreadable pre-shift read
        $r1 = Shifted; RunStep $r1 @('rev-old') -ReadFailed -Switch | Out-Null
        @(DeactivateCalls).Count | Should -Be 0
        Get-GatedRollbackExitCode -Result $r1 | Should -Be $baseline
        # a run that is not a verified shift
        NewAz
        $r2 = [pscustomobject]@{ Action = 'shifted'; Verified = $false; Reason = 'x' }; RunStep $r2 @('rev-old') -Switch | Out-Null
        @(DeactivateCalls).Count | Should -Be 0
        Get-GatedRollbackExitCode -Result $r2 | Should -Be (Get-GatedRollbackExitCode -Result ([pscustomobject]@{ Action = 'shifted'; Verified = $false }))
        # the switch not given
        NewAz
        $r3 = Shifted; RunStep $r3 @('rev-old') | Out-Null
        @(DeactivateCalls).Count | Should -Be 0
        Get-GatedRollbackExitCode -Result $r3 | Should -Be $baseline
    }

    It 'a throw anywhere in the step (az read, az deactivate, the verdict-script dot-source) is contained: nothing escapes, nothing is deactivated, the exit code equals the no-switch run' {
        $baseline = Get-GatedRollbackExitCode -Result (Shifted)
        foreach ($case in @(
                @{ Name = 'az revision show throws'; Over = @{ ThrowOn = '^containerapp revision show' }; Script = $script:SpyVerdictScript },
                @{ Name = 'az deactivate throws'; Over = @{ ThrowOn = '^containerapp revision deactivate' }; Script = $script:SpyVerdictScript },
                @{ Name = 'az deactivate exits non-zero'; Over = @{ DeactivateExit = 1 }; Script = $script:SpyVerdictScript },
                @{ Name = 'the verdict script dot-source throws'; Over = @{}; Script = (Join-Path $TestDrive 'missing' 'verdict.ps1') })) {
            NewAz $case.Over
            $r = Shifted
            $core = { param($x) "$($x.Action)|$($x.Verified)|$($x.Reason)" }
            $before = & $core $r
            $threw = $false
            try { $rec = RunStep $r @('rev-old') -Switch -VerdictScript $case.Script } catch { $threw = $true }
            $threw | Should -BeFalse -Because $case.Name
            @($r.PreviousDeactivated) | Should -Not -Contain 'rev-old' -Because $case.Name
            (& $core $r) | Should -Be $before -Because "$($case.Name): Action, Verified and Reason are untouched"
            Get-GatedRollbackExitCode -Result $r | Should -Be $baseline -Because "$($case.Name): the exit code equals the run without the switch"
        }
    }

    It 'LINT (the bug class): no scriptblock passed to one of our functions reads a variable that function declares or assigns (a dynamic-scope shadow)' {
        $parse = { param($path) $e = $null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $path).Path, [ref]$null, [ref]$e) }
        $gr = & $parse "$PSScriptRoot/../operations/devops/GatedRollback.ps1"
        $wrapper = & $parse "$PSScriptRoot/../operations/devops/Invoke-GatedRollback.ps1"
        $isVar = { param($a) $a -is [System.Management.Automation.Language.VariableExpressionAst] }
        $isAssign = { param($a) $a -is [System.Management.Automation.Language.AssignmentStatementAst] }
        $names = { param($ast) @($ast.FindAll($isVar, $true) | ForEach-Object { $_.VariablePath.UserPath } | Where-Object { $_ -notmatch ':' } | Select-Object -Unique) }
        $automatic = @('_', 'true', 'false', 'null', 'args', 'input', 'PSScriptRoot', 'LASTEXITCODE', 'ErrorActionPreference', 'PSBoundParameters', 'error', 'matches', 'this')
        # what each of OUR functions declares: its parameters and every variable it assigns or loops over
        $functions = @{}
        foreach ($fn in $gr.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
            $declared = @()
            if ($fn.Body.ParamBlock) { $declared += @($fn.Body.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) }
            foreach ($as in $fn.Body.FindAll($isAssign, $true)) { $declared += & $names $as.Left }
            foreach ($fe in $fn.Body.FindAll({ param($a) $a -is [System.Management.Automation.Language.ForEachStatementAst] }, $true)) { $declared += $fe.Variable.VariablePath.UserPath }
            $functions[$fn.Name] = @($declared | Select-Object -Unique)
        }
        # by design, not a bug: Invoke-GatedRollbackCore's own $RevisionName IS the rollback target (the script passes -RevisionName $RevisionName)
        $allowed = @{ 'Invoke-GatedRollbackCore' = @('RevisionName') }
        $findings = @()
        foreach ($tree in @($gr, $wrapper)) {
            foreach ($sb in $tree.FindAll({ param($a) $a -is [System.Management.Automation.Language.ScriptBlockExpressionAst] }, $true)) {
                $cmd = $sb.Parent
                while ($cmd -and $cmd -isnot [System.Management.Automation.Language.CommandAst]) { $cmd = $cmd.Parent }
                if (-not $cmd) { continue }
                $callee = $cmd.GetCommandName()
                if (-not $callee -or -not $functions.ContainsKey($callee)) { continue }
                $block = $sb.ScriptBlock
                $own = @()
                if ($block.ParamBlock) { $own += @($block.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) }
                foreach ($as in $block.FindAll($isAssign, $true)) { $own += & $names $as.Left }
                $free = @(& $names $block | Where-Object { $_ -notin $own -and $_ -notin $automatic })
                foreach ($v in $free) {
                    if ($v -in $functions[$callee] -and $v -notin @($allowed[$callee])) { $findings += "a scriptblock passed to $callee reads `$$v, which $callee itself declares or assigns" }
                }
            }
        }
        $findings | Should -Be @()
    }

    It 'LINT arm: the lint catches the original bug shape (a block under Invoke-GuardedDeactivate reading $RevisionName)' {
        $src = 'function Bad { param($Prev, $RevisionName) Invoke-GuardedDeactivate -RevisionName $Prev -GetVerdict { param($Rev) Get-X -ServingRevisionName $RevisionName } -Deactivate { param($Rev) } }'
        $tree = [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$null, [ref]$null)
        $sb = $tree.Find({ param($a) $a -is [System.Management.Automation.Language.ScriptBlockExpressionAst] }, $true)
        $free = @($sb.ScriptBlock.FindAll({ param($a) $a -is [System.Management.Automation.Language.VariableExpressionAst] }, $true) | ForEach-Object { $_.VariablePath.UserPath })
        $free | Should -Contain 'RevisionName'
        # and Invoke-GuardedDeactivate really declares RevisionName, which is why that read was wrong
        (Get-Command Invoke-GuardedDeactivate).Parameters.Keys | Should -Contain 'RevisionName'
    }

    It 'WIRING: the script calls Invoke-DeactivatePreviousStep with its own $RevisionName as the target, and the function binds it to a distinct variable the blocks read' {
        $wrapper = Get-Content -Raw "$PSScriptRoot/../operations/devops/Invoke-GatedRollback.ps1"
        $wrapper | Should -Match '(?s)Invoke-DeactivatePreviousStep -Result \$r -PreviousRevisions \$previousRevisions -TargetRevision \$RevisionName\s*`\s*\r?\n\s*-AppName \$AppName -ResourceGroup \$ResourceGroup'
        $fn = Get-Content -Raw "$PSScriptRoot/../operations/devops/GatedRollback.ps1"
        $fn | Should -Match '\$guardServingTarget = \$ServingTarget'
        $fn | Should -Match '-ServingRevisionName \$guardServingTarget'
        $fn | Should -Match '-ServingTarget \$TargetRevision'
    }
}
