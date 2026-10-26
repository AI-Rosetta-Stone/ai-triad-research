# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4513, SO C1 (e/364#2): base_url (prod) / $BaseUrl (staging) falls back to the APP url -- the
# OLD, still-serving revision -- when the revision-specific FQDN lookup returns nothing. Without a
# guard, the mount-readiness probe would then test the sibling revision's already-warm mount and
# pass on attempt 1, vacuously: the exact t/4504 shape (looks healthy, isn't the revision being
# deployed). These are structural (text) assertions on the real workflow files, same rationale as
# DeployAzureHealthCheckExitWiring.Tests.ps1 -- the behavior is GitHub Actions' own step wiring,
# which Pester cannot execute directly.

BeforeAll {
    $script:AzurePath = Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-azure.yml'
    $script:AzureText = Get-Content -Raw $script:AzurePath
    $script:StagingPath = Join-Path $PSScriptRoot '..' '.github' 'workflows' 'deploy-staging.yml'
    $script:StagingText = Get-Content -Raw $script:StagingPath
}

Describe 'deploy-azure.yml mount probe fails closed without a revision-specific URL (SO C1)' {
    It '"Health check new revision" emits is_revision_url' {
        $stepMatch = [regex]::Match($script:AzureText, '(?s)- name: Health check new revision.*?(?=\r?\n      - name:)')
        $stepMatch.Success | Should -BeTrue
        $stepMatch.Value | Should -Match 'is_revision_url=\$\(-not \[string\]::IsNullOrWhiteSpace\(\$RevFqdn\)\)'
    }

    It '"Mount readiness probe (t/4513)" checks is_revision_url BEFORE the probe loop runs, and sets ready=false without probing when it is not true' {
        $stepMatch = [regex]::Match($script:AzureText, "(?s)- name: Mount readiness probe \(t/4513\).*?(?=\r?\n      - name:)")
        $stepMatch.Success | Should -BeTrue
        $stepText = $stepMatch.Value

        $guardIndex = $stepText.IndexOf("is_revision_url")
        $probeIndex = $stepText.IndexOf('Wait-MountReady -Probe')
        $guardIndex | Should -BeGreaterThan -1 -Because 'the step must check is_revision_url'
        $probeIndex | Should -BeGreaterThan -1 -Because 'the step must still run the probe loop on the happy path'
        $guardIndex | Should -BeLessThan $probeIndex -Because 'the guard must run before any probe attempt, never after'

        $guardBlock = $stepText.Substring($guardIndex, $probeIndex - $guardIndex)
        $guardBlock | Should -Match "ready=false"
        $guardBlock | Should -Match 'exit 0' -Because 'the step is designed to always report step-success (t/4249), same as health_check'
    }

    It 'FIRE ARM: a step missing the guard would fail the ordering assertion' {
        $unguarded = @'
        run: |
          Import-Module ./scripts/AITriad/AITriad.psm1 -Force
          $BaseUrl = '${{ steps.health_check.outputs.base_url }}'
          $Verdict = Wait-MountReady -Probe $Probe -MaxAttempts 13 -IntervalSeconds 10
'@
        $unguarded.IndexOf('is_revision_url') | Should -Be -1
    }
}

Describe 'deploy-staging.yml mount probe fails closed without a revision-specific URL (SO C1)' {
    It 'the smoke step checks $RevFqdn a second time, immediately before the mount probe, and exits 1 without probing when blank' {
        $stepMatch = [regex]::Match($script:StagingText, '(?s)- name: Smoke test new revision \(pre-traffic gate\).*?(?=\r?\n      - name:)')
        $stepMatch.Success | Should -BeTrue
        $stepText = $stepMatch.Value

        $guardMatches = [regex]::Matches($stepText, 'IsNullOrWhiteSpace\(\$RevFqdn\)')
        $guardMatches.Count | Should -Be 2 -Because 'one check for the base_url fallback (warns, continues) and a second, independent check guarding the mount probe (fails closed)'

        $secondGuardIndex = $guardMatches[1].Index
        $probeIndex = $stepText.IndexOf('Wait-MountReady -Probe')
        $probeIndex | Should -BeGreaterThan -1
        $secondGuardIndex | Should -BeLessThan $probeIndex -Because 'the second guard must run before any probe attempt'

        $guardBlock = $stepText.Substring($secondGuardIndex, $probeIndex - $secondGuardIndex)
        $guardBlock | Should -Match 'exit 1' -Because 'staging gates on failure(), unlike prod -- the step must actually fail, not just set an output'
    }
}
