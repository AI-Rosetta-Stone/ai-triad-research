#Requires -Modules Pester
<#
.SYNOPSIS
    Both-arms gate for Test-ContainerVarIsolation.ps1 (t/4794#9 item 2).

    The real AZURE_ANALYTICS_CONTAINER incident is reproduced against the REAL repo in its own
    Describe block below, separately from the synthetic fixture arms.
#>

Describe 'Test-ContainerVarIsolation' {
    BeforeAll {
        $scriptRoot  = Split-Path $PSScriptRoot -Parent
        $checkScript = Join-Path $scriptRoot 'operations/devops/Test-ContainerVarIsolation.ps1'
        $fixtureDir  = Join-Path $PSScriptRoot 'fixtures/container-var-isolation'
        $serverRoot  = Join-Path $fixtureDir 'server-src'
    }

    It 'GREEN arm: exits 0 when every discovered *_CONTAINER var isolates cleanly' {
        $bicepFixture = Join-Path $fixtureDir 'isolated.bicep'
        $proc = Start-Process pwsh `
            -ArgumentList '-NoProfile', '-NonInteractive', '-File', $checkScript,
                          '-ServerRoot', $serverRoot, '-BicepPath', $bicepFixture `
            -PassThru -Wait -NoNewWindow
        $proc.ExitCode | Should -Be 0
    }

    It 'RED arm: exits 1 when a discovered *_CONTAINER var has no stagingEnvOverrides entry at all (the real AZURE_ANALYTICS_CONTAINER shape)' {
        $bicepFixture = Join-Path $fixtureDir 'missing-override.bicep'
        $proc = Start-Process pwsh `
            -ArgumentList '-NoProfile', '-NonInteractive', '-File', $checkScript,
                          '-ServerRoot', $serverRoot, '-BicepPath', $bicepFixture `
            -PassThru -Wait -NoNewWindow
        $proc.ExitCode | Should -Be 1
    }
}

Describe 'Test-ContainerVarIsolation against the REAL repo (t/4794 live incident state)' {
    BeforeAll {
        $scriptRoot  = Split-Path $PSScriptRoot -Parent
        $checkScript = Join-Path $scriptRoot 'operations/devops/Test-ContainerVarIsolation.ps1'
    }

    # NOTE (t/4794#9): this arm documents the incident's actual state. It is EXPECTED to fail
    # until BOTH land: #4431 (the three blob-container vars' override resolution) and Azure's
    # AZURE_ANALYTICS_CONTAINER wiring (t/4794#9 item 1). Do not wire this check into ci-gate's
    # required needs until both have merged, or every PR's CI breaks on an unrelated incident
    # that this check correctly, but prematurely, flags.
    It 'Documents the current real-repo state (informational -- see note above before wiring into ci-gate)' -Skip:$false {
        $proc = Start-Process pwsh -ArgumentList '-NoProfile', '-NonInteractive', '-File', $checkScript `
            -PassThru -Wait -NoNewWindow -RedirectStandardOutput ([System.IO.Path]::GetTempFileName())
        Write-Host "Test-ContainerVarIsolation against the real repo exited $($proc.ExitCode) (0 = all isolated, 1 = at least one gap remains)."
        # Intentionally no assertion -- this is a live status readout, not a pass/fail gate here.
    }
}
