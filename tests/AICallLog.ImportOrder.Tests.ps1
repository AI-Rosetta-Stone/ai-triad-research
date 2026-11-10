# Tag: unit (t/150)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/150 (TL p/37#25): AI call logging is a property of Invoke-AIApi, whatever the import order.
.DESCRIPTION
    AIEnrich registers its own default call logger, so every import order writes EXACTLY ONE log entry
    per Invoke-AIApi call: AIEnrich alone (analyses/.../run_judge.ps1), AITriad alone, AIEnrich then
    AITriad (scripts/Invoke-DisagreementTypeBackfill.ps1), and AITriad then AIEnrich. AITriad re-exports
    Invoke-AIApi, so the backfill script's order resolves it. Invoke-AIByUsage's own logger replaces the
    default: still one entry. Module state is per process, so each order runs in a child pwsh; HTTP is
    faked inside the AIEnrich instance that DEFINES the resolved Invoke-AIApi (no network, no spend).
#>

BeforeAll {
    $script:Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $script:Pwsh = (Get-Process -Id $PID).Path

    # Runs one import order in a child pwsh with a temp data root; returns { Resolved; Ready; Entries; Tokens }.
    function script:Invoke-OrderProbe([string]$Order, [string]$Call = 'direct') {
        $dataRoot = Join-Path $TestDrive ("dr-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $dataRoot | Out-Null
        $child = @'
param($Repo, $Order, $Call)
$ErrorActionPreference = 'Stop'
$at = Join-Path $Repo 'scripts/AITriad/AITriad.psm1'; $ae = Join-Path $Repo 'scripts/AIEnrich.psm1'
switch ($Order) {
  'AIEnrich-only'         { Import-Module $ae -Force -WarningAction SilentlyContinue }
  'AITriad-only'          { Import-Module $at -Force -WarningAction SilentlyContinue }
  'AIEnrich-then-AITriad' { Import-Module $ae -Force -WarningAction SilentlyContinue; Import-Module $at -Force -WarningAction SilentlyContinue }
  'AITriad-then-AIEnrich' { Import-Module $at -Force -WarningAction SilentlyContinue; Import-Module $ae -Force -WarningAction SilentlyContinue }
}
$cmd = Get-Command Invoke-AIApi -ErrorAction SilentlyContinue
$out = @{ Resolved = [bool]$cmd; Ready = $null; Entries = -1; Tokens = $null }
if ($cmd) {
    $owner = $cmd.ScriptBlock.Module   # the AIEnrich instance that defines it (also for AITriad's re-export)
    & $owner {
        function script:Resolve-AIApiKey { 'fake-key' }
        function script:Start-Sleep { }
        function script:Invoke-RestMethod {
            [pscustomobject]@{
                candidates    = @([pscustomobject]@{ content = [pscustomobject]@{ parts = @([pscustomobject]@{ text = 'ok' }) }; finishReason = 'STOP' })
                usageMetadata = [pscustomobject]@{ promptTokenCount = 7; candidatesTokenCount = 3; totalTokenCount = 10 }
            }
        }
    }
    if (Get-Command Test-AICallLogReady -ErrorAction SilentlyContinue) { $out.Ready = [bool](Test-AICallLogReady) }
    if ($Call -eq 'byusage') {
        & (Get-Module AITriad) {
            function script:Get-UsageConfig { @{ message = 'Say hi'; model = 'gemini-3.5-flash-lite' } }
            Invoke-AIByUsage -UsageId 'enrichment.demo-scenario' -Values @{} -WarningAction SilentlyContinue | Out-Null
        }
    } else {
        Invoke-AIApi -Prompt 'hi' -Model 'gemini-3.5-flash-lite' -FallbackModels @() -SkipTokenCheck -WarningAction SilentlyContinue | Out-Null
    }
    $log = Join-Path $env:AI_TRIAD_DATA_ROOT 'ai-call-log.jsonl'
    $lines = @(if (Test-Path $log) { Get-Content $log | Where-Object { $_ } })   # @() outside: a 1-line file must stay an array
    $out.Entries = $lines.Count
    if ($lines.Count) { $r = $lines[0] | ConvertFrom-Json; $out.Tokens = "$($r.InputTokens)/$($r.OutputTokens)" }
}
'T150JSON:' + ($out | ConvertTo-Json -Compress)
'@
        $childFile = Join-Path $TestDrive "probe-$Order-$Call.ps1"
        Set-Content -LiteralPath $childFile -Value $child -Encoding utf8
        $env:AI_CALL_LOG_ENABLED = '1'
        $prior = $env:AI_TRIAD_DATA_ROOT
        $env:AI_TRIAD_DATA_ROOT = $dataRoot
        try {
            $json = & $script:Pwsh -NoProfile -NonInteractive -File $childFile -Repo $script:Repo -Order $Order -Call $Call 2>$null |
                Where-Object { "$_" -like 'T150JSON:*' } | Select-Object -Last 1
        } finally {
            $env:AI_TRIAD_DATA_ROOT = $prior
            Remove-Item Env:AI_CALL_LOG_ENABLED -ErrorAction SilentlyContinue
        }
        if (-not $json) { throw "probe '$Order/$Call' printed no T150JSON line" }
        return (($json -replace '^T150JSON:', '') | ConvertFrom-Json)
    }
}

Describe 'Invoke-AIApi logs exactly once per call in every import order (t/150)' -Tag 'unit' {

    It '<Order>: Invoke-AIApi resolves, Test-AICallLogReady is true, one entry with tokens' -TestCases @(
        @{ Order = 'AIEnrich-only' }
        @{ Order = 'AITriad-only' }
        @{ Order = 'AIEnrich-then-AITriad' }
        @{ Order = 'AITriad-then-AIEnrich' }
    ) {
        param($Order)
        $r = Invoke-OrderProbe -Order $Order
        $r.Resolved | Should -BeTrue -Because 'AITriad re-exports Invoke-AIApi; AIEnrich exports it'
        $r.Entries  | Should -Be 1 -Because 'logging is a property of Invoke-AIApi: never 0 (spend-guard hole), never 2 (double count)'
        $r.Tokens   | Should -Be '7/3'
        if ($Order -ne 'AIEnrich-only') { $r.Ready | Should -BeTrue }
    }

    It 'Invoke-AIByUsage with both modules loaded still writes exactly one entry (its logger replaces the default)' {
        $r = Invoke-OrderProbe -Order 'AIEnrich-then-AITriad' -Call 'byusage'
        $r.Entries | Should -Be 1
    }
}

Describe 'Test-AICallLogReady (t/150)' -Tag 'unit' {
    BeforeAll {
        Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AITriad' 'AITriad.psm1') -Force -WarningAction SilentlyContinue
    }
    AfterEach { Remove-Item Env:AI_CALL_LOG_ENABLED -ErrorAction SilentlyContinue }

    It 'is false (with a reason) when the call log is disabled' {
        Remove-Item Env:AI_CALL_LOG_ENABLED -ErrorAction SilentlyContinue
        Test-AICallLogReady | Should -BeFalse
        (Test-AICallLogReady -Detailed).Reason | Should -Match 'AI_CALL_LOG_ENABLED'
    }

    It 'is true when enabled and the resolved Invoke-AIApi has its default logger' {
        $env:AI_CALL_LOG_ENABLED = '1'
        $d = Test-AICallLogReady -Detailed
        $d.Ready | Should -BeTrue
        $d.InvokeAIApiResolved | Should -BeTrue
        $d.DefaultLoggerRegistered | Should -BeTrue
    }
}

Describe 'scripts/Invoke-DisagreementTypeBackfill.ps1 resolves Invoke-AIApi in its import order (t/150)' -Tag 'unit' {
    It 'the script imports AIEnrich then AITriad, and Invoke-AIApi resolves after both (it failed on main)' {
        $src = Get-Content -Raw (Join-Path $script:Repo 'scripts' 'Invoke-DisagreementTypeBackfill.ps1')
        $src | Should -Match 'AIEnrich\.psm1'
        $src | Should -Match 'Invoke-AIApi'
        (Invoke-OrderProbe -Order 'AIEnrich-then-AITriad').Resolved | Should -BeTrue
    }
}
