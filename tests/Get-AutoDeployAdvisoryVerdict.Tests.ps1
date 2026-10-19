BeforeAll {
    . "$PSScriptRoot/../operations/devops/Get-AutoDeployAdvisoryVerdict.ps1"

    $script:Now = [datetime]'2026-10-20T12:00:00Z'
    $script:GreenContexts = @(
        [PSCustomObject]@{ Context = 'ci-gate'; Conclusion = 'success' }
        [PSCustomObject]@{ Context = 'joint-gv-guard'; Conclusion = 'success' }
        [PSCustomObject]@{ Context = 'CodeQL'; Conclusion = 'success' }
        [PSCustomObject]@{ Context = 'consult-hold-guard'; Conclusion = 'success' }
    )
    $script:InfraPaths = @(
        'deploy/azure/main.bicep'
        'deploy/azure/deploy.ps1'
        '.github/workflows/deploy-azure.yml'
        'operations/devops/Move-PiCredential*.ps1'
    )

    function New-BaseParams {
        @{
            HeadSha                 = 'head1234567'
            LastDeployedSha         = 'deployed0001'
            RequiredContextResults  = $script:GreenContexts
            HoldActive              = $false
            ChangedPaths            = @('taxonomy-editor/src/renderer/App.tsx')
            InfraPaths              = $script:InfraPaths
            MinIntervalMinutes      = 120
            Now                     = $script:Now
        }
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

    Context 'Required contexts (condition 1)' {
        It 'skips when a required context is not success' {
            $p = New-BaseParams
            $p.RequiredContextResults = @(
                [PSCustomObject]@{ Context = 'ci-gate'; Conclusion = 'success' }
                [PSCustomObject]@{ Context = 'CodeQL'; Conclusion = 'failure' }
            )
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'Skip'
            $v.SkipReason | Should -Be 'red-required-context'
            $v.Detail | Should -Match 'CodeQL=failure'
        }
        It 'would deploy when every required context is success' {
            $p = New-BaseParams
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.Verdict | Should -Be 'WouldDeploy'
        }
    }

    Context 'Infra-path skip (condition 3)' {
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

    Context 'Rate cap (condition 5)' {
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
            $p.RequiredContextResults = @(
                [PSCustomObject]@{ Context = 'ci-gate'; Conclusion = 'failure' }
            )
            $v = Get-AutoDeployAdvisoryVerdict @p
            $v.SkipReason | Should -Be 'hold'
        }
    }
}
