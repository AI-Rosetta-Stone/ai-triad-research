# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4932: 2026-11-06 staging downgrade incident, plus the 2026-11-09 live-incident redesign
# (p/916#12-18): the predicate flipped to the POSITIVE relation (current-is-ancestor-of-built),
# and the old single "unknown commit" case split into BuiltMissing (always block) and
# CurrentMissing (proceed with a WARN -- the off-main/force-push recovery path).

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-StagingDeployGateVerdict.ps1')
}

Describe 'Get-StagingDeployGateVerdict (t/4932)' {
    It 'push=false -> skip, whatever the SHA comparison' {
        $r = Get-StagingDeployGateVerdict -Pushed $false -BuiltSha 'abc1234' -CurrentDeploySha 'def5678' -CurrentIsAncestorOfBuilt $false
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'did not push'
    }

    It 'forward deploy: current IS an ancestor of built -> proceed, no warn' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'new999' -CurrentDeploySha 'old111' -CurrentIsAncestorOfBuilt $true
        $r.Proceed | Should -Be $true
        $r.Warn | Should -Be $false
    }

    It 'downgrade: current is NOT an ancestor of built (built is older) -> skip' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'old111' -CurrentDeploySha 'new999' -CurrentIsAncestorOfBuilt $false
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'does not descend'
        $r.Reason | Should -Match 'downgrade or diverged'
    }

    It 'diverged build: current is NOT an ancestor of built (different branch) -> skip, same arm as downgrade' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'branch555' -CurrentDeploySha 'main111' -CurrentIsAncestorOfBuilt $false
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'downgrade or diverged'
    }

    It 'the built SHA equals the current deploy SHA -> skip (nothing to redeploy, rebuild case), even if Pushed=true' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'same123' -CurrentDeploySha 'same123' -CurrentIsAncestorOfBuilt $true
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'nothing to redeploy'
    }

    It 'a first deploy (no CurrentDeploySha, no ancestor comparison possible) proceeds when pushed' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'abc1234' -CurrentDeploySha '' -CurrentIsAncestorOfBuilt $null
        $r.Proceed | Should -Be $true
        $r.Warn | Should -Be $false
    }

    It 'push=false is checked before the SHA comparison -- a forward SHA AND push=false still reports the push reason' {
        $r = Get-StagingDeployGateVerdict -Pushed $false -BuiltSha 'new999' -CurrentDeploySha 'old111' -CurrentIsAncestorOfBuilt $true
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'did not push'
    }

    # S1 (Lead review, #4679): an active revision exists but DEPLOY_SHA couldn't be read --
    # fails closed with a WARN, distinct from a true first deploy (no active revision at all).
    It 'S1: CurrentDeployReadFailed=true fails closed with Warn, even though Pushed=true' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'abc1234' -CurrentDeploySha '' -CurrentDeployReadFailed $true
        $r.Proceed | Should -Be $false
        $r.Warn | Should -Be $true
        $r.Reason | Should -Match 'could not be read'
    }

    It 'S1: is checked before the SHA comparison -- read-failed takes priority over an incidental SHA match' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'same123' -CurrentDeploySha 'same123' -CurrentDeployReadFailed $true
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'could not be read'
    }

    It 'S1: a TRUE first deploy (no active revision, CurrentDeployReadFailed=false) is NOT the S1 case -- proceeds' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'abc1234' -CurrentDeploySha '' -CurrentDeployReadFailed $false -CurrentIsAncestorOfBuilt $null
        $r.Proceed | Should -Be $true
        $r.Warn | Should -Be $false
    }

    # TL p/916#17: BUILT missing always blocks, regardless of what the ancestor predicate would
    # have said (it's $null here anyway, since the caller never reaches merge-base in this case).
    It 'BUILT missing -> block, even though Pushed=true and there is a CurrentDeploySha' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'ghost1234' -CurrentDeploySha 'old111' -BuiltMissing $true
        $r.Proceed | Should -Be $false
        $r.Warn | Should -Be $true
        $r.Reason | Should -Match 'does not resolve in this checkout'
    }

    It 'BUILT missing is checked before the first-deploy case -- an empty CurrentDeploySha does not mask it' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'ghost1234' -CurrentDeploySha '' -BuiltMissing $true
        $r.Proceed | Should -Be $false
        $r.Reason | Should -Match 'does not resolve in this checkout'
    }

    # Lead p/916#16, TL p/916#17: CURRENT missing (but BUILT confirmed to exist) is the recovery
    # path -- an off-main or force-pushed staging deploy must not block a legitimate main build
    # forever. Proceeds, but WARNs, since the forward-deploy guard genuinely could not verify it.
    It 'CURRENT missing (BUILT resolvable) -> proceed with a WARN (recovery path)' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'new999' -CurrentDeploySha 'unreachable999' -CurrentMissing $true
        $r.Proceed | Should -Be $true
        $r.Warn | Should -Be $true
        $r.Reason | Should -Match 'not found in this checkout'
    }

    It 'CURRENT missing takes priority over the ancestor predicate (which is null/meaningless in that case anyway)' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'new999' -CurrentDeploySha 'unreachable999' -CurrentMissing $true -CurrentIsAncestorOfBuilt $null
        $r.Proceed | Should -Be $true
        $r.Warn | Should -Be $true
    }

    It 'a clean forward deploy (current ancestor of built) proceeds WITHOUT warning' {
        $r = Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'new999' -CurrentDeploySha 'old111' -CurrentIsAncestorOfBuilt $true
        $r.Proceed | Should -Be $true
        $r.Warn | Should -Be $false
    }

    It 'every skip/warn reason sets Warn=true' {
        (Get-StagingDeployGateVerdict -Pushed $false -BuiltSha 'a' -CurrentDeploySha 'b').Warn | Should -Be $true
        (Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'a' -CurrentDeploySha '' -CurrentDeployReadFailed $true).Warn | Should -Be $true
        (Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'same' -CurrentDeploySha 'same' -CurrentIsAncestorOfBuilt $true).Warn | Should -Be $true
        (Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'old' -CurrentDeploySha 'new' -CurrentIsAncestorOfBuilt $false).Warn | Should -Be $true
        (Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'ghost' -CurrentDeploySha 'x' -BuiltMissing $true).Warn | Should -Be $true
        (Get-StagingDeployGateVerdict -Pushed $true -BuiltSha 'new' -CurrentDeploySha 'unreachable' -CurrentMissing $true).Warn | Should -Be $true
    }
}

