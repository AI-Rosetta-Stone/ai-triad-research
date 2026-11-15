# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

# Interweave t/78: Invoke-ContainerBuild.ps1 step 2 must find the ci-gate check-run even
# when the commit carries more than 30 check runs (merge-queue commits carry 100+). The
# unfiltered /check-runs endpoint returns page 1 only (30 runs), so a ci-gate on page 2
# was invisible and the poll timed out while ci-gate was green (commit 295ad67b: 135
# runs, green ci-gate not on page 1).
#
# `gh` is replaced by a global function that emulates the GitHub API's paging and
# `check_name` filter, so the tests never reach GitHub and never dispatch a real build.

BeforeAll {
    $script:ScriptPath = Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Invoke-ContainerBuild.ps1'
    $script:Sha        = '295ad67b92b402ebdc22112b9c2f95573beee0ad'

    function script:New-FakeRun {
        param([string]$Name, [string]$Status = 'completed', [string]$Conclusion = 'success', [int]$MinutesAgo = 10)
        [pscustomobject]@{
            name       = $Name
            status     = $Status
            conclusion = if ($Status -eq 'completed') { $Conclusion } else { $null }
            started_at = (Get-Date).ToUniversalTime().AddMinutes(-$MinutesAgo).ToString('yyyy-MM-ddTHH:mm:ssZ')
        }
    }

    # N unrelated runs first, so anything after index 29 sits on page 2 of the default listing.
    function script:New-Filler {
        param([int]$Count)
        @(1..$Count | ForEach-Object { New-FakeRun -Name "job-$_" })
    }

    function global:gh {
        $argList = @($args)
        $global:T78GhCalls.Add(($argList -join ' '))

        if ($argList[0] -eq 'api' -and $argList[1] -match '/commits/[0-9a-f]{40}/check-runs(\?(?<q>.*))?$') {
            $query = @{}
            if ($Matches['q']) {
                foreach ($pair in $Matches['q'] -split '&') {
                    $k, $v = $pair -split '=', 2
                    $query[$k] = $v
                }
            }
            $runs = @($global:T78FakeRuns)
            if ($query.ContainsKey('check_name')) {
                $runs = @($runs | Where-Object { $_.name -eq $query['check_name'] })
            }
            $perPage = if ($query.ContainsKey('per_page')) { [int]$query['per_page'] } else { 30 }
            $page    = @($runs | Select-Object -First $perPage)

            # Emulate the script's --jq '[.check_runs[] | select(.name == "ci-gate")]'.
            $jqIndex = [array]::IndexOf($argList, '--jq')
            if ($jqIndex -lt 0 -or $argList[$jqIndex + 1] -notmatch 'select\(\.name == "ci-gate"\)') {
                throw "fake gh: unexpected --jq for check-runs: $($argList -join ' ')"
            }
            $global:LASTEXITCODE = 0
            return (ConvertTo-Json -InputObject @($page | Where-Object { $_.name -eq 'ci-gate' }) -Compress -Depth 5)
        }
        if ($argList[0] -eq 'workflow' -and $argList[1] -eq 'run') {
            $global:LASTEXITCODE = 0
            return
        }
        if ($argList[0] -eq 'api' -and $argList[1] -match 'actions/workflows/container\.yml/runs') {
            $global:LASTEXITCODE = 0
            return 'Run 1: https://example.invalid/runs/1'
        }
        throw "fake gh: unexpected call: $($argList -join ' ')"
    }
}

AfterAll {
    Remove-Item -Path Function:\global:gh -ErrorAction SilentlyContinue
    Remove-Variable -Name T78GhCalls, T78FakeRuns -Scope Global -ErrorAction SilentlyContinue
}

Describe 'Invoke-ContainerBuild.ps1 step 2 ci-gate lookup (t/78)' {
    BeforeEach {
        $global:T78GhCalls = [System.Collections.Generic.List[string]]::new()
        Mock Start-Sleep { }
        Mock Write-Host { }
    }

    It 'finds a green ci-gate that sits beyond the first 30 check runs and dispatches' {
        $global:T78FakeRuns = @(New-Filler -Count 40) + @(New-FakeRun -Name 'ci-gate')

        { & $script:ScriptPath -Sha $script:Sha -Push:$false -WaitTimeoutMinutes 0 } | Should -Not -Throw

        @($global:T78GhCalls | Where-Object { $_ -like 'workflow run container.yml*' }).Count | Should -Be 1
        $global:T78GhCalls | Should -Contain "workflow run container.yml --repo AI-Rosetta-Stone/ai-triad-research --ref main -f sha=$($script:Sha) -f push=false"
    }

    It 'queries check-runs by name with per_page=100' {
        $global:T78FakeRuns = @(New-FakeRun -Name 'ci-gate')

        & $script:ScriptPath -Sha $script:Sha -Push:$false -WaitTimeoutMinutes 0

        $checkCalls = @($global:T78GhCalls | Where-Object { $_ -match '/check-runs' })
        $checkCalls.Count | Should -BeGreaterThan 0
        foreach ($c in $checkCalls) {
            $c | Should -Match "repos/AI-Rosetta-Stone/ai-triad-research/commits/$($script:Sha)/check-runs\?check_name=ci-gate&per_page=100 "
        }
    }

    It 'picks the newest ci-gate run when there are several (re-run)' {
        $global:T78FakeRuns = @(New-Filler -Count 35) +
            @(New-FakeRun -Name 'ci-gate' -Conclusion 'failure' -MinutesAgo 30) +
            @(New-FakeRun -Name 'ci-gate' -Conclusion 'success' -MinutesAgo 5)

        { & $script:ScriptPath -Sha $script:Sha -Push:$false -WaitTimeoutMinutes 0 } | Should -Not -Throw
    }

    It 'fails closed when ci-gate concluded failure, without dispatching' {
        $global:T78FakeRuns = @(New-Filler -Count 40) + @(New-FakeRun -Name 'ci-gate' -Conclusion 'failure')

        { & $script:ScriptPath -Sha $script:Sha -Push:$false -WaitTimeoutMinutes 0 } |
            Should -Throw -ExpectedMessage "*concluded 'failure'*"
        @($global:T78GhCalls | Where-Object { $_ -like 'workflow run*' }).Count | Should -Be 0
    }

    It 'times out when no ci-gate check-run exists, without dispatching' {
        $global:T78FakeRuns = @(New-Filler -Count 40)

        { & $script:ScriptPath -Sha $script:Sha -Push:$false -WaitTimeoutMinutes 0 } |
            Should -Throw -ExpectedMessage '*did not complete within 0 min*'
        @($global:T78GhCalls | Where-Object { $_ -like 'workflow run*' }).Count | Should -Be 0
    }

    It 'times out while ci-gate is still in progress, without dispatching' {
        $global:T78FakeRuns = @(New-Filler -Count 40) + @(New-FakeRun -Name 'ci-gate' -Status 'in_progress')

        { & $script:ScriptPath -Sha $script:Sha -Push:$false -WaitTimeoutMinutes 0 } |
            Should -Throw -ExpectedMessage '*did not complete within 0 min*'
        @($global:T78GhCalls | Where-Object { $_ -like 'workflow run*' }).Count | Should -Be 0
    }
}
