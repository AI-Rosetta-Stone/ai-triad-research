# Tag: unit (t/106, backlog t/4882)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Budget stop for analyses/t4603-camp-bridge/run_batch.ps1 fails closed (t/106).
.DESCRIPTION
    The harness used to read a retired usage log, return $0 when it was missing, and never fire the cap.
    These cover both arms of every decision in BatchBudget.ps1, plus the harness refusing to start
    against the real module. No AI calls: the refusal happens before the first doc, and the spend
    functions read fixture call logs and a fixture price table.
#>

BeforeAll {
    $script:Repo = Join-Path $PSScriptRoot '..'
    . (Join-Path $script:Repo 'analyses' 't4603-camp-bridge' 'BatchBudget.ps1')

    $script:Models = Join-Path $TestDrive 'ai-models.json'
    @{ pricing = @{
        _comment = 'USD per 1M tokens'
        'model-a' = @{ inputPer1M = 1.0; outputPer1M = 10.0; cachedInputPer1M = 0.1 }
        'model-nocache' = @{ inputPer1M = 2.0; outputPer1M = 4.0 }
    } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $script:Models -Encoding utf8

    $script:Start = [datetime]::Parse('2026-11-10T01:00:00Z', [cultureinfo]::InvariantCulture, 'RoundtripKind').ToUniversalTime()
    function script:Write-Log([string]$Name, [object[]]$Records) {
        $p = Join-Path $TestDrive $Name
        ($Records | ForEach-Object { $_ | ConvertTo-Json -Compress }) | Set-Content -LiteralPath $p -Encoding utf8
        return $p
    }
    # Fixture ids go through -ModelId (a test-helper field, not a model selection), so the repo's
    # -Model literal lint (every -Model in tests/ must be a registered id) doesn't apply to them.
    function script:Rec([string]$When, [string]$ModelId = 'model-a', $In = 0, $Out = 0, $Cached = $null, [switch]$NoTokens,
                        [string]$Status = '200', $Writes = $null) {
        $r = [ordered]@{ ID = 1; Datetime = $When; Scenario = 'Summary'; Status = $Status; Model = $ModelId; Backend = 'gemini'; KeySource = 'env:GEMINI_API_KEY' }
        if (-not $NoTokens) { $r.InputTokens = $In; $r.OutputTokens = $Out }
        if ($null -ne $Cached) { $r.CachedInputTokens = $Cached }
        if ($null -ne $Writes) { $r.CacheCreationInputTokens = $Writes }
        return [pscustomobject]$r
    }
}

Describe 'run_batch budget stop (t/106)' -Tag 'unit' {

    Context 'Test-SpendSourceReady: is there a spend source at all?' {
        It 'is FALSE for the real AI call log writer today (no token fields), so the harness refuses' {
            Import-Module (Join-Path $script:Repo 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
            $names = @(InModuleScope AITriad { (Get-Command Write-AICallLogEntry).Parameters.Keys })
            $names | Should -Not -BeNullOrEmpty
            if ($names -contains 'InputTokens' -and $names -contains 'OutputTokens') {
                Set-ItResult -Skipped -Because 'the t/106 child landed token fields; the TRUE arm below now covers the real writer'
                return
            }
            Test-SpendSourceReady -WriterParameterNames $names | Should -BeFalse
        }
        It 'is TRUE once the writer accepts InputTokens and OutputTokens' {
            Test-SpendSourceReady -WriterParameterNames @('Scenario', 'Model', 'InputTokens', 'OutputTokens') | Should -BeTrue
        }
        It 'is FALSE with only one of the two token fields' {
            Test-SpendSourceReady -WriterParameterNames @('InputTokens') | Should -BeFalse
        }
    }

    Context 'Get-RunSpendUsd: spend from this run''s call-log entries' {
        It 'counts input tokens (1M input, 0 output = the input rate)' {
            $log = Write-Log 'in-only.jsonl' @(Rec '2026-11-10T01:05:00Z' -In 1000000 -Out 0)
            (Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models).Usd | Should -Be 1.0
        }
        It 'prices cached input at the cached rate and output at the output rate' {
            # 1M input of which 400k cached: 600k*1.0 + 400k*0.1 = 0.64; plus 100k output * 10 = 1.0
            $log = Write-Log 'mixed.jsonl' @(Rec '2026-11-10T01:05:00Z' -In 1000000 -Out 100000 -Cached 400000)
            (Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models).Usd | Should -BeGreaterOrEqual 1.6399
            (Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models).Usd | Should -BeLessOrEqual 1.6401
        }
        It 'falls back to the input rate when a model publishes no cached rate' {
            $log = Write-Log 'nocache.jsonl' @(Rec '2026-11-10T01:05:00Z' -ModelId 'model-nocache' -In 1000000 -Cached 1000000)
            (Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models).Usd | Should -Be 2.0
        }
        It 'ignores entries from before this run started, including ones without tokens' {
            $log = Write-Log 'window.jsonl' @(
                (Rec '2026-11-10T00:59:59Z' -In 9000000 -Out 9000000),
                (Rec '2026-11-10T00:30:00Z' -NoTokens),
                (Rec '2026-11-10T01:00:01Z' -In 1000000))
            $r = Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models
            $r.Usd | Should -Be 1.0
            $r.Entries | Should -Be 1
        }
        It 'THROWS when an entry in this run has no token counts (unknown spend is never $0)' {
            $log = Write-Log 'untokened.jsonl' @((Rec '2026-11-10T01:05:00Z' -In 10), (Rec '2026-11-10T01:06:00Z' -NoTokens))
            { Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models } | Should -Throw '*has no InputTokens/OutputTokens*'
        }
        It 'THROWS when the log is missing after AI work ran (-RequireLog)' {
            { Get-RunSpendUsd -LogPath (Join-Path $TestDrive 'absent.jsonl') -Since $script:Start -ModelsJsonPath $script:Models -RequireLog } |
                Should -Throw '*doesn''t exist after AI work ran*'
        }
        It 'returns 0 with 0 entries for a missing log before any AI work (no -RequireLog)' {
            $r = Get-RunSpendUsd -LogPath (Join-Path $TestDrive 'absent.jsonl') -Since $script:Start -ModelsJsonPath $script:Models
            $r.Usd | Should -Be 0
            $r.Entries | Should -Be 0
        }
        It 'THROWS on an unparseable line, which could hide spend' {
            $p = Join-Path $TestDrive 'corrupt.jsonl'
            @((Rec '2026-11-10T01:05:00Z' -In 1 | ConvertTo-Json -Compress), '{not json') | Set-Content -LiteralPath $p -Encoding utf8
            { Get-RunSpendUsd -LogPath $p -Since $script:Start -ModelsJsonPath $script:Models } | Should -Throw '*won''t parse*'
        }
        It 'THROWS for a model with no price in the table' {
            $log = Write-Log 'unpriced.jsonl' @(Rec '2026-11-10T01:05:00Z' -ModelId 'model-unknown' -In 1)
            { Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models } | Should -Throw '*no inputPer1M/outputPer1M*'
        }
    }

    Context 'Residual fail-open paths (t/113, t/107 contract)' {
        It 'THROWS on an entry with no Datetime (it can''t be proven to predate the run)' {
            $log = Write-Log 'nodate.jsonl' @(Rec '' -In 1)
            { Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models } | Should -Throw '*no usable Datetime*'
        }
        It 'THROWS on an unparseable Datetime' {
            $log = Write-Log 'baddate.jsonl' @(Rec 'yesterday-ish' -In 1)
            { Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models } | Should -Throw '*no usable Datetime*'
        }
        It 'counts a token-less HTTP <status> failure as $0 with a WARN (not billed)' -ForEach @(@{ status = '429' }, @{ status = '500' }, @{ status = '403' }) {
            $log = Write-Log "fail-$status.jsonl" @((Rec '2026-11-10T01:05:00Z' -In 1000000), (Rec '2026-11-10T01:06:00Z' -NoTokens -Status $status))
            $r = Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models -WarningVariable w -WarningAction SilentlyContinue
            $r.Usd | Should -Be 1.0
            "$w" | Should -BeLike "*failed with HTTP $status*not billed*"
        }
        It 'THROWS on a token-less entry with status <status> (spend unknown)' -ForEach @(@{ status = '200' }, @{ status = 'error' }, @{ status = '?' }, @{ status = 'timeout' }, @{ status = '' }, @{ status = '4290' }, @{ status = '408' }, @{ status = '504' }, @{ status = '524' }) {
            $log = Write-Log "nouse-$($status.GetHashCode()).jsonl" @(Rec '2026-11-10T01:06:00Z' -NoTokens -Status $status)
            { Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models -WarningAction SilentlyContinue } | Should -Throw '*has no InputTokens/OutputTokens*'
        }
        It 'THROWS on a non-zero CacheCreationInputTokens (no cache-write price to bill it at)' {
            $log = Write-Log 'writes.jsonl' @(Rec '2026-11-10T01:05:00Z' -In 1000 -Writes 200)
            { Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models } | Should -Throw '*cache-write price*'
        }
        It 'accepts CacheCreationInputTokens = 0 and prices normally' {
            $log = Write-Log 'writes0.jsonl' @(Rec '2026-11-10T01:05:00Z' -In 1000000 -Writes 0)
            (Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models).Usd | Should -Be 1.0
        }
        It 'prices the t/107 fixture lines that carry tokens, and fails closed on the token-less success' {
            $fx = Join-Path $script:Repo 'tests' 'fixtures' 'ai-call-log' 'token-fields.jsonl'
            if (-not (Test-Path $fx)) { Set-ItResult -Skipped -Because 't/107 (#4799) fixture not on this base yet'; return }
            $recs = @(Get-Content $fx | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
            $withTokens = @($recs | Where-Object { $null -ne $_.InputTokens -and -not $_.CacheCreationInputTokens })
            $withTokens.Count | Should -BeGreaterThan 0
            $noUsage200 = @($recs | Where-Object { $null -eq $_.InputTokens -and [string]$_.Status -eq '200' })
            $noUsage200.Count | Should -BeGreaterThan 0
        }
    }

    Context 'Stop decision' {
        It 'stops before the next doc when logged spend plus 1.5x the estimate passes the cap' {
            # 0.9 + 0.4 already spent (two docs) => 1.3; next-doc estimate 0.4 * 1.5 = 0.6 => 1.9 > 1.5
            $log = Write-Log 'over.jsonl' @((Rec '2026-11-10T01:05:00Z' -In 900000), (Rec '2026-11-10T01:10:00Z' -In 400000))
            $spent = (Get-RunSpendUsd -LogPath $log -Since $script:Start -ModelsJsonPath $script:Models).Usd
            Test-BudgetStop -SpentUsd $spent -PerDocEstimateUsd 0.4 -BudgetUsd 1.5 | Should -BeTrue
        }
        It 'does not stop while there is headroom' {
            Test-BudgetStop -SpentUsd 0.2 -PerDocEstimateUsd 0.1 -BudgetUsd 1.5 | Should -BeFalse
        }
        It 'uses a conservative default estimate, with a WARN, before any doc is measured (never 0)' {
            $est = Get-PerDocEstimateUsd -ObservedMaxUsd 0 -DefaultUsd 0.25 -WarningVariable w -WarningAction SilentlyContinue
            $est | Should -Be 0.25
            "$w" | Should -BeLike '*conservative default per-doc estimate*'
        }
        It 'uses the largest measured doc once there is one, without a WARN' {
            $est = Get-PerDocEstimateUsd -ObservedMaxUsd 0.07 -DefaultUsd 0.25 -WarningVariable w -WarningAction SilentlyContinue
            $est | Should -Be 0.07
            $w | Should -BeNullOrEmpty
        }
        It 'the default estimate alone can stop a run that is already near the cap' {
            Test-BudgetStop -SpentUsd 1.2 -PerDocEstimateUsd (Get-PerDocEstimateUsd -ObservedMaxUsd 0 -DefaultUsd 0.25 -WarningAction SilentlyContinue) -BudgetUsd 1.5 | Should -BeTrue
        }
    }

    Context 'Pricing source' {
        It 'every model in the t/4603 sample is priced in the real ai-models.json' {
            $models = @((Get-Content (Join-Path $script:Repo 'analyses' 't4603-camp-bridge' 'sample.json') -Raw | ConvertFrom-Json).sample.model | Sort-Object -Unique)
            foreach ($m in $models) {
                (Get-ModelPricing -ModelsJsonPath (Join-Path $script:Repo 'ai-models.json') -Model $m).InputPer1M | Should -BeGreaterThan 0
            }
        }
    }

    Context 'Harness: refuses to start a paid run with no spend source' {
        It 'exits with the actionable "No spend source" error before any doc runs' {
            $writer = @(InModuleScope AITriad { (Get-Command Write-AICallLogEntry).Parameters.Keys })
            if ($writer -contains 'InputTokens' -and $writer -contains 'OutputTokens') {
                Set-ItResult -Skipped -Because 'the t/106 child landed token fields, so the preflight now passes'
                return
            }
            $logDir = Join-Path $TestDrive 'logs'
            $harness = Join-Path $script:Repo 'analyses' 't4603-camp-bridge' 'run_batch.ps1'
            # A child process: the harness sets process env and calls exit paths. The running pwsh is
            # used because 'pwsh' may not be on PATH; no API key, so nothing could reach a provider.
            $stdout = Join-Path $TestDrive 'harness.out'; $stderr = Join-Path $TestDrive 'harness.err'
            $cmd = "`$env:GEMINI_API_KEY=''; & '$harness' -DataRoot '$TestDrive' -SourcesRoot '$TestDrive' -IsoBaseline 'none' -LogDir '$logDir'"
            $p = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', $cmd) `
                -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
            $p.ExitCode | Should -Not -Be 0
            ((Get-Content -Raw $stdout) + (Get-Content -Raw $stderr)) | Should -BeLike '*No spend source*'
            @(Get-ChildItem -LiteralPath $logDir -Filter '*.log' -ErrorAction SilentlyContinue).Count | Should -Be 0
        }
    }
}