Describe 'deploy-staging.yml gate job workflow wiring (t/4932)' {
    BeforeAll {
        $Script:Workflow = Get-Content (Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-staging.yml') -Raw
    }

    # Lead p/916#18: fetch-depth: 0 is already present (added in #4679 for the ancestor check) --
    # this guards against it being silently removed, which would make merge-base spuriously
    # exit 128 on a shallow clone and push every deploy down the CurrentMissing/WARN path.
    It 'gate job checkout uses fetch-depth: 0 (needed for the ancestor check to see full history)' {
        $gateStart = $Script:Workflow.IndexOf('  gate:')
        $gateStart | Should -BeGreaterThan -1
        $deployStagingStart = $Script:Workflow.IndexOf("`n  deploy-staging:", $gateStart)
        $gateBody = $Script:Workflow.Substring($gateStart, $deployStagingStart - $gateStart)
        $gateBody | Should -Match 'actions/checkout@'
        $gateBody | Should -Match 'fetch-depth:\s*0'
    }

    It 'the compare step resets $global:LASTEXITCODE after both the az and git native-command captures' {
        $compareStart = $Script:Workflow.IndexOf("id: compare")
        $compareStart | Should -BeGreaterThan -1
        $verdictStart = $Script:Workflow.IndexOf("id: verdict", $compareStart)
        $compareBody = $Script:Workflow.Substring($compareStart, $verdictStart - $compareStart)

        $azResetIdx = $compareBody.IndexOf('$AzExit = $LASTEXITCODE')
        $azResetIdx | Should -BeGreaterThan -1
        $windowLen = [Math]::Min(500, $compareBody.Length - $azResetIdx)
        $compareBody.Substring($azResetIdx, $windowLen) | Should -Match '\$global:LASTEXITCODE = 0'

        ($compareBody | Select-String -Pattern '\$global:LASTEXITCODE = 0' -AllMatches).Matches.Count | Should -BeGreaterOrEqual 3
    }

    It 'the GitMergeBaseFn scriptblock calls --is-ancestor with Ancestor (current) first, Descendant (built) second' {
        $Script:Workflow | Should -Match 'git merge-base --is-ancestor \$Ancestor \$Descendant'
    }

    It 'merge-base is invoked with CurrentSha as the ancestor-candidate and BuiltSha as the descendant-candidate' {
        $Script:Workflow | Should -Match '-GitMergeBaseFn\s*\{'
    }
}
