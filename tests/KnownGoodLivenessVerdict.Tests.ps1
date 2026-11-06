# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# Both-arms proof for the t/4170 ask-3 known-good-liveness predicate: a missing or
# stale known-good tag must surface; a fresh known-good tag must stay silent.

BeforeAll {
    . (Join-Path $PSScriptRoot '..' 'operations' 'devops' 'Get-KnownGoodLivenessVerdict.ps1')
}

Describe 'Get-KnownGoodLivenessVerdict' -Tag 'config' {
    It 'surfaces missing when no image carries the known-good tag' {
        $images = @(
            [pscustomobject]@{ Tags = @('sha-abc123'); CreatedAt = '2026-10-10T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-def456'); CreatedAt = '2026-10-15T00:00:00Z' }
        )
        $v = Get-KnownGoodLivenessVerdict -Images $images
        $v.Status | Should -Be 'missing'
        $v.Pass | Should -BeFalse
        $v.DeploysBehind | Should -BeNullOrEmpty
    }

    It 'surfaces missing when the image list is empty' {
        $v = Get-KnownGoodLivenessVerdict -Images @()
        $v.Status | Should -Be 'missing'
        $v.Pass | Should -BeFalse
    }

    It 'passes when known-good is the newest deploy (0 deploys behind)' {
        $images = @(
            [pscustomobject]@{ Tags = @('sha-abc123', 'known-good'); CreatedAt = '2026-10-15T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-old999'); CreatedAt = '2026-10-10T00:00:00Z' }
        )
        $v = Get-KnownGoodLivenessVerdict -Images $images
        $v.Status | Should -Be 'ok'
        $v.Pass | Should -BeTrue
        $v.DeploysBehind | Should -Be 0
    }

    It 'passes when known-good is within the MaxDeploysBehind window' {
        $images = @(
            [pscustomobject]@{ Tags = @('sha-5'); CreatedAt = '2026-10-15T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-4'); CreatedAt = '2026-10-14T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-3', 'known-good'); CreatedAt = '2026-10-13T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-2'); CreatedAt = '2026-10-12T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-1'); CreatedAt = '2026-10-11T00:00:00Z' }
        )
        $v = Get-KnownGoodLivenessVerdict -Images $images -MaxDeploysBehind 5
        $v.Status | Should -Be 'ok'
        $v.Pass | Should -BeTrue
        $v.DeploysBehind | Should -Be 2
    }

    It 'surfaces stale when known-good lags past MaxDeploysBehind newer deploys' {
        $images = @(
            [pscustomobject]@{ Tags = @('sha-7'); CreatedAt = '2026-10-17T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-6'); CreatedAt = '2026-10-16T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-5'); CreatedAt = '2026-10-15T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-4'); CreatedAt = '2026-10-14T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-3'); CreatedAt = '2026-10-13T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-2'); CreatedAt = '2026-10-12T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-1', 'known-good'); CreatedAt = '2026-10-11T00:00:00Z' }
        )
        $v = Get-KnownGoodLivenessVerdict -Images $images -MaxDeploysBehind 5
        $v.Status | Should -Be 'stale'
        $v.Pass | Should -BeFalse
        $v.DeploysBehind | Should -Be 6
    }

    It 'stays exactly at the MaxDeploysBehind boundary without flagging (inclusive bound)' {
        $images = @(
            [pscustomobject]@{ Tags = @('sha-5'); CreatedAt = '2026-10-15T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-4'); CreatedAt = '2026-10-14T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-3'); CreatedAt = '2026-10-13T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-2'); CreatedAt = '2026-10-12T00:00:00Z' }
            [pscustomobject]@{ Tags = @('sha-1'); CreatedAt = '2026-10-11T00:00:00Z' }
            [pscustomobject]@{ Tags = @('known-good'); CreatedAt = '2026-10-10T00:00:00Z' }
        )
        $v = Get-KnownGoodLivenessVerdict -Images $images -MaxDeploysBehind 5
        $v.Pass | Should -BeTrue
        $v.DeploysBehind | Should -Be 5
    }

    It 'ignores non-deploy (no sha- tag) versions when counting deploys-behind' {
        # Untagged/cosign-attestation versions newer than known-good must NOT count as deploys.
        $images = @(
            [pscustomobject]@{ Tags = @('sha256-digestattestation'); CreatedAt = '2026-10-16T00:00:00Z' }
            [pscustomobject]@{ Tags = @(); CreatedAt = '2026-10-15T00:00:00Z' }
            [pscustomobject]@{ Tags = @('known-good', 'sha-1'); CreatedAt = '2026-10-10T00:00:00Z' }
        )
        $v = Get-KnownGoodLivenessVerdict -Images $images -MaxDeploysBehind 0
        $v.Pass | Should -BeTrue
        $v.DeploysBehind | Should -Be 0
    }

    Context 't/4924: -ProdDeployTimes counts prod deploys, not image pushes' {
        BeforeAll {
            # known-good = prod's image, built 14:48; then 7 sha-* rebuild pushes (the #4640 shape).
            $script:KgImages = @(
                [pscustomobject]@{ Tags = @('sha-39cc128', 'known-good'); CreatedAt = '2026-11-06T14:48:00Z' }
                1..7 | ForEach-Object { [pscustomobject]@{ Tags = @("sha-rebuild$_"); CreatedAt = "2026-11-06T17:$('{0:D2}' -f ($_ * 5)):00Z" } }
            )
        }

        It 'does NOT fire on image pushes alone (#4640: 7 rebuilds, one prod deploy that set the tag)' {
            $v = Get-KnownGoodLivenessVerdict -Images $script:KgImages -ProdDeployTimes @([datetime]'2026-11-06T15:21:00Z')
            $v.Basis | Should -Be 'prod deploy'
            $v.DeploysBehind | Should -Be 1
            $v.Pass | Should -BeTrue
        }

        It 'still fires when more than MaxDeploysBehind prod deploys happened since the known-good image' {
            $times = @(1..6 | ForEach-Object { [datetime]"2026-11-0$($_ + 1)T12:00:00Z" })
            $images = @([pscustomobject]@{ Tags = @('sha-old', 'known-good'); CreatedAt = '2026-11-01T00:00:00Z' })
            $v = Get-KnownGoodLivenessVerdict -Images $images -ProdDeployTimes $times
            $v.DeploysBehind | Should -Be 6
            $v.Status | Should -Be 'stale'
            $v.Pass | Should -BeFalse
        }

        It 'ignores prod deploys from before the known-good image was built' {
            $v = Get-KnownGoodLivenessVerdict -Images $script:KgImages -ProdDeployTimes @([datetime]'2026-11-05T16:05:00Z', [datetime]'2026-11-05T13:24:00Z')
            $v.DeploysBehind | Should -Be 0
            $v.Pass | Should -BeTrue
        }

        It 'without -ProdDeployTimes keeps the image-push basis (and would have fired on #4640)' {
            $v = Get-KnownGoodLivenessVerdict -Images $script:KgImages
            $v.Basis | Should -Be 'image push'
            $v.DeploysBehind | Should -Be 7
            $v.Pass | Should -BeFalse
        }
    }
}
