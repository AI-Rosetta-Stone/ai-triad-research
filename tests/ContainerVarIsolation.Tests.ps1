#Requires -Modules Pester
<#
.SYNOPSIS
    Both-arms gate for Test-ContainerVarIsolation.ps1 (t/4794#9 item 2, hardened t/4953).

    Fixture arms (synthetic server-src + Bicep) cover each scanner read form and each staging
    isolation rule. The REAL repo is checked in its own Describe block: current main must pass,
    and copies of the real main.bicep with the AZURE_ANALYTICS_CONTAINER staging override dropped
    or set equal to prod's must fail (the failing arms proven against real code, t/100#4).
#>

BeforeAll {
    $script:repoRoot    = Split-Path $PSScriptRoot -Parent
    $script:checkScript = Join-Path $script:repoRoot 'operations/devops/Test-ContainerVarIsolation.ps1'

    # Runs the check in a child pwsh; returns its exit code and combined stdout+stderr text.
    function Invoke-IsolationCheck {
        param([string[]]$CheckArgs = @())
        $out = & pwsh -NoProfile -NonInteractive -File $script:checkScript @CheckArgs 2>&1
        [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out | Out-String) }
    }
}

Describe 'Test-ContainerVarIsolation (fixtures)' {
    BeforeAll {
        $fixtureDir = Join-Path $PSScriptRoot 'fixtures/container-var-isolation'
        $serverRoot = Join-Path $fixtureDir 'server-src'
        function Invoke-Fixture([string]$Bicep) {
            Invoke-IsolationCheck -CheckArgs @('-ServerRoot', $serverRoot, '-BicepPath', (Join-Path $fixtureDir $Bicep))
        }
        $green = Invoke-Fixture 'isolated.bicep'
        $scanLine = ($green.Output -split "`r?`n" | Where-Object { $_ -match 'server code reads' }) -join ''
    }

    Context 'staging isolation rules' {
        It 'GREEN: exits 0 when every *_CONTAINER var has a set, different, staging- prefixed staging value' {
            $green.ExitCode | Should -Be 0 -Because $green.Output
            $green.Output | Should -Match 'PASSED'
        }

        It 'RED: override missing, so staging inherits prod''s value (the real AZURE_ANALYTICS_CONTAINER shape)' {
            $r = Invoke-Fixture 'missing-override.bicep'
            $r.ExitCode | Should -Be 1
            $r.Output | Should -Match "::error::.*'AZURE_FOO_CONTAINER' resolves to the SAME value \('foo'\)"
            $r.Output | Should -Match 'Goal: .*\r?\nProblem: 1 of '
        }

        It 'RED: override present but equal to prod''s value' {
            $r = Invoke-Fixture 'equal-override.bicep'
            $r.ExitCode | Should -Be 1
            $r.Output | Should -Match "::error::.*'AZURE_FOO_CONTAINER' resolves to the SAME value \('foo'\)"
        }

        It 'RED: override differs from prod but lacks the staging- prefix' {
            $r = Invoke-Fixture 'unprefixed-override.bicep'
            $r.ExitCode | Should -Be 1
            $r.Output | Should -Match "::error::.*'AZURE_FOO_CONTAINER' staging value 'foo-test'.*lacks the 'staging-' prefix"
        }

        It 'RED: a *_CONTAINER var only main.bicep declares (no code read) is still checked' {
            $r = Invoke-Fixture 'bicep-only-missing-override.bicep'
            $r.ExitCode | Should -Be 1
            $r.Output | Should -Match "::error::.*'AZURE_BICEPONLY_CONTAINER' resolves to the SAME value \('biceponly'\)"
            $r.Output | Should -Not -Match "::error::.*'AZURE_FOO_CONTAINER'"
        }

        It 'RED: population floor -- 0 vars discovered exits 1 with an actionable error' {
            $empty = Join-Path $TestDrive 'empty-server'
            New-Item -ItemType Directory -Path $empty | Out-Null
            Set-Content -Path (Join-Path $empty 'x.ts') -Value 'export const a = process.env.NODE_ENV;'
            $r = Invoke-IsolationCheck -CheckArgs @('-ServerRoot', $empty, '-BicepPath', (Join-Path $fixtureDir 'isolated.bicep'))
            $r.ExitCode | Should -Be 1
            $r.Output | Should -Match '::error::.*discovered 0'
            $r.Output | Should -Match 'Goal: .*\r?\nProblem: the scanner discovered 0'
        }
    }

    Context 'scanner read forms (t/4953)' {
        It 'discovers the dot form: env.X_CONTAINER' {
            $scanLine | Should -Match '\bAZURE_FOO_CONTAINER\b'
        }
        It 'discovers quoted bracket forms: process.env[''X''] and process.env["X"]' {
            $scanLine | Should -Match '\bAZURE_BRACKET_SQ_CONTAINER\b'
            $scanLine | Should -Match '\bAZURE_BRACKET_DQ_CONTAINER\b'
        }
        It 'discovers destructuring, single-name and multi-name/multi-line with rename + default' {
            $scanLine | Should -Match '\bAZURE_DESTRUCT_CONTAINER\b'
            $scanLine | Should -Match '\bAZURE_MULTI_A_CONTAINER\b'
            $scanLine | Should -Match '\bAZURE_MULTI_B_CONTAINER\b'
        }
        It 'does NOT discover non-container vars read in the same forms' {
            $scanLine | Should -Not -Match 'AZURE_BRACKET_TIMEOUT'
            $scanLine | Should -Not -Match 'AZURE_DESTRUCT_REGION'
            $scanLine | Should -Match 'reads 6 \*_CONTAINER var'
        }
        It 'reports process.env[<identifier>] as an indirect WARN finding, not a discovered name' {
            $green.Output | Should -Match '::warning::.*WARN indirect env read at indirectContainer\.ts:6 reads env\[NAME\].*needs an allowlist reason'
            $scanLine | Should -Not -Match 'AZURE_INDIRECT_CONTAINER'
        }
        It 'emits no indirect WARN for files with only direct reads' {
            $green.Output | Should -Not -Match 'WARN indirect env read at (fooContainer|bracketContainer|destructureContainer)\.ts'
        }
    }
}

