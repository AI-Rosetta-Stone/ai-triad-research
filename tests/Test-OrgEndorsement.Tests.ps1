# Tag: taxonomy (t/4475 7b / t/4523 endorsement-confirmation gate)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Coverage for Test-OrgEndorsement — the LLM wrapper behind the t/4523
    endorsement-confirmation gate used by Invoke-OrgClaimMatching.
.DESCRIPTION
    Invoke-AIApi is mocked (no network/spend); this suite covers the wrapper's
    own contract: verdict mapping, the fail-safe to 'unknown' on a call
    failure, out-of-enum verdicts, and an empty input short-circuit.
#>

BeforeAll {
    $ModulePath = Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1'
    Import-Module $ModulePath -Force -WarningAction SilentlyContinue
}

Describe 'Test-OrgEndorsement (t/4523 wrapper)' -Tag 'taxonomy' {

    It 'Returns the verdict per pair, order preserved' {
        InModuleScope AITriad {
            Mock Invoke-AIApi {
                $v = if ($Prompt -match 'ENDORSE-MARKER') { 'endorses' }
                     elseif ($Prompt -match 'PARTIAL-MARKER') { 'partial' }
                     else { 'topic_only' }
                [PSCustomObject]@{ Text = (@{ verdict = $v; reason = 'r' } | ConvertTo-Json -Compress); Backend = 'mock' }
            }

            $r = Test-OrgEndorsement -Pair @(
                @{ Id = 'a'; ClaimProp = 'ENDORSE-MARKER claim'; NodeProp = 'node'; NodePov = 'accelerationist' }
                @{ Id = 'b'; ClaimProp = 'PARTIAL-MARKER claim'; NodeProp = 'node'; NodePov = 'safetyist' }
                @{ Id = 'c'; ClaimProp = 'plain claim';          NodeProp = 'node'; NodePov = 'skeptic' }
            )
            @($r).Count | Should -Be 3
            $r[0].Id | Should -Be 'a'; $r[0].Verdict | Should -Be 'endorses'
            $r[1].Id | Should -Be 'b'; $r[1].Verdict | Should -Be 'partial'
            $r[2].Id | Should -Be 'c'; $r[2].Verdict | Should -Be 'topic_only'
        }
    }

    It 'Fails safe to "unknown" when the AI call throws — never a silent demotion' {
        InModuleScope AITriad {
            Mock Invoke-AIApi { throw 'backend unreachable' }

            $r = Test-OrgEndorsement -Pair @(@{ Id = 'x'; ClaimProp = 'c'; NodeProp = 'n'; NodePov = 'skeptic' }) 3>$null
            $r[0].Verdict | Should -Be 'unknown'
        }
    }

    It 'Fails safe to "unknown" when the response is empty or unparseable' {
        InModuleScope AITriad {
            Mock Invoke-AIApi { [PSCustomObject]@{ Text = ''; Backend = 'mock' } }
            $r1 = Test-OrgEndorsement -Pair @(@{ Id = 'x'; ClaimProp = 'c'; NodeProp = 'n'; NodePov = 'skeptic' }) 3>$null
            $r1[0].Verdict | Should -Be 'unknown'
        }
        InModuleScope AITriad {
            Mock Invoke-AIApi { [PSCustomObject]@{ Text = 'not json'; Backend = 'mock' } }
            $r2 = Test-OrgEndorsement -Pair @(@{ Id = 'y'; ClaimProp = 'c'; NodeProp = 'n'; NodePov = 'skeptic' }) 3>$null
            $r2[0].Verdict | Should -Be 'unknown'
        }
    }

    It 'Fails safe to "unknown" on an out-of-enum verdict, with a WARN' {
        InModuleScope AITriad {
            Mock Invoke-AIApi { [PSCustomObject]@{ Text = (@{ verdict = 'maybe' } | ConvertTo-Json -Compress); Backend = 'mock' } }
            $Warnings = $null
            $r = Test-OrgEndorsement -Pair @(@{ Id = 'z'; ClaimProp = 'c'; NodeProp = 'n'; NodePov = 'skeptic' }) -WarningVariable Warnings -WarningAction SilentlyContinue
            $r[0].Verdict | Should -Be 'unknown'
            @($Warnings | Where-Object { "$_" -like '*out-of-enum*' }).Count | Should -Be 1
        }
    }

    It 'An empty pair collection returns an empty result — no AI call' {
        InModuleScope AITriad {
            Mock Invoke-AIApi { throw 'should never be called' }
            $r = Test-OrgEndorsement -Pair @()
            @($r).Count | Should -Be 0
        }
    }
}
