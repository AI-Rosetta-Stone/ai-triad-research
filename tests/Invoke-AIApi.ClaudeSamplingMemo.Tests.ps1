# Tag: enrichment (t/4164)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4164: Invoke-AIApi re-sends a Claude request without temperature when the model rejects it, and
    memoizes the model for the rest of the process (mirrors lib/ai-client/providers/claude.ts, t/3942).
.DESCRIPTION
    Current Claude models return 400 "`temperature` is deprecated for this model" for ANY temperature.
    On that 400 the model is recorded in $script:ClaudeSamplingRejected, one WARN is written, and the same
    request is re-sent once without temperature (outside MaxRetries). Later calls to that model omit
    temperature from the start. Any other 400 is still never retried (t/4078), the memo is per model, and
    a second 400 on the re-send is a normal failure.

    The memo is cleared before every test with a test-only reset into the module scope.
    NO LIVE CALL: Invoke-RestMethod and Start-Sleep are mocked in AIEnrich and every key variable is cleared.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1') -Force -WarningAction SilentlyContinue

    $script:Key = 'unit-test-key-t4164'
    $script:Haiku = 'claude-haiku-5-5'          # apiModelId claude-haiku-5-5
    $script:Sonnet45 = 'claude-sonnet-4-5'      # apiModelId claude-sonnet-4-5-20250929
    $script:DeprecatedBody = '{"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}'
    $script:OtherBody = '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be greater than 0"}}'
    $script:KeyVars = @('GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY',
        'AZURE_OPENAI_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'AI_API_KEY',
        'AZURE_OPENAI_ENDPOINT', 'OLLAMA_HOST')
    $script:SavedEnv = @{}
    foreach ($v in $script:KeyVars) { $script:SavedEnv[$v] = [Environment]::GetEnvironmentVariable($v) }

    # An HttpClient-shaped HTTP failure with its body on ErrorDetails, as Invoke-RestMethod throws it in PS7.
    function script:New-HttpError([int]$Code, [string]$Body = '') {
        $resp = [System.Net.Http.HttpResponseMessage]::new([Enum]::ToObject([System.Net.HttpStatusCode], $Code))
        $ex = [Microsoft.PowerShell.Commands.HttpResponseException]::new("Response status code does not indicate success: $Code (fake).", $resp)
        $er = [System.Management.Automation.ErrorRecord]::new($ex, 'WebCmdletWebResponseException',
            [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
        if ($Body) { $er.ErrorDetails = [System.Management.Automation.ErrorDetails]::new($Body) }
        $er
    }
    function script:New-ClaudeOk([string]$Text = 'ok') { [pscustomobject]@{ content = @([pscustomobject]@{ type = 'text'; text = $Text }); stop_reason = 'end_turn' } }
    function script:New-ChatOk([string]$Text = 'ok') {
        [pscustomobject]@{ choices = @([pscustomobject]@{ message = [pscustomobject]@{ content = $Text }; finish_reason = 'stop' }) }
    }

    # Replies in order; the last reply repeats.
    function script:Set-Replies([object[]]$Replies) {
        $script:Queue = [System.Collections.Generic.Queue[object]]::new()
        foreach ($r in $Replies) { $script:Queue.Enqueue($r) }
    }
    function script:Invoke-Call([hashtable]$Params) {
        $w = $null
        $r = Invoke-AIApi @Params -WarningVariable w -WarningAction SilentlyContinue
        [pscustomobject]@{ Result = $r; Warnings = @($w | ForEach-Object { $_.Message }) }
    }
    # The parsed JSON body of the Nth request (zero-based).
    function script:Get-Body([int]$Index) {
        [System.Text.Encoding]::UTF8.GetString([byte[]]$script:Calls[$Index].Body) | ConvertFrom-Json -AsHashtable
    }
    function script:Get-RejectionWarnings([string[]]$Warnings) { @($Warnings | Where-Object { $_ -like 'Claude model *rejected temperature*' }) }
    function script:Base([string]$Model) { @{ Prompt = 'p'; Model = $Model; ApiKey = $script:Key; FallbackModels = @(); Temperature = 0.7 } }
}

AfterAll {
    foreach ($v in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($v, $script:SavedEnv[$v]) }
    & (Get-Module AIEnrich) { $script:ClaudeSamplingRejected.Clear() }
}

Describe 'Invoke-AIApi Claude temperature-rejection memo (t/4164)' -Tag 'enrichment' {

    BeforeEach {
        foreach ($v in $script:KeyVars) { [Environment]::SetEnvironmentVariable($v, $null) }
        & (Get-Module AIEnrich) { $script:ClaudeSamplingRejected.Clear() }
        $script:Calls = [System.Collections.Generic.List[hashtable]]::new()
        $script:Sleeps = [System.Collections.Generic.List[double]]::new()
        script:Set-Replies @()
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
            $call = @{}; foreach ($k in $PesterBoundParameters.Keys) { $call[$k] = $PesterBoundParameters[$k] }
            $script:Calls.Add($call)
            if ($script:Queue.Count -eq 0) { throw 't/4164 test: no reply configured' }
            $next = if ($script:Queue.Count -gt 1) { $script:Queue.Dequeue() } else { $script:Queue.Peek() }
            if ($next -is [System.Management.Automation.ErrorRecord]) { throw $next }
            return $next
        }
        Mock Start-Sleep -ModuleName AIEnrich -MockWith { $script:Sleeps.Add([double]$Seconds) }
        Mock Write-Host -ModuleName AIEnrich -MockWith { }
    }

    It 'a deprecation 400 is re-sent once without temperature and succeeds, with exactly one WARN' {
        script:Set-Replies @((script:New-HttpError 400 $script:DeprecatedBody), (script:New-ClaudeOk 'second'))
        $out = script:Invoke-Call (script:Base $script:Haiku)

        $out.Result.Text | Should -Be 'second'
        $script:Calls.Count | Should -Be 2
        (script:Get-Body 0).ContainsKey('temperature') | Should -BeTrue
        (script:Get-Body 0)['temperature'] | Should -Be 0.7
        (script:Get-Body 1).ContainsKey('temperature') | Should -BeFalse
        # Otherwise the same request.
        (script:Get-Body 1)['model'] | Should -Be 'claude-haiku-5-5'
        (script:Get-Body 1)['messages'][0]['content'] | Should -Be 'p'
        $script:Calls[1].Uri | Should -Be $script:Calls[0].Uri
        $script:Sleeps.Count | Should -Be 0

        $rej = @(script:Get-RejectionWarnings $out.Warnings)
        $rej.Count | Should -Be 1
        $rej[0] | Should -BeExactly ('Claude model "claude-haiku-5-5" rejected temperature=0.7; retrying without it. Later calls to this model omit temperature for the rest of the process. API: ' + $script:DeprecatedBody)
        $out.Warnings.Count | Should -Be 1   # no failure WARN: the call succeeded
        (& (Get-Module AIEnrich) { $script:ClaudeSamplingRejected.Contains('claude-haiku-5-5') }) | Should -BeTrue
    }

    It 'the re-send does not count against MaxRetries' {
        script:Set-Replies @((script:New-HttpError 400 $script:DeprecatedBody), (script:New-ClaudeOk 'second'))
        $p = script:Base $script:Haiku; $p['MaxRetries'] = 1
        $out = script:Invoke-Call $p
        $out.Result.Text | Should -Be 'second'
        $script:Calls.Count | Should -Be 2
    }

    It 'the WARN scrubs the API body and keeps its first 200 characters' {
        $long = '{"message":"`temperature` is deprecated for this model. key=' + $script:Key + ' ' + ('x' * 400) + '"}'
        script:Set-Replies @((script:New-HttpError 400 $long), (script:New-ClaudeOk))
        $out = script:Invoke-Call (script:Base $script:Haiku)
        $rej = @(script:Get-RejectionWarnings $out.Warnings)[0]
        $rej | Should -Not -Match ([regex]::Escape($script:Key))
        $api = $rej.Substring($rej.IndexOf('API: ') + 5)
        $api.Length | Should -Be 200
    }

    It 'a later call to the memoized model omits temperature from the start: one request, no WARN' {
        script:Set-Replies @((script:New-HttpError 400 $script:DeprecatedBody), (script:New-ClaudeOk 'first'))
        $null = script:Invoke-Call (script:Base $script:Haiku)
        $script:Calls.Clear()
        script:Set-Replies @((script:New-ClaudeOk 'later'))

        $out = script:Invoke-Call (script:Base $script:Haiku)
        $out.Result.Text | Should -Be 'later'
        $script:Calls.Count | Should -Be 1
        (script:Get-Body 0).ContainsKey('temperature') | Should -BeFalse
        $out.Warnings.Count | Should -Be 0
    }

    It 'the memo does not leak: another Claude model still sends temperature' {
        script:Set-Replies @((script:New-HttpError 400 $script:DeprecatedBody), (script:New-ClaudeOk 'first'))
        $null = script:Invoke-Call (script:Base $script:Haiku)
        $script:Calls.Clear()
        script:Set-Replies @((script:New-ClaudeOk 'other'))

        $out = script:Invoke-Call (script:Base $script:Sonnet45)
        $out.Result.Text | Should -Be 'other'
        $script:Calls.Count | Should -Be 1
        (script:Get-Body 0)['model'] | Should -Be 'claude-sonnet-4-5-20250929'
        (script:Get-Body 0)['temperature'] | Should -Be 0.7
    }

    It 'any other 400 is still not retried and is reported as before' {
        script:Set-Replies @((script:New-HttpError 400 $script:OtherBody), (script:New-ClaudeOk 'never'))
        $out = script:Invoke-Call (script:Base $script:Haiku)

        $out.Result | Should -BeNullOrEmpty
        $script:Calls.Count | Should -Be 1
        @(script:Get-RejectionWarnings $out.Warnings).Count | Should -Be 0
        $out.Warnings[0] | Should -BeLike 'claude: API call failed (HTTP 400)*'
        $out.Warnings | Should -Contain "claude: Response body: $($script:OtherBody)"
        (& (Get-Module AIEnrich) { $script:ClaudeSamplingRejected.Count }) | Should -Be 0
    }

    It 'a temperature-deprecated 400 from a non-Claude backend is not re-sent' {
        script:Set-Replies @((script:New-HttpError 400 $script:DeprecatedBody), (script:New-ChatOk 'never'))
        $out = script:Invoke-Call (script:Base 'groq-openai-gpt-oss-120b')
        $out.Result | Should -BeNullOrEmpty
        $script:Calls.Count | Should -Be 1
        @(script:Get-RejectionWarnings $out.Warnings).Count | Should -Be 0
    }

    It 'a second 400 on the re-send is a normal failure: two requests, no loop' {
        script:Set-Replies @((script:New-HttpError 400 $script:DeprecatedBody), (script:New-HttpError 400 $script:DeprecatedBody), (script:New-ClaudeOk 'never'))
        $out = script:Invoke-Call (script:Base $script:Haiku)

        $out.Result | Should -BeNullOrEmpty
        $script:Calls.Count | Should -Be 2
        (script:Get-Body 1).ContainsKey('temperature') | Should -BeFalse
        @(script:Get-RejectionWarnings $out.Warnings).Count | Should -Be 1
        @($out.Warnings | Where-Object { $_ -like 'claude: API call failed (HTTP 400)*' }).Count | Should -Be 1
    }

    It 'the CallLogger logs one entry per call: the re-send''s outcome, not counted as a retry' {
        script:Set-Replies @((script:New-HttpError 400 $script:DeprecatedBody), (script:New-ClaudeOk 'second'))
        $script:Logged = [System.Collections.Generic.List[string]]::new()
        $p = script:Base $script:Haiku
        $p['CallLogger'] = { param($Retry, $Status) $script:Logged.Add("$Retry|$Status") }
        $null = script:Invoke-Call $p
        @($script:Logged) | Should -Be @('0|200')
    }
}
