# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Tests for deploy/azure/Test-DeployRoute.ps1 (t/612).
.DESCRIPTION
    gh output is shimmed (Invoke-RouteGh is mocked) and what-if output is synthetic JSON in TestDrive.
    Each check must PASS on a good route and fail closed on a bad one: branch policy refused,
    a what-if change beyond the image, no trusted green CI, and any API error read as UNKNOWN.
#>

BeforeAll {
    . "$PSScriptRoot/../deploy/azure/Test-DeployRoute.ps1"

    function script:New-WhatIfFile([object[]]$Changes) {
        $p = Join-Path $TestDrive ("wi-{0}.json" -f [guid]::NewGuid())
        @{ status = 'Succeeded'; changes = $Changes } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $p
        return $p
    }
    $script:App = '/subscriptions/x/resourceGroups/ai-triad/providers/Microsoft.App/containerApps/taxonomy-editor'
    $script:ImageLeaf = @{ path = 'properties.template.containers'; propertyChangeType = 'Array'; children = @(
            @{ path = '0'; propertyChangeType = 'Modify'; children = @(
                    @{ path = 'image'; propertyChangeType = 'Modify'; before = 'img@sha256:aaa'; after = 'img@sha256:bbb' }) }) }
    $script:NoiseLeaves = @(
        @{ path = 'properties.template.revisionSuffix'; propertyChangeType = 'Delete'; before = 'deploy-x' }
        @{ path = 'properties.configuration.ingress.exposedPort'; propertyChangeType = 'Delete'; before = 0 }
        @{ path = 'properties.template.containers'; propertyChangeType = 'Array'; children = @(
                @{ path = '0'; propertyChangeType = 'Modify'; children = @(
                        @{ path = 'env'; propertyChangeType = 'Array'; children = @(
                                @{ path = '30'; propertyChangeType = 'Delete'; before = @{ name = 'DEPLOY_SHA'; value = 'abc' } }
                                @{ path = '6'; propertyChangeType = 'Modify'; before = 'https://kv/'; after = "[reference('x').vaultUri]" }) }) }) }
    )
}

Describe 'Test-BranchPolicy (check 1)' {
    It 'PASS when the ref matches an allowed pattern' {
        Mock Invoke-RouteGh -ParameterFilter { $Arguments[1] -like '*/environments/production' } { '{"deployment_branch_policy":{"custom_branch_policies":true,"protected_branches":false}}' }
        Mock Invoke-RouteGh -ParameterFilter { $Arguments[1] -like '*/deployment-branch-policies' } { '{"branch_policies":[{"name":"main","type":"branch"}]}' }
        (Test-BranchPolicy -Environment production -Ref main -Repo o/r).Status | Should -Be 'PASS'
    }
    It 'FAIL when the ref is not allowed (the t/579 route-B case)' {
        Mock Invoke-RouteGh -ParameterFilter { $Arguments[1] -like '*/environments/production' } { '{"deployment_branch_policy":{"custom_branch_policies":true,"protected_branches":false}}' }
        Mock Invoke-RouteGh -ParameterFilter { $Arguments[1] -like '*/deployment-branch-policies' } { '{"branch_policies":[{"name":"main","type":"branch"}]}' }
        $r = Test-BranchPolicy -Environment production -Ref epic/t579-deploy -Repo o/r
        $r.Status | Should -Be 'FAIL'
        $r.Detail | Should -Match 'reject'
    }
    It 'PASS when there is no policy' {
        Mock Invoke-RouteGh { '{"deployment_branch_policy":null}' }
        (Test-BranchPolicy -Environment production -Ref anything -Repo o/r).Status | Should -Be 'PASS'
    }
    It 'single star does not cross a slash; double star does' {
        'epic/x' | Should -Not -Match (ConvertTo-RefPatternRegex 'epic*')
        'epic/x' | Should -Match (ConvertTo-RefPatternRegex 'epic/*')
        'epic/x/y' | Should -Match (ConvertTo-RefPatternRegex 'epic/**')
    }
    It 'UNKNOWN (fail closed) when the API errors' {
        Mock Invoke-RouteGh { throw 'HTTP 403: API rate limit exceeded' }
        (Test-BranchPolicy -Environment production -Ref main -Repo o/r).Status | Should -Be 'UNKNOWN'
    }
}

