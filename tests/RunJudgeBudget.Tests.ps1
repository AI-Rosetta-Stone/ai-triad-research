# Tag: unit (t/150)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    analyses/t4603-camp-bridge/judge/run_judge.ps1 goes through the run_batch spend guard (t/150).
.DESCRIPTION
    Before t/150 the judge imported only AIEnrich, so its paid calls never reached the AI call log and a
    guarded batch couldn't count them. These run the real harness with NO billable call:
      - no API key: Invoke-AIApi never attempts, nothing is logged, and the harness stops (fails closed);
      - a static check that every judge call is made inside AITriad's scope (the logged instance), so a
        later edit can't quietly go back to a bare AIEnrich Invoke-AIApi.
    The live probe (an invalid key gets an unbilled HTTP 400 that must appear in the call log, after which
    the harness stops on missing usage) makes a network request, so it runs only with AITRIAD_LIVE_PROBE=1.
#>

BeforeAll {
    $script:Repo = Join-Path $PSScriptRoot '..'
    $script:Harness = Join-Path $script:Repo 'analyses' 't4603-camp-bridge' 'judge' 'run_judge.ps1'
    function script:Invoke-Judge([string]$Work, [hashtable]$Keys) {
        New-Item -ItemType Directory -Force -Path $Work | Out-Null
        '[{"id":"P1","prompt":"Reply with {\"ok\": true}"}]' | Set-Content (Join-Path $Work 'items.json')
        $saved = @{}
        foreach ($k in 'GEMINI_API_KEY', 'AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_TRIAD_DATA_ROOT', 'AI_CALL_LOG_ENABLED') {
            $saved[$k] = [Environment]::GetEnvironmentVariable($k)
            [Environment]::SetEnvironmentVariable($k, $null)
        }
        foreach ($k in $Keys.Keys) { [Environment]::SetEnvironmentVariable($k, $Keys[$k]) }
        $env:AI_TRIAD_DATA_ROOT = $Work
        try {
            $threw = $false; $msg = ''
            try { & $script:Harness -ItemsPath (Join-Path $Work 'items.json') -OutPath (Join-Path $Work 'out.jsonl') *>&1 | Out-Null }
            catch { $threw = $true; $msg = $_.Exception.Message }
            $log = Join-Path $Work 'ai-call-log.jsonl'
            return [pscustomobject]@{
                Threw    = $threw
                Message  = $msg
                LogLines = @(if (Test-Path $log) { Get-Content $log | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json } })
                OutLines = @(if (Test-Path (Join-Path $Work 'out.jsonl')) { Get-Content (Join-Path $Work 'out.jsonl') })
            }
        }
        finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
    }
}

Describe 'run_judge spend guard (t/150)' -Tag 'unit' {

    It 'FAILS CLOSED with no API key: no call is attempted, nothing is logged, the harness stops, no output' {
        $r = Invoke-Judge -Work (Join-Path $TestDrive 'nokey') -Keys @{}
        $r.Threw | Should -BeTrue
        $r.Message | Should -BeLike '*AI call log*'
        $r.LogLines.Count | Should -Be 0
        $r.OutLines.Count | Should -Be 0
    }

    It 'every judge Invoke-AIApi call is made inside AITriad''s scope (the logged instance)' {
        $src = Get-Content -Raw $script:Harness
        $noBlocks = [regex]::Replace($src, '(?s)<#.*?#>', '')   # comment-based help blocks
        $code = ($noBlocks -split "`n" | Where-Object { $_ -notmatch '^\s*#' } | ForEach-Object { $_ -replace '\s#\s.*$', '' }) -join "`n"
        $calls = [regex]::Matches($code, '(?m)^.*\bInvoke-AIApi\b.*$') | ForEach-Object { $_.Value.Trim() }
        $calls.Count | Should -BeGreaterThan 0
        foreach ($c in $calls) { $c | Should -Match '&\s*\$Module\s*\{' -Because "a bare Invoke-AIApi bypasses the AI call log (t/150): $c" }
        $code | Should -Not -Match 'AIEnrich\.psm1' -Because 'importing AIEnrich directly is the path that skipped the call log'
    }

    It 'the guard prices from ai-models.json, not hard-coded rates' {
        $src = Get-Content -Raw $script:Harness
        $src | Should -Match 'Get-RunSpendUsd'
        $src | Should -Not -Match 'PricePerTok\s*='
    }

    It 'LIVE probe: an unbilled 400 reaches the call log under the judge model, then the harness stops on missing usage' {
        if ($env:AITRIAD_LIVE_PROBE -ne '1') { Set-ItResult -Skipped -Because 'makes a network request; set AITRIAD_LIVE_PROBE=1 to run'; return }
        $r = Invoke-Judge -Work (Join-Path $TestDrive 'badkey') -Keys @{ GEMINI_API_KEY = 'invalid-key-t150-probe' }
        @($r.LogLines | Where-Object { $_.Model -eq 'gemini-3.5-flash-lite' -and $_.Status -match '^4\d\d$' }).Count | Should -BeGreaterThan 0
        $r.Threw | Should -BeTrue
        $r.Message | Should -BeLike '*no usage metadata*'
        $r.OutLines.Count | Should -Be 0
    }
}
