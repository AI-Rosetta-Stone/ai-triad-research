# Tag: enrichment (t/4078)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    t/4078: Invoke-AIApi's retry policy, per-link cascade timeout, empty-text handling and WARN-only
    failure output (TL sign-off t/4078#3).
.DESCRIPTION
    §1 retry classes: 500/502/504 are retried like 429/503/529 (same schedule, same MaxRetries); a timeout
       or connection failure (no HTTP response) is retried at most ONCE per call; other 4xx never; 429 keeps
       its 120s floor. A cascade link exhausts its own retries before the next link. Each retry WARN names
       its reason ('HTTP 502', 'timeout', 'connection failure').
    §2 a fallback link uses its own model's default timeout unless the caller passed -TimeoutSec.
    §3 a 200 with no text WARNs "<DisplayName>: response had no text" with the stop/finish reason when the
       envelope has one, and returns $null (a cascade link then moves on).
    §4 every failure path is a Write-Warning; nothing on the Invoke-AIApi path but the [AI] config line
       uses Write-Host.

    The characterization suite (Invoke-AIApi.Characterization.Tests.ps1) carries the flipped t/4078 pins.
    NO LIVE CALL: Invoke-RestMethod and Start-Sleep are mocked in AIEnrich and every key variable is cleared.
#>

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1') -Force -WarningAction SilentlyContinue

    $script:D = [string][char]0x2014   # em dash, as in Invoke-AIApi's messages
    $script:Key = 'unit-test-key-t4078'
    $script:Groq = 'groq-openai-gpt-oss-120b'
    $script:KeyVars = @('GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY',
        'AZURE_OPENAI_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'AI_API_KEY',
        'AZURE_OPENAI_ENDPOINT', 'OLLAMA_HOST')
    $script:SavedEnv = @{}
    foreach ($v in $script:KeyVars) { $script:SavedEnv[$v] = [Environment]::GetEnvironmentVariable($v) }

    # An HttpClient-shaped HTTP failure, as Invoke-RestMethod throws it in PS7.
    function script:New-HttpError([int]$Code) {
        $resp = [System.Net.Http.HttpResponseMessage]::new([Enum]::ToObject([System.Net.HttpStatusCode], $Code))
        $ex = [Microsoft.PowerShell.Commands.HttpResponseException]::new("fake failure $Code", $resp)
        [System.Management.Automation.ErrorRecord]::new($ex, 'WebCmdletWebResponseException',
            [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
    }
    # A -TimeoutSec expiry exactly as PS 7.4 surfaces it (probed against a silent local listener):
    # TaskCanceledException wrapping TimeoutException, FQID ConnectionTimeoutReached, no .Response.
    function script:New-RealTimeout {
        $ex = [System.Threading.Tasks.TaskCanceledException]::new(
            'The request was canceled due to the configured HttpClient.Timeout of 9 seconds elapsing.',
            [System.TimeoutException]::new('The operation was canceled.'))
        [System.Management.Automation.ErrorRecord]::new($ex, 'ConnectionTimeoutReached',
            [System.Management.Automation.ErrorCategory]::OperationTimeout, $null)
    }
    # A refused connection as PS 7.4 surfaces it: HttpRequestException(SocketException), no .Response.
    function script:New-Refused {
        $ex = [System.Net.Http.HttpRequestException]::new('No connection could be made because the target machine actively refused it.',
            [System.Net.Sockets.SocketException]::new(10061))
        [System.Management.Automation.ErrorRecord]::new($ex, 'WebCmdletWebResponseException',
            [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
    }
    function script:New-ChatOk([string]$Text = 'ok') {
        [pscustomobject]@{ choices = @([pscustomobject]@{ message = [pscustomobject]@{ content = $Text }; finish_reason = 'stop' }) }
    }
    function script:New-ClaudeOk([string]$Text = 'ok') { [pscustomobject]@{ content = @([pscustomobject]@{ type = 'text'; text = $Text }); stop_reason = 'end_turn' } }
    function script:New-GeminiOk([string]$Text = 'ok') {
        [pscustomobject]@{ candidates = @([pscustomobject]@{ finishReason = 'STOP'; content = [pscustomobject]@{ parts = @([pscustomobject]@{ text = $Text }) } }) }
    }

    # Replies per host fragment, in order; the last reply repeats.
    function script:Set-Replies([hashtable]$ByHost) {
        $script:Queues = @{}
        foreach ($h in $ByHost.Keys) {
            $q = [System.Collections.Generic.Queue[object]]::new(); foreach ($i in $ByHost[$h]) { $q.Enqueue($i) }
            $script:Queues[$h] = $q
        }
    }
    function script:Invoke-Call([hashtable]$Params) {
        $w = $null
        $r = Invoke-AIApi @Params -WarningVariable w -WarningAction SilentlyContinue
        [pscustomobject]@{ Result = $r; Warnings = @($w | ForEach-Object { $_.Message }) }
    }
    function script:Get-Hosts { @($script:Calls | ForEach-Object { ([uri]$_.Uri).Host }) -join ',' }
    function script:Get-ModuleValue([scriptblock]$Block, [object[]]$Arguments = @()) { & (Get-Module AIEnrich) $Block @Arguments }
}

AfterAll {
    foreach ($v in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($v, $script:SavedEnv[$v]) }
}

Describe 'Invoke-AIApi retry policy and empty-text handling (t/4078)' -Tag 'enrichment' {

    BeforeEach {
        foreach ($v in $script:KeyVars) { [Environment]::SetEnvironmentVariable($v, $null) }
        $script:Calls = [System.Collections.Generic.List[hashtable]]::new()
        $script:Sleeps = [System.Collections.Generic.List[double]]::new()
        $script:HostLines = [System.Collections.Generic.List[string]]::new()
        script:Set-Replies @{}
        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
            $call = @{}; foreach ($k in $PesterBoundParameters.Keys) { $call[$k] = $PesterBoundParameters[$k] }
            if ($call.ContainsKey('ConnectionTimeoutSeconds')) { $call['TimeoutSec'] = $call['ConnectionTimeoutSeconds'] }
            $script:Calls.Add($call)
            foreach ($h in $script:Queues.Keys) {
                if ($call.Uri -like "*$h*") {
                    $q = $script:Queues[$h]
                    $next = if ($q.Count -gt 1) { $q.Dequeue() } else { $q.Peek() }
                    if ($next -is [System.Management.Automation.ErrorRecord] -or $next -is [System.Exception]) { throw $next }
                    return $next
                }
            }
            throw "t/4078 test: no reply configured for $($call.Uri)"
        }
        Mock Start-Sleep -ModuleName AIEnrich -MockWith { $script:Sleeps.Add([double]$Seconds) }
        Mock Write-Host -ModuleName AIEnrich -MockWith { $script:HostLines.Add([string]$Object) }
    }

    Context '§1 retry classes' {

        It 'HTTP <Code> is retried on the RetryDelays schedule, then succeeds' -ForEach @(@{ Code = 500 }, @{ Code = 502 }, @{ Code = 504 }) {
            script:Set-Replies @{ 'api.groq.com' = @((script:New-HttpError $Code), (script:New-HttpError $Code), (script:New-ChatOk 'third')) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @() }
            $out.Result.Text | Should -BeExactly 'third'
            $script:Calls.Count | Should -Be 3
            ($script:Sleeps -join ',') | Should -BeExactly '15,45'
            $out.Warnings -join "`n" | Should -BeExactly (@(
                "groq: HTTP $Code $($script:D) retrying in 15s (attempt 1/5)"
                "groq: HTTP $Code $($script:D) retrying in 45s (attempt 2/5)"
            ) -join "`n")
        }

        It 'HTTP <Code> exhausts exactly MaxRetries attempts' -ForEach @(@{ Code = 500 }, @{ Code = 502 }, @{ Code = 504 }) {
            script:Set-Replies @{ 'api.groq.com' = @((script:New-HttpError $Code)) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @(); MaxRetries = 3; RetryDelays = @(1, 2) }
            $out.Result | Should -BeNullOrEmpty
            $script:Calls.Count | Should -Be 3
            ($script:Sleeps -join ',') | Should -BeExactly '1,2'
            $out.Warnings | Should -Contain "groq: API call failed (HTTP $Code) $($script:D) fake failure $Code"
        }

        It 'HTTP <Code> is never retried' -ForEach @(@{ Code = 400 }, @{ Code = 401 }, @{ Code = 403 }, @{ Code = 404 }) {
            script:Set-Replies @{ 'api.groq.com' = @((script:New-HttpError $Code), (script:New-ChatOk 'must not be reached')) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @() }
            $out.Result | Should -BeNullOrEmpty
            $script:Calls.Count | Should -Be 1
            $script:Sleeps.Count | Should -Be 0
            @($out.Warnings | Where-Object { $_ -like '*retrying in*' }).Count | Should -Be 0
        }

        It 'a timeout is retried once and the retry can succeed' {
            script:Set-Replies @{ 'api.groq.com' = @((script:New-RealTimeout), (script:New-ChatOk 'after timeout')) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @() }
            $out.Result.Text | Should -BeExactly 'after timeout'
            $script:Calls.Count | Should -Be 2
            $out.Warnings -join "`n" | Should -BeExactly "groq: timeout $($script:D) retrying in 15s (attempt 1/5)"
        }

        It 'a timeout is retried ONCE, not MaxRetries times, and the failure line names it' {
            script:Set-Replies @{ 'api.groq.com' = @((script:New-RealTimeout)) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @(); MaxRetries = 10; TimeoutSec = 9 }
            $out.Result | Should -BeNullOrEmpty
            $script:Calls.Count | Should -Be 2
            ($script:Sleeps -join ',') | Should -BeExactly '15'
            $out.Warnings -join "`n" | Should -BeExactly (@(
                "groq: timeout $($script:D) retrying in 15s (attempt 1/10)"
                "groq: API call failed (timeout after 9s) $($script:D) The request was canceled due to the configured HttpClient.Timeout of 9 seconds elapsing."
            ) -join "`n")
        }

        It 'a connection failure is retried once, with reason "connection failure"' {
            script:Set-Replies @{ 'api.groq.com' = @((script:New-Refused)) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @() }
            $script:Calls.Count | Should -Be 2
            $out.Warnings -join "`n" | Should -BeExactly (@(
                "groq: connection failure $($script:D) retrying in 15s (attempt 1/5)"
                "groq: API call failed (connection failure) $($script:D) No connection could be made because the target machine actively refused it."
            ) -join "`n")
        }

        It 'the one no-response retry is per call: timeout, 503, timeout stops at the second timeout' {
            script:Set-Replies @{ 'api.groq.com' = @((script:New-RealTimeout), (script:New-HttpError 503), (script:New-RealTimeout), (script:New-ChatOk 'unreached')) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @() }
            $out.Result | Should -BeNullOrEmpty
            $script:Calls.Count | Should -Be 3
            ($script:Sleeps -join ',') | Should -BeExactly '15,45'
        }

        It 'an unclassified failure (no HTTP response, not a timeout or connection failure) is not retried' {
            script:Set-Replies @{ 'api.groq.com' = @([System.InvalidOperationException]::new('something else'), (script:New-ChatOk 'unreached')) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @() }
            $out.Result | Should -BeNullOrEmpty
            $script:Calls.Count | Should -Be 1
        }

        It '429 is unchanged: retried with the 120s floor, a larger delay kept' {
            script:Set-Replies @{ 'api.groq.com' = @((script:New-HttpError 429), (script:New-HttpError 429), (script:New-ChatOk 'later')) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @(); RetryDelays = @(5, 300) }
            $out.Result.Text | Should -BeExactly 'later'
            ($script:Sleeps -join ',') | Should -BeExactly '120,300'
            $out.Warnings[0] | Should -BeExactly "groq: HTTP 429 $($script:D) retrying in 120s (attempt 1/5)"
        }

        It 'a link exhausts its retries before the cascade moves to the next link' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'; $env:GEMINI_API_KEY = 'gemini-test-value'
            script:Set-Replies @{
                'api.groq.com'       = @((script:New-HttpError 502))
                'api.anthropic.com'  = @((script:New-RealTimeout))
                'generativelanguage' = @((script:New-GeminiOk 'gemini served'))
            }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; MaxRetries = 3; RetryDelays = @(1)
                FallbackModels = @('claude-haiku-4-5', 'gemini-2.5-flash') }
            $out.Result.Text | Should -BeExactly 'gemini served'
            script:Get-Hosts | Should -BeExactly 'api.groq.com,api.groq.com,api.groq.com,api.anthropic.com,api.anthropic.com,generativelanguage.googleapis.com'
            ($script:Sleeps -join ',') | Should -BeExactly '1,1,5' -Because 'primary: two retries at 1s; claude link: one timeout retry at its 5s'
            @($out.Warnings | Where-Object { $_ -like '*retrying in*' -or $_ -like 'Cascade:*' }) -join "`n" | Should -BeExactly (@(
                "groq: HTTP 502 $($script:D) retrying in 1s (attempt 1/3)"
                "groq: HTTP 502 $($script:D) retrying in 1s (attempt 2/3)"
                'Cascade: falling back to claude-haiku-4-5 (claude)'
                "claude: timeout $($script:D) retrying in 5s (attempt 1/2)"
                'Cascade: falling back to gemini-2.5-flash (gemini)'
            ) -join "`n")
        }

        It 'the retry predicate: <Kind> <Code> with <Used> no-response retries used -> <Expected>' -ForEach @(
            @{ Kind = 'http'; Code = 429; Used = 0; Expected = $true }
            @{ Kind = 'http'; Code = 500; Used = 0; Expected = $true }
            @{ Kind = 'http'; Code = 502; Used = 0; Expected = $true }
            @{ Kind = 'http'; Code = 503; Used = 0; Expected = $true }
            @{ Kind = 'http'; Code = 504; Used = 0; Expected = $true }
            @{ Kind = 'http'; Code = 529; Used = 0; Expected = $true }
            @{ Kind = 'http'; Code = 400; Used = 0; Expected = $false }
            @{ Kind = 'http'; Code = 401; Used = 0; Expected = $false }
            @{ Kind = 'http'; Code = 403; Used = 0; Expected = $false }
            @{ Kind = 'http'; Code = 404; Used = 0; Expected = $false }
            @{ Kind = 'http'; Code = 501; Used = 0; Expected = $false }
            @{ Kind = 'timeout'; Code = $null; Used = 0; Expected = $true }
            @{ Kind = 'timeout'; Code = $null; Used = 1; Expected = $false }
            @{ Kind = 'connection'; Code = $null; Used = 0; Expected = $true }
            @{ Kind = 'connection'; Code = $null; Used = 1; Expected = $false }
            @{ Kind = 'other'; Code = $null; Used = 0; Expected = $false }
        ) {
            $f = [pscustomobject]@{ Kind = $Kind; StatusCode = $Code; Reason = '' }
            script:Get-ModuleValue { param($f, $u) Test-AIRestFailureRetryable -Failure $f -NoResponseRetries $u } @($f, $Used) | Should -Be $Expected
        }
    }

    Context '§2 cascade link timeout' {

        It 'without -TimeoutSec, each link uses its own model''s default timeout' {
            $env:GROQ_API_KEY = 'groq-test-value'; $env:GEMINI_API_KEY = 'gemini-test-value'
            $primary = 'claude-haiku-4-5'; $fb1 = 'groq-openai-gpt-oss-20b'; $fb2 = 'gemini-2.5-flash'
            $defaults = script:Get-ModuleValue { param($a, $b, $c) @((Get-AIDefaultTimeoutSec -Model $a), (Get-AIDefaultTimeoutSec -Model $b), (Get-AIDefaultTimeoutSec -Model $c)) } @($primary, $fb1, $fb2)
            script:Set-Replies @{ 'api.anthropic.com' = @((script:New-HttpError 400)); 'api.groq.com' = @((script:New-HttpError 400)); 'generativelanguage' = @((script:New-GeminiOk)) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $primary; ApiKey = $script:Key; FallbackModels = @($fb1, $fb2) }
            $out.Result.Model | Should -BeExactly $fb2
            @($script:Calls | ForEach-Object { $_.TimeoutSec }) -join ',' | Should -BeExactly ($defaults -join ',')
        }

        It 'an explicit -TimeoutSec applies to every link' {
            $env:GROQ_API_KEY = 'groq-test-value'
            script:Set-Replies @{ 'api.anthropic.com' = @((script:New-HttpError 400)); 'api.groq.com' = @((script:New-ChatOk)) }
            script:Invoke-Call @{ Prompt = 'p'; Model = 'claude-haiku-4-5'; ApiKey = $script:Key; TimeoutSec = 77; FallbackModels = @('groq-openai-gpt-oss-20b') } | Out-Null
            @($script:Calls | ForEach-Object { $_.TimeoutSec }) -join ',' | Should -BeExactly '77,77'
        }

        It 'New-AICascadeLinkParams: TimeoutSec <In> for <Model> -> <Expected>' -ForEach @(
            @{ In = 0;  Model = 'gemini-2.5-flash'; Expected = 'default' }
            @{ In = 0;  Model = 'claude-haiku-4-5'; Expected = 'default' }
            @{ In = 42; Model = 'claude-haiku-4-5'; Expected = '42' }
        ) {
            $p = script:Get-ModuleValue { param($m, $t) New-AICascadeLinkParams -FbModel $m -FbKey 'k' -Prompt 'p' -TimeoutSec $t } @($Model, $In)
            $want = if ($Expected -eq 'default') { script:Get-ModuleValue { param($m) Get-AIDefaultTimeoutSec -Model $m } @($Model) } else { [int]$Expected }
            $p.TimeoutSec | Should -Be $want
        }
    }

    Context '§3 a 200 with no text' {

        It '<Name>: WARNs with the stop reason "<Reason>" and returns $null' -ForEach @(
            @{ Name = 'gemini MAX_TOKENS, no parts text'; Model = 'gemini-2.5-flash'; HostFrag = 'generativelanguage'; Reason = 'finishReason=MAX_TOKENS'
               Envelope = [pscustomobject]@{ candidates = @([pscustomobject]@{ finishReason = 'MAX_TOKENS'; content = [pscustomobject]@{ parts = @([pscustomobject]@{ text = '' }) } }) } }
            @{ Name = 'claude max_tokens, thinking only'; Model = 'claude-haiku-4-5'; HostFrag = 'api.anthropic.com'; Reason = 'stop_reason=max_tokens'
               Envelope = [pscustomobject]@{ content = @([pscustomobject]@{ type = 'thinking'; thinking = 'hmm' }); stop_reason = 'max_tokens' } }
            @{ Name = 'chat length, empty content'; Model = 'groq-openai-gpt-oss-120b'; HostFrag = 'api.groq.com'; Reason = 'finish_reason=length'
               Envelope = [pscustomobject]@{ choices = @([pscustomobject]@{ message = [pscustomobject]@{ content = '' }; finish_reason = 'length' }) } }
            @{ Name = 'chat content_filter'; Model = 'groq-openai-gpt-oss-120b'; HostFrag = 'api.groq.com'; Reason = 'finish_reason=content_filter'
               Envelope = [pscustomobject]@{ choices = @([pscustomobject]@{ message = [pscustomobject]@{ content = $null }; finish_reason = 'content_filter' }) } }
            @{ Name = 'chat whitespace-only text'; Model = 'groq-openai-gpt-oss-120b'; HostFrag = 'api.groq.com'; Reason = 'finish_reason=stop'
               Envelope = [pscustomobject]@{ choices = @([pscustomobject]@{ message = [pscustomobject]@{ content = "  `n " }; finish_reason = 'stop' }) } }
            @{ Name = 'openai incomplete'; Model = 'openai-gpt-4o'; HostFrag = 'api.openai.com'; Reason = 'status=incomplete, incomplete_details.reason=max_output_tokens'
               Envelope = [pscustomobject]@{ output = @([pscustomobject]@{ type = 'reasoning' }); status = 'incomplete'; incomplete_details = [pscustomobject]@{ reason = 'max_output_tokens' } } }
            @{ Name = 'claude HTML body'; Model = 'claude-haiku-4-5'; HostFrag = 'api.anthropic.com'; Reason = 'no stop reason in the response'
               Envelope = '<html><body>502 Bad Gateway</body></html>' }
        ) {
            $backend = script:Get-ModuleValue { param($m) $script:ModelRegistry[$m].Backend } @($Model)
            $name = script:Get-ModuleValue { param($b) $script:AIBackendProfiles[$b].DisplayName } @($backend)
            script:Set-Replies @{ $HostFrag = @(, $Envelope) }
            $logged = [System.Collections.Generic.List[string]]::new()
            $logger = { $logged.Add([string]$args[1]) }.GetNewClosure()
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $Model; ApiKey = $script:Key; FallbackModels = @(); CallLogger = $logger }
            $out.Result | Should -BeNullOrEmpty
            $out.Warnings -join "`n" | Should -BeExactly "$($name): response had no text (backend $backend, model $Model, $Reason). Returning `$null so a fallback can be tried."
            $logged -join ',' | Should -BeExactly '200' -Because 'the call itself succeeded at HTTP level'
            $script:Calls.Count | Should -Be 1 -Because 'an empty 200 is not retried'
        }

        It 'a cascade link with no text moves on to the next link' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'; $env:GEMINI_API_KEY = 'gemini-test-value'
            script:Set-Replies @{
                'api.groq.com'       = @((script:New-HttpError 400))
                'api.anthropic.com'  = @([pscustomobject]@{ content = @(); stop_reason = 'refusal' })
                'generativelanguage' = @((script:New-GeminiOk 'gemini text'))
            }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @('claude-haiku-4-5', 'gemini-2.5-flash') }
            $out.Result.Text | Should -BeExactly 'gemini text'
            $out.Warnings | Should -Contain 'Anthropic Claude: response had no text (backend claude, model claude-haiku-4-5, stop_reason=refusal). Returning $null so a fallback can be tried.'
        }

        It 'judgement call: a PRIMARY with no text returns $null without cascading (as the existing parser-rejected paths do)' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'
            script:Set-Replies @{ 'api.groq.com' = @((script:New-ChatOk '')); 'api.anthropic.com' = @((script:New-ClaudeOk 'unreached')) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @('claude-haiku-4-5') }
            $out.Result | Should -BeNullOrEmpty
            script:Get-Hosts | Should -BeExactly 'api.groq.com'
        }

        It 'a non-empty text is still a success (control)' {
            script:Set-Replies @{ 'api.groq.com' = @((script:New-ChatOk '0')) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @() }
            $out.Result.Text | Should -BeExactly '0'
            $out.Warnings | Should -BeNullOrEmpty
        }
    }

    Context '§4 failure paths warn, never Write-Host' {

        It 'no failure path writes to the host; every message is a capturable warning (<Name>)' -ForEach @(
            @{ Name = 'HTTP 502 exhausted'; Reply = 'h502' }
            @{ Name = 'timeout';            Reply = 'timeout' }
            @{ Name = 'no text';            Reply = 'empty' }
            @{ Name = 'malformed envelope'; Reply = 'malformed' }
        ) {
            # Suppress the [AI] config line (the one intended Write-Host) so only failure output is observed.
            script:Get-ModuleValue { param($m) $script:AIApiLoggedThisSession = $true; $script:AIApiLastModel = $m; $script:AIApiCorrelationId = ''; $script:AIApiLastCorrelationId = '' } @($script:Groq)
            $item = switch ($Reply) {
                'h502' { script:New-HttpError 502 } 'timeout' { script:New-RealTimeout }
                'empty' { script:New-ChatOk '' } 'malformed' { [pscustomobject]@{ error = 'bad' } }
            }
            script:Set-Replies @{ 'api.groq.com' = @(, $item) }
            $out = script:Invoke-Call @{ Prompt = 'p'; Model = $script:Groq; ApiKey = $script:Key; FallbackModels = @(); MaxRetries = 2; RetryDelays = @(0) }
            $out.Result | Should -BeNullOrEmpty
            $out.Warnings.Count | Should -BeGreaterThan 0
            $script:HostLines.Count | Should -Be 0
        }

        It 'statically: the only Write-Host on the Invoke-AIApi path is the [AI] config log' {
            $path = Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1'
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)
            $offenders = foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
                if ($fn.Name -in 'Get-AIMetadata', 'Write-AIApiConfigLog') { continue }   # Get-AIMetadata is not on Invoke-AIApi's path
                foreach ($c in $fn.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Write-Host' }, $true)) {
                    "$($fn.Name):$($c.Extent.StartLineNumber)"
                }
            }
            @($offenders) | Should -BeNullOrEmpty
        }
    }
}
