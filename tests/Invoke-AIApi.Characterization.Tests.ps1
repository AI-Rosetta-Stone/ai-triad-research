# Tag: enrichment (t/4135)
# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Module Pester

<#
.SYNOPSIS
    Characterization tests for Invoke-AIApi (t/4135 PR A), written BEFORE its decomposition refactor and
    required to pass unchanged after it.
.DESCRIPTION
    Every AI call in the product goes through Invoke-AIApi, so this suite pins CURRENT behaviour, bugs
    included, so the refactor (t/4135 PR B1/B2) can prove it changed nothing:

      1. Golden request snapshots, one file per backend in ai-models.json, at
         tests/fixtures/invoke-aiapi/request-<backend>.json. Each holds six cases (plain / JsonMode /
         JsonMode+ResponseSchema, each with and without -SystemInstruction): the Invoke-RestMethod
         parameter names, URI, method, content type, timeout, header names (values redacted) and the
         parsed request body.
      2. The retry matrix (Start-Sleep is mocked and every -Seconds value recorded).
      3. Failure reporting and the model cascade.
      4. Response-envelope parsing per backend.
      5. The CallLogger hook, including its third {Model, Backend, KeySource} argument (t/4088).
      6. Pre-existing bugs, each marked "# PINNED BUG (t/4078): <what>". They assert what the code does
         today, not what it should do; a fix updates the pin deliberately. t/4078 fixed the retry set
         (500/502/504, one timeout retry), the cascade timeout, empty-text success, the Azure actionable
         error and MaxRetries 0; those pins now assert the fixed behaviour ("Fixed by t/4078"). The pins
         that remain are out of t/4078's scope. New t/4078 tests live in Invoke-AIApi.RetryPolicy.Tests.ps1.

    NO LIVE CALL CAN HAPPEN: Invoke-RestMethod is mocked in AIEnrich for every test, and every AI key
    variable is cleared before each test (and restored after the file).

    Determinism (Sage #220): request bodies are plain @{} hashtables, so their key order is random per
    process. Bodies are compared PARSED, with keys sorted ordinally. The Claude arm also appends the
    ResponseSchema to the PROMPT TEXT via ConvertTo-Json of a hashtable, so that text's key order is
    random per process too; the golden stores the prompt with the schema JSON replaced by
    <SCHEMA_JSON> and the parsed schema alongside it.

    Redaction (TL condition 1): golden header values are redacted (a "Bearer " scheme is kept), and URI
    query parameters whose name looks secret are redacted (api-version is kept). The golden-secret scan
    sets a distinct sentinel in every key variable while goldens are generated and compared, and fails if
    any golden file contains a sentinel, or its first or last four characters, or any key value that was
    set in the environment when this file started (whole value, or its first or last eight characters).

    The ApiModelId in the URI and body is stored as {apiModelId}, so the goldens do not depend on which
    registered model is first for a backend in ai-models.json.

    Regenerate the goldens ONLY when a behaviour change is intended and reviewed: set
    $env:INVOKEAIAPI_REGEN_GOLDEN = '1' and run once.
#>

BeforeDiscovery {
    $script:RegistryPath = Join-Path $PSScriptRoot '..' 'ai-models.json'
    $script:Registry = Get-Content -Raw -Path $script:RegistryPath | ConvertFrom-Json
    # One registered model per backend, chosen at test time: the first in ai-models.json order.
    $script:BackendCases = @(foreach ($b in $script:Registry.backends) {
        $first = @($script:Registry.models | Where-Object { $_.backend -eq $b.id })[0]
        $apiId = if ($first.PSObject.Properties['apiModelId']) { $first.apiModelId } else { $first.id }
        @{ Backend = $b.id; ModelId = $first.id; ApiModelId = $apiId }
    })
    $hints = @{
        gemini = 'GEMINI_API_KEY or AI_API_KEY'; claude = 'ANTHROPIC_API_KEY / CLAUDE_API_KEY'; groq = 'GROQ_API_KEY'
        openai = 'OPENAI_API_KEY'; azure = 'AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT'; zai = 'ZAI_API_KEY'
        moonshot = 'MOONSHOT_API_KEY'; xai = 'XAI_API_KEY'; deepseek = 'DEEPSEEK_API_KEY'
    }
    # Every keyed backend (a new one without a hint here fails the test, by design).
    $script:MissingKeyCases = @($script:BackendCases | Where-Object { $_.Backend -ne 'ollama' } | ForEach-Object {
        @{ Backend = $_.Backend; ModelId = $_.ModelId; Hint = $hints[$_.Backend] }
    })
}

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..' 'scripts' 'AIEnrich.psm1') -Force -WarningAction SilentlyContinue

    $script:D = [string][char]0x2014       # em dash, as used in Invoke-AIApi's messages
    $script:Arrow = [string][char]0x2192   # right arrow, in the "Model changed" host line
    $script:GoldenDir = Join-Path $PSScriptRoot 'fixtures' 'invoke-aiapi'
    $script:Utf8 = [System.Text.UTF8Encoding]::new($false)
    $script:Regen = ($env:INVOKEAIAPI_REGEN_GOLDEN -eq '1')

    $script:KeyVars = @('GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY',
        'AZURE_OPENAI_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'AI_API_KEY')
    $script:OtherVars = @('AZURE_OPENAI_ENDPOINT', 'OLLAMA_HOST')
    $script:SavedEnv = @{}
    foreach ($v in $script:KeyVars + $script:OtherVars) { $script:SavedEnv[$v] = [Environment]::GetEnvironmentVariable($v) }
    # Real key values present when the file started: the golden scan also proves none of them leaked.
    $script:RealKeyValues = @($script:KeyVars | ForEach-Object { $script:SavedEnv[$_] } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    $script:FakeAzureEndpoint = 'https://t4135-fake-resource.openai.azure.com/'
    $script:TestKey = 'unit-test-key-t4135'

    # Distinct sentinels, one per key variable, each with a unique 4-char prefix and suffix.
    $script:Sentinels = [ordered]@{
        GEMINI_API_KEY       = 'Gx7q-t4135-sentinel-gemini-v9Kp'
        ANTHROPIC_API_KEY    = 'Ah3w-t4135-sentinel-anthropic-m2Zr'
        CLAUDE_API_KEY       = 'Cl5j-t4135-sentinel-claude-b8Qe'
        GROQ_API_KEY         = 'Gr2u-t4135-sentinel-groq-k4Wn'
        OPENAI_API_KEY       = 'Op9d-t4135-sentinel-openai-x3Lf'
        AZURE_OPENAI_API_KEY = 'Az6m-t4135-sentinel-azure-p1Hs'
        ZAI_API_KEY          = 'Zi4c-t4135-sentinel-zai-q7Ty'
        MOONSHOT_API_KEY     = 'Mo8n-t4135-sentinel-moonshot-j5Rg'
        XAI_API_KEY          = 'Xa1b-t4135-sentinel-xai-w6Dv'
        DEEPSEEK_API_KEY     = 'Dp3k-t4135-sentinel-deepseek-n2Mc'
        AI_API_KEY           = 'Ai7f-t4135-sentinel-fallback-h4Bx'
    }

    if (-not ('T4135FakeWebResponse' -as [type])) {
        Add-Type -TypeDefinition @'
public class T4135FakeWebResponse {
    public System.Net.HttpStatusCode StatusCode;
    public string Payload;
    public int Reads;
    public T4135FakeWebResponse(int code, string payload) { StatusCode = (System.Net.HttpStatusCode)code; Payload = payload; }
    public System.IO.Stream GetResponseStream() { Reads++; return new System.IO.MemoryStream(System.Text.Encoding.UTF8.GetBytes(Payload)); }
}
public class T4135WebException : System.Exception {
    public T4135FakeWebResponse Response;
    public T4135WebException(string message, T4135FakeWebResponse response) : base(message) { Response = response; }
}
'@
    }

    function script:Clear-KeyEnv {
        foreach ($v in $script:KeyVars + @('OLLAMA_HOST')) { [Environment]::SetEnvironmentVariable($v, $null) }
        [Environment]::SetEnvironmentVariable('AZURE_OPENAI_ENDPOINT', $script:FakeAzureEndpoint)
    }
    script:Clear-KeyEnv

    # An HttpClient-shaped failure, as Invoke-RestMethod throws it in PS7.
    function script:New-HttpError([int]$Code, [string]$Message = '', [string]$Body = '') {
        if (-not $Message) { $Message = "Response status code does not indicate success: $Code (fake)." }
        # [Enum]::ToObject, because a PowerShell cast refuses codes the enum does not name (529).
        $resp = [System.Net.Http.HttpResponseMessage]::new([Enum]::ToObject([System.Net.HttpStatusCode], $Code))
        $ex = [Microsoft.PowerShell.Commands.HttpResponseException]::new($Message, $resp)
        $er = [System.Management.Automation.ErrorRecord]::new($ex, 'WebCmdletWebResponseException',
            [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
        if ($Body) { $er.ErrorDetails = [System.Management.Automation.ErrorDetails]::new($Body) }
        $er
    }

    # The Invoke-RestMethod mock replies with the queued items in order; the last one repeats.
    function script:Set-RestSequence([object[]]$Items) {
        $q = [System.Collections.Generic.Queue[object]]::new()
        foreach ($i in $Items) { $q.Enqueue($i) }
        $script:RestQueue = $q
        $script:Responder = {
            param($Call)
            $next = if ($script:RestQueue.Count -gt 1) { $script:RestQueue.Dequeue() } else { $script:RestQueue.Peek() }
            if ($next -is [System.Management.Automation.ErrorRecord] -or $next -is [System.Exception]) { throw $next }
            $next
        }
    }

    function script:New-OkEnvelope([string]$Backend, [string]$Text = 'hello', [switch]$Truncated, [switch]$NoUsage) {
        switch ($Backend) {
            'gemini' {
                $o = [ordered]@{ candidates = @([pscustomobject]@{
                        content      = [pscustomobject]@{ parts = @([pscustomobject]@{ text = $Text }) }
                        finishReason = if ($Truncated) { 'MAX_TOKENS' } else { 'STOP' } }) }
                if (-not $NoUsage) { $o.usageMetadata = [pscustomobject]@{ promptTokenCount = 11; candidatesTokenCount = 22; totalTokenCount = 33; cachedContentTokenCount = 4 } }
            }
            'claude' {
                $o = [ordered]@{ content = @([pscustomobject]@{ type = 'text'; text = $Text }); stop_reason = if ($Truncated) { 'max_tokens' } else { 'end_turn' } }
                if (-not $NoUsage) { $o.usage = [pscustomobject]@{ input_tokens = 11; output_tokens = 22 } }
            }
            'openai' {
                $o = [ordered]@{ output = @([pscustomobject]@{ type = 'message'; content = @([pscustomobject]@{ type = 'output_text'; text = $Text }) })
                                 status = if ($Truncated) { 'incomplete' } else { 'completed' } }
                if (-not $NoUsage) { $o.usage = [pscustomobject]@{ input_tokens = 11; output_tokens = 22; total_tokens = 33 } }
            }
            default {
                $o = [ordered]@{ choices = @([pscustomobject]@{ message = [pscustomobject]@{ content = $Text }; finish_reason = if ($Truncated) { 'length' } else { 'stop' } }) }
                if (-not $NoUsage) { $o.usage = [pscustomobject]@{ prompt_tokens = 11; completion_tokens = 22; total_tokens = 33 } }
            }
        }
        [pscustomobject]$o
    }

    # Calls Invoke-AIApi and returns its result and the warning MESSAGES it emitted.
    function script:Invoke-CharacterizedCall([hashtable]$Params) {
        $w = $null
        $r = Invoke-AIApi @Params -WarningVariable w -WarningAction SilentlyContinue
        [pscustomobject]@{ Result = $r; Warnings = @($w | ForEach-Object { $_.Message }) }
    }

    function script:Get-ModuleValue([scriptblock]$Block, [object[]]$Arguments = @()) { & (Get-Module AIEnrich) $Block @Arguments }

    # Recursively sorts dictionary keys (ordinal); arrays keep their order.
    function script:ConvertTo-Canonical($o) {
        if ($null -eq $o) { return $null }
        if ($o -is [System.Collections.IDictionary]) {
            $keys = [string[]]@($o.Keys)
            [Array]::Sort($keys, [StringComparer]::Ordinal)
            $r = [ordered]@{}
            foreach ($k in $keys) { $r[$k] = script:ConvertTo-Canonical $o[$k] }
            return $r
        }
        if ($o -is [System.Collections.IList] -and $o -isnot [string]) {
            $l = [System.Collections.Generic.List[object]]::new()
            foreach ($i in $o) { $l.Add((script:ConvertTo-Canonical $i)) }
            return , $l
        }
        return $o
    }
    function script:ConvertTo-CanonicalJson($o) { ((script:ConvertTo-Canonical $o) | ConvertTo-Json -Depth 100) -replace "`r`n", "`n" }

    $script:ClaudeSchemaMarker = "`n`nYou MUST respond with a JSON object conforming to this schema:`n"
    $script:SecretQueryName = '(?i)(key|token|secret|sig|auth|password)'

    # One captured Invoke-RestMethod call -> the redacted, normalized golden record.
    function script:ConvertTo-RequestRecord([hashtable]$Call, [string]$ApiModelId) {
        $paramNames = [string[]]@($Call.Keys); [Array]::Sort($paramNames, [StringComparer]::Ordinal)

        $uri = [string]$Call.Uri
        $base, $query = $uri -split '\?', 2
        if ($query) {
            $pairs = foreach ($pair in ($query -split '&')) {
                $name, $value = $pair -split '=', 2
                if ($name -match $script:SecretQueryName -and $name -ne 'api-version') { "$name=<REDACTED>" } else { $pair }
            }
            $uri = $base + '?' + ($pairs -join '&')
        }
        $uri = $uri.Replace($ApiModelId, '{apiModelId}')

        $headers = [ordered]@{}
        $headerNames = @()
        if ($Call.ContainsKey('Headers')) {
            $headerNames = [string[]]@($Call.Headers.Keys); [Array]::Sort($headerNames, [StringComparer]::Ordinal)
            foreach ($h in $headerNames) {
                $v = [string]$Call.Headers[$h]
                $headers[$h] = if ($h -eq 'anthropic-version') { $v } elseif ($v -match '^Bearer\s') { 'Bearer <REDACTED>' } else { '<REDACTED>' }
            }
        }

        $bodyType = $Call.Body.GetType().FullName
        $bodyText = $script:Utf8.GetString([byte[]]$Call.Body)
        $body = $bodyText | ConvertFrom-Json -AsHashtable -Depth 100
        if ($body.ContainsKey('model') -and $body['model'] -ceq $ApiModelId) { $body['model'] = '{apiModelId}' }
        $promptSchema = $null
        if ($body.ContainsKey('messages')) {
            foreach ($m in $body['messages']) {
                $c = [string]$m['content']
                $at = $c.IndexOf($script:ClaudeSchemaMarker, [StringComparison]::Ordinal)
                if ($at -ge 0) {
                    $promptSchema = $c.Substring($at + $script:ClaudeSchemaMarker.Length) | ConvertFrom-Json -AsHashtable -Depth 100
                    $m['content'] = $c.Substring(0, $at + $script:ClaudeSchemaMarker.Length) + '<SCHEMA_JSON>'
                }
            }
        }

        $rec = [ordered]@{
            parameterNames = $paramNames
            uri            = $uri
            method         = [string]$Call.Method
            contentType    = [string]$Call.ContentType
            timeoutSec     = $Call.TimeoutSec
            errorAction    = [string]$Call.ErrorAction
            headerNames    = $headerNames
            headers        = $headers
            bodyType       = $bodyType
            body           = $body
        }
        if ($null -ne $promptSchema) { $rec['promptSchema'] = $promptSchema }
        $rec
    }

    # Scans text for every secret, and for its first and last $Edge characters. Returns the hits.
    function script:Find-SecretFragments([string]$Text, [string[]]$Secrets, [int]$Edge = 4) {
        foreach ($s in $Secrets) {
            if ([string]::IsNullOrEmpty($s)) { continue }
            $needles = @($s)
            if ($s.Length -ge 2 * $Edge) { $needles += $s.Substring(0, $Edge), $s.Substring($s.Length - $Edge) }
            foreach ($n in $needles) { if ($Text.Contains($n)) { "'$n' (from a $($s.Length)-char secret)" } }
        }
    }

    $script:GoldenPrompt = "Summarize: caf$([char]0xE9) $($script:D) na$([char]0xEF)ve $([char]0x6771)$([char]0x4EAC). Line two."
    $script:GoldenSystem = 'You are a careful policy analyst.'
    $script:GoldenSchema = @{
        type                 = 'object'
        additionalProperties = $false
        required             = @('answer', 'confidence')
        properties           = @{
            answer     = @{ type = 'string'; description = 'The answer' }
            confidence = @{ type = 'number' }
            tags       = @{ type = 'array'; items = @{ type = 'string'; enum = @('a', 'b') } }
            detail     = @{ type = 'object'; required = @('note'); properties = @{ note = @{ type = 'string'; nullable = $true } } }
        }
    }
}

AfterAll {
    foreach ($v in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($v, $script:SavedEnv[$v]) }
}

Describe 'Invoke-AIApi characterization (t/4135)' -Tag 'enrichment' {

    BeforeEach {
        script:Clear-KeyEnv
        $script:RestCalls = [System.Collections.Generic.List[hashtable]]::new()
        $script:Sleeps = [System.Collections.Generic.List[double]]::new()
        $script:HostLines = [System.Collections.Generic.List[object]]::new()
        script:Set-RestSequence @([pscustomobject]@{ unexpected = 'no response queued' })

        Mock Invoke-RestMethod -ModuleName AIEnrich -MockWith {
            $call = @{}
            foreach ($k in $PesterBoundParameters.Keys) { $call[$k] = $PesterBoundParameters[$k] }
            if ($call.ContainsKey('Headers')) { $call['Headers'] = $call['Headers'].Clone() }
            # Newer PS7 builds bind -TimeoutSec to its canonical name ConnectionTimeoutSeconds (TimeoutSec is an
            # alias); record it under the name Invoke-AIApi passes so the goldens are pwsh-version independent.
            if ($call.ContainsKey('ConnectionTimeoutSeconds')) { $call['TimeoutSec'] = $call['ConnectionTimeoutSeconds']; $call.Remove('ConnectionTimeoutSeconds') }
            $script:RestCalls.Add($call)
            & $script:Responder $call
        }
        Mock Invoke-WebRequest -ModuleName AIEnrich -MockWith { throw 't/4135: Invoke-AIApi must not call Invoke-WebRequest' }
        Mock Start-Sleep -ModuleName AIEnrich -MockWith { $script:Sleeps.Add([double]$Seconds) }
        Mock Write-Host -ModuleName AIEnrich -MockWith { $script:HostLines.Add([pscustomobject]@{ Text = [string]$Object; Color = [string]$ForegroundColor }) }
    }

    # ── 1. Golden request snapshots ─────────────────────────────────────────────────────────────
    Context 'golden request snapshots per backend' {

        BeforeEach {
            foreach ($k in $script:Sentinels.Keys) { [Environment]::SetEnvironmentVariable($k, $script:Sentinels[$k]) }
        }

        It 'every ai-models.json backend has a golden matching today''s request (<Backend>, model <ModelId>)' -ForEach $script:BackendCases {
            $variants = [ordered]@{
                'plain'                = @{}
                'plain+system'         = @{ SystemInstruction = $script:GoldenSystem }
                'json'                 = @{ JsonMode = $true }
                'json+system'          = @{ JsonMode = $true; SystemInstruction = $script:GoldenSystem }
                'json+schema'          = @{ JsonMode = $true; ResponseSchema = $script:GoldenSchema }
                'json+schema+system'   = @{ JsonMode = $true; ResponseSchema = $script:GoldenSchema; SystemInstruction = $script:GoldenSystem }
            }
            $cases = [ordered]@{}
            foreach ($name in $variants.Keys) {
                $script:RestCalls.Clear()
                script:Set-RestSequence @((script:New-OkEnvelope $Backend))
                $p = @{ Prompt = $script:GoldenPrompt; Model = $ModelId; Temperature = 0.3; MaxTokens = 777; TimeoutSec = 77; FallbackModels = @() }
                foreach ($k in $variants[$name].Keys) { $p[$k] = $variants[$name][$k] }
                $out = script:Invoke-CharacterizedCall $p

                $out.Result | Should -Not -BeNullOrEmpty -Because "$name must succeed against the mocked envelope"
                $out.Warnings | Should -BeNullOrEmpty -Because "$name emits no warning"
                $script:RestCalls.Count | Should -Be 1
                $raw = $script:RestCalls[0]
                if ($Backend -ne 'ollama') {
                    # The request really carried the sentinel key, so the golden scan below is meaningful.
                    ((@($raw.Headers.Values) -join ' ').Contains([string](script:Get-ModuleValue { param($b) Resolve-AIApiKey -Backend $b } @($Backend)))) |
                        Should -BeTrue -Because 'the key travels in a header'
                }
                $cases[$name] = script:ConvertTo-RequestRecord -Call $raw -ApiModelId $ApiModelId
            }
            $actual = script:ConvertTo-CanonicalJson ([ordered]@{ backend = $Backend; cases = $cases })

            $golden = Join-Path $script:GoldenDir "request-$Backend.json"
            if ($script:Regen) {
                New-Item -ItemType Directory -Path $script:GoldenDir -Force | Out-Null
                [System.IO.File]::WriteAllText($golden, $actual + "`n", $script:Utf8)
            }
            Test-Path -LiteralPath $golden | Should -BeTrue -Because "backend '$Backend' is in ai-models.json, so it needs a golden (set INVOKEAIAPI_REGEN_GOLDEN=1 once, then review)"
            $expected = ([System.IO.File]::ReadAllText($golden) -replace "`r`n", "`n").TrimEnd("`n")
            $actual | Should -BeExactly $expected
        }

        It '-ResponseSchema alone implies -JsonMode (same request as -JsonMode -ResponseSchema)' {
            script:Set-RestSequence @((script:New-OkEnvelope 'groq'))
            $base = @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; TimeoutSec = 9; FallbackModels = @(); ResponseSchema = $script:GoldenSchema }
            script:Invoke-CharacterizedCall $base | Out-Null
            $withSwitch = $base.Clone(); $withSwitch['JsonMode'] = $true
            script:Invoke-CharacterizedCall $withSwitch | Out-Null
            $a = script:ConvertTo-CanonicalJson (script:ConvertTo-RequestRecord $script:RestCalls[0] 'x')
            $b = script:ConvertTo-CanonicalJson (script:ConvertTo-RequestRecord $script:RestCalls[1] 'x')
            $a | Should -BeExactly $b
        }

        It 'no golden file contains any key: sentinels, their 4-char prefix/suffix, or a key set when the run began' {
            $files = @(Get-ChildItem -LiteralPath $script:GoldenDir -File -Recurse)
            $files.Count | Should -BeGreaterOrEqual @($script:BackendCases).Count
            $secrets = @($script:Sentinels.Values)
            $hits = foreach ($f in $files) {
                $text = $script:Utf8.GetString([System.IO.File]::ReadAllBytes($f.FullName))
                foreach ($h in (script:Find-SecretFragments $text $secrets)) { "$($f.Name): $h" }
                # Real keys: the whole value and its 8-char ends (4-char ends of a real key, e.g. 'sk-a', would
                # false-positive on ordinary text).
                foreach ($h in (script:Find-SecretFragments $text $script:RealKeyValues -Edge 8)) { "$($f.Name): real key $h" }
            }
            @($hits) | Should -BeNullOrEmpty
            # Control: the scanner does detect a planted sentinel.
            @(script:Find-SecretFragments "x $($script:Sentinels.GROQ_API_KEY) y" $secrets).Count | Should -BeGreaterThan 0
            @(script:Find-SecretFragments 'zz Gr2u zz' $secrets).Count | Should -BeGreaterThan 0
        }
    }

    Context 'request details outside the goldens' {

        It 'OLLAMA_HOST overrides the Ollama base URL (trailing slash trimmed) and Ollama sends no Headers' {
            $env:OLLAMA_HOST = 'http://gpu-box:11434/'
            script:Set-RestSequence @((script:New-OkEnvelope 'ollama'))
            script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'ollama-gemma4-e4b-it-q4-k-m'; FallbackModels = @() } | Out-Null
            $script:RestCalls[0].Uri | Should -BeExactly 'http://gpu-box:11434/v1/chat/completions'
            $script:RestCalls[0].ContainsKey('Headers') | Should -BeFalse
        }

        It 'the default timeout comes from Get-AIDefaultTimeoutSec when -TimeoutSec is omitted' {
            script:Set-RestSequence @((script:New-OkEnvelope 'claude'))
            script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'claude-haiku-4-5'; ApiKey = $script:TestKey; FallbackModels = @() } | Out-Null
            $expected = script:Get-ModuleValue { Get-AIDefaultTimeoutSec -Model 'claude-haiku-4-5' }
            $script:RestCalls[0].TimeoutSec | Should -Be $expected
        }

        It 'an unknown model warns, lists the registry, and returns $null with no request' {
            $bogus = 'no-such-model-t4135'
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = $bogus }
            $out.Result | Should -BeNullOrEmpty
            $out.Warnings.Count | Should -Be 1
            $out.Warnings[0] | Should -BeLike "Unknown model '$bogus'. Valid models: *"
            $script:RestCalls.Count | Should -Be 0
        }

        It 'a missing key for <Backend> warns with its env hint and returns $null with no request' -ForEach $script:MissingKeyCases {
            $Hint | Should -Not -BeNullOrEmpty -Because "backend '$Backend' needs its expected env hint in this file"
            $model = $ModelId
            $logged = [System.Collections.Generic.List[object]]::new()
            $logger = { $logged.Add(@($args)) }.GetNewClosure()
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = $model; CallLogger = $logger }
            $out.Result | Should -BeNullOrEmpty
            $out.Warnings -join "`n" | Should -BeExactly "No API key found for $Backend backend. Set $Hint."
            $script:RestCalls.Count | Should -Be 0
            $logged.Count | Should -Be 0 -Because 'the CallLogger only fires once a request was attempted'
        }

        It 'Azure with no AZURE_OPENAI_ENDPOINT throws the actionable Goal/Error/Location/Resolve error (t/4078)' {
            # Fixed by t/4078 (was pinned: New-ActionableError is AITriad-private, so this threw
            # CommandNotFoundException). AIEnrich now builds the error itself. No request is sent.
            $env:AZURE_OPENAI_ENDPOINT = $null
            $azureModel = script:Get-ModuleValue { @($script:ModelRegistry.Keys | Where-Object { $script:ModelRegistry[$_].Backend -eq 'azure' } | Sort-Object)[0] }
            $azureModel | Should -Not -BeNullOrEmpty
            $err = $null
            try { Invoke-AIApi -Prompt 'p' -Model $azureModel -ApiKey $script:TestKey -FallbackModels @() -WarningAction SilentlyContinue }
            catch { $err = $_ }
            $err | Should -Not -BeNullOrEmpty
            $err.Exception | Should -Not -BeOfType [System.Management.Automation.CommandNotFoundException]
            $err.FullyQualifiedErrorId | Should -BeLike 'ActionableError*'
            ($err.Exception.Message -replace "`r`n", "`n") | Should -BeExactly (@(
                ''
                '  Goal:     Call Azure OpenAI API'
                '  Error:    AZURE_OPENAI_ENDPOINT environment variable is not set'
                '  Location: Invoke-AIApi (azure)'
                '  Resolve:'
                '   1. Set $env:AZURE_OPENAI_ENDPOINT to your Azure OpenAI resource URL'
                '   2. Example: https://my-resource.openai.azure.com'
            ) -join "`n")
            $err.TargetObject.Goal | Should -BeExactly 'Call Azure OpenAI API'
            @($err.TargetObject.NextSteps).Count | Should -Be 2
            $script:RestCalls.Count | Should -Be 0
        }

        It 'the pre-flight token check warns past 80% of the backend context window, and -SkipTokenCheck silences it' {
            $limit = script:Get-ModuleValue { $script:ContextWindows['deepseek'] }
            $len = [int][Math]::Floor($limit * 0.8 * 3.2) + 64
            $prompt = 'x' * $len
            $est = [Math]::Ceiling($len / 3.2)
            script:Set-RestSequence @((script:New-OkEnvelope 'deepseek'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = $prompt; Model = 'deepseek-deepseek-v4-flash'; ApiKey = $script:TestKey; FallbackModels = @() }
            $out.Warnings -join "`n" | Should -BeExactly "deepseek-deepseek-v4-flash: prompt is ~$est tokens (est.), which exceeds 80% of the $limit-token context window. Consider chunking or using a model with a larger context."
            $out.Result.Text | Should -BeExactly 'hello' -Because 'the check only warns'
            $out = script:Invoke-CharacterizedCall @{ Prompt = $prompt; Model = 'deepseek-deepseek-v4-flash'; ApiKey = $script:TestKey; FallbackModels = @(); SkipTokenCheck = $true }
            $out.Warnings | Should -BeNullOrEmpty
        }

        It 'the [AI] host lines: first call, same model (silent), model change, correlation change' {
            script:Get-ModuleValue { $script:AIApiLoggedThisSession = $false; $script:AIApiLastModel = $null; $script:AIApiCorrelationId = ''; $script:AIApiLastCorrelationId = '' }
            try {
                script:Set-RestSequence @((script:New-OkEnvelope 'groq'))
                $g = @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @() }
                $c = @{ Prompt = 'p'; Model = 'claude-haiku-4-5'; ApiKey = $script:TestKey; FallbackModels = @() }
                script:Invoke-CharacterizedCall $g | Out-Null
                script:Invoke-CharacterizedCall $g | Out-Null
                script:Set-RestSequence @((script:New-OkEnvelope 'claude'))
                script:Invoke-CharacterizedCall $c | Out-Null
                Set-AIApiCorrelationId 'doc-x'
                script:Invoke-CharacterizedCall $c | Out-Null
            }
            finally { Set-AIApiCorrelationId '' }
            $lines = @($script:HostLines | ForEach-Object { "$($_.Color)|$($_.Text)" })
            $lines -join "`n" | Should -BeExactly (@(
                'DarkCyan|[AI] Backend: groq | Model: groq-openai-gpt-oss-120b | Key source: explicit parameter'
                "Yellow|[AI] Model changed: groq-openai-gpt-oss-120b $($script:Arrow) claude-haiku-4-5 | Backend: claude | Key source: explicit parameter"
                'DarkCyan|[AI] doc-x | Backend: claude | Model: claude-haiku-4-5 | Key source: explicit parameter'
            ) -join "`n")
        }

        It 'PINNED BUG: a ResponseSchema nested past ConvertTo-Json -Depth 10 is silently stringified' {
            # PINNED BUG (t/4078): request bodies use ConvertTo-Json -Depth 10, so a deep ResponseSchema is cut at
            # depth 10: the leaf becomes the string "System.Collections.Hashtable" and only ConvertTo-Json's own
            # warning says so. The request is still sent.
            $s = @{ type = 'string' }
            for ($i = 0; $i -lt 10; $i++) { $s = @{ type = 'object'; properties = @{ n = $s } } }
            script:Set-RestSequence @((script:New-OkEnvelope 'groq'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @(); ResponseSchema = $s }
            $out.Warnings -join "`n" | Should -BeExactly 'Resulting JSON is truncated as serialization has exceeded the set depth of 10.'
            $out.Result.Text | Should -BeExactly 'hello'
            $body = $script:Utf8.GetString($script:RestCalls[0].Body) | ConvertFrom-Json -AsHashtable
            $schema = $body.response_format.json_schema.schema
            $schema.properties.n.properties.n.properties.n.properties.n | Should -BeExactly 'System.Collections.Hashtable'
        }
    }

    # ── 2. Retry matrix ─────────────────────────────────────────────────────────────────────────
    Context 'retry matrix' {

        It 'HTTP <Code> with MaxRetries <MaxRetries> and RetryDelays <Delays>: <Calls> request(s), sleeps <Sleeps>' -ForEach @(
            @{ Code = 429; MaxRetries = 5; Delays = $null;  Calls = 5; Sleeps = @(120, 120, 120, 120) }    # 429 clamped up to 120s
            @{ Code = 429; MaxRetries = 3; Delays = @(200); Calls = 3; Sleeps = @(200, 200) }              # above the clamp: kept
            @{ Code = 429; MaxRetries = 3; Delays = @(5, 15); Calls = 3; Sleeps = @(120, 120) }
            @{ Code = 429; MaxRetries = 1; Delays = $null;  Calls = 1; Sleeps = @() }
            @{ Code = 503; MaxRetries = 5; Delays = $null;  Calls = 5; Sleeps = @(15, 45, 90, 120) }
            @{ Code = 503; MaxRetries = 7; Delays = $null;  Calls = 7; Sleeps = @(15, 45, 90, 120, 120, 120) }   # past the array: last value repeats
            @{ Code = 503; MaxRetries = 2; Delays = @(5, 15); Calls = 2; Sleeps = @(5) }                         # the cascade's settings
            @{ Code = 529; MaxRetries = 3; Delays = @(1, 2); Calls = 3; Sleeps = @(1, 2) }
            @{ Code = 529; MaxRetries = 6; Delays = @(1, 2); Calls = 6; Sleeps = @(1, 2, 2, 2, 2) }
            # t/4078 §1 (was pinned: never retried): 500, 502 and 504 are retried on the same schedule and MaxRetries.
            @{ Code = 500; MaxRetries = 5; Delays = $null;  Calls = 5; Sleeps = @(15, 45, 90, 120) }
            @{ Code = 502; MaxRetries = 5; Delays = $null;  Calls = 5; Sleeps = @(15, 45, 90, 120) }
            @{ Code = 504; MaxRetries = 5; Delays = $null;  Calls = 5; Sleeps = @(15, 45, 90, 120) }
            @{ Code = 502; MaxRetries = 2; Delays = @(5, 15); Calls = 2; Sleeps = @(5) }                         # the cascade's settings
            # Other 4xx are never retried.
            @{ Code = 401; MaxRetries = 5; Delays = $null;  Calls = 1; Sleeps = @() }
            @{ Code = 403; MaxRetries = 5; Delays = $null;  Calls = 1; Sleeps = @() }
            @{ Code = 400; MaxRetries = 5; Delays = $null;  Calls = 1; Sleeps = @() }
            @{ Code = 404; MaxRetries = 5; Delays = $null;  Calls = 1; Sleeps = @() }
        ) {
            script:Set-RestSequence @((script:New-HttpError $Code "fake failure $Code"))
            $p = @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @(); MaxRetries = $MaxRetries }
            if ($Delays) { $p['RetryDelays'] = [int[]]$Delays }
            $out = script:Invoke-CharacterizedCall $p

            $out.Result | Should -BeNullOrEmpty
            $script:RestCalls.Count | Should -Be $Calls
            ($script:Sleeps -join ',') | Should -BeExactly ($Sleeps -join ',')
            $retryLines = for ($i = 0; $i -lt $Sleeps.Count; $i++) { "groq: HTTP $Code $($script:D) retrying in $($Sleeps[$i])s (attempt $($i + 1)/$MaxRetries)" }
            @($out.Warnings | Where-Object { $_ -like '*retrying in*' }) -join "`n" | Should -BeExactly (@($retryLines) -join "`n")
            $out.Warnings | Should -Contain "groq: API call failed (HTTP $Code) $($script:D) fake failure $Code"
        }

        It 'a timeout (exception with no .Response) is retried once, then fails "(timeout after Ns)" (t/4078)' {
            # Fixed by t/4078 §1 (was pinned: not retried, failure line "(HTTP )"). A timeout gets ONE retry,
            # not MaxRetries, and the failure line names the timeout.
            script:Set-RestSequence @([System.TimeoutException]::new('The operation has timed out.'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @(); TimeoutSec = 33 }
            $out.Result | Should -BeNullOrEmpty
            $script:RestCalls.Count | Should -Be 2
            ($script:Sleeps -join ',') | Should -BeExactly '15'
            $out.Warnings -join "`n" | Should -BeExactly (@(
                "groq: timeout $($script:D) retrying in 15s (attempt 1/5)"
                "groq: API call failed (timeout after 33s) $($script:D) The operation has timed out."
            ) -join "`n")
        }

        It 'recovers after transient errors: 503 then 429 then success' {
            script:Set-RestSequence @((script:New-HttpError 503), (script:New-HttpError 429), (script:New-OkEnvelope 'groq' -Text 'third time'))
            $logged = [System.Collections.Generic.List[object]]::new()
            $logger = { $logged.Add(@($args)) }.GetNewClosure()
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @(); CallLogger = $logger }
            $out.Result.Text | Should -BeExactly 'third time'
            $script:RestCalls.Count | Should -Be 3
            ($script:Sleeps -join ',') | Should -BeExactly '15,120'
            $out.Warnings -join "`n" | Should -BeExactly (@(
                "groq: HTTP 503 $($script:D) retrying in 15s (attempt 1/5)"
                "groq: HTTP 429 $($script:D) retrying in 120s (attempt 2/5)"
            ) -join "`n")
            $logged.Count | Should -Be 1
            $logged[0][0] | Should -Be 2
            $logged[0][1] | Should -BeExactly '200'
        }

        It 'every attempt re-sends the same URI, headers, timeout and body bytes' {
            script:Set-RestSequence @((script:New-HttpError 503), (script:New-OkEnvelope 'groq'))
            script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @() } | Out-Null
            $a = script:ConvertTo-CanonicalJson (script:ConvertTo-RequestRecord $script:RestCalls[0] 'x')
            $b = script:ConvertTo-CanonicalJson (script:ConvertTo-RequestRecord $script:RestCalls[1] 'x')
            $a | Should -BeExactly $b
            [Convert]::ToBase64String($script:RestCalls[0].Body) | Should -BeExactly ([Convert]::ToBase64String($script:RestCalls[1].Body))
        }

        It 'MaxRetries outside 1..10 is rejected at the parameter, before any request or log (t/4078)' -ForEach @(@{ N = 0 }, @{ N = -1 }, @{ N = 11 }) {
            # Fixed by t/4078 (was pinned: MaxRetries 0 sent no request and failed "(HTTP ?) — " with no message).
            $logged = [System.Collections.Generic.List[object]]::new()
            $logger = { $logged.Add(@($args)) }.GetNewClosure()
            $err = $null
            try { Invoke-AIApi -Prompt 'p' -Model 'groq-openai-gpt-oss-120b' -ApiKey $script:TestKey -FallbackModels @() -MaxRetries $N -CallLogger $logger -WarningAction SilentlyContinue }
            catch { $err = $_ }
            $err.FullyQualifiedErrorId | Should -BeLike 'ParameterArgumentValidationError*'
            $err.Exception.Message | Should -BeLike "*parameter 'MaxRetries'*"
            $script:RestCalls.Count | Should -Be 0
            $logged.Count | Should -Be 0
        }
    }

    # ── 3. Failure reporting and cascade ────────────────────────────────────────────────────────
    Context 'failure reporting' {

        It 'HTTP <Code> -> failure line plus hint "<Hint>"' -ForEach @(
            @{ Code = 400; Hint = '' }
            @{ Code = 401; Hint = 'Check your API key {D} it may be invalid or expired.' }
            @{ Code = 403; Hint = 'Access denied {D} verify your API key has the required permissions.' }
            @{ Code = 429; Hint = 'Rate limit exceeded {D} wait a moment and try again.' }
            @{ Code = 500; Hint = 'Server error {D} the API may be temporarily unavailable.' }
            @{ Code = 502; Hint = 'Server error {D} the API may be temporarily unavailable.' }
            @{ Code = 503; Hint = 'Server error {D} the API may be temporarily unavailable.' }
            @{ Code = 504; Hint = '' }
            @{ Code = 529; Hint = '' }
        ) {
            script:Set-RestSequence @((script:New-HttpError $Code "boom $Code"))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'claude-haiku-4-5'; ApiKey = $script:TestKey; FallbackModels = @(); MaxRetries = 1 }
            $expected = @("claude: API call failed (HTTP $Code) $($script:D) boom $Code")
            if ($Hint) { $expected += 'claude: ' + $Hint.Replace('{D}', $script:D) }
            $out.Warnings -join "`n" | Should -BeExactly ($expected -join "`n")
        }

        It 'logs the ErrorDetails.Message body (scrubbed) after the hint' {
            script:Set-RestSequence @((script:New-HttpError 400 'bad request' '{"error":{"message":"model not found"}}'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @() }
            $out.Warnings -join "`n" | Should -BeExactly (@(
                "groq: API call failed (HTTP 400) $($script:D) bad request"
                'groq: Response body: {"error":{"message":"model not found"}}'
            ) -join "`n")
        }

        It 'falls back to the WebRequest-style GetResponseStream() body when there is no ErrorDetails' {
            $resp = [T4135FakeWebResponse]::new(502, 'upstream exploded')
            script:Set-RestSequence @([T4135WebException]::new('bad gateway', $resp))
            # MaxRetries 1: a 502 is retried since t/4078, and this test is about the body, not the retries.
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @(); MaxRetries = 1 }
            $out.Warnings -join "`n" | Should -BeExactly (@(
                "groq: API call failed (HTTP 502) $($script:D) bad gateway"
                "groq: Server error $($script:D) the API may be temporarily unavailable."
                'groq: Response body: upstream exploded'
            ) -join "`n")
            $resp.Reads | Should -Be 1
        }

        It 'prefers ErrorDetails.Message over the response stream when both exist' {
            $resp = [T4135FakeWebResponse]::new(400, 'stream body')
            $er = [System.Management.Automation.ErrorRecord]::new([T4135WebException]::new('bad', $resp), 'X',
                [System.Management.Automation.ErrorCategory]::InvalidOperation, $null)
            $er.ErrorDetails = [System.Management.Automation.ErrorDetails]::new('details body')
            script:Set-RestSequence @($er)
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @() }
            $out.Warnings | Should -Contain 'groq: Response body: details body'
            $out.Warnings | Should -Not -Contain 'groq: Response body: stream body'
            $resp.Reads | Should -Be 0
        }

        It 'a whitespace-only error body is not logged; a long body is capped at 1000 chars' {
            script:Set-RestSequence @((script:New-HttpError 400 'm' '   '))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @() }
            @($out.Warnings | Where-Object { $_ -like '*Response body*' }).Count | Should -Be 0

            script:Set-RestSequence @((script:New-HttpError 400 'm' ('y' * 1500)))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @() }
            $line = @($out.Warnings | Where-Object { $_ -like '*Response body*' })[0]
            $line | Should -BeExactly ('groq: Response body: ' + ('y' * 1000) + [char]0x2026 + '[truncated]')
        }

        It 'TL condition 2: a key echoed by the exception message and the error body is redacted, no 4-char fragment survives' {
            $key = 'Qz7Xk9Vw2Jm4Pq8Rt6Yb'   # not a known key shape, so only the literal -Secret pass can redact it
            script:Set-RestSequence @((script:New-HttpError 401 "Unauthorized: key $key rejected" "{`"error`":`"invalid key $key`",`"echo`":`"$key`"}"))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $key; FallbackModels = @() }
            $all = $out.Warnings -join "`n"
            $all | Should -BeExactly (@(
                "groq: API call failed (HTTP 401) $($script:D) Unauthorized: key [REDACTED] rejected"
                "groq: Check your API key $($script:D) it may be invalid or expired."
                'groq: Response body: {"error":"invalid key [REDACTED]","echo":"[REDACTED]"}'
            ) -join "`n")
            $fragments = for ($i = 0; $i -le $key.Length - 4; $i++) { $key.Substring($i, 4) }
            foreach ($f in $fragments) { $all.Contains($f) | Should -BeFalse -Because "fragment '$f' of the key must not reach a warning" }
        }

        It 'PINNED BUG: a $null response with no error throws under Set-StrictMode -Version Latest' {
            # PINNED BUG (t/4078): when Invoke-RestMethod returns $null (an empty body) there is no error record, so
            # $LastError is $null and the failure path's $LastError.Exception.Message throws under StrictMode
            # instead of warning. Without StrictMode it warns "(HTTP ?) — " and returns $null (next test).
            script:Set-RestSequence @($null)
            $msg = script:Get-ModuleValue {
                param($k)
                Set-StrictMode -Version Latest
                try { Invoke-AIApi -Prompt 'p' -Model 'groq-openai-gpt-oss-120b' -ApiKey $k -FallbackModels @() -WarningAction SilentlyContinue; 'no throw' }
                catch { $_.Exception.Message }
            } @($script:TestKey)
            $msg | Should -BeExactly "The property 'Exception' cannot be found on this object. Verify that the property exists."
        }

        It 'a $null response with no error (no StrictMode) warns "(HTTP ?)" and still cascades' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'
            $script:Responder = { param($Call) if ($Call.Uri -like '*anthropic*') { script:New-OkEnvelope 'claude' -Text 'from fallback' } else { $null } }
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @('claude-haiku-4-5') }
            $out.Result.Text | Should -BeExactly 'from fallback'
            $out.Warnings -join "`n" | Should -BeExactly (@(
                "groq: API call failed (HTTP ?) $($script:D) "
                'Cascade: falling back to claude-haiku-4-5 (claude)'
            ) -join "`n")
        }
    }

    Context 'model cascade' {

        BeforeEach {
            $script:ByHost = @{}   # host fragment -> queue of replies
            $script:Responder = {
                param($Call)
                foreach ($h in $script:ByHost.Keys) {
                    if ($Call.Uri -like "*$h*") {
                        $q = $script:ByHost[$h]
                        $next = if ($q.Count -gt 1) { $q.Dequeue() } else { $q.Peek() }
                        if ($next -is [System.Management.Automation.ErrorRecord] -or $next -is [System.Exception]) { throw $next }
                        return $next
                    }
                }
                throw "t/4135: no reply configured for $($Call.Uri)"
            }
            function script:Set-HostReplies([string]$HostFragment, [object[]]$Items) {
                $q = [System.Collections.Generic.Queue[object]]::new(); foreach ($i in $Items) { $q.Enqueue($i) }
                $script:ByHost[$HostFragment] = $q
            }
        }

        It 'tries explicit -FallbackModels in order; the first non-null result wins and later links are not called' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'; $env:GEMINI_API_KEY = 'gemini-test-value'
            script:Set-HostReplies 'api.groq.com' @((script:New-HttpError 500 'groq down'))
            script:Set-HostReplies 'api.anthropic.com' @((script:New-HttpError 500 'claude down'))
            script:Set-HostReplies 'generativelanguage' @((script:New-OkEnvelope 'gemini' -Text 'gemini answered'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; MaxRetries = 1
                FallbackModels = @('claude-haiku-4-5', 'gemini-2.5-flash', 'groq-openai-gpt-oss-20b') }
            $out.Result.Text | Should -BeExactly 'gemini answered'
            $out.Result.Model | Should -BeExactly 'gemini-2.5-flash'
            $out.Result.Backend | Should -BeExactly 'gemini'
            # t/4078: the claude link's 500 is retried (its MaxRetries 2) BEFORE the cascade moves to gemini.
            @($script:RestCalls | ForEach-Object { ([uri]$_.Uri).Host }) -join ',' | Should -BeExactly 'api.groq.com,api.anthropic.com,api.anthropic.com,generativelanguage.googleapis.com'
            $out.Warnings -join "`n" | Should -BeExactly (@(
                "groq: API call failed (HTTP 500) $($script:D) groq down"
                "groq: Server error $($script:D) the API may be temporarily unavailable."
                'Cascade: falling back to claude-haiku-4-5 (claude)'
                "claude: HTTP 500 $($script:D) retrying in 5s (attempt 1/2)"
                "claude: API call failed (HTTP 500) $($script:D) claude down"
                "claude: Server error $($script:D) the API may be temporarily unavailable."
                'Cascade: falling back to gemini-2.5-flash (gemini)'
            ) -join "`n")
        }

        It 'uses $script:FallbackChains when -FallbackModels is omitted, and -FallbackModels @() disables it' {
            $primary = 'groq-openai-gpt-oss-120b'
            $saved = script:Get-ModuleValue { param($m) if ($script:FallbackChains.ContainsKey($m)) { , @($script:FallbackChains[$m]) } else { $null } } @($primary)
            try {
                script:Get-ModuleValue { param($m) $script:FallbackChains[$m] = @('claude-haiku-4-5') } @($primary)
                $env:ANTHROPIC_API_KEY = 'anthropic-test-value'
                script:Set-HostReplies 'api.groq.com' @((script:New-HttpError 400 'nope'))
                script:Set-HostReplies 'api.anthropic.com' @((script:New-OkEnvelope 'claude' -Text 'chain answered'))
                $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = $primary; ApiKey = $script:TestKey }
                $out.Result.Text | Should -BeExactly 'chain answered'
                $out.Warnings | Should -Contain 'Cascade: falling back to claude-haiku-4-5 (claude)'

                $script:RestCalls.Clear()
                $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = $primary; ApiKey = $script:TestKey; FallbackModels = @() }
                $out.Result | Should -BeNullOrEmpty
                $script:RestCalls.Count | Should -Be 1
            }
            finally {
                script:Get-ModuleValue { param($m, $c) if ($null -eq $c) { $script:FallbackChains.Remove($m) } else { $script:FallbackChains[$m] = @($c) } } @($primary, $saved)
            }
        }

        It 'skips an unregistered fallback model silently' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'
            $bogus = 'no-such-model-t4135'
            script:Set-HostReplies 'api.groq.com' @((script:New-HttpError 400 'nope'))
            script:Set-HostReplies 'api.anthropic.com' @((script:New-OkEnvelope 'claude'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @($bogus, 'claude-haiku-4-5') }
            $out.Result.Backend | Should -BeExactly 'claude'
            @($out.Warnings | Where-Object { $_ -like "*$bogus*" }).Count | Should -Be 0
        }

        It 'on HTTP <Code> skips same-backend fallbacks (silently) and tries other backends' -ForEach @(@{ Code = 401 }, @{ Code = 403 }) {
            $env:GROQ_API_KEY = 'groq-test-value'; $env:ANTHROPIC_API_KEY = 'anthropic-test-value'
            script:Set-HostReplies 'api.groq.com' @((script:New-HttpError $Code 'auth'))
            script:Set-HostReplies 'api.anthropic.com' @((script:New-OkEnvelope 'claude'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; FallbackModels = @('groq-openai-gpt-oss-20b', 'claude-haiku-4-5') }
            $out.Result.Backend | Should -BeExactly 'claude'
            @($script:RestCalls | Where-Object { $_.Uri -like '*groq*' }).Count | Should -Be 1
            @($out.Warnings | Where-Object { $_ -like 'Cascade:*' }) -join "`n" | Should -BeExactly 'Cascade: falling back to claude-haiku-4-5 (claude)'
        }

        It 'on HTTP 500 a same-backend fallback IS tried' {
            $env:GROQ_API_KEY = 'groq-test-value'
            script:Set-HostReplies 'api.groq.com' @((script:New-HttpError 500 'x'), (script:New-OkEnvelope 'groq' -Text 'second groq'))
            # MaxRetries 1: since t/4078 a 500 is retried, which would let the PRIMARY take the second reply.
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; FallbackModels = @('groq-openai-gpt-oss-20b'); MaxRetries = 1 }
            $out.Result.Text | Should -BeExactly 'second groq'
            $out.Result.Model | Should -BeExactly 'groq-openai-gpt-oss-20b'
        }

        It 'skips a fallback whose backend has no key, silently' {
            $env:GEMINI_API_KEY = 'gemini-test-value'
            script:Set-HostReplies 'api.groq.com' @((script:New-HttpError 400 'x'))
            script:Set-HostReplies 'generativelanguage' @((script:New-OkEnvelope 'gemini'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @('claude-haiku-4-5', 'gemini-2.5-flash') }
            $out.Result.Backend | Should -BeExactly 'gemini'
            @($script:RestCalls | Where-Object { $_.Uri -like '*anthropic*' }).Count | Should -Be 0
            @($out.Warnings | Where-Object { $_ -like 'Cascade:*' }) -join "`n" | Should -BeExactly 'Cascade: falling back to gemini-2.5-flash (gemini)'
        }

        It 'returns $null when every fallback fails' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'
            script:Set-HostReplies 'api.groq.com' @((script:New-HttpError 400 'x'))
            script:Set-HostReplies 'api.anthropic.com' @((script:New-HttpError 400 'y'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @('claude-haiku-4-5') }
            $out.Result | Should -BeNullOrEmpty
            $script:RestCalls.Count | Should -Be 2
        }

        It 'passes the recursive call exactly these parameters (full set: system, JSON, schema, logger)' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'; $env:GEMINI_API_KEY = 'gemini-test-value'
            script:Set-HostReplies 'api.groq.com' @((script:New-HttpError 500 'x'))
            $inner = [System.Collections.Generic.List[hashtable]]::new()
            $sentinelResult = [pscustomobject]@{ Text = 'from mocked inner call' }
            Mock Invoke-AIApi -ModuleName AIEnrich -MockWith {
                $copy = @{}; foreach ($k in $PesterBoundParameters.Keys) { $copy[$k] = $PesterBoundParameters[$k] }
                $inner.Add($copy)
                if ($Model -eq 'gemini-2.5-flash') { $sentinelResult } else { $null }
            }
            $logger = { }
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'the prompt'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey
                SystemInstruction = 'sys'; JsonMode = $true; ResponseSchema = $script:GoldenSchema; Temperature = 0.7; MaxTokens = 333
                TimeoutSec = 55; MaxRetries = 4; RetryDelays = @(1, 1); CallLogger = $logger
                FallbackModels = @('claude-haiku-4-5', 'gemini-2.5-flash', 'groq-openai-gpt-oss-20b') }
            [object]::ReferenceEquals($out.Result, $sentinelResult) | Should -BeTrue
            $inner.Count | Should -Be 2 -Because 'a $null result moves on; the first non-null result is returned'
            $p = $inner[0]
            $names = [string[]]@($p.Keys); [Array]::Sort($names, [StringComparer]::Ordinal)
            $names -join ',' | Should -BeExactly 'ApiKey,CallLogger,FallbackModels,JsonMode,MaxRetries,MaxTokens,Model,Prompt,ResponseSchema,RetryDelays,SkipTokenCheck,SystemInstruction,Temperature,TimeoutSec'
            $p.Model | Should -BeExactly 'claude-haiku-4-5'
            $p.Prompt | Should -BeExactly 'the prompt'
            $p.ApiKey | Should -BeExactly 'anthropic-test-value' -Because 'the fallback key is resolved from the fallback backend''s env var'
            $p.SystemInstruction | Should -BeExactly 'sys'
            [bool]$p.JsonMode | Should -BeTrue
            [object]::ReferenceEquals($p.ResponseSchema, $script:GoldenSchema) | Should -BeTrue
            $p.Temperature | Should -Be 0.7
            $p.MaxTokens | Should -Be 333
            # t/4078 §2: an EXPLICIT caller -TimeoutSec still applies to every link.
            $p.TimeoutSec | Should -Be 55
            $p.MaxRetries | Should -Be 2
            (@($p.RetryDelays) -join ',') | Should -BeExactly '5,15'
            @($p.FallbackModels).Count | Should -Be 0
            [bool]$p.SkipTokenCheck | Should -BeTrue
            [object]::ReferenceEquals($p.CallLogger, $logger) | Should -BeTrue
            $inner[1].Model | Should -BeExactly 'gemini-2.5-flash'
            $inner[1].ApiKey | Should -BeExactly 'gemini-test-value'
        }

        It 'passes the recursive call only the core parameters when no system/JSON/schema/logger was given' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'
            script:Set-HostReplies 'api.groq.com' @((script:New-HttpError 500 'x'))
            $inner = [System.Collections.Generic.List[hashtable]]::new()
            Mock Invoke-AIApi -ModuleName AIEnrich -MockWith {
                $copy = @{}; foreach ($k in $PesterBoundParameters.Keys) { $copy[$k] = $PesterBoundParameters[$k] }
                $inner.Add($copy); $null
            }
            script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @('claude-haiku-4-5') } | Out-Null
            $inner.Count | Should -Be 1
            $names = [string[]]@($inner[0].Keys); [Array]::Sort($names, [StringComparer]::Ordinal)
            $names -join ',' | Should -BeExactly 'ApiKey,CallLogger,FallbackModels,MaxRetries,MaxTokens,Model,Prompt,RetryDelays,SkipTokenCheck,Temperature,TimeoutSec'
            $inner[0].CallLogger | Should -BeNullOrEmpty
            # t/4078 §2 (was pinned: the primary's default): with no -TimeoutSec the link gets ITS OWN default.
            $inner[0].TimeoutSec | Should -Be (script:Get-ModuleValue { Get-AIDefaultTimeoutSec -Model 'claude-haiku-4-5' })
            $inner[0].TimeoutSec | Should -Not -Be (script:Get-ModuleValue { Get-AIDefaultTimeoutSec -Model 'groq-openai-gpt-oss-120b' })
        }

        It 'end to end, the fallback request uses its own model''s default timeout and the cascade retry settings (t/4078)' {
            # Fixed by t/4078 §2 (was pinned: the fallback reused the primary's resolved TimeoutSec).
            $primary = 'claude-haiku-4-5'; $fallback = 'groq-openai-gpt-oss-20b'
            $primaryDefault = script:Get-ModuleValue { param($m) Get-AIDefaultTimeoutSec -Model $m } @($primary)
            $fallbackDefault = script:Get-ModuleValue { param($m) Get-AIDefaultTimeoutSec -Model $m } @($fallback)
            $primaryDefault | Should -Not -Be $fallbackDefault -Because 'the pin needs two different defaults'
            $env:GROQ_API_KEY = 'groq-test-value'
            script:Set-HostReplies 'api.anthropic.com' @((script:New-HttpError 400 'x'))
            script:Set-HostReplies 'api.groq.com' @((script:New-HttpError 503 'busy'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = $primary; ApiKey = $script:TestKey; FallbackModels = @($fallback) }
            $out.Result | Should -BeNullOrEmpty
            $groqCalls = @($script:RestCalls | Where-Object { $_.Uri -like '*groq*' })
            $groqCalls.Count | Should -Be 2 -Because 'the cascade link uses MaxRetries 2'
            $groqCalls[0].TimeoutSec | Should -Be $fallbackDefault
            $groqCalls[1].TimeoutSec | Should -Be $fallbackDefault
            @($script:RestCalls | Where-Object { $_.Uri -like '*anthropic*' })[0].TimeoutSec | Should -Be $primaryDefault
            ($script:Sleeps -join ',') | Should -BeExactly '5' -Because 'the cascade link uses RetryDelays 5,15'
            $out.Warnings | Should -Contain "groq: HTTP 503 $($script:D) retrying in 5s (attempt 1/2)"
        }

        It 'a Gemini blocked finishReason returns $null without cascading' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'
            $blocked = [pscustomobject]@{ candidates = @([pscustomobject]@{ finishReason = 'SAFETY' }) }
            script:Set-HostReplies 'generativelanguage' @($blocked)
            script:Set-HostReplies 'api.anthropic.com' @((script:New-OkEnvelope 'claude'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'gemini-2.5-flash'; ApiKey = $script:TestKey; FallbackModels = @('claude-haiku-4-5') }
            $out.Result | Should -BeNullOrEmpty
            $script:RestCalls.Count | Should -Be 1
        }

        It 'a malformed chat envelope returns $null without cascading' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'
            script:Set-HostReplies 'api.groq.com' @([pscustomobject]@{ error = 'bad' })
            script:Set-HostReplies 'api.anthropic.com' @((script:New-OkEnvelope 'claude'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @('claude-haiku-4-5') }
            $out.Result | Should -BeNullOrEmpty
            $script:RestCalls.Count | Should -Be 1
        }
    }

    # ── 4. Envelope parsing ─────────────────────────────────────────────────────────────────────
    Context 'response envelope parsing per backend' {

        BeforeAll {
            $script:DisplayName = @{ gemini = 'Gemini'; claude = 'Claude'; groq = 'Groq'; zai = 'z.ai'; moonshot = 'Moonshot'; xai = 'xAI'
                                     deepseek = 'DeepSeek'; ollama = 'Ollama'; azure = 'Azure OpenAI'; openai = 'OpenAI' }
            $script:Expected = @{ gemini = 'candidates[].content.parts[].text'; claude = 'content[].text'; openai = 'output[].content[].text' }
            function script:Invoke-Envelope([string]$ModelId, $Envelope) {
                script:Set-RestSequence @(, $Envelope)
                script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = $ModelId; ApiKey = $script:TestKey; FallbackModels = @() }
            }
        }

        It '<Backend>: a normal envelope returns {Text, Backend, Model, Truncated, Usage, RawResponse}' -ForEach $script:BackendCases {
            $env = script:New-OkEnvelope $Backend -Text 'the text'
            $out = script:Invoke-Envelope $ModelId $env
            $out.Warnings | Should -BeNullOrEmpty
            $r = $out.Result
            ($r.PSObject.Properties.Name -join ',') | Should -BeExactly 'Text,Backend,Model,Truncated,Usage,RawResponse'
            $r.Text | Should -BeExactly 'the text'
            $r.Backend | Should -BeExactly $Backend
            $r.Model | Should -BeExactly $ModelId
            $r.Truncated | Should -BeOfType [bool]
            $r.Truncated | Should -BeFalse
            [object]::ReferenceEquals($r.RawResponse, $env) | Should -BeTrue
            if ($Backend -eq 'gemini') {
                ($r.Usage.PSObject.Properties.Name -join ',') | Should -BeExactly 'InputTokens,OutputTokens,CachedTokens,TotalTokens'
                "$($r.Usage.InputTokens),$($r.Usage.OutputTokens),$($r.Usage.CachedTokens),$($r.Usage.TotalTokens)" | Should -BeExactly '11,22,4,33'
            }
            else {
                ($r.Usage.PSObject.Properties.Name -join ',') | Should -BeExactly 'InputTokens,OutputTokens,TotalTokens'
                "$($r.Usage.InputTokens),$($r.Usage.OutputTokens),$($r.Usage.TotalTokens)" | Should -BeExactly '11,22,33'
            }
            foreach ($n in $r.Usage.PSObject.Properties.Name) { $r.Usage.$n | Should -BeOfType [int] }
        }

        It '<Backend>: a truncated envelope sets Truncated and warns' -ForEach $script:BackendCases {
            $out = script:Invoke-Envelope $ModelId (script:New-OkEnvelope $Backend -Text 'part' -Truncated)
            $out.Result.Truncated | Should -BeTrue
            $out.Result.Text | Should -BeExactly 'part'
            $out.Warnings -join "`n" | Should -BeExactly "$($Backend): response was truncated (max_tokens reached). Output may be incomplete."
        }

        It '<Backend>: a missing usage block gives Usage $null and no warning' -ForEach $script:BackendCases {
            $out = script:Invoke-Envelope $ModelId (script:New-OkEnvelope $Backend -NoUsage)
            $out.Result.Text | Should -BeExactly 'hello'
            $out.Result.Usage | Should -BeNullOrEmpty
            $out.Warnings | Should -BeNullOrEmpty
        }

        It '<Backend>: a malformed envelope (object without the expected keys)' -ForEach $script:BackendCases {
            $bad = [pscustomobject][ordered]@{ error = 'bad'; id = 'x1' }
            $out = script:Invoke-Envelope $ModelId $bad
            if ($Backend -in 'claude', 'openai') {
                # t/4078 §3 (was pinned: a SUCCESS with Text $null and no warning, because these parsers pipe a
                # missing property through Where-Object, which never throws). Now: no text -> WARN + $null.
                $name = script:Get-ModuleValue { param($b) $script:AIBackendProfiles[$b].DisplayName } @($Backend)
                $out.Result | Should -BeNullOrEmpty
                $out.Warnings -join "`n" | Should -BeExactly "$($name): response had no text (backend $Backend, model $ModelId, no stop reason in the response). Returning `$null so a fallback can be tried."
            }
            else {
                $expect = if ($script:Expected.ContainsKey($Backend)) { $script:Expected[$Backend] } else { 'choices[].message.content' }
                $out.Result | Should -BeNullOrEmpty
                $out.Warnings -join "`n" | Should -BeExactly "$($script:DisplayName[$Backend]): unexpected response shape (top-level keys: error, id). Expected $expect"
            }
        }

        It '<Backend>: a string body (e.g. an HTML error page)' -ForEach $script:BackendCases {
            $out = script:Invoke-Envelope $ModelId '<html>oops</html>'
            if ($Backend -in 'claude', 'openai') {
                # t/4078 §3 (was pinned: as above, a non-JSON body was a success with Text $null).
                $name = script:Get-ModuleValue { param($b) $script:AIBackendProfiles[$b].DisplayName } @($Backend)
                $out.Result | Should -BeNullOrEmpty
                $out.Warnings -join "`n" | Should -BeExactly "$($name): response had no text (backend $Backend, model $ModelId, no stop reason in the response). Returning `$null so a fallback can be tried."
            }
            else {
                $expect = if ($script:Expected.ContainsKey($Backend)) { $script:Expected[$Backend] } else { 'choices[].message.content' }
                $out.Result | Should -BeNullOrEmpty
                $out.Warnings -join "`n" | Should -BeExactly "$($script:DisplayName[$Backend]): unexpected response shape (top-level keys: Length). Expected $expect"
            }
        }

        It '<Backend> WARNs "response had no text" with the stop reason and returns $null when the text field is missing (t/4078)' -ForEach $script:BackendCases {
            # Fixed by t/4078 §3 (was pinned: a well-formed envelope with no text was a success, Text $null, no WARN).
            $env = switch ($Backend) {
                'gemini' { [pscustomobject]@{ candidates = @([pscustomobject]@{ content = [pscustomobject]@{ parts = @([pscustomobject]@{ functionCall = 'f' }) }; finishReason = 'STOP' }) } }
                'claude' { [pscustomobject]@{ content = @([pscustomobject]@{ type = 'tool_use'; id = 't1' }); stop_reason = 'tool_use' } }
                'openai' { [pscustomobject]@{ output = @([pscustomobject]@{ type = 'reasoning' }); status = 'completed' } }
                default  { [pscustomobject]@{ choices = @([pscustomobject]@{ message = [pscustomobject]@{ content = $null }; finish_reason = 'stop' }) } }
            }
            $reason = switch ($Backend) { 'gemini' { 'finishReason=STOP' } 'claude' { 'stop_reason=tool_use' } 'openai' { 'status=completed' } default { 'finish_reason=stop' } }
            $name = script:Get-ModuleValue { param($b) $script:AIBackendProfiles[$b].DisplayName } @($Backend)
            $out = script:Invoke-Envelope $ModelId $env
            $out.Result | Should -BeNullOrEmpty
            $out.Warnings -join "`n" | Should -BeExactly "$($name): response had no text (backend $Backend, model $ModelId, $reason). Returning `$null so a fallback can be tried."
        }

        It 'Gemini: a blocking finishReason (<Reason>) returns $null with a warning' -ForEach @(@{ Reason = 'SAFETY' }, @{ Reason = 'RECITATION' }, @{ Reason = 'OTHER' }) {
            $env = [pscustomobject]@{ candidates = @([pscustomobject]@{ finishReason = $Reason; content = [pscustomobject]@{ parts = @([pscustomobject]@{ text = 'x' }) } }) }
            $out = script:Invoke-Envelope 'gemini-2.5-flash' $env
            $out.Result | Should -BeNullOrEmpty
            $out.Warnings -join "`n" | Should -BeExactly "Gemini: generation stopped with finishReason=$Reason (content may have been blocked)"
        }

        It 'Gemini: no finishReason is treated as complete; no cachedContentTokenCount gives CachedTokens 0' {
            $env = [pscustomobject]@{
                candidates    = @([pscustomobject]@{ content = [pscustomobject]@{ parts = @([pscustomobject]@{ text = 'ok' }) } })
                usageMetadata = [pscustomobject]@{ promptTokenCount = 1; candidatesTokenCount = 2; totalTokenCount = 3 } }
            $out = script:Invoke-Envelope 'gemini-2.5-flash' $env
            $out.Result.Text | Should -BeExactly 'ok'
            $out.Result.Truncated | Should -BeFalse
            $out.Result.Usage.CachedTokens | Should -Be 0
        }

        It 'PINNED BUG: Gemini reads only parts[0].text, so later parts are dropped' {
            # PINNED BUG (t/4078): a multi-part candidate (e.g. a thinking model's thought part first) returns only
            # the first part's text.
            $env = [pscustomobject]@{ candidates = @([pscustomobject]@{ finishReason = 'STOP'; content = [pscustomobject]@{ parts = @(
                [pscustomobject]@{ text = 'thinking...'; thought = $true }, [pscustomobject]@{ text = 'the answer' }) } }) }
            $out = script:Invoke-Envelope 'gemini-2.5-flash' $env
            $out.Result.Text | Should -BeExactly 'thinking...'
        }

        It 'Claude: picks the first text part, skipping non-text parts; TotalTokens is input + output' {
            $env = [pscustomobject]@{ stop_reason = 'end_turn'
                content = @([pscustomobject]@{ type = 'thinking'; thinking = 'hmm' }, [pscustomobject]@{ type = 'text'; text = 'first' }, [pscustomobject]@{ type = 'text'; text = 'second' })
                usage = [pscustomobject]@{ input_tokens = 5; output_tokens = 7 } }
            $out = script:Invoke-Envelope 'claude-haiku-4-5' $env
            $out.Result.Text | Should -BeExactly 'first'
            $out.Result.Usage.TotalTokens | Should -Be 12
        }

        It 'OpenAI: picks the first message output and its first output_text part' {
            $env = [pscustomobject]@{ status = 'completed'
                output = @([pscustomobject]@{ type = 'reasoning' },
                           [pscustomobject]@{ type = 'message'; content = @([pscustomobject]@{ type = 'refusal'; refusal = 'no' }, [pscustomobject]@{ type = 'output_text'; text = 'yes' }) },
                           [pscustomobject]@{ type = 'message'; content = @([pscustomobject]@{ type = 'output_text'; text = 'later' }) }) }
            $out = script:Invoke-Envelope 'openai-gpt-4o' $env
            $out.Result.Text | Should -BeExactly 'yes'
        }
    }

    # ── 5. CallLogger ───────────────────────────────────────────────────────────────────────────
    Context 'CallLogger hook' {

        BeforeEach {
            $script:Logged = [System.Collections.Generic.List[object]]::new()
            $logged = $script:Logged
            $script:Logger = { $logged.Add(@($args)) }.GetNewClosure()
        }

        It 'outcome <Name>: called once with (attempt <Attempt>, status ''<Status>'')' -ForEach @(
            @{ Name = 'success';            Reply = 'ok';       MaxRetries = 5; Attempt = 0; Status = '200' }
            @{ Name = 'HTTP 400';           Reply = 400;        MaxRetries = 5; Attempt = 0; Status = '400' }
            @{ Name = '429 exhausted';      Reply = 429;        MaxRetries = 3; Attempt = 2; Status = '429' }
            @{ Name = '503 exhausted';      Reply = 503;        MaxRetries = 2; Attempt = 1; Status = '503' }
            # t/4078: a timeout is retried once, so the logged attempt is 1 (was 0). The old 'no attempt'
            # row (MaxRetries 0, status '?') is gone: MaxRetries 0 is now rejected at the parameter.
            @{ Name = 'timeout';            Reply = 'timeout';  MaxRetries = 5; Attempt = 1; Status = 'error' }
            @{ Name = 'timeout, 1 attempt'; Reply = 'timeout';  MaxRetries = 1; Attempt = 0; Status = 'error' }
            @{ Name = '502 exhausted';      Reply = 502;        MaxRetries = 3; Attempt = 2; Status = '502' }
        ) {
            $item = switch ($Reply) { 'ok' { script:New-OkEnvelope 'groq' } 'timeout' { [System.TimeoutException]::new('t') } default { script:New-HttpError $Reply } }
            script:Set-RestSequence @(, $item)
            script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @(); MaxRetries = $MaxRetries; CallLogger = $script:Logger } | Out-Null
            $script:Logged.Count | Should -Be 1
            $a = $script:Logged[0]
            $a.Count | Should -Be 3
            $a[0] | Should -Be $Attempt
            $a[1] | Should -BeOfType [string]
            $a[1] | Should -BeExactly $Status
            ($a[2].PSObject.Properties.Name -join ',') | Should -BeExactly 'Model,Backend,KeySource'
            $a[2].Model | Should -BeExactly 'groq-openai-gpt-oss-120b'
            $a[2].Backend | Should -BeExactly 'groq'
            $a[2].KeySource | Should -BeExactly 'explicit'
        }

        It 'context KeySource: env:GROQ_API_KEY for an env key; none for keyless Ollama' {
            $env:GROQ_API_KEY = 'groq-test-value'
            script:Set-RestSequence @((script:New-OkEnvelope 'groq'))
            script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; FallbackModels = @(); CallLogger = $script:Logger } | Out-Null
            script:Set-RestSequence @((script:New-OkEnvelope 'ollama'))
            script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'ollama-gemma4-e4b-it-q4-k-m'; FallbackModels = @(); CallLogger = $script:Logger } | Out-Null
            $script:Logged[0][2].KeySource | Should -BeExactly 'env:GROQ_API_KEY'
            $script:Logged[1][2].KeySource | Should -BeExactly 'none'
            $script:Logged[1][2].Backend | Should -BeExactly 'ollama'
        }

        It 'a logger that throws is non-fatal: one warning, and the result is still returned' {
            script:Set-RestSequence @((script:New-OkEnvelope 'groq' -Text 'still here'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @(); CallLogger = { throw 'logger exploded' } }
            $out.Result.Text | Should -BeExactly 'still here'
            $out.Warnings -join "`n" | Should -BeExactly 'Invoke-AIApi: call-logger threw (logger exploded); continuing (audit log is non-fatal).'
        }

        It 'a two-argument logger still works (the third argument is ignored)' {
            $seen = [System.Collections.Generic.List[object]]::new()
            $two = { param($Attempt, $Status) $seen.Add("$Attempt/$Status") }.GetNewClosure()
            script:Set-RestSequence @((script:New-OkEnvelope 'groq'))
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @(); CallLogger = $two }
            $out.Warnings | Should -BeNullOrEmpty
            $seen -join ';' | Should -BeExactly '0/200'
        }

        It 'is forwarded through the cascade: one entry per link, each with its own model, backend and key source' {
            $env:ANTHROPIC_API_KEY = 'anthropic-test-value'
            $script:Responder = { param($Call) if ($Call.Uri -like '*anthropic*') { script:New-OkEnvelope 'claude' } else { throw (script:New-HttpError 500 'x') } }
            # MaxRetries 1: since t/4078 a 500 is retried; one primary attempt keeps the logged attempt at 0.
            script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'groq-openai-gpt-oss-120b'; ApiKey = $script:TestKey; FallbackModels = @('claude-haiku-4-5'); CallLogger = $script:Logger; MaxRetries = 1 } | Out-Null
            $rows = @($script:Logged | ForEach-Object { "$($_[0])|$($_[1])|$($_[2].Model)|$($_[2].Backend)|$($_[2].KeySource)" })
            $rows -join "`n" | Should -BeExactly (@(
                '0|500|groq-openai-gpt-oss-120b|groq|explicit'
                '0|200|claude-haiku-4-5|claude|env:ANTHROPIC_API_KEY'
            ) -join "`n")
        }

        It 'fires once (status 200) on the Gemini blocked path, before the envelope is parsed' {
            script:Set-RestSequence @([pscustomobject]@{ candidates = @([pscustomobject]@{ finishReason = 'SAFETY' }) })
            $out = script:Invoke-CharacterizedCall @{ Prompt = 'p'; Model = 'gemini-2.5-flash'; ApiKey = $script:TestKey; FallbackModels = @(); CallLogger = $script:Logger }
            $out.Result | Should -BeNullOrEmpty
            $script:Logged.Count | Should -Be 1
            $script:Logged[0][1] | Should -BeExactly '200'
        }
    }
}
