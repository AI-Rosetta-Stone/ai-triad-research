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

Describe 'Test-WhatIf fails closed on security changes (SO red arms, t/612 p/299#6)' {
    BeforeAll {
        function script:Get-OneLeafStatus([string]$Path, [string]$Change, $Before, $After, [string]$ResourceChange = 'Modify') {
            $leaf = @{ path = $Path; propertyChangeType = $Change }
            if ($null -ne $Before) { $leaf.before = $Before }
            if ($null -ne $After) { $leaf.after = $After }
            $p = New-WhatIfFile @(@{ resourceId = $script:App; changeType = $ResourceChange; delta = @($leaf) })
            (Test-WhatIf -WhatIfJsonPath $p).Status
        }
    }
    It 'FAIL: Key Vault networkAcls defaultAction Deny to Allow' {
        Get-OneLeafStatus 'properties.networkAcls.defaultAction' 'Modify' 'Deny' 'Allow' | Should -Be 'FAIL'
    }
    It 'FAIL: Key Vault networkAcls removed by a template that no longer sets it' {
        Get-OneLeafStatus 'properties.networkAcls.defaultAction' 'Delete' 'Deny' $null | Should -Be 'FAIL'
    }
    It 'FAIL: a new container-app secret' {
        Get-OneLeafStatus 'properties.configuration.secrets.3' 'Create' $null @{ name = 'new-secret' } | Should -Be 'FAIL'
    }
    It 'FAIL: a secret re-pointed to another Key Vault secret' {
        Get-OneLeafStatus 'properties.configuration.secrets.1.keyVaultUrl' 'Modify' 'https://kv/secrets/a' 'https://kv/secrets/b' | Should -Be 'FAIL'
    }
    It 'FAIL: a changed auth audience' {
        Get-OneLeafStatus 'properties.identityProviders.azureActiveDirectory.validation.allowedAudiences.0' 'Modify' 'api://a' 'api://b' | Should -Be 'FAIL'
    }
    It 'FAIL: an added external redirect URL' {
        Get-OneLeafStatus 'properties.login.allowedExternalRedirectUrls.2' 'Create' $null 'https://evil.example' | Should -Be 'FAIL'
    }
    It 'FAIL: an env var re-pointed to another secretRef (the t/269 case)' {
        Get-OneLeafStatus 'properties.template.containers.0.env.5.secretRef' 'Modify' 'free-tier-gemini-key' 'gemini-paid-key' | Should -Be 'FAIL'
    }
    It 'FAIL: a whole env entry with a secretRef replaced' {
        Get-OneLeafStatus 'properties.template.containers.0.env.5' 'Modify' @{ name = 'AI_API_KEY'; secretRef = 'a' } @{ name = 'AI_API_KEY'; secretRef = 'b' } | Should -Be 'FAIL'
    }
    It 'FAIL: a stamped-looking env entry that carries a secretRef' {
        Get-OneLeafStatus 'properties.template.containers.0.env.30' 'Delete' @{ name = 'DEPLOY_SHA'; secretRef = 'x' } $null | Should -Be 'FAIL'
    }
    It 'FAIL: allowPermanentDelete turned on' {
        Get-OneLeafStatus 'properties.deleteRetentionPolicy.allowPermanentDelete' 'Modify' $false $true | Should -Be 'FAIL'
    }
    It 'FAIL: allowPermanentDelete removed while it was on' {
        Get-OneLeafStatus 'properties.deleteRetentionPolicy.allowPermanentDelete' 'Delete' $true $null | Should -Be 'FAIL'
    }
    It 'FAIL: a role assignment principalId change' {
        Get-OneLeafStatus 'properties.principalId' 'Modify' '1111' '2222' | Should -Be 'FAIL'
    }
    It 'FAIL: diagnostic logs removed' {
        Get-OneLeafStatus 'properties.logs.0.enabled' 'Modify' $true $false | Should -Be 'FAIL'
    }
    It 'FAIL: a resource changeType Unsupported is never dropped' {
        $p = New-WhatIfFile @(@{ resourceId = $script:App; changeType = 'Unsupported' })
        (Test-WhatIf -WhatIfJsonPath $p).Status | Should -Be 'FAIL'
    }
    It 'FAIL: an unknown future resource changeType' {
        $p = New-WhatIfFile @(@{ resourceId = $script:App; changeType = 'SomethingNew' })
        (Test-WhatIf -WhatIfJsonPath $p).Status | Should -Be 'FAIL'
    }
    It 'FAIL: an image leaf removed rather than changed' {
        Get-OneLeafStatus 'properties.template.containers.0.image' 'Delete' 'img@sha256:aaa' $null | Should -Be 'FAIL'
    }
    It 'PASS: a secret value the local what-if cannot know' {
        Get-OneLeafStatus 'properties.configuration.secrets.1.value' 'Modify' '*' '*' | Should -Be 'PASS'
    }
    It 'PASS: allowPermanentDelete reported as an unset default (Delete of false)' {
        Get-OneLeafStatus 'properties.deleteRetentionPolicy.allowPermanentDelete' 'Delete' $false $null | Should -Be 'PASS'
    }
    It 'PASS: an unevaluated reference() replacing a non-secret value' {
        Get-OneLeafStatus 'properties.template.containers.0.env.6.value' 'Modify' 'https://kv/' "[reference('x').vaultUri]" | Should -Be 'PASS'
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