Describe 'Test-TrustedCi (check 2)' {
    It 'PASS on a completed workflow_dispatch run with test-container success' {
        Mock Invoke-RouteGh -ParameterFilter { $Arguments[1] -like '*ci.yml/runs*' } { '{"workflow_runs":[{"id":1,"event":"workflow_dispatch","head_branch":"epic/h","status":"completed","conclusion":"success"}]}' }
        Mock Invoke-RouteGh -ParameterFilter { $Arguments[1] -like '*/runs/1/jobs*' } { '{"jobs":[{"name":"test-container","conclusion":"success"}]}' }
        (Test-TrustedCi -Sha abc -Repo o/r).Status | Should -Be 'PASS'
    }
    It 'FAIL when only pull_request runs exist (the t/579 displacement case)' {
        Mock Invoke-RouteGh -ParameterFilter { $Arguments[1] -like '*ci.yml/runs*' } { '{"workflow_runs":[{"id":2,"event":"pull_request","head_branch":"hotfix/x","status":"completed","conclusion":"success"}]}' }
        $r = Test-TrustedCi -Sha abc -Repo o/r
        $r.Status | Should -Be 'FAIL'
        $r.Detail | Should -Match 'Pull-request runs never count'
    }
    It 'FAIL on a push from a non-trusted branch' {
        Mock Invoke-RouteGh -ParameterFilter { $Arguments[1] -like '*ci.yml/runs*' } { '{"workflow_runs":[{"id":3,"event":"push","head_branch":"feature/x","status":"completed","conclusion":"success"}]}' }
        (Test-TrustedCi -Sha abc -Repo o/r).Status | Should -Be 'FAIL'
    }
    It 'FAIL when test-container failed' {
        Mock Invoke-RouteGh -ParameterFilter { $Arguments[1] -like '*ci.yml/runs*' } { '{"workflow_runs":[{"id":4,"event":"push","head_branch":"main","status":"completed","conclusion":"failure"}]}' }
        Mock Invoke-RouteGh -ParameterFilter { $Arguments[1] -like '*/runs/4/jobs*' } { '{"jobs":[{"name":"test-container","conclusion":"failure"}]}' }
        (Test-TrustedCi -Sha abc -Repo o/r).Status | Should -Be 'FAIL'
    }
    It 'FAIL when there is no CI run at all (never falls back to an ancestor)' {
        Mock Invoke-RouteGh { '{"workflow_runs":[]}' }
        (Test-TrustedCi -Sha abc -Repo o/r).Status | Should -Be 'FAIL'
    }
    It 'UNKNOWN (fail closed, not "CI failed") on a rate limit' {
        Mock Invoke-RouteGh { throw 'HTTP 403: API rate limit exceeded for installation' }
        $r = Test-TrustedCi -Sha abc -Repo o/r
        $r.Status | Should -Be 'UNKNOWN'
        $r.Detail | Should -Match 'not a CI failure'
    }
}

Describe 'Test-WhatIf (check 3)' {
    It 'PASS when only the image and known noise change' {
        $p = New-WhatIfFile @(@{ resourceId = $script:App; changeType = 'Modify'; delta = @($script:ImageLeaf) + $script:NoiseLeaves })
        $r = Test-WhatIf -WhatIfJsonPath $p
        $r.Status | Should -Be 'PASS'
        @($r.Rows | Where-Object Class -eq 'IMAGE').Count | Should -Be 1
    }
    It 'FAIL on any other property change (for example cpu)' {
        $cpu = @{ path = 'properties.template.containers'; propertyChangeType = 'Array'; children = @(
                @{ path = '0'; propertyChangeType = 'Modify'; children = @(
                        @{ path = 'resources.cpu'; propertyChangeType = 'Modify'; before = 0.5; after = 0.25 }) }) }
        $p = New-WhatIfFile @(@{ resourceId = $script:App; changeType = 'Modify'; delta = @($script:ImageLeaf, $cpu) })
        $r = Test-WhatIf -WhatIfJsonPath $p
        $r.Status | Should -Be 'FAIL'
        @($r.Rows | Where-Object Class -eq 'FLAG').Path | Should -Contain 'properties.template.containers.0.resources.cpu'
    }
    It 'FAIL on a resource Create or Delete' {
        $p = New-WhatIfFile @(@{ resourceId = '/subscriptions/x/providers/Microsoft.Storage/storageAccounts/s'; changeType = 'Delete' })
        (Test-WhatIf -WhatIfJsonPath $p).Status | Should -Be 'FAIL'
    }
    It 'NoEffect and Ignore are never flagged' {
        $p = New-WhatIfFile @(
            @{ resourceId = '/x/providers/Microsoft.Authorization/roleAssignments/r'; changeType = 'Modify'; delta = @(@{ path = 'properties.principalType'; propertyChangeType = 'NoEffect'; before = 'User'; after = 'ServicePrincipal' }) }
            @{ resourceId = '/x/providers/Microsoft.Web/x'; changeType = 'Ignore' })
        (Test-WhatIf -WhatIfJsonPath $p).Status | Should -Be 'PASS'
    }
    It 'UNKNOWN when no what-if is supplied or it is unreadable' {
        (Test-WhatIf).Status | Should -Be 'UNKNOWN'
        $bad = Join-Path $TestDrive 'bad.json'; Set-Content -LiteralPath $bad 'not json'
        (Test-WhatIf -WhatIfJsonPath $bad).Status | Should -Be 'UNKNOWN'
    }
}

Describe 'Format-RouteReport' {
    It 'says NOT SAFE TO PROPOSE unless every check passes' {
        $res = @(
            [pscustomobject]@{ Check = 'branch-policy'; Status = 'PASS'; Detail = 'ok' }
            [pscustomobject]@{ Check = 'ci'; Status = 'UNKNOWN'; Detail = 'rate limit' }
            [pscustomobject]@{ Check = 'what-if'; Status = 'PASS'; Detail = 'ok'; Rows = @() })
        Format-RouteReport -Results $res -Environment production -Ref main -Sha abc | Should -Match 'NOT SAFE TO PROPOSE'
    }
}
