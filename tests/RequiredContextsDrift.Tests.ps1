# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Arms for the t/3646 required-contexts drift comparator (RequiredContextsDriftVerdict.ps1).
.DESCRIPTION
    The SSOT is a mirror of branch protection; a drifted mirror makes workflow-lint enforce the wrong
    set. These test the pure set-comparison (no network): in-sync (order-insensitive), over-claim
    (SSOT has extra), under-claim (API has extra), and both directions at once.
#>

Describe 'Get-RequiredContextsDriftVerdict (t/3646)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/RequiredContextsDriftVerdict.ps1"
    }

    It 'IN SYNC — same set, different order' {
        $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate', 'joint-gv-guard', 'CodeQL') -Api @('CodeQL', 'ci-gate', 'joint-gv-guard')
        $v.InSync | Should -BeTrue
        @($v.MissingFromApi).Count | Should -Be 0
        @($v.MissingFromSsot).Count | Should -Be 0
    }

    It 'over-claim — SSOT lists a context branch protection does NOT require' {
        $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate', 'CodeQL', 'ghost-gate') -Api @('ci-gate', 'CodeQL')
        $v.InSync | Should -BeFalse
        $v.MissingFromApi | Should -Be @('ghost-gate')
        @($v.MissingFromSsot).Count | Should -Be 0
    }

    It 'under-claim — branch protection requires a context MISSING from the SSOT' {
        $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate') -Api @('ci-gate', 'CodeQL')
        $v.InSync | Should -BeFalse
        @($v.MissingFromApi).Count | Should -Be 0
        $v.MissingFromSsot | Should -Be @('CodeQL')
    }

    It 'both directions — over- and under-claim at once' {
        $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate', 'old-gate') -Api @('ci-gate', 'new-gate')
        $v.InSync | Should -BeFalse
        $v.MissingFromApi | Should -Be @('old-gate')
        $v.MissingFromSsot | Should -Be @('new-gate')
    }

    It 'dedupes and trims whitespace before comparing' {
        $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate', ' ci-gate ', 'CodeQL') -Api @('CodeQL', 'ci-gate')
        $v.InSync | Should -BeTrue
    }

    Context '"strict" assertion (t/3804 PR-1)' {
        It 'BACKWARD COMPAT: omitting -SsotStrict/-ApiStrict does not affect InSync (pre-existing callers unaffected)' {
            $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate') -Api @('ci-gate')
            $v.InSync | Should -BeTrue
            $v.StrictChecked | Should -BeFalse
        }

        It 'IN SYNC on contexts AND matching strict (both false)' {
            $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate') -Api @('ci-gate') -SsotStrict $false -ApiStrict $false
            $v.InSync | Should -BeTrue
            $v.StrictChecked | Should -BeTrue
            $v.StrictInSync | Should -BeTrue
        }

        It 'LOAD-BEARING: contexts in sync but strict MISMATCHES (SSOT false, live true) -> NOT in sync' {
            $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate') -Api @('ci-gate') -SsotStrict $false -ApiStrict $true
            $v.InSync | Should -BeFalse
            $v.StrictChecked | Should -BeTrue
            $v.StrictInSync | Should -BeFalse
            $v.SsotStrict | Should -BeFalse
            $v.ApiStrict | Should -BeTrue
        }

        It 'a strict mismatch alone (contexts otherwise in sync) is the ONLY reason InSync is false' {
            $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate', 'CodeQL') -Api @('ci-gate', 'CodeQL') -SsotStrict $false -ApiStrict $true
            @($v.MissingFromApi).Count | Should -Be 0
            @($v.MissingFromSsot).Count | Should -Be 0
            $v.InSync | Should -BeFalse
        }

        It 'strict mismatch is INDEPENDENT of context drift — both can fire together' {
            $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate', 'ghost-gate') -Api @('ci-gate') -SsotStrict $false -ApiStrict $true
            $v.MissingFromApi | Should -Be @('ghost-gate')
            $v.StrictInSync | Should -BeFalse
            $v.InSync | Should -BeFalse
        }
    }

    Context '"enforce_admins" assertion (t/3804 PR-2)' {
        It 'BACKWARD COMPAT: omitting -SsotEnforceAdmins/-ApiEnforceAdmins does not affect InSync' {
            $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate') -Api @('ci-gate') -SsotStrict $false -ApiStrict $false
            $v.InSync | Should -BeTrue
            $v.EnforceAdminsChecked | Should -BeFalse
        }

        It 'IN SYNC on contexts, strict, AND matching enforce_admins (both true)' {
            $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate') -Api @('ci-gate') -SsotStrict $false -ApiStrict $false -SsotEnforceAdmins $true -ApiEnforceAdmins $true
            $v.InSync | Should -BeTrue
            $v.EnforceAdminsChecked | Should -BeTrue
            $v.EnforceAdminsInSync | Should -BeTrue
        }

        It 'LOAD-BEARING: contexts and strict in sync but enforce_admins MISMATCHES (SSOT true, live false) -> NOT in sync' {
            $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate') -Api @('ci-gate') -SsotStrict $false -ApiStrict $false -SsotEnforceAdmins $true -ApiEnforceAdmins $false
            $v.InSync | Should -BeFalse
            $v.EnforceAdminsChecked | Should -BeTrue
            $v.EnforceAdminsInSync | Should -BeFalse
            $v.SsotEnforceAdmins | Should -BeTrue
            $v.ApiEnforceAdmins | Should -BeFalse
        }

        It 'an enforce_admins mismatch alone (contexts and strict otherwise in sync) is the ONLY reason InSync is false' {
            $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate', 'CodeQL') -Api @('ci-gate', 'CodeQL') -SsotStrict $false -ApiStrict $false -SsotEnforceAdmins $true -ApiEnforceAdmins $false
            @($v.MissingFromApi).Count | Should -Be 0
            @($v.MissingFromSsot).Count | Should -Be 0
            $v.StrictInSync | Should -BeTrue
            $v.InSync | Should -BeFalse
        }

        It 'enforce_admins mismatch is INDEPENDENT of strict mismatch and context drift — all three can fire together' {
            $v = Get-RequiredContextsDriftVerdict -Ssot @('ci-gate', 'ghost-gate') -Api @('ci-gate') -SsotStrict $false -ApiStrict $true -SsotEnforceAdmins $true -ApiEnforceAdmins $false
            $v.MissingFromApi | Should -Be @('ghost-gate')
            $v.StrictInSync | Should -BeFalse
            $v.EnforceAdminsInSync | Should -BeFalse
            $v.InSync | Should -BeFalse
        }
    }
}