Describe 'Test-ContainerVarIsolation against the REAL repo' {
    BeforeAll {
        $realBicep  = Join-Path $script:repoRoot 'deploy/azure/main.bicep'
        $realServer = Join-Path $script:repoRoot 'taxonomy-editor/src/server'
        $overrideLine = "{ name: 'AZURE_ANALYTICS_CONTAINER', value: azureAnalyticsContainerStaging }"
        $realText = Get-Content $realBicep -Raw
    }

    # t/4794#9 prerequisites (#4431 and the AZURE_ANALYTICS_CONTAINER wiring) have landed, so the
    # real repo must pass. This is now an assertion, not an informational readout (t/4953).
    It 'GREEN: current main.bicep + server code exits 0' {
        $r = Invoke-IsolationCheck
        $r.ExitCode | Should -Be 0 -Because $r.Output
        $r.Output | Should -Match 'AZURE_ANALYTICS_CONTAINER'
    }

    It 'RED (real code): dropping the AZURE_ANALYTICS_CONTAINER staging override fails -- staging would inherit prod''s ''analytics''' {
        $realText.Contains($overrideLine) | Should -BeTrue -Because 'the mutation below must actually remove something'
        $mutated = Join-Path $TestDrive 'main.dropped.bicep'
        Set-Content -Path $mutated -Value $realText.Replace($overrideLine, '') -NoNewline
        $r = Invoke-IsolationCheck -CheckArgs @('-ServerRoot', $realServer, '-BicepPath', $mutated)
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match "::error::.*'AZURE_ANALYTICS_CONTAINER' resolves to the SAME value \('analytics'\)"
    }

    It 'RED (real code): an AZURE_ANALYTICS_CONTAINER staging override equal to prod''s fails' {
        $mutated = Join-Path $TestDrive 'main.equal.bicep'
        Set-Content -Path $mutated -NoNewline -Value $realText.Replace($overrideLine, "{ name: 'AZURE_ANALYTICS_CONTAINER', value: 'analytics' }")
        $r = Invoke-IsolationCheck -CheckArgs @('-ServerRoot', $realServer, '-BicepPath', $mutated)
        $r.ExitCode | Should -Be 1
        $r.Output | Should -Match "::error::.*'AZURE_ANALYTICS_CONTAINER' resolves to the SAME value \('analytics'\)"
    }
}
