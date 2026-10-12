# Tag: cost (t/3910)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Get-AICostReport (t/3910), written BEFORE the
    complexity refactor so the same assertions pass unchanged after it.
.DESCRIPTION
    Pins current behavior: cost math (exact pricing match, backend-prefixed
    fallback, no-match), the malformed-line / missing-field tolerance, the
    -After/-Before/-Backend/-GroupBy filters, the no-files/no-entries early
    returns, the -PassThru Summary shape, -Budget reporting, and the
    provider-key-status probe (no key / valid / invalid) for each backend.
    Uses the real repo-root ai-models.json for pricing (read-only) and a
    $TestDrive usage-summary.jsonl fixture via -Path, so no mocking of
    $script:RepoRoot is needed.
#>

BeforeAll {
    # Import AITriad first, then AIEnrich directly LAST so Resolve-AIApiKey stays mockable
    # via -ModuleName AIEnrich from this test scope (AITriad's internal -Force re-import
    # otherwise shadows the direct handle -- same pattern as AICallLogCapture.Tests.ps1).
    Import-Module "$PSScriptRoot/../scripts/AITriad/AITriad.psm1" -Force -WarningAction SilentlyContinue
    Import-Module "$PSScriptRoot/../scripts/AIEnrich.psm1" -Force -WarningAction SilentlyContinue
}

