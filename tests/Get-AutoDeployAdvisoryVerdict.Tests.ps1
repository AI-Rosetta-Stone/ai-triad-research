BeforeAll {
    . "$PSScriptRoot/../operations/devops/Get-AutoDeployAdvisoryVerdict.ps1"

    $script:Now = [datetime]'2026-10-20T12:00:00Z'
    $script:InfraPaths = @(
        'deploy/azure/main.bicep'
        'deploy/azure/deploy.ps1'
        '.github/workflows/deploy-azure.yml'
        'operations/devops/Move-PiCredential*.ps1'
    )

    function New-BaseParams {
        @{
            HeadSha                = 'head1234567'
            LastDeployedSha         = 'deployed0001'
            CiGateConclusion        = 'success'
            CodeQlConclusion        = $null
            HoldActive              = $false
            CommitsWithoutMergedPR  = @()
            ChangedPaths            = @('taxonomy-editor/src/renderer/App.tsx')
            InfraPaths              = $script:InfraPaths
            MinIntervalMinutes      = 120
            Now                     = $script:Now
        }
    }
}

Describe 'ConvertFrom-CheckRunsResponse' {
    It 'parses a recorded real check-runs response for a known-green SHA (f55a0ead, #3386)' {
        # TL finding (p/331#2104): ci-gate/CodeQL are check runs, not commit statuses — this
        # fixture is the real `gh api repos/.../commits/f55a0ead/check-runs` response, trimmed to
        # a handful of runs, not hand-written, so it can't silently drift from the real API shape.
        $fixture = Get-Content "$PSScriptRoot/fixtures/check-runs-f55a0ead.json" -Raw | ConvertFrom-Json
        $byName = ConvertFrom-CheckRunsResponse -CheckRunsResponse $fixture

        $byName['ci-gate'].Conclusion | Should -Be 'success'
        $byName.ContainsKey('CodeQL') | Should -Be $false  # legitimately absent (push path-filtered) — not an error
    }

    It 'keeps only the most-recently-started run when a name appears twice' {
        $fixture = [PSCustomObject]@{
            check_runs = @(
                [PSCustomObject]@{ name = 'ci-gate'; status = 'completed'; conclusion = 'failure'; started_at = '2026-10-19T10:00:00Z' }
                [PSCustomObject]@{ name = 'ci-gate'; status = 'completed'; conclusion = 'success'; started_at = '2026-10-19T10:19:41Z' }
            )
        }
        $byName = ConvertFrom-CheckRunsResponse -CheckRunsResponse $fixture
        $byName['ci-gate'].Conclusion | Should -Be 'success'
    }

    It 'reports status (not conclusion) for a still-running check' {
        $fixture = [PSCustomObject]@{
            check_runs = @(
                [PSCustomObject]@{ name = 'ci-gate'; status = 'in_progress'; conclusion = $null; started_at = '2026-10-19T10:19:41Z' }
            )
        }
        $byName = ConvertFrom-CheckRunsResponse -CheckRunsResponse $fixture
        $byName['ci-gate'].Conclusion | Should -Be 'in_progress'
    }
}

Describe 'Get-AutoDeployAdvisoryVerdict' {

    Context 'No new commits' {
        It 'skips when HEAD equals the last deployed SHA' {
            $p = New-BaseParams
            $p.LastDeployedSha = $p.HeadSha
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'Skip'
            $v.SkipReason | Should -Be 'no-new-commits'
        }
    }

    Context 'Hold switch' {
        It 'skips when the hold is active' {
            $p = New-BaseParams
            $p.HoldActive = $true
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'Skip'
            $v.SkipReason | Should -Be 'hold'
        }
        It 'would deploy when the hold is inactive (all else clear)' {
            $p = New-BaseParams
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'WouldDeploy'
        }
    }

    Context 'Commit-without-PR association (TL ruling p/331#2106)' {
        It 'skips when a commit in range has no associated merged PR' {
            $p = New-BaseParams
            $p.CommitsWithoutMergedPR = @('abc1234')
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'Skip'
            $v.SkipReason | Should -Be 'no-pr-association'
            $v.Detail | Should -Match 'abc1234'
        }
        It 'would deploy when every commit in range has a merged PR' {
            $p = New-BaseParams
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'WouldDeploy'
        }
    }

    Context 'ci-gate / CodeQL green check (TL ruling p/331#2106)' {
        It 'skips when ci-gate is not success' {
            $p = New-BaseParams
            $p.CiGateConclusion = 'failure'
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'Skip'
            $v.SkipReason | Should -Be 'red-required-context'
            $v.Detail | Should -Match 'ci-gate'
        }
        It 'would deploy when CodeQL is absent (push-path-filtered, legitimately did not run)' {
            $p = New-BaseParams
            $p.CodeQlConclusion = $null
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'WouldDeploy'
        }
        It 'skips when CodeQL ran and failed' {
            $p = New-BaseParams
            $p.CodeQlConclusion = 'failure'
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'Skip'
            $v.SkipReason | Should -Be 'red-required-context'
            $v.Detail | Should -Match 'CodeQL'
        }
        It 'skips when CodeQL ran and is still pending' {
            $p = New-BaseParams
            $p.CodeQlConclusion = 'pending'
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'Skip'
            $v.SkipReason | Should -Be 'red-required-context'
        }
        It 'would deploy when CodeQL ran and succeeded' {
            $p = New-BaseParams
            $p.CodeQlConclusion = 'success'
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'WouldDeploy'
        }
    }

    Context 'Infra-path skip' {
        It 'skips when the diff touches deploy/azure/main.bicep' {
            $p = New-BaseParams
            $p.ChangedPaths = @('taxonomy-editor/src/renderer/App.tsx', 'deploy/azure/main.bicep')
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'Skip'
            $v.SkipReason | Should -Be 'infra-change'
            $v.Detail | Should -Match 'deploy/azure/main.bicep'
        }
        It 'skips on a glob infra path match' {
            $p = New-BaseParams
            $p.ChangedPaths = @('operations/devops/Move-PiCredentialRotate.ps1')
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'Skip'
            $v.SkipReason | Should -Be 'infra-change'
        }
        It 'would deploy on a renderer-only change (no infra path touched)' {
            $p = New-BaseParams
            $p.ChangedPaths = @('taxonomy-editor/src/renderer/App.tsx', 'docs/LessonsLearned.md')
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'WouldDeploy'
        }
    }

    Context 'Rate cap' {
        It 'skips when the minimum interval has not elapsed' {
            $p = New-BaseParams
            $p.LastAutoDeployAt = $script:Now.AddMinutes(-30)
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'Skip'
            $v.SkipReason | Should -Be 'rate-cap'
            $v.Detail | Should -Match '90 min left'
        }
        It 'would deploy once the minimum interval has elapsed' {
            $p = New-BaseParams
            $p.LastAutoDeployAt = $script:Now.AddMinutes(-121)
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'WouldDeploy'
        }
        It 'would deploy when there is no prior auto-deploy recorded' {
            $p = New-BaseParams
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'WouldDeploy'
        }
    }

    Context 'Precedence (hold beats everything else named first)' {
        It 'reports hold even when a required context is also red' {
            $p = New-BaseParams
            $p.HoldActive = $true
            $p.CiGateConclusion = 'failure'
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.SkipReason | Should -Be 'hold'
        }
        It 'reports no-pr-association even when ci-gate is also red' {
            $p = New-BaseParams
            $p.CommitsWithoutMergedPR = @('abc1234')
            $p.CiGateConclusion = 'failure'
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.SkipReason | Should -Be 'no-pr-association'
        }
    }
}