Describe 'Get-RequiredContextsAppPinVerdict (t/728)' -Tag 'devops' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/RequiredContextsDriftVerdict.ps1"
        function script:Pin($context, $id, $prop = 'app_id') { [PSCustomObject]@{ context = $context; $prop = $id } }
        $script:Ssot = @((Pin 'ci-gate' 15368), (Pin 'merge-approval' 5912670))
        $script:Classic = @((Pin 'ci-gate' 15368), (Pin 'merge-approval' 5912670))
        $script:Rules = @((Pin 'ci-gate' 15368 'integration_id'), (Pin 'merge-approval' 5912670 'integration_id'))
    }

    It 'IN SYNC: every pin matches in the mirror, classic protection and the ruleset' {
        $v = Get-RequiredContextsAppPinVerdict -Ssot $script:Ssot -Classic $script:Classic -Ruleset $script:Rules -RulesetChecked $true
        $v.InSync | Should -BeTrue
        @($v.Problems).Count | Should -Be 0
    }

    It 'the pin is removed LIVE (classic app_id -1): drift, even though the names still match' {
        $live = @((Pin 'ci-gate' 15368), (Pin 'merge-approval' -1))
        $v = Get-RequiredContextsAppPinVerdict -Ssot $script:Ssot -Classic $live
        $v.InSync | Should -BeFalse
        ($v.Problems -join ' ') | Should -Match "leaves 'merge-approval' unpinned"
    }

    It 'the pin is null LIVE: drift' {
        $live = @((Pin 'ci-gate' $null), (Pin 'merge-approval' 5912670))
        (Get-RequiredContextsAppPinVerdict -Ssot $script:Ssot -Classic $live).InSync | Should -BeFalse
    }

    It 'the pin CHANGED live (a different App): drift naming both ids' {
        $live = @((Pin 'ci-gate' 15368), (Pin 'merge-approval' 15368))
        $v = Get-RequiredContextsAppPinVerdict -Ssot $script:Ssot -Classic $live
        $v.InSync | Should -BeFalse
        ($v.Problems -join ' ') | Should -Match "pins 'merge-approval' to 15368, the SSOT expects 5912670"
    }

    It 'the pin is MISSING in the mirror: drift, and an unpinned live context is drift even when the mirror also says null' {
        $noPin = @([PSCustomObject]@{ context = 'ci-gate' }, (Pin 'merge-approval' 5912670))
        $v = Get-RequiredContextsAppPinVerdict -Ssot $noPin -Classic $script:Classic
        $v.InSync | Should -BeFalse
        ($v.Problems -join ' ') | Should -Match "SSOT has no valid app_id for 'ci-gate'"
        $bothNull = Get-RequiredContextsAppPinVerdict -Ssot @((Pin 'ci-gate' $null)) -Classic @((Pin 'ci-gate' $null))
        $bothNull.InSync | Should -BeFalse
        ($bothNull.Problems -join ' ') | Should -Match 'leaves .ci-gate. unpinned'
    }

    It 'the legacy contexts[] shape (no pin data) reads as unpinned, never in sync' {
        $v = Get-RequiredContextsAppPinVerdict -Ssot $script:Ssot -Classic @([PSCustomObject]@{ context = 'ci-gate'; app_id = $null }, [PSCustomObject]@{ context = 'merge-approval'; app_id = $null })
        $v.InSync | Should -BeFalse
    }

    It 'classic and the ruleset DISAGREE (the mirror matches classic): drift' {
        $rs = @((Pin 'ci-gate' 15368 'integration_id'), (Pin 'merge-approval' 15368 'integration_id'))
        $v = Get-RequiredContextsAppPinVerdict -Ssot $script:Ssot -Classic $script:Classic -Ruleset $rs -RulesetChecked $true
        $v.InSync | Should -BeFalse
        ($v.Problems -join ' ') | Should -Match "ruleset pins 'merge-approval' to 15368"
    }

    It 'the ruleset leaves a context unpinned (integration_id null) or does not require it: drift' {
        $unpinned = @((Pin 'ci-gate' 15368 'integration_id'), (Pin 'merge-approval' $null 'integration_id'))
        (Get-RequiredContextsAppPinVerdict -Ssot $script:Ssot -Classic $script:Classic -Ruleset $unpinned -RulesetChecked $true).InSync | Should -BeFalse
        $missing = @((Pin 'ci-gate' 15368 'integration_id'))
        $v = Get-RequiredContextsAppPinVerdict -Ssot $script:Ssot -Classic $script:Classic -Ruleset $missing -RulesetChecked $true
        $v.InSync | Should -BeFalse
        ($v.Problems -join ' ') | Should -Match "ruleset does not require 'merge-approval'"
    }

    It 'the ruleset arm is skipped when the ruleset was not read' {
        (Get-RequiredContextsAppPinVerdict -Ssot $script:Ssot -Classic $script:Classic -Ruleset @() -RulesetChecked $false).InSync | Should -BeTrue
    }

    It 'the committed SSOT carries a valid app_id for every required context' {
        $json = Get-Content -Raw (Join-Path $PSScriptRoot '..' '.github' 'ci' 'required-contexts.json') | ConvertFrom-Json
        foreach ($e in $json.required_contexts) {
            $e.PSObject.Properties['app_id'] | Should -Not -BeNullOrEmpty -Because "$($e.context) must name its App pin"
            [long]$e.app_id | Should -BeGreaterThan 0
        }
    }
}