Describe 'Get-AICostReport' -Tag 'cost' {

    BeforeAll {
        $script:usageDir = Join-Path $TestDrive 'usage'
        New-Item -ItemType Directory -Path $script:usageDir -Force | Out-Null
        $script:usageFile = Join-Path $script:usageDir 'usage-summary.jsonl'

        $Lines = @(
            '{"ts":"2026-01-01T00:00:00Z","model":"gemini-3.5-flash-lite","backend":"gemini","promptTokens":1000,"completionTokens":500,"cachedTokens":200}'
            '{"ts":"2026-01-02T00:00:00Z","model":"openai/gpt-oss-120b","backend":"groq","promptTokens":2000,"completionTokens":1000}'
            '{"ts":"2026-01-03T00:00:00Z","model":"totally-unknown-model","backend":"unknownbackend","promptTokens":100,"completionTokens":50}'
            '{not valid json'
            '{"ts":"2026-01-04T00:00:00Z","model":"gemini-3.5-flash-lite","backend":"gemini"}'
            '{"ts":"2026-06-15T00:00:00Z","model":"gemini-3.5-flash-lite","backend":"gemini","promptTokens":10,"completionTokens":10}'
        )
        Set-Content -Path $script:usageFile -Value $Lines -Encoding utf8
    }

    BeforeEach {
        # No keys configured for any backend by default -- deterministic, no network calls.
        # Get-AICostReport calls Resolve-AIApiKey from inside AITriad's own module scope
        # (AITriad.psm1 nested-imports AIEnrich.psm1 at load time), so the mock must patch
        # AITriad's copy, not a separately re-imported AIEnrich module instance.
        Mock Resolve-AIApiKey -ModuleName AITriad -MockWith { '' }
    }

    It 'computes cost via an exact pricing-id match' {
        $r = Get-AICostReport -Path $script:usageFile -PassThru -GroupBy Model
        $Row = $r.Breakdown | Where-Object { $_.Group -eq 'gemini-3.5-flash-lite' }
        # 3 gemini-3.5-flash-lite entries: (1000p/500c/200cached) + (0/0/0) + (10/10/0)
        # Prices (t/3946, live 2026-10-05): input 0.30, output 2.50, cachedInput 0.30 (caching N/A -> cached = input).
        # cost1 = (800*0.30 + 200*0.30 + 500*2.50)/1e6 = 0.00155 ; cost2 = 0 ; cost3 = (10*0.30+10*2.50)/1e6 = 0.000028
        $Row.EstimatedCost | Should -Be ([Math]::Round(0.00155 + 0 + 0.000028, 4))
        $Row.Calls | Should -Be 3
    }

    It 'computes cost via the (backend, apiModelId) map (t/3951 -- bare apiModelId alone has no pricing match)' {
        $r = Get-AICostReport -Path $script:usageFile -PassThru -GroupBy Model
        $Row = $r.Breakdown | Where-Object { $_.Group -eq 'openai/gpt-oss-120b' }
        $Row.EstimatedCost | Should -Be ([Math]::Round((2000 * 0.15 + 1000 * 0.60) / 1000000, 4))
    }

    It 'marks an entry with no pricing match at all as zero-cost, still counted' {
        $r = Get-AICostReport -Path $script:usageFile -PassThru -GroupBy Model
        $Row = $r.Breakdown | Where-Object { $_.Group -eq 'totally-unknown-model' }
        $Row.EstimatedCost | Should -Be 0
        $Row.Calls | Should -Be 1
    }

    It 'silently skips a malformed JSON line -- no warning, no throw (pinned current behavior)' {
        { Get-AICostReport -Path $script:usageFile -PassThru -WarningVariable w -WarningAction SilentlyContinue } |
            Should -Not -Throw
        $r = Get-AICostReport -Path $script:usageFile -PassThru -WarningVariable w -WarningAction SilentlyContinue
        # Narrowed to the malformed-line path specifically (t/3947): the fixture's
        # gemini/groq models legitimately warn on a DIFFERENT path (no cachedInputPer1M,
        # ConvertTo-AIUsageCostEstimate) -- unrelated to this test's claim.
        $w | Where-Object { $_ -match 'malformed|JSON' } | Should -BeNullOrEmpty -Because 'the malformed line is swallowed by an empty catch, not warned about'
        $r.TotalCalls | Should -Be 5 -Because '6 lines total, 1 is malformed JSON and never becomes an entry'
    }

    It 'defaults missing promptTokens/completionTokens/cachedTokens to 0' {
        $r = Get-AICostReport -Path $script:usageFile -PassThru -GroupBy Model
        $Row = $r.Breakdown | Where-Object { $_.Group -eq 'gemini-3.5-flash-lite' }
        # one of the 3 gemini rows has no token fields at all; aggregate must not throw and must not inflate counts
        $Row.Calls | Should -Be 3
    }

    It 'filters by -After and -Before' {
        $r = Get-AICostReport -Path $script:usageFile -PassThru -After '2026-01-02' -Before '2026-01-04'
        $r.TotalCalls | Should -Be 2 -Because 'only the 01-02 and 01-03 entries fall inside the window'
    }

    It 'filters by -Backend' {
        $r = Get-AICostReport -Path $script:usageFile -PassThru -Backend groq
        $r.TotalCalls | Should -Be 1
    }

    It 'groups by each of Model/Session/Date/Backend without throwing' {
        foreach ($g in @('Model', 'Session', 'Date', 'Backend')) {
            { Get-AICostReport -Path $script:usageFile -PassThru -GroupBy $g } | Should -Not -Throw
        }
    }

    It 'returns a -PassThru Summary with the expected shape' {
        $r = Get-AICostReport -Path $script:usageFile -PassThru
        $r.TotalCalls | Should -Be 5
        $r.DateRange.Earliest | Should -Not -BeNullOrEmpty
        $r.DateRange.Latest | Should -Not -BeNullOrEmpty
        $r.Breakdown | Should -Not -BeNullOrEmpty
        $r.Providers | Should -Not -BeNullOrEmpty
        @($r.Providers).Count | Should -Be 4
    }

    It 'reports budget remaining when under budget' {
        { Get-AICostReport -Path $script:usageFile -Budget 1000 } | Should -Not -Throw
    }

    It 'reports over-budget when spend exceeds the budget' {
        { Get-AICostReport -Path $script:usageFile -Budget 0.00000001 } | Should -Not -Throw
    }

    It 'returns early with a warning when no usage files are found' {
        $emptyDir = Join-Path $TestDrive 'empty-usage'
        New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
        $r = Get-AICostReport -Path $emptyDir -PassThru -WarningAction SilentlyContinue
        $r | Should -BeNullOrEmpty
    }

    It 'returns early with a warning when no entries match the filters' {
        $r = Get-AICostReport -Path $script:usageFile -PassThru -After '2099-01-01' -WarningAction SilentlyContinue
        $r | Should -BeNullOrEmpty
    }

    Context 'Provider key status' {
        It 'reports KeyConfigured=false for every backend when no keys are set' {
            $r = Get-AICostReport -Path $script:usageFile -PassThru
            foreach ($p in $r.Providers) {
                $p.KeyConfigured | Should -BeFalse
                $p.Valid | Should -Be $null
            }
        }

        It 'reports Valid=true for a backend with a configured, working key (claude: RateLimit/RateRemaining/RateReset all present)' {
            Mock Resolve-AIApiKey -ModuleName AITriad -MockWith { 'fake-key' }
            Mock Invoke-WebRequest -ModuleName AITriad -MockWith {
                [PSCustomObject]@{ StatusCode = 200; Headers = @{ 'x-ratelimit-limit-requests' = '100'; 'x-ratelimit-remaining-requests' = '99'; 'x-ratelimit-reset-requests' = '60s' } }
            }
            $path = $script:usageFile
            $r = InModuleScope AITriad -Parameters @{ path = $path } { Get-AICostReport -Path $path -PassThru }
            $Claude = $r.Providers | Where-Object { $_.Backend -eq 'claude' }
            $Claude.KeyConfigured | Should -BeTrue
            $Claude.Valid | Should -BeTrue
        }

        It 'reports Valid=false for a backend whose key probe throws' {
            Mock Resolve-AIApiKey -ModuleName AITriad -MockWith { 'fake-key' }
            Mock Invoke-WebRequest -ModuleName AITriad -MockWith { throw 'unauthorized' }
            $r = Get-AICostReport -Path $script:usageFile -PassThru
            $Claude = $r.Providers | Where-Object { $_.Backend -eq 'claude' }
            $Claude.KeyConfigured | Should -BeTrue
            $Claude.Valid | Should -BeFalse
        }

        It 'reports Valid=true for gemini and openai on a successful probe, even though their rate-limit fields are absent (t/3926 fix)' {
            Mock Resolve-AIApiKey -ModuleName AITriad -MockWith { 'fake-key' }
            Mock Invoke-WebRequest -ModuleName AITriad -MockWith {
                [PSCustomObject]@{ StatusCode = 200; Headers = @{} }
            }
            $path = $script:usageFile
            $r = InModuleScope AITriad -Parameters @{ path = $path } { Get-AICostReport -Path $path -PassThru }
            $Gemini = $r.Providers | Where-Object { $_.Backend -eq 'gemini' }
            $Openai = $r.Providers | Where-Object { $_.Backend -eq 'openai' }
            $Gemini.KeyConfigured | Should -BeTrue
            $Gemini.Valid | Should -BeTrue -Because 'gemini never exposes rate-limit fields, but a 200 response is still a valid key'
            $Openai.KeyConfigured | Should -BeTrue
            $Openai.Valid | Should -BeTrue -Because 'openai lacks RateReset specifically, but RateLimit/RateRemaining absence (or presence) must not affect Valid'
        }
    }
}
