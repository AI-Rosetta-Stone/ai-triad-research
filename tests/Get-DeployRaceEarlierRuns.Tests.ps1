# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Unit tests for Get-DeployRaceEarlierRuns (t/4233: break startedAt ties on databaseId in the
    t/4194 deploy-race wait-gate).
.DESCRIPTION
    CI can't reliably produce a real same-second tie between two dispatched workflow runs, so
    this tests the extracted pure predicate directly instead of the workflow steps themselves.
    Arms:
      Earlier:        other.startedAt < own.startedAt                      → counted earlier.
      Tie, lower ID:  startedAt equal, other.databaseId < own.databaseId   → counted earlier.
      Tie, higher ID: startedAt equal, other.databaseId > own.databaseId   → NOT counted earlier.
      Later:          other.startedAt > own.startedAt                      → NOT counted earlier.
      Antisymmetry:   for two distinct same-second runs A and B, exactly one of
                       "A sees B as earlier" / "B sees A as earlier" holds.
#>

Describe 'Get-DeployRaceEarlierRuns — tie-break on databaseId (t/4233)' {

    BeforeAll {
        . "$PSScriptRoot/../operations/devops/Get-DeployRaceEarlierRuns.ps1"
        $script:Now = [datetimeoffset]::Parse('2026-11-06T12:00:00Z')
    }

    Context 'Earlier arm' {
        It 'counts a genuinely earlier startedAt as earlier, regardless of databaseId' {
            $others = @(@{ startedAt = $script:Now.AddSeconds(-10); databaseId = 999 })
            $result = @(Get-DeployRaceEarlierRuns -OwnStartedAt $script:Now -OwnDatabaseId 200 -Others $others)
            $result.Count | Should -Be 1
        }
    }

    Context 'Tie arm — lower databaseId' {
        It 'counts a same-second tie as earlier when the other run has the lower databaseId' {
            $others = @(@{ startedAt = $script:Now; databaseId = 100 })
            $result = @(Get-DeployRaceEarlierRuns -OwnStartedAt $script:Now -OwnDatabaseId 200 -Others $others)
            $result.Count | Should -Be 1
        }
    }

    Context 'Tie arm — higher databaseId' {
        It 'does NOT count a same-second tie as earlier when the other run has the higher databaseId' {
            $others = @(@{ startedAt = $script:Now; databaseId = 300 })
            $result = @(Get-DeployRaceEarlierRuns -OwnStartedAt $script:Now -OwnDatabaseId 200 -Others $others)
            $result.Count | Should -Be 0
        }
    }

    Context 'Later arm' {
        It 'does NOT count a genuinely later startedAt as earlier' {
            $others = @(@{ startedAt = $script:Now.AddSeconds(10); databaseId = 1 })
            $result = @(Get-DeployRaceEarlierRuns -OwnStartedAt $script:Now -OwnDatabaseId 200 -Others $others)
            $result.Count | Should -Be 0
        }
    }

    Context 'Antisymmetry — same-second tie, two distinct runs' {
        It 'exactly one of A-sees-B-earlier / B-sees-A-earlier holds' {
            $aStartedAt = $script:Now
            $aDatabaseId = 100
            $bStartedAt = $script:Now
            $bDatabaseId = 200

            $aSeesBEarlier = @(Get-DeployRaceEarlierRuns -OwnStartedAt $aStartedAt -OwnDatabaseId $aDatabaseId -Others @(@{ startedAt = $bStartedAt; databaseId = $bDatabaseId })).Count -eq 1
            $bSeesAEarlier = @(Get-DeployRaceEarlierRuns -OwnStartedAt $bStartedAt -OwnDatabaseId $bDatabaseId -Others @(@{ startedAt = $aStartedAt; databaseId = $aDatabaseId })).Count -eq 1

            ($aSeesBEarlier -xor $bSeesAEarlier) | Should -BeTrue
        }
    }

    Context 'Multiple others, mixed arms' {
        It 'returns only the subset that is actually earlier' {
            $others = @(
                @{ startedAt = $script:Now.AddSeconds(-5); databaseId = 1 }   # earlier
                @{ startedAt = $script:Now; databaseId = 50 }                 # tie, lower -> earlier
                @{ startedAt = $script:Now; databaseId = 999 }                # tie, higher -> not earlier
                @{ startedAt = $script:Now.AddSeconds(5); databaseId = 2 }    # later -> not earlier
            )
            $result = @(Get-DeployRaceEarlierRuns -OwnStartedAt $script:Now -OwnDatabaseId 200 -Others $others)
            $result.Count | Should -Be 2
        }
    }

    Context 'Real parse paths — own raw `gh api --jq` string vs. others via ConvertFrom-Json' {
        It 'still detects a same-second tie when -OwnStartedAt is a raw ISO string (as gh api --jq emits) and -Others carries ConvertFrom-Json DateTime values (not strings)' {
            # SO e/428#2 (non-blocking recommendation): the production call sites don't match
            # types exactly — $OwnStartedAt comes from `gh api ... --jq '.run_started_at'`, a raw
            # [string]; $Others comes from `gh run list --json ... | ConvertFrom-Json`, which
            # auto-converts ISO8601-looking strings to [DateTime] (not [datetimeoffset], and NOT
            # a string). Both get cast to [datetimeoffset] inside the function/here, but prove
            # the actual types in play, not just pre-cast [datetimeoffset] fixtures.
            $ownRaw = '2026-11-06T12:00:00Z'  # raw string, as gh api --jq would emit
            $othersJson = '[{"databaseId": 100, "startedAt": "2026-11-06T12:00:00Z"}]'
            $others = $othersJson | ConvertFrom-Json
            $others[0].startedAt.GetType().Name | Should -Be 'DateTime'  # sanity: not a string

            $result = @(Get-DeployRaceEarlierRuns -OwnStartedAt ([datetimeoffset]$ownRaw) -OwnDatabaseId 200 -Others $others)
            $result.Count | Should -Be 1
        }
    }
}
