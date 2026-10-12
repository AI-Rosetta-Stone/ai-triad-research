# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

#Requires -Version 5.1
<#
.SYNOPSIS
    Multi-backend AI API helper functions for AI Triad document enrichment.
.DESCRIPTION
    Supports Gemini (Google), Claude (Anthropic), and Groq backends with a
    unified Invoke-AIApi dispatcher.  Separated into a module to avoid AMSI
    false-positive detections triggered by REST API calls and safety-category
    strings.
#>

# ─────────────────────────────────────────────────────────────────────────────
# Model Registry — loaded from ai-models.json (single source of truth)
# Falls back to hardcoded defaults if the file is missing.
# ─────────────────────────────────────────────────────────────────────────────
$script:ModelRegistry = @{}
$script:FallbackChains = @{}
$script:ContextWindows = @{ gemini = 1048576; claude = 200000; groq = 131072; openai = 131072; zai = 1000000; moonshot = 1000000; xai = 500000; deepseek = 65536 }
$script:DebateTiers = @{ basic = @{}; advanced = @{} }
$script:LastApiKeySource = ''
$script:AIApiLoggedThisSession = $false
$script:AIApiLastModel = ''
# Correlation token for log attribution. In a parallel batch (ForEach-Object
# -Parallel) each worker runspace re-imports this module, so this $script: var
# is runspace-local — set it per-doc via Set-AIApiCorrelationId and every
# downstream Invoke-AIApi log line in that runspace carries the doc's id. This
# is what lets interleaved [AI] Backend lines be attributed to a document
# (t/1647).
$script:AIApiCorrelationId = ''
$script:AIApiLastCorrelationId = ''

function Set-AIApiCorrelationId {
    <#
    .SYNOPSIS
        Sets (or clears) the correlation token prefixed to Invoke-AIApi log lines.
    .DESCRIPTION
        The token — typically a document id — is prepended to every subsequent
        "[AI] Backend: ..." log line emitted by Invoke-AIApi in the current
        runspace, so that in a parallel batch (ForEach-Object -Parallel, one
        runspace per doc) an interleaved backend line can be attributed to the
        document that produced it (t/1647). Pass an empty string to clear it.

        Runspace scope: each -Parallel worker re-imports this module, so the
        underlying $script: var is worker-local and never bleeds across docs.
    .PARAMETER Id
        The correlation token to prefix. Empty/whitespace clears it.
    .EXAMPLE
        Set-AIApiCorrelationId $Doc.DocId
        # subsequent AI calls log: [AI] my-doc-slug | Backend: gemini | ...
    #>
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Id)
    if ($null -eq $Id) { $Id = '' }
    $script:AIApiCorrelationId = $Id
}

function Get-AIApiCorrelationPrefix {
    <#
    .SYNOPSIS
        Returns the log-line prefix for the current correlation token.
    .DESCRIPTION
        Central formatter for the "[AI] <doc> | " prefix used by Invoke-AIApi log
        lines (t/1647). Returns "<token> | " when a token is set via
        Set-AIApiCorrelationId, or '' when none is set. The log block calls this
        so the exact production prefix logic is unit-testable without a real AI
        call.
    #>
    [CmdletBinding()]
    param()
    if (-not [string]::IsNullOrWhiteSpace($script:AIApiCorrelationId)) {
        return "$($script:AIApiCorrelationId) | "
    }
    return ''
}

$_aiModelsPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'ai-models.json'
if (-not (Test-Path $_aiModelsPath)) {
    $_aiModelsPath = Join-Path $PSScriptRoot 'ai-models.json'
}
# Also try repo root (two levels up from scripts/)
if (-not (Test-Path $_aiModelsPath)) {
    $_aiModelsPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'ai-models.json'
}

if (Test-Path $_aiModelsPath) {
    try {
        $_aiConfig = Get-Content -Raw -Path $_aiModelsPath | ConvertFrom-Json
        foreach ($_m in $_aiConfig.models) {
            $script:ModelRegistry[$_m.id] = @{
                Backend    = $_m.backend
                ApiModelId = if ($_m.PSObject.Properties['apiModelId']) { $_m.apiModelId } else { $_m.id }
            }
        }
        if ($_aiConfig.PSObject.Properties['fallbackChains'] -and $_aiConfig.fallbackChains) {
            foreach ($_prop in $_aiConfig.fallbackChains.PSObject.Properties) {
                $script:FallbackChains[$_prop.Name] = @($_prop.Value)
            }
        }
        if ($_aiConfig.PSObject.Properties['contextWindows'] -and $_aiConfig.contextWindows) {
            foreach ($_prop in $_aiConfig.contextWindows.PSObject.Properties) {
                $script:ContextWindows[$_prop.Name] = [int]$_prop.Value
            }
        }
        if ($_aiConfig.PSObject.Properties['debateTiers'] -and $_aiConfig.debateTiers) {
            foreach ($_tier in @('basic', 'advanced')) {
                $tierObj = $_aiConfig.debateTiers.$_tier
                if ($tierObj) {
                    foreach ($_prop in $tierObj.PSObject.Properties) {
                        $script:DebateTiers[$_tier][$_prop.Name] = $_prop.Value
                    }
                }
            }
        }
        Write-Verbose "AIEnrich: loaded $($script:ModelRegistry.Count) models, $($script:FallbackChains.Count) fallback chains from ai-models.json"
    }
    catch {
        Write-Warning "AIEnrich: failed to load ai-models.json — $($_.Exception.Message). Using hardcoded fallback."
    }
}
else {
    # Fallback-Path Logging (docs/error-handling.md; t/3179 Finding 7): the file-not-found path is
    # as anomalous as a parse failure (which warns above) — warn rather than silently dropping to
    # the hardcoded registry, which may be stale relative to ai-models.json.
    Write-Warning "AIEnrich: ai-models.json not found at any candidate path (last tried: $_aiModelsPath) — using hardcoded fallback model list (may be stale)."
}

# Fallback if ai-models.json missing or empty
if ($script:ModelRegistry.Count -eq 0) {
    $script:ModelRegistry = @{
        'gemini-flash-lite-latest' = @{ Backend = 'gemini';  ApiModelId = 'gemini-flash-lite-latest' }
        'gemini-2.5-flash'      = @{ Backend = 'gemini';  ApiModelId = 'gemini-2.5-flash' }
        'gemini-2.5-flash-lite' = @{ Backend = 'gemini';  ApiModelId = 'gemini-2.5-flash-lite' }
        'gemini-2.5-pro'        = @{ Backend = 'gemini';  ApiModelId = 'gemini-2.5-pro' }
        'claude-opus-4'         = @{ Backend = 'claude';  ApiModelId = 'claude-opus-4-20250514' }
        'claude-sonnet-4-5'     = @{ Backend = 'claude';  ApiModelId = 'claude-sonnet-4-5-20250514' }
        'claude-haiku-3.5'      = @{ Backend = 'claude';  ApiModelId = 'claude-3-5-haiku-20241022' }
        'groq-llama-3.3-70b'    = @{ Backend = 'groq';    ApiModelId = 'llama-3.3-70b-versatile' }
        'groq-llama-4-scout'    = @{ Backend = 'groq';    ApiModelId = 'meta-llama/llama-4-scout-17b-16e-instruct' }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Protect-SensitiveText — secret redaction for AI error logging (t/2530 L14, t/3140).
# MUST live in THIS module: Invoke-AIApi's all-retries-exhausted error path (below) calls it,
# and AIEnrich is imported as a SEPARATE module (own scope) — a copy in AITriad/Private is NOT
# visible here, so the error path threw 'Protect-SensitiveText not recognized', masking the real
# HTTP error and failing every caller on any AI error (t/3123 smoke-batch finding).
# ─────────────────────────────────────────────────────────────────────────────
function Protect-SensitiveText {
    <#
    .SYNOPSIS
        Redacts secret-looking tokens from text before it is logged.
    .DESCRIPTION
        AI API error bodies and exception messages can echo API keys, bearer
        tokens, or `key=` query parameters straight into warnings and logs.
        This replaces known secret shapes — and any explicitly-supplied literal
        secret values — with [REDACTED], then caps the length, so diagnostics
        never leak credentials.
    .PARAMETER Text
        The text to scrub. Null/empty is returned unchanged.
    .PARAMETER Secret
        Zero or more literal secret values to redact wherever they appear
        (e.g. the resolved API key in scope at the call site).
    .PARAMETER MaxLength
        Cap the returned length (default 1000). 0 disables the cap.
    .EXAMPLE
        Write-Warning "Response body: $(Protect-SensitiveText -Text $ErrBody -Secret $ResolvedKey)"
    #>
    [CmdletBinding()]
    param(
        [Parameter(Position = 0, ValueFromPipeline)]
        [AllowEmptyString()]
        [AllowNull()]
        [string]$Text,

        [string[]]$Secret = @(),

        [int]$MaxLength = 1000
    )

    process {
        if ([string]::IsNullOrEmpty($Text)) { return $Text }

        $out = $Text

        # 1) Explicit literal secrets first, longest-first so a shorter secret
        #    that is a substring of a longer one doesn't leave a partial behind.
        foreach ($s in (@($Secret) | Where-Object { $_ } | Sort-Object { $_.Length } -Descending)) {
            $out = $out.Replace($s, '[REDACTED]')
        }

        # 2) Known secret shapes. Token-shaped patterns run BEFORE the header
        #    key/value pattern: otherwise "Authorization: Bearer <tok>" has only
        #    "Bearer" eaten as the value, leaving the token behind.
        $patterns = @(
            '(?i)\bBearer\s+[A-Za-z0-9._\-]+'
            'AIza[0-9A-Za-z\-_]{20,}'        # Google API key (AIza… classic)
            'AQ\.[0-9A-Za-z\-_\.]{20,}'      # Google API key (AQ.… newer format, t/3140)
            'sk-[A-Za-z0-9\-_]{16,}'         # OpenAI / Anthropic style
            'gsk_[A-Za-z0-9]{16,}'           # Groq
            '(?i)\bkey=[^&\s"'']+'           # ?key= query parameter
            '(?i)(x-goog-api-key|api[_-]?key|authorization)["'']?\s*[:=]\s*["'']?[^\s"'',&}]+'
        )
        foreach ($p in $patterns) {
            $out = [regex]::Replace($out, $p, '[REDACTED]')
        }

        if ($MaxLength -gt 0 -and $out.Length -gt $MaxLength) {
            $out = $out.Substring(0, $MaxLength) + '…[truncated]'
        }

        return $out
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Resolve-AIApiKey
# Resolves the API key for a given backend using the priority:
#   explicit -ApiKey > backend-specific env var > AI_API_KEY fallback (gemini only, t/4102)
# ─────────────────────────────────────────────────────────────────────────────
<#
.SYNOPSIS
    Resolves the API key for a given AI backend.
.DESCRIPTION
    Determines the API key to use for an AI backend call using the following
    priority chain:

    1. Explicit key passed via -ExplicitKey parameter.
    2. Backend-specific environment variable (GEMINI_API_KEY, ANTHROPIC_API_KEY
       or CLAUDE_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, AZURE_OPENAI_API_KEY).
    3. Gemini only: the generic fallback $env:AI_API_KEY. For any other
       backend, a set AI_API_KEY with no backend variable is refused with an
       error naming that backend's own variable (t/4102).

    Returns $null if no key is found at any level.  The resolved source is
    tracked in $script:LastApiKeySource for diagnostic logging.
.PARAMETER ExplicitKey
    An API key passed directly by the caller.  Takes highest priority.
.PARAMETER Backend
    The AI backend name: 'gemini', 'claude', or 'groq'.  Determines which
    environment variable to check.
.EXAMPLE
    $Key = Resolve-AIApiKey -Backend 'gemini'

    Resolves the Gemini API key from $env:GEMINI_API_KEY or $env:AI_API_KEY.
.EXAMPLE
    $Key = Resolve-AIApiKey -ExplicitKey 'sk-abc123' -Backend 'claude'

    Returns the explicit key, ignoring environment variables.
#>
$script:AIApiKeyEnvVarMap = @{
    'gemini' = @('GEMINI_API_KEY')
    'claude' = @('ANTHROPIC_API_KEY', 'CLAUDE_API_KEY')
    'groq'   = @('GROQ_API_KEY')
    'openai' = @('OPENAI_API_KEY')
    'azure'  = @('AZURE_OPENAI_API_KEY')
    'zai'    = @('ZAI_API_KEY')
    'moonshot' = @('MOONSHOT_API_KEY')
    'xai'    = @('XAI_API_KEY')
    'deepseek' = @('DEEPSEEK_API_KEY')
}
$script:AIApiKeyFallbackWarned = @{}
# FullyQualifiedErrorId of the gemini-only AI_API_KEY refusal (t/4102). Match it with Test-AIApiKeyGeminiOnlyRefusal.
$script:GeminiOnlyRefusalErrorId = 'AIApiKeyGeminiOnlyRefused'
# FullyQualifiedErrorId of the refusal of a key that is another backend's named credential (t/4087). Named in
# parallel with the TS KeyRefusalKind (lib/ai-client/apiKeyFallback.ts) so logs read the same from both tools.
# NO consumer branches on this id: every path surfaces the refusal, nothing softens it. That is why it shipped
# T0 (t/4110). THE EXEMPTION LAPSES the moment a consumer branches on it; that change is T1 or higher.
$script:ForeignCredentialRefusalErrorId = 'AIApiKeyForeignCredentialRefused'

function Test-AIApiKeyGeminiOnlyRefusal {
    <#
    .SYNOPSIS
        True when an ErrorRecord is Resolve-AIApiKey's gemini-only AI_API_KEY refusal (t/4102). Classifies by
        error kind (FullyQualifiedErrorId), so a listing path can soften exactly this refusal and nothing else.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param([Parameter(Mandatory)][System.Management.Automation.ErrorRecord]$ErrorRecord)
    return ($ErrorRecord.FullyQualifiedErrorId -like "$script:GeminiOnlyRefusalErrorId*")
}

# The env var (of a backend OTHER than $Backend) that holds exactly $Key, or '' if none. A key equal to
# another backend's named variable IS that backend's credential, whatever route it took to get here.
function Get-AIApiKeyForeignOwner {
    param([string]$Key, [string]$Backend)
    $OwnVars = if ($script:AIApiKeyEnvVarMap.ContainsKey($Backend)) { @($script:AIApiKeyEnvVarMap[$Backend]) } else { @() }
    foreach ($Var in $OwnVars) {
        if ([System.Environment]::GetEnvironmentVariable($Var) -ceq $Key) { return '' }
    }
    foreach ($Other in ($script:AIApiKeyEnvVarMap.Keys | Sort-Object)) {
        if ($Other -eq $Backend) { continue }
        foreach ($Var in $script:AIApiKeyEnvVarMap[$Other]) {
            $Value = [System.Environment]::GetEnvironmentVariable($Var)
            if (-not [string]::IsNullOrWhiteSpace($Value) -and $Value -ceq $Key) { return $Var }
        }
    }
    ''
}

# t/4087: an env-var key may only ever reach the backend it is named for. Refuse, before any send, a key
# that is another backend's named credential. The message names variables, never key material.
function Assert-AIApiKeyBackend {
    param([string]$Key, [string]$Backend, [string]$Route)
    $Owner = Get-AIApiKeyForeignOwner -Key $Key -Backend $Backend
    if (-not $Owner) { return }
    $script:LastApiKeySource = "(refused: $Route matches `$env:$Owner)"
    $Message = @(
        "Goal:     Resolve an API key for the '$Backend' backend"
        "Error:    the $Route key is the value of `$env:$Owner, another backend's credential; it will not be sent to '$Backend' (t/4087)"
        'Location: Resolve-AIApiKey (AIEnrich.psm1)'
        "Resolve:  set the '$Backend' backend's own key variable, or pass -ApiKey with a key issued for '$Backend'"
    ) -join [Environment]::NewLine
    # Typed kind, named in parallel with AIApiKeyGeminiOnlyRefused and identical in the TS client (TL e/284#14).
    # Never softened anywhere: every path surfaces it.
    throw [System.Management.Automation.ErrorRecord]::new(
        [System.InvalidOperationException]::new($Message), $script:ForeignCredentialRefusalErrorId,
        [System.Management.Automation.ErrorCategory]::PermissionDenied, $Backend)
}

function Resolve-AIApiKey {
    [CmdletBinding()]
    param(
        [string]$ExplicitKey,
        [Parameter(Mandatory)][string]$Backend
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitKey)) {
        Assert-AIApiKeyBackend -Key $ExplicitKey -Backend $Backend -Route 'explicit -ApiKey'
        $script:LastApiKeySource = 'explicit parameter'
        return $ExplicitKey
    }

    $BackendEnvVars = $script:AIApiKeyEnvVarMap[$Backend]
    foreach ($BackendEnvVar in $BackendEnvVars) {
        $BackendKey = [System.Environment]::GetEnvironmentVariable($BackendEnvVar)
        if (-not [string]::IsNullOrWhiteSpace($BackendKey)) {
            $script:LastApiKeySource = "`$env:$BackendEnvVar"
            return $BackendKey
        }
    }

    # AI_API_KEY is the generic fallback for the gemini backend ONLY (PI decision, t/4102). The fallback
    # can't say which provider's key it holds, so offering it elsewhere sends an unknown credential to that
    # provider. For any other backend a set AI_API_KEY is refused actionably, naming the variable the
    # backend actually reads. The message names variables, never key material.
    $Fallback = $env:AI_API_KEY
    if ($Backend -ne 'gemini' -and -not [string]::IsNullOrWhiteSpace($Fallback)) {
        $OwnVars = if ($script:AIApiKeyEnvVarMap.ContainsKey($Backend)) { @($script:AIApiKeyEnvVarMap[$Backend]) -join ' or ' } else { "the '$Backend' backend's key variable" }
        $script:LastApiKeySource = '(refused: $env:AI_API_KEY is gemini-only)'
        $Message = @(
            "Goal:     Resolve an API key for the '$Backend' backend"
            "Error:    no key for backend '$Backend': `$env:AI_API_KEY is set, but it is the fallback for the gemini backend only and is never sent to '$Backend' (t/4102)"
            'Location: Resolve-AIApiKey (AIEnrich.psm1)'
            "Resolve:  set $OwnVars, or pass -ApiKey with a key issued for '$Backend'"
        ) -join [Environment]::NewLine
        # A typed error kind, so callers classify this refusal by kind, never by message text or check order
        # (SO e/284#12). Only listing/status paths and SECONDARY cascade links may treat it as "not configured";
        # a call's primary backend always surfaces it, and it is never a reason to fail over.
        throw [System.Management.Automation.ErrorRecord]::new(
            [System.InvalidOperationException]::new($Message), $script:GeminiOnlyRefusalErrorId,
            [System.Management.Automation.ErrorCategory]::PermissionDenied, $Backend)
    }
    if (-not [string]::IsNullOrWhiteSpace($Fallback)) {
        Assert-AIApiKeyBackend -Key $Fallback -Backend $Backend -Route '$env:AI_API_KEY fallback'
        if (-not $script:AIApiKeyFallbackWarned.ContainsKey($Backend)) {
            $script:AIApiKeyFallbackWarned[$Backend] = $true
            Write-Warning "No key variable for the '$Backend' backend is set; using the generic `$env:AI_API_KEY fallback for '$Backend' (warned once per backend per session)."
        }
        $script:LastApiKeySource = '$env:AI_API_KEY (fallback)'
        return $Fallback
    }

    $script:LastApiKeySource = '(none found)'
    return $null
}

# ─────────────────────────────────────────────────────────────────────────────
# Get-AIApiKeySource — expose the last-resolved key source for diagnostics
# ─────────────────────────────────────────────────────────────────────────────
<#
.SYNOPSIS
    Returns the source of the most recently resolved API key.
.DESCRIPTION
    Resolve-AIApiKey records where it found the key ('explicit parameter',
    '$env:ZAI_API_KEY', '$env:AI_API_KEY (fallback)', '(none found)', etc.) in a
    module-private variable. Cross-module callers (e.g. Test-AIApiKey in the
    AITriad module) cannot read that private reliably via
    `& (Get-Module AIEnrich) { ... }` — that expression throws when Get-Module
    resolves AIEnrich zero or multiple times, and the swallowed error left
    KeySource reporting '(none found)' on genuinely-successful calls (t/1621).
    This accessor reads the value from within the module's own scope, so it is
    deterministic for any caller that reaches the same module instance.
.OUTPUTS
    [string] The last key source, or '' if no key has been resolved this session.
#>
function Get-AIApiKeySource {
    [CmdletBinding()]
    [OutputType([string])]
    param()
    return $script:LastApiKeySource
}

function ConvertTo-AICallLogKeySource {
    <#
    .SYNOPSIS
        Map a Resolve-AIApiKey source label to the AI call log's closed KeySource vocabulary (t/4088).
    .DESCRIPTION
        The vocabulary is defined once, in tests/fixtures/ai-call-log/README.md: explicit,
        env:<VAR> (a known backend key variable), fallback:AI_API_KEY, store, keyvault, none.
        Anything unmappable returns '' with a WARN (TL t/4088#3). The result names WHERE the key came
        from; the key is compared, never returned or logged.

        An 'explicit parameter' key whose value is the backend's own named variable is reported as
        env:<VAR>. That is how the cascade passes a fallback link its env-resolved key, so without
        this every fallback link would be logged as 'explicit'.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [AllowEmptyString()][string]$SourceLabel,
        [AllowEmptyString()][string]$Backend,
        [AllowEmptyString()][string]$Key
    )
    $OwnVars = if ($script:AIApiKeyEnvVarMap.ContainsKey($Backend)) { @($script:AIApiKeyEnvVarMap[$Backend]) } else { @() }
    $KnownVars = @($script:AIApiKeyEnvVarMap.Values | ForEach-Object { $_ })

    if ($SourceLabel -like '(keyless*') { return 'none' }
    if ($SourceLabel -eq '$env:AI_API_KEY (fallback)') { return 'fallback:AI_API_KEY' }
    if ($SourceLabel -match '^\$env:([A-Z][A-Z0-9_]*)$' -and $Matches[1] -in $KnownVars) { return "env:$($Matches[1])" }
    if ($SourceLabel -eq 'explicit parameter') {
        foreach ($Var in $OwnVars) {
            $Value = [System.Environment]::GetEnvironmentVariable($Var)
            if (-not [string]::IsNullOrEmpty($Value) -and $Value -ceq $Key) { return "env:$Var" }
        }
        if ($Backend -eq 'gemini' -and -not [string]::IsNullOrEmpty($env:AI_API_KEY) -and $env:AI_API_KEY -ceq $Key) {
            return 'fallback:AI_API_KEY'
        }
        return 'explicit'
    }
    Write-Warning "AI call log: key source '$SourceLabel' for backend '$Backend' is not in the KeySource vocabulary; logging '' (t/4088)."
    return ''
}

# ─────────────────────────────────────────────────────────────────────────────
# Measure-PromptTokens — pre-flight token estimation
# ─────────────────────────────────────────────────────────────────────────────
<#
.SYNOPSIS
    Estimates the token count of a prompt text.
.DESCRIPTION
    Uses Gemini's free countTokens API for accurate counts when a Gemini API
    key is available. Falls back to a character-based heuristic (~3.2 chars
    per token for prose, ~2.5 for JSON/code).
.PARAMETER Text
    The prompt text to measure.
.PARAMETER ApiKey
    Optional API key. If omitted, attempts to resolve a Gemini key from env.
.EXAMPLE
    $Tokens = Measure-PromptTokens -Text $MyPrompt
    $Tokens.TokenCount  # 1523
    $Tokens.Accurate    # $true (if Gemini countTokens was used)
#>
function Measure-PromptTokens {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Text,
        [string]$ApiKey = ''
    )

    # countTokens is a Gemini endpoint, so this deliberately resolves the GEMINI key (t/4087: correct
    # key -> backend pairing). A foreign explicit key is refused by Resolve-AIApiKey; degrade to the
    # heuristic rather than fail a pre-flight estimate.
    $GeminiKey = $null
    try { $GeminiKey = Resolve-AIApiKey -ExplicitKey $ApiKey -Backend 'gemini' }
    catch { Write-Warning "Measure-PromptTokens: $($_.Exception.Message.Split([Environment]::NewLine)[1].Trim()) -- using the character heuristic (Accurate=`$false)" }
    if ($GeminiKey) {
        try {
            # Key travels in the x-goog-api-key header, not the URL — a ?key= query
            # param leaks via proxy logs and PS5.1 error-record URIs (t/2530 L1).
            $CountUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens'
            $CountBody = @{
                contents = @(@{ parts = @(@{ text = $Text }) })
            } | ConvertTo-Json -Depth 5
            $BodyBytes = [System.Text.Encoding]::UTF8.GetBytes($CountBody)
            $CountResponse = Invoke-RestMethod -Uri $CountUrl -Method POST -Headers @{ 'x-goog-api-key' = $GeminiKey } -ContentType 'application/json; charset=utf-8' -Body $BodyBytes -TimeoutSec 10
            return [PSCustomObject]@{
                TokenCount = [int]$CountResponse.totalTokens
                Method     = 'gemini-countTokens'
                Accurate   = $true
            }
        } catch {
            # Fallback-Path Logging (docs/error-handling.md; t/3179 Finding 6): WARN, not Verbose.
            # The pre-flight token-overflow check downstream depends on this count, so a silent
            # heuristic undercount can suppress that warning — surface the degraded accuracy.
            Write-Warning "Measure-PromptTokens: Gemini countTokens failed ($($_.Exception.Message)) — falling back to character heuristic (Accurate=`$false)"
        }
    }

    $JsonLike = $Text -match '^\s*[\[{]' -or ($Text.Length -gt 200 -and (($Text -split '[\{\}\[\]":]').Count * 1.0 / $Text.Length) -gt 0.01)
    $CharsPerToken = if ($JsonLike) { 2.5 } else { 3.2 }
    $EstTokens = [Math]::Ceiling($Text.Length / $CharsPerToken)
    return [PSCustomObject]@{
        TokenCount = $EstTokens
        Method     = "heuristic ($CharsPerToken chars/token)"
        Accurate   = $false
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Invoke-AIApi — central dispatcher
#
# Accepts a prompt and model name, looks up the backend, builds the
# backend-specific request, calls the API with retry logic, and returns a
# uniform result object.
# ─────────────────────────────────────────────────────────────────────────────

function ConvertTo-GeminiSchema {
    param([hashtable]$Schema)
    $TypeMap = @{
        'string'  = 'STRING'; 'number' = 'NUMBER'; 'integer' = 'INTEGER'
        'boolean' = 'BOOLEAN'; 'array' = 'ARRAY'; 'object' = 'OBJECT'
    }
    $result = @{}
    if ($Schema.ContainsKey('type')) {
        $result['type'] = $TypeMap[$Schema['type']] ?? $Schema['type'].ToString().ToUpper()
    }
    if ($Schema.ContainsKey('description')) { $result['description'] = $Schema['description'] }
    if ($Schema.ContainsKey('enum')) { $result['enum'] = $Schema['enum'] }
    if ($Schema.ContainsKey('nullable')) { $result['nullable'] = $Schema['nullable'] }
    if ($Schema.ContainsKey('required')) { $result['required'] = $Schema['required'] }
    if ($Schema.ContainsKey('items') -and $Schema['items'] -is [hashtable]) {
        $result['items'] = ConvertTo-GeminiSchema -Schema $Schema['items']
    }
    if ($Schema.ContainsKey('properties') -and $Schema['properties'] -is [hashtable]) {
        $props = @{}
        foreach ($key in $Schema['properties'].Keys) {
            $val = $Schema['properties'][$key]
            if ($val -is [hashtable]) { $props[$key] = ConvertTo-GeminiSchema -Schema $val }
            else { $props[$key] = $val }
        }
        $result['properties'] = $props
    }
    return $result
}

# ─────────────────────────────────────────────────────────────────────────────
# Get-AIDefaultTimeoutSec (private)
# Returns the default Invoke-AIApi timeout for a model, applying 2x for
# frontier-tier models (mirrors TS getDefaultTimeout in lib/ai-client/registry.ts).
# ─────────────────────────────────────────────────────────────────────────────
function Get-AIDefaultTimeoutSec {
    param([string]$Model)

    $backend = switch -Wildcard ($Model) {
        'claude*'    { 'claude';    break }
        'groq*'      { 'groq';      break }
        'openai*'    { 'openai';    break }
        'azure*'     { 'azure';     break }
        'ollama*'    { 'ollama';    break }
        'deepseek*'  { 'deepseek';  break }
        'zai*'       { 'zai';       break }
        'moonshot*'  { 'moonshot';  break }
        'xai*'       { 'xai';       break }
        default      { 'gemini' }
    }

    $base = switch ($backend) {
        'ollama'    { 300 }
        'deepseek'  { 180 }
        'openai'    { 180 }
        'azure'     { 180 }
        'claude'    { 180 }
        'groq'      { 120 }
        'zai'       { 300 }
        'moonshot'  { 240 }
        'xai'       { 240 }
        'gemini'    { 120 }
        default     { 120 }
    }

    $advanced = $script:DebateTiers['advanced'][$backend]
    $basic    = $script:DebateTiers['basic'][$backend]
    if ($advanced -and ($advanced -eq $Model) -and ($advanced -ne $basic)) {
        return $base * 2
    }
    return $base
}

# ─────────────────────────────────────────────────────────────────────────────
# Backend request profiles (t/4135 B1) — one row per backend in ai-models.json.
# Everything Invoke-AIApi needs to BUILD a request for a backend lives in its row;
# tests/AIBackendProfiles.Completeness.Tests.ps1 fails if a registry backend has no
# row or a row names no registry backend. Row fields:
#   DisplayName  — human label (matches ai-models.json backends[].label)
#   RequestShape — body builder: gemini | claude | chat (OpenAI-compatible
#                  /chat/completions) | openai-responses
#   UriTemplate  — {model} = ApiModelId; {azure-endpoint} = $env:AZURE_OPENAI_ENDPOINT
#                  (required); {ollama-host} = $env:OLLAMA_HOST or http://localhost:11434
#   AuthStyle    — x-goog-api-key | x-api-key+anthropic-version | bearer | api-key | none
#   ModelInBody  — the body carries "model" (azure addresses it by deployment URI and
#                  gemini by URI path; only the chat builder branches on it)
#   EnvHint      — the "Set ..." text of the missing-key warning (pinned by tests)
# ─────────────────────────────────────────────────────────────────────────────
$script:AIBackendProfiles = @{
    'gemini'   = @{ DisplayName = 'Google Gemini'; RequestShape = 'gemini'; AuthStyle = 'x-goog-api-key'; ModelInBody = $false
                    UriTemplate = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
                    EnvHint = 'GEMINI_API_KEY or AI_API_KEY' }   # the AI_API_KEY fallback is gemini-only (t/4102)
    'claude'   = @{ DisplayName = 'Anthropic Claude'; RequestShape = 'claude'; AuthStyle = 'x-api-key+anthropic-version'; ModelInBody = $true
                    UriTemplate = 'https://api.anthropic.com/v1/messages'; EnvHint = 'ANTHROPIC_API_KEY / CLAUDE_API_KEY' }
    'groq'     = @{ DisplayName = 'Groq'; RequestShape = 'chat'; AuthStyle = 'bearer'; ModelInBody = $true
                    UriTemplate = 'https://api.groq.com/openai/v1/chat/completions'; EnvHint = 'GROQ_API_KEY' }
    'openai'   = @{ DisplayName = 'OpenAI'; RequestShape = 'openai-responses'; AuthStyle = 'bearer'; ModelInBody = $true
                    UriTemplate = 'https://api.openai.com/v1/responses'; EnvHint = 'OPENAI_API_KEY' }
    'azure'    = @{ DisplayName = 'Azure OpenAI'; RequestShape = 'chat'; AuthStyle = 'api-key'; ModelInBody = $false
                    UriTemplate = '{azure-endpoint}/openai/deployments/{model}/chat/completions?api-version=2024-10-21'
                    EnvHint = 'AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT' }
    # t/1409 — local and keyless: no Authorization header.
    'ollama'   = @{ DisplayName = 'Ollama (Local)'; RequestShape = 'chat'; AuthStyle = 'none'; ModelInBody = $true
                    UriTemplate = '{ollama-host}/v1/chat/completions'; EnvHint = '(no env var — local, keyless)' }
    'zai'      = @{ DisplayName = 'Z.AI (GLM)'; RequestShape = 'chat'; AuthStyle = 'bearer'; ModelInBody = $true   # t/1437
                    UriTemplate = 'https://api.z.ai/api/paas/v4/chat/completions'; EnvHint = 'ZAI_API_KEY' }
    'moonshot' = @{ DisplayName = 'Moonshot (Kimi)'; RequestShape = 'chat'; AuthStyle = 'bearer'; ModelInBody = $true   # t/1936
                    UriTemplate = 'https://api.moonshot.ai/v1/chat/completions'; EnvHint = 'MOONSHOT_API_KEY' }
    'xai'      = @{ DisplayName = 'xAI (Grok)'; RequestShape = 'chat'; AuthStyle = 'bearer'; ModelInBody = $true   # t/2583
                    UriTemplate = 'https://api.x.ai/v1/chat/completions'; EnvHint = 'XAI_API_KEY' }
    'deepseek' = @{ DisplayName = 'DeepSeek'; RequestShape = 'chat'; AuthStyle = 'bearer'; ModelInBody = $true   # t/1938
                    UriTemplate = 'https://api.deepseek.com/v1/chat/completions'; EnvHint = 'DEEPSEEK_API_KEY' }
}

function Get-AIBackendEnvHint {
    <#
    .SYNOPSIS
        The env-var hint for the missing-key warning: the backend's profile EnvHint, or the
        unknown-backend text when $script:AIBackendProfiles has no row for it (t/4135).
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([string]$Backend)
    if ($script:AIBackendProfiles.ContainsKey($Backend)) { return $script:AIBackendProfiles[$Backend].EnvHint }
    "(unknown backend '$Backend' — expected gemini/claude/groq/openai/azure/ollama/zai/moonshot/xai/deepseek)"
}

function Get-AIRequestUri {
    <#
    .SYNOPSIS
        Expands a backend profile's UriTemplate (t/4135): {azure-endpoint} from
        $env:AZURE_OPENAI_ENDPOINT (throws when unset), {ollama-host} from $env:OLLAMA_HOST,
        and {model} from the ApiModelId. Trailing slashes on both env values are trimmed.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param([Parameter(Mandatory)][hashtable]$BackendProfile, [string]$ApiModelId)
    $Uri = $BackendProfile.UriTemplate
    if ($Uri.Contains('{azure-endpoint}')) {
        $AzureEndpoint = $env:AZURE_OPENAI_ENDPOINT
        if ([string]::IsNullOrWhiteSpace($AzureEndpoint)) {
            # PINNED BUG (t/4078): New-ActionableError is not visible from this module, so this
            # surfaces as a CommandNotFoundException. Pinned by the characterization tests.
            throw (New-ActionableError `
                -Goal 'Call Azure OpenAI API' `
                -Problem 'AZURE_OPENAI_ENDPOINT environment variable is not set' `
                -Location 'Invoke-AIApi (azure)' `
                -NextSteps @(
                    'Set $env:AZURE_OPENAI_ENDPOINT to your Azure OpenAI resource URL',
                    'Example: https://my-resource.openai.azure.com'
                ))
        }
        $Uri = $Uri.Replace('{azure-endpoint}', $AzureEndpoint.TrimEnd('/'))
    }
    if ($Uri.Contains('{ollama-host}')) {
        $OllamaHost = if ($env:OLLAMA_HOST) { $env:OLLAMA_HOST.TrimEnd('/') } else { 'http://localhost:11434' }
        $Uri = $Uri.Replace('{ollama-host}', $OllamaHost)
    }
    $Uri.Replace('{model}', $ApiModelId)
}

function Get-AIRequestHeaderTable {
    <#
    .SYNOPSIS
        The request headers for a profile AuthStyle (t/4135). 'none' (and an unknown style)
        gives an empty table, which Invoke-AIApi sends as no Headers at all.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string]$AuthStyle, [string]$ResolvedKey)
    switch ($AuthStyle) {
        # Gemini's key travels in a header, not the URL: a ?key= query param leaks via proxy
        # logs and PS5.1 error-record URIs (t/2530 L1).
        'x-goog-api-key'              { return @{ 'x-goog-api-key' = $ResolvedKey } }
        'x-api-key+anthropic-version' { return @{ 'x-api-key' = $ResolvedKey; 'anthropic-version' = '2023-06-01' } }
        'bearer'                      { return @{ 'Authorization' = "Bearer $ResolvedKey" } }
        'api-key'                     { return @{ 'api-key' = $ResolvedKey } }
    }
    return @{}
}

function Get-AIResponseFormat {
    <#
    .SYNOPSIS
        The OpenAI-style structured-output format (t/4135): json_schema (strict) when a
        ResponseSchema is given, else json_object. Used by the chat and Responses builders.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([hashtable]$ResponseSchema)
    if ($ResponseSchema) {
        return @{
            type        = 'json_schema'
            json_schema = @{
                name   = 'response'
                schema = $ResponseSchema
                strict = $true
            }
        }
    }
    return @{ type = 'json_object' }
}

function New-AIChatRequestBody {
    <#
    .SYNOPSIS
        Pure: the OpenAI-compatible /chat/completions body (groq, zai, moonshot, xai, deepseek,
        ollama, azure). -IncludeModel:$false omits "model" (azure). JsonMode adds response_format.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string]$ApiModelId, [switch]$IncludeModel, [string]$Prompt, [string]$SystemInstruction,
          [double]$Temperature, [int]$MaxTokens, [switch]$JsonMode, [hashtable]$ResponseSchema)
    $Messages = [System.Collections.Generic.List[object]]::new()
    if ($SystemInstruction) {
        $Messages.Add(@{ role = 'system'; content = $SystemInstruction })
    }
    $Messages.Add(@{ role = 'user'; content = $Prompt })

    if ($IncludeModel) {
        $ChatBody = @{
            model       = $ApiModelId
            messages    = @($Messages)
            temperature = $Temperature
            max_tokens  = $MaxTokens
        }
    } else {
        $ChatBody = @{
            messages    = @($Messages)
            temperature = $Temperature
            max_tokens  = $MaxTokens
        }
    }
    if ($JsonMode) { $ChatBody['response_format'] = Get-AIResponseFormat -ResponseSchema $ResponseSchema }
    return $ChatBody
}

function New-AIGeminiRequestBody {
    <#
    .SYNOPSIS
        Pure: the Gemini generateContent body, with all four safety categories at BLOCK_NONE.
        JsonMode sets responseMimeType; a ResponseSchema is converted by ConvertTo-GeminiSchema.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string]$Prompt, [string]$SystemInstruction, [double]$Temperature, [int]$MaxTokens,
          [switch]$JsonMode, [hashtable]$ResponseSchema)
    $Categories = @('HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT')
    $SafetyList = $Categories | ForEach-Object {
        @{ category = "HARM_CATEGORY_$_"; threshold = 'BLOCK_NONE' }
    }

    $GenConfig = @{
        temperature     = $Temperature
        maxOutputTokens = $MaxTokens
    }
    if ($JsonMode) {
        $GenConfig['responseMimeType'] = 'application/json'
        if ($ResponseSchema) {
            $GenConfig['responseSchema'] = ConvertTo-GeminiSchema -Schema $ResponseSchema
        }
    }

    $GeminiBody = @{
        contents         = @(@{ parts = @(@{ text = $Prompt }) })
        generationConfig = $GenConfig
        safetySettings   = $SafetyList
    }
    if ($SystemInstruction) {
        $GeminiBody['systemInstruction'] = @{ parts = @(@{ text = $SystemInstruction }) }
    }
    return $GeminiBody
}

function New-AIClaudeRequestBody {
    <#
    .SYNOPSIS
        Pure: the Anthropic Messages body. Claude has no JSON mode here: a ResponseSchema is
        appended to the prompt as an instruction instead.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string]$ApiModelId, [string]$Prompt, [string]$SystemInstruction, [double]$Temperature,
          [int]$MaxTokens, [hashtable]$ResponseSchema)
    $ClaudePrompt = $Prompt
    if ($ResponseSchema) {
        $SchemaJson = $ResponseSchema | ConvertTo-Json -Depth 10
        $ClaudePrompt = $Prompt + "`n`nYou MUST respond with a JSON object conforming to this schema:`n$SchemaJson"
    }

    $ClaudeBody = @{
        model      = $ApiModelId
        max_tokens = $MaxTokens
        messages   = @(@{
            role    = 'user'
            content = $ClaudePrompt
        })
        temperature = $Temperature
    }
    if ($SystemInstruction) {
        $ClaudeBody['system'] = $SystemInstruction
    }
    return $ClaudeBody
}

function New-AIOpenAIResponsesRequestBody {
    <#
    .SYNOPSIS
        Pure: the OpenAI Responses API (/v1/responses) body. No temperature is sent; JsonMode
        puts the response format under text.format.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string]$ApiModelId, [string]$Prompt, [string]$SystemInstruction, [int]$MaxTokens,
          [switch]$JsonMode, [hashtable]$ResponseSchema)
    $OpenAIBody = @{
        model             = $ApiModelId
        max_output_tokens = $MaxTokens
    }
    if ($SystemInstruction) {
        $OpenAIBody['instructions'] = $SystemInstruction
    }
    $OpenAIBody['input'] = $Prompt
    if ($JsonMode) { $OpenAIBody['text'] = @{ format = Get-AIResponseFormat -ResponseSchema $ResponseSchema } }
    return $OpenAIBody
}

function New-AIApiRequest {
    <#
    .SYNOPSIS
        Builds Invoke-AIApi's request {Uri; Headers; Body} from the backend's row in
        $script:AIBackendProfiles (t/4135). Body is the builder's table as ConvertTo-Json
        -Depth 10. A backend with no row gets Uri '', Headers @{} and Body ''.
    #>
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([string]$Backend, [string]$ApiModelId, [string]$ResolvedKey, [string]$Prompt,
          [string]$SystemInstruction, [double]$Temperature, [int]$MaxTokens,
          [switch]$JsonMode, [hashtable]$ResponseSchema)
    $Request = @{ Uri = ''; Headers = @{}; Body = '' }
    if (-not $script:AIBackendProfiles.ContainsKey($Backend)) { return $Request }
    $BackendProfile = $script:AIBackendProfiles[$Backend]

    $Request.Uri     = Get-AIRequestUri -BackendProfile $BackendProfile -ApiModelId $ApiModelId
    $Request.Headers = Get-AIRequestHeaderTable -AuthStyle $BackendProfile.AuthStyle -ResolvedKey $ResolvedKey
    $Common = @{ Prompt = $Prompt; SystemInstruction = $SystemInstruction; MaxTokens = $MaxTokens; ResponseSchema = $ResponseSchema }
    $BodyObject = switch ($BackendProfile.RequestShape) {
        'gemini'           { New-AIGeminiRequestBody @Common -Temperature $Temperature -JsonMode:$JsonMode }
        'claude'           { New-AIClaudeRequestBody @Common -Temperature $Temperature -ApiModelId $ApiModelId }
        'openai-responses' { New-AIOpenAIResponsesRequestBody @Common -ApiModelId $ApiModelId -JsonMode:$JsonMode }
        'chat'             { New-AIChatRequestBody @Common -Temperature $Temperature -ApiModelId $ApiModelId -JsonMode:$JsonMode -IncludeModel:([bool]$BackendProfile.ModelInBody) }
    }
    $Request.Body = $BodyObject | ConvertTo-Json -Depth 10
    return $Request
}

<#
.SYNOPSIS
    Calls an AI backend with a prompt and returns the generated text.
.DESCRIPTION
    Central dispatcher for all AI API calls in the AITriad module.  Accepts a
    prompt and model name, looks up the backend (Gemini, Claude, or Groq) from
    the model registry (ai-models.json), builds the backend-specific HTTP
    request, executes it with automatic retry on transient errors (HTTP 429,
    503, 529), and returns a uniform result object.

    The result object has six properties:
      Text        — the generated text content
      Backend     — 'gemini', 'claude', 'groq', or 'openai'
      Model       — the model ID that was used
      Truncated   — $true if the response was cut short by max_tokens
      Usage       — token counts (InputTokens, OutputTokens, TotalTokens) or $null
      RawResponse — the full deserialized API response

    Returns $null on failure (with warnings explaining the issue).
.PARAMETER Prompt
    The prompt text to send to the AI model.
.PARAMETER Model
    Model identifier from ai-models.json (e.g., 'gemini-2.5-flash',
    'claude-sonnet-4-5', 'groq-llama-3.3-70b').  Defaults to 'gemini-2.5-flash'.
.PARAMETER ApiKey
    Optional explicit API key.  If empty, resolved via Resolve-AIApiKey.
.PARAMETER Temperature
    Sampling temperature (0.0–2.0).  Lower = more deterministic.  Defaults to 0.1.
.PARAMETER MaxTokens
    Maximum tokens in the response.  Defaults to 1024.
.PARAMETER JsonMode
    When specified, requests JSON-formatted output from the backend.
.PARAMETER ResponseSchema
    Optional JSON Schema hashtable for structured output enforcement.
    When provided, implies -JsonMode. Gemini and Groq enforce the schema
    via constrained decoding; Claude injects the schema into the prompt.
.PARAMETER TimeoutSec
    HTTP request timeout in seconds.  Defaults to 120.
.PARAMETER MaxRetries
    Number of retry attempts on transient failures.  Defaults to 5.
.PARAMETER RetryDelays
    Array of delay durations (seconds) between retries.  Defaults to @(15, 45, 90, 120).
.PARAMETER FallbackModels
    Ordered list of models to try if the primary model fails permanently.
    If omitted, uses the fallback chain from ai-models.json (if defined for
    the primary model). Pass an empty array @() to disable fallback.
.PARAMETER SkipTokenCheck
    Skip the pre-flight token count check that warns when a prompt exceeds
    80% of the model's context window.
.EXAMPLE
    $Result = Invoke-AIApi -Prompt 'Summarize this document...' -Model 'gemini-2.5-flash'
    $Result.Text  # The generated summary

.EXAMPLE
    $Result = Invoke-AIApi -Prompt $Prompt -Model 'claude-sonnet-4-5' -JsonMode -MaxTokens 4096
    $Parsed = $Result.Text | ConvertFrom-Json

    Requests JSON output from Claude and parses it.
.EXAMPLE
    Invoke-AIApi -Prompt 'Hello' -Model 'groq-llama-3.3-70b' -Temperature 0.7

    Calls the Groq backend with higher creativity.
.EXAMPLE
    Invoke-AIApi -Prompt $P -Model 'gemini-2.5-flash' -FallbackModels @('groq-llama-3.3-70b-versatile')

    Falls back to Groq if Gemini fails.
#>
function Invoke-AIApi {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Prompt,
        [string]$SystemInstruction = '',
        [ArgumentCompleter({ param($cmd, $param, $word) $script:ModelRegistry.Keys | Where-Object { $_ -like "$word*" } | Sort-Object })]
        [string]$Model       = 'gemini-2.5-flash',
        [string]$ApiKey      = '',
        [double]$Temperature = 0.1,
        [int]   $MaxTokens   = 1024,
        [switch]$JsonMode,
        [hashtable]$ResponseSchema,
        [int]   $TimeoutSec  = 0,
        [int]   $MaxRetries  = 5,
        [int[]] $RetryDelays = @(15, 45, 90, 120),
        [string[]]$FallbackModels,
        [switch]$SkipTokenCheck,
        # t/3242 — optional AI Call Log hook (IoC). A scriptblock invoked once per call with
        # ($RetryCount, $Status). Defined in AITriad (Invoke-AIByUsage) so it retains that module's
        # affinity and can reach the AITriad-private Write-AICallLogEntry across the module boundary.
        [scriptblock]$CallLogger
    )

    # -- Resolve model info from registry -------------------------------------
    $ModelInfo = $script:ModelRegistry[$Model]
    if (-not $ModelInfo) {
        Write-Warning "Unknown model '$Model'. Valid models: $($script:ModelRegistry.Keys -join ', ')"
        return $null
    }

    $Backend    = $ModelInfo.Backend
    $ApiModelId = $ModelInfo.ApiModelId

    if ($TimeoutSec -le 0) { $TimeoutSec = Get-AIDefaultTimeoutSec -Model $Model }

    # -- Resolve API key ------------------------------------------------------
    # t/1409: Ollama runs models locally and has no auth surface — skip both the
    # key resolution and the missing-key gate. The key-required backends still
    # gate as before; every backend's EnvHint comes from its $script:AIBackendProfiles
    # row, which the completeness test keeps exhaustive, so no future backend
    # produces the blank-token warning (AC#1).
    $ResolvedKey = ''
    $KeySourceLabel = ''
    if ($Backend -eq 'ollama') {
        $script:LastApiKeySource = '(keyless — local Ollama)'
        $KeySourceLabel = $script:LastApiKeySource
    }
    else {
        $ResolvedKey = Resolve-AIApiKey -ExplicitKey $ApiKey -Backend $Backend
        $KeySourceLabel = $script:LastApiKeySource   # captured now, so nothing later in the call can overwrite it (t/4088)
        if ([string]::IsNullOrWhiteSpace($ResolvedKey)) {
            $EnvHint = Get-AIBackendEnvHint -Backend $Backend
            Write-Warning "No API key found for $Backend backend. Set $EnvHint."
            return $null
        }
    }

    # -- Log AI configuration --------------------------------------------------
    # Correlation prefix: when a per-doc token is set (Set-AIApiCorrelationId,
    # e.g. the doc id from Invoke-DocumentSummary), every log line names the doc
    # it belongs to. In a parallel batch this is the only reliable way to
    # attribute an interleaved [AI] line to a document (t/1647).
    $corrPrefix = Get-AIApiCorrelationPrefix
    Write-Verbose "[AI] ${corrPrefix}Backend: $Backend | Model: $Model (API: $ApiModelId) | Key source: $($script:LastApiKeySource)"
    $modelChanged = $script:AIApiLastModel -and ($script:AIApiLastModel -ne $Model)
    # Re-announce the colored line whenever the doc changes too, so each document
    # in a sequential worker gets one visible attributed [AI] line — not just the
    # first document the worker happens to process.
    $corrChanged = $script:AIApiLastCorrelationId -ne $script:AIApiCorrelationId
    if (-not $script:AIApiLoggedThisSession -or $modelChanged -or $corrChanged) {
        if ($modelChanged) {
            Write-Host "[AI] ${corrPrefix}Model changed: $($script:AIApiLastModel) → $Model | Backend: $Backend | Key source: $($script:LastApiKeySource)" -ForegroundColor Yellow
        } else {
            Write-Host "[AI] ${corrPrefix}Backend: $Backend | Model: $Model | Key source: $($script:LastApiKeySource)" -ForegroundColor DarkCyan
        }
        $script:AIApiLoggedThisSession = $true
    }
    $script:AIApiLastModel = $Model
    $script:AIApiLastCorrelationId = $script:AIApiCorrelationId

    # -- Pre-flight token check ---------------------------------------------------
    if (-not $SkipTokenCheck) {
        $PromptLength = $Prompt.Length + $SystemInstruction.Length
        $EstTokens = [Math]::Ceiling($PromptLength / 3.2)
        $ContextLimit = if ($script:ContextWindows.ContainsKey($Backend)) { $script:ContextWindows[$Backend] } else { 131072 }
        if ($EstTokens -gt ($ContextLimit * 0.8)) {
            Write-Warning "$Model`: prompt is ~$EstTokens tokens (est.), which exceeds 80% of the $ContextLimit-token context window. Consider chunking or using a model with a larger context."
        }
    }

    # -- ResponseSchema implies JsonMode ----------------------------------------
    if ($ResponseSchema) { $JsonMode = [switch]::Present }

    # -- Build backend-specific request ---------------------------------------
    # t/4135 B1: the per-backend facts live in $script:AIBackendProfiles; New-AIApiRequest builds
    # the URI, headers and JSON body from the backend's row (an unknown backend gets '' / @{} / '').
    $Request = New-AIApiRequest -Backend $Backend -ApiModelId $ApiModelId -ResolvedKey $ResolvedKey `
        -Prompt $Prompt -SystemInstruction $SystemInstruction -Temperature $Temperature -MaxTokens $MaxTokens `
        -JsonMode:$JsonMode -ResponseSchema $ResponseSchema
    $Uri         = $Request.Uri
    $Headers     = $Request.Headers
    $Body        = $Request.Body
    $ContentType = 'application/json; charset=utf-8'

    # -- Call API with retry logic --------------------------------------------
    $Response  = $null
    $LastError = $null

    for ($Attempt = 0; $Attempt -lt $MaxRetries; $Attempt++) {
        try {
            # Encode body as UTF-8 bytes — PS 5.1's Invoke-RestMethod defaults to
            # Windows-1252, which mangles non-ASCII chars and produces invalid JSON.
            $BodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)

            $SplatParams = @{
                Uri         = $Uri
                Method      = 'POST'
                ContentType = $ContentType
                Body        = $BodyBytes
                TimeoutSec  = $TimeoutSec
                ErrorAction = 'Stop'
            }
            if ($Headers.Count -gt 0) {
                $SplatParams['Headers'] = $Headers
            }

            $Response  = Invoke-RestMethod @SplatParams
            $LastError = $null
            break
        } catch {
            $LastError  = $_
            $StatusCode = $_.Exception.Response.StatusCode.value__

            if ($StatusCode -in @(429, 503, 529) -and $Attempt -lt ($MaxRetries - 1)) {
                if ($Attempt -lt $RetryDelays.Count) { $Delay = $RetryDelays[$Attempt] } else { $Delay = $RetryDelays[-1] }
                # Server-side rate limiting (429) needs a longer wait than transient errors
                if ($StatusCode -eq 429) { $Delay = [Math]::Max($Delay, 120) }
                Write-Warning "$($Backend): HTTP $StatusCode — retrying in ${Delay}s (attempt $($Attempt + 1)/$MaxRetries)"
                Start-Sleep -Seconds $Delay
            } else {
                break
            }
        }
    }

    # t/3242 — AI Call Log capture (IoC). Fire the injected logger ONCE per call HERE, before the
    # failure $null-return AND the success extraction, so a failed call is logged too (TL C, cond.3).
    # Fail-safe (cond.2): the logger — and the audit write it drives — must never break the AI call.
    if ($CallLogger) {
        if ($null -ne $Response -and $null -eq $LastError) { $LogStatus = 200 }
        elseif ($LastError -and $LastError.Exception.Response) { $LogStatus = $LastError.Exception.Response.StatusCode.value__ }
        elseif ($LastError) { $LogStatus = 'error' }
        else { $LogStatus = '?' }
        # t/4088: the model and backend ACTUALLY called (a cascade link logs its own) and where its key came
        # from. Backend is the registry value resolved above, never a prefix guess. A two-argument logger
        # still works; it just ignores the third argument.
        try {
            $LogContext = [pscustomobject]@{
                Model     = $Model
                Backend   = $Backend
                KeySource = ConvertTo-AICallLogKeySource -SourceLabel $KeySourceLabel -Backend $Backend -Key $ResolvedKey
            }
            & $CallLogger $Attempt ([string]$LogStatus) $LogContext
        }
        catch { Write-Warning "Invoke-AIApi: call-logger threw ($($_.Exception.Message)); continuing (audit log is non-fatal)." }
    }

    if ($null -ne $LastError -or $null -eq $Response) {
        if ($LastError) { $StatusCode = $LastError.Exception.Response.StatusCode.value__ } else { $StatusCode = '?' }
        $Hint = switch ($StatusCode) {
            401     { 'Check your API key — it may be invalid or expired.' }
            403     { 'Access denied — verify your API key has the required permissions.' }
            429     { 'Rate limit exceeded — wait a moment and try again.' }
            { $_ -in 500, 502, 503 } { 'Server error — the API may be temporarily unavailable.' }
            default { '' }
        }
        # Scrub any key/token that the exception message or response body may echo
        # before it reaches a log (t/2530 L14).
        $SafeMsg = Protect-SensitiveText -Text $LastError.Exception.Message -Secret $ResolvedKey
        Write-Warning "$($Backend): API call failed (HTTP $StatusCode) — $SafeMsg"
        if ($Hint) { Write-Warning "$($Backend): $Hint" }
        # Capture the HTTP error BODY — it carries the real reason (e.g. a 400's message). t/3196:
        # Invoke-RestMethod (HttpClient) surfaces the response body on $_.ErrorDetails.Message, NOT
        # on Exception.Response.GetResponseStream() (the old WebRequest shape) — so the previous
        # read silently caught nothing on every HttpClient failure, and the body was invisible
        # (this masked the t/3123 400 during diagnosis). Prefer ErrorDetails.Message; fall back to
        # the WebRequest stream for any caller still on that path.
        try {
            $ErrBody = $null
            if ($LastError.PSObject.Properties['ErrorDetails'] -and $LastError.ErrorDetails -and $LastError.ErrorDetails.Message) {
                $ErrBody = [string]$LastError.ErrorDetails.Message
            }
            elseif ($LastError.Exception.Response -and ($LastError.Exception.Response | Get-Member -Name GetResponseStream -MemberType Method -ErrorAction SilentlyContinue)) {
                $ErrStream = $LastError.Exception.Response.GetResponseStream()
                $ErrReader = [System.IO.StreamReader]::new($ErrStream)
                $ErrBody   = $ErrReader.ReadToEnd()
                $ErrReader.Close()
            }
            if (-not [string]::IsNullOrWhiteSpace($ErrBody)) {
                $SafeBody = Protect-SensitiveText -Text $ErrBody -Secret $ResolvedKey
                Write-Warning "$($Backend): Response body: $SafeBody"
            }
        } catch { }

        # -- Model cascade: try fallback models ----------------------------------
        $CascadeModels = $FallbackModels
        if ($null -eq $CascadeModels -and $script:FallbackChains.ContainsKey($Model)) {
            $CascadeModels = $script:FallbackChains[$Model]
        }
        if ($CascadeModels -and $CascadeModels.Count -gt 0) {
            foreach ($FbModel in $CascadeModels) {
                $FbInfo = $script:ModelRegistry[$FbModel]
                if (-not $FbInfo) { continue }
                if ($StatusCode -in @(401, 403) -and $FbInfo.Backend -eq $Backend) { continue }
                # A SECONDARY link whose only key is the gemini-only $env:AI_API_KEY is "not configured" here,
                # not an error: skip it and say why (t/4102, SO e/284#2 cond. 1). Other refusals propagate. The
                # primary backend's refusal never reaches this cascade: it is thrown at key resolution, before
                # any request, so it can never be served by a link further down the chain (SO e/284#10).
                try { $FbKey = Resolve-AIApiKey -ExplicitKey '' -Backend $FbInfo.Backend }
                catch {
                    if (-not (Test-AIApiKeyGeminiOnlyRefusal -ErrorRecord $_)) { throw }
                    Write-Warning "Cascade: skipping $FbModel ($($FbInfo.Backend)): `$env:AI_API_KEY applies to gemini only and no key for '$($FbInfo.Backend)' is set"
                    continue
                }
                if ([string]::IsNullOrWhiteSpace($FbKey)) { continue }

                Write-Warning "Cascade: falling back to $FbModel ($($FbInfo.Backend))"
                $FbParams = @{
                    Prompt         = $Prompt
                    Model          = $FbModel
                    ApiKey         = $FbKey
                    Temperature    = $Temperature
                    MaxTokens      = $MaxTokens
                    TimeoutSec     = $TimeoutSec
                    MaxRetries     = 2
                    RetryDelays    = @(5, 15)
                    FallbackModels = @()
                    SkipTokenCheck = $true
                    CallLogger     = $CallLogger   # t/3242 cond.1: forward the logger through the cascade
                }
                if ($SystemInstruction) { $FbParams['SystemInstruction'] = $SystemInstruction }
                if ($JsonMode)          { $FbParams['JsonMode'] = $true }
                if ($ResponseSchema)    { $FbParams['ResponseSchema'] = $ResponseSchema }

                $FbResult = Invoke-AIApi @FbParams
                if ($null -ne $FbResult) { return $FbResult }
            }
        }

        return $null
    }

    # -- Extract text from backend-specific response envelope -----------------
    $Text      = $null
    $Truncated = $false
    $Usage     = $null

    switch ($Backend) {
        'gemini' {
            try {
                $Candidate = $Response.candidates[0]
                $FinishReason = $Candidate.finishReason
                if ($FinishReason -and $FinishReason -notin @('STOP', 'MAX_TOKENS')) {
                    Write-Warning "Gemini: generation stopped with finishReason=$FinishReason (content may have been blocked)"
                    return $null
                }
                $Truncated = ($FinishReason -eq 'MAX_TOKENS')
                $Text = $Candidate.content.parts[0].text
                $um = $Response.usageMetadata
                if ($um) {
                    $CachedCount = if ($um.PSObject.Properties['cachedContentTokenCount']) { [int]($um.cachedContentTokenCount) } else { 0 }
                    $Usage = [PSCustomObject]@{
                        InputTokens  = [int]($um.promptTokenCount)
                        OutputTokens = [int]($um.candidatesTokenCount)
                        CachedTokens = $CachedCount
                        TotalTokens  = [int]($um.totalTokenCount)
                    }
                }
            } catch {
                $TopKeys = ($Response.PSObject.Properties.Name | Select-Object -First 5) -join ', '
                Write-Warning "Gemini: unexpected response shape (top-level keys: $TopKeys). Expected candidates[].content.parts[].text"
                return $null
            }
        }
        'claude' {
            try {
                $Text = ($Response.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text
                $Truncated = ($Response.stop_reason -eq 'max_tokens')
                $u = $Response.usage
                if ($u) {
                    $Usage = [PSCustomObject]@{
                        InputTokens  = [int]($u.input_tokens)
                        OutputTokens = [int]($u.output_tokens)
                        TotalTokens  = [int]($u.input_tokens) + [int]($u.output_tokens)
                    }
                }
            } catch {
                $TopKeys = ($Response.PSObject.Properties.Name | Select-Object -First 5) -join ', '
                Write-Warning "Claude: unexpected response shape (top-level keys: $TopKeys). Expected content[].text"
                return $null
            }
        }
        'groq' {
            try {
                $Choice = $Response.choices[0]
                $Text = $Choice.message.content
                $Truncated = ($Choice.finish_reason -eq 'length')
                $u = $Response.usage
                if ($u) {
                    $Usage = [PSCustomObject]@{
                        InputTokens  = [int]($u.prompt_tokens)
                        OutputTokens = [int]($u.completion_tokens)
                        TotalTokens  = [int]($u.total_tokens)
                    }
                }
            } catch {
                $TopKeys = ($Response.PSObject.Properties.Name | Select-Object -First 5) -join ', '
                Write-Warning "Groq: unexpected response shape (top-level keys: $TopKeys). Expected choices[].message.content"
                return $null
            }
        }
        # t/1437 — z.ai / GLM-5.3 response shape mirrors Groq/OpenAI.
        'zai' {
            try {
                $Choice = $Response.choices[0]
                $Text = $Choice.message.content
                $Truncated = ($Choice.finish_reason -eq 'length')
                $u = $Response.usage
                if ($u) {
                    $Usage = [PSCustomObject]@{
                        InputTokens  = [int]($u.prompt_tokens)
                        OutputTokens = [int]($u.completion_tokens)
                        TotalTokens  = [int]($u.total_tokens)
                    }
                }
            } catch {
                $TopKeys = ($Response.PSObject.Properties.Name | Select-Object -First 5) -join ', '
                Write-Warning "z.ai: unexpected response shape (top-level keys: $TopKeys). Expected choices[].message.content"
                return $null
            }
        }
        # t/1936 — Moonshot (Kimi) response shape mirrors Groq/z.ai/OpenAI.
        'moonshot' {
            try {
                $Choice = $Response.choices[0]
                $Text = $Choice.message.content
                $Truncated = ($Choice.finish_reason -eq 'length')
                $u = $Response.usage
                if ($u) {
                    $Usage = [PSCustomObject]@{
                        InputTokens  = [int]($u.prompt_tokens)
                        OutputTokens = [int]($u.completion_tokens)
                        TotalTokens  = [int]($u.total_tokens)
                    }
                }
            } catch {
                $TopKeys = ($Response.PSObject.Properties.Name | Select-Object -First 5) -join ', '
                Write-Warning "Moonshot: unexpected response shape (top-level keys: $TopKeys). Expected choices[].message.content"
                return $null
            }
        }
        # t/2583 — xAI (Grok) response shape mirrors Groq/z.ai/OpenAI.
        'xai' {
            try {
                $Choice = $Response.choices[0]
                $Text = $Choice.message.content
                $Truncated = ($Choice.finish_reason -eq 'length')
                $u = $Response.usage
                if ($u) {
                    $Usage = [PSCustomObject]@{
                        InputTokens  = [int]($u.prompt_tokens)
                        OutputTokens = [int]($u.completion_tokens)
                        TotalTokens  = [int]($u.total_tokens)
                    }
                }
            } catch {
                $TopKeys = ($Response.PSObject.Properties.Name | Select-Object -First 5) -join ', '
                Write-Warning "xAI: unexpected response shape (top-level keys: $TopKeys). Expected choices[].message.content"
                return $null
            }
        }
        # t/1938 — DeepSeek's /v1/chat/completions mirrors the Groq/OpenAI response shape.
        'deepseek' {
            try {
                $Choice = $Response.choices[0]
                $Text = $Choice.message.content
                $Truncated = ($Choice.finish_reason -eq 'length')
                $u = $Response.usage
                if ($u) {
                    $Usage = [PSCustomObject]@{
                        InputTokens  = [int]($u.prompt_tokens)
                        OutputTokens = [int]($u.completion_tokens)
                        TotalTokens  = [int]($u.total_tokens)
                    }
                }
            } catch {
                $TopKeys = ($Response.PSObject.Properties.Name | Select-Object -First 5) -join ', '
                Write-Warning "DeepSeek: unexpected response shape (top-level keys: $TopKeys). Expected choices[].message.content"
                return $null
            }
        }
        # t/1409 — Ollama's /v1/chat/completions mirrors the Groq/OpenAI response shape.
        'ollama' {
            try {
                $Choice = $Response.choices[0]
                $Text = $Choice.message.content
                $Truncated = ($Choice.finish_reason -eq 'length')
                $u = $Response.usage
                if ($u) {
                    $Usage = [PSCustomObject]@{
                        InputTokens  = [int]($u.prompt_tokens)
                        OutputTokens = [int]($u.completion_tokens)
                        TotalTokens  = [int]($u.total_tokens)
                    }
                }
            } catch {
                $TopKeys = ($Response.PSObject.Properties.Name | Select-Object -First 5) -join ', '
                Write-Warning "Ollama: unexpected response shape (top-level keys: $TopKeys). Expected choices[].message.content"
                return $null
            }
        }
        'azure' {
            try {
                $Choice = $Response.choices[0]
                $Text = $Choice.message.content
                $Truncated = ($Choice.finish_reason -eq 'length')
                $u = $Response.usage
                if ($u) {
                    $Usage = [PSCustomObject]@{
                        InputTokens  = [int]($u.prompt_tokens)
                        OutputTokens = [int]($u.completion_tokens)
                        TotalTokens  = [int]($u.total_tokens)
                    }
                }
            } catch {
                $TopKeys = ($Response.PSObject.Properties.Name | Select-Object -First 5) -join ', '
                Write-Warning "Azure OpenAI: unexpected response shape (top-level keys: $TopKeys). Expected choices[].message.content"
                return $null
            }
        }
        'openai' {
            try {
                $MsgOutput = $Response.output | Where-Object { $_.type -eq 'message' } | Select-Object -First 1
                $Text = ($MsgOutput.content | Where-Object { $_.type -eq 'output_text' } | Select-Object -First 1).text
                $Truncated = ($Response.status -eq 'incomplete')
                $u = $Response.usage
                if ($u) {
                    $Usage = [PSCustomObject]@{
                        InputTokens  = [int]($u.input_tokens)
                        OutputTokens = [int]($u.output_tokens)
                        TotalTokens  = [int]($u.total_tokens)
                    }
                }
            } catch {
                $TopKeys = ($Response.PSObject.Properties.Name | Select-Object -First 5) -join ', '
                Write-Warning "OpenAI: unexpected response shape (top-level keys: $TopKeys). Expected output[].content[].text"
                return $null
            }
        }
    }

    if ($Truncated) {
        Write-Warning "$($Backend): response was truncated (max_tokens reached). Output may be incomplete."
    }

    return [PSCustomObject]@{
        Text        = $Text
        Backend     = $Backend
        Model       = $Model
        Truncated   = $Truncated
        Usage       = $Usage
        RawResponse = $Response
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Get-AIMetadata — generalized metadata enrichment
#
# Sends the first ~6,000 words of the document to an AI backend and asks it
# to extract structured metadata.  Returns a hashtable with:
#   title, authors, date_published, pov_tags, topic_tags, one_liner
# On any failure returns $null.
# ─────────────────────────────────────────────────────────────────────────────
<#
.SYNOPSIS
    Extracts structured metadata from a document using AI.
.DESCRIPTION
    Sends the first ~6,000 words of a Markdown document to an AI backend and
    asks it to extract structured metadata including title, authors, publication
    date, POV tags, topic tags, and a one-line summary.

    The metadata-extraction prompt is loaded from Prompts/metadata-extraction.prompt.
    POV tags are validated against the four canonical values (accelerationist,
    safetyist, skeptic, cross-cutting); unrecognized tags are rejected with a
    warning.  Topic tags are normalized to lowercase slugs.

    Returns a hashtable with: title, authors, date_published, pov_tags,
    topic_tags, one_liner.  Returns $null on any AI or parsing failure.
.PARAMETER MarkdownText
    The full Markdown text of the document.  Only the first ~6,000 words are
    sent to keep token costs low.
.PARAMETER SourceUrl
    Original URL for context (helps the AI identify the source).
.PARAMETER FallbackTitle
    A heuristic title extracted from HTML or filename, used if AI extraction
    fails.  Defaults to empty string.
.PARAMETER Model
    AI model to use for extraction.  Defaults to 'gemini-2.5-flash-lite' (fast
    and cheap for metadata tasks).
.PARAMETER ApiKey
    Optional explicit API key.  If empty, resolved via Resolve-AIApiKey.
.EXAMPLE
    $Meta = Get-AIMetadata -MarkdownText $Snapshot -SourceUrl 'https://example.com/paper'
    Write-Host "Title: $($Meta.title), POVs: $($Meta.pov_tags -join ', ')"

.EXAMPLE
    $Meta = Get-AIMetadata -MarkdownText $md -FallbackTitle 'Unknown Paper' -Model 'gemini-2.5-flash'

    Uses a faster model with a fallback title.
#>
function Get-AIMetadata {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$MarkdownText,
        [string]$SourceUrl     = '',
        [string]$FallbackTitle = '',
        [string]$Model         = 'gemini-2.5-flash-lite',
        [string]$ApiKey        = ''
    )

    $BackendLabel = $Model
    $ModelInfo = $script:ModelRegistry[$Model]
    if ($ModelInfo) { $BackendLabel = "$($ModelInfo.Backend)/$Model" }

    Write-Host "`n▶  Calling AI for metadata enrichment ($BackendLabel)" -ForegroundColor Cyan

    # Truncate to ~6,000 words to keep token cost low
    $Words   = $MarkdownText -split '\s+'
    if ($Words.Count -gt 6000) {
        $Excerpt = ($Words[0..5999] -join ' ') + "`n`n[... truncated for metadata extraction ...]"
    } else {
        $Excerpt = $MarkdownText
    }

    # Dev layout: scripts/AITriad/Prompts/; PSGallery: Prompts/ (flat)
    $PromptPath = Join-Path (Join-Path (Join-Path $PSScriptRoot 'AITriad') 'Prompts') 'metadata-extraction.prompt'
    if (-not (Test-Path $PromptPath)) {
        $PromptPath = Join-Path (Join-Path $PSScriptRoot 'Prompts') 'metadata-extraction.prompt'
    }
    $StaticPrompt = (Get-Content -Path $PromptPath -Raw).TrimEnd()

    $Prompt = @"
$StaticPrompt

SOURCE URL (for context): $SourceUrl
FALLBACK TITLE (from heuristics, improve if possible): $FallbackTitle

DOCUMENT EXCERPT:
$Excerpt
"@

    $InitialMaxTokens = 1024
    # t/1261: route through UsageID registry when AITriad is loaded (which owns
    # Invoke-AIByUsage). Falls back to direct Invoke-AIApi when AIEnrich is used
    # standalone (tests, or dev sessions without AITriad).
    if (Get-Command Invoke-AIByUsage -ErrorAction SilentlyContinue) {
        $AIResult = Invoke-AIByUsage -UsageId 'enrichment.metadata-extraction' `
            -Values @{ prompt = $Prompt } `
            -Override @{
                messageTemplate = '{{prompt}}'
                systemMessage   = ''
                model           = $Model
                maxTokens       = $InitialMaxTokens
                temperature     = 0.1
                jsonMode        = $true
            } `
            -ApiKey $ApiKey
    } else {
        $AIResult = Invoke-AIApi -Prompt $Prompt -Model $Model -ApiKey $ApiKey -Temperature 0.1 -MaxTokens $InitialMaxTokens -JsonMode
    }
    if ($null -eq $AIResult) { return $null }

    $RawText = $AIResult.Text

    # Strip markdown fences defensively
    $CleanJson = $RawText `
        -replace '(?s)^```json\s*', '' `
        -replace '(?s)\s*```$',     '' `
        | ForEach-Object { $_.Trim() }

    $Parsed = $null
    try {
        $Parsed = $CleanJson | ConvertFrom-Json -ErrorAction Stop
    } catch {
        if ($AIResult.Truncated) {
            Write-Warning "$($AIResult.Backend): metadata response truncated at $InitialMaxTokens tokens — attempting repair"
            $Repaired = Repair-TruncatedJson -Text $RawText
            if ($Repaired) {
                try {
                    $Parsed = $Repaired | ConvertFrom-Json -ErrorAction Stop
                    Write-Verbose 'Repair-TruncatedJson succeeded'
                } catch { }
            }
            if ($null -eq $Parsed) {
                Write-Warning "$($AIResult.Backend): repair failed — retrying with higher token limit"
                # t/1261: retry path — UsageID when AITriad loaded, fallback otherwise
                if (Get-Command Invoke-AIByUsage -ErrorAction SilentlyContinue) {
                    $RetryResult = Invoke-AIByUsage -UsageId 'enrichment.metadata-extraction' `
                        -Values @{ prompt = $Prompt } `
                        -Override @{
                            messageTemplate = '{{prompt}}'
                            systemMessage   = ''
                            model           = $Model
                            maxTokens       = 2048
                            temperature     = 0.1
                            jsonMode        = $true
                        } `
                        -ApiKey $ApiKey
                } else {
                    $RetryResult = Invoke-AIApi -Prompt $Prompt -Model $Model -ApiKey $ApiKey -Temperature 0.1 -MaxTokens 2048 -JsonMode
                }
                if ($RetryResult) {
                    $RetryJson = $RetryResult.Text `
                        -replace '(?s)^```json\s*', '' `
                        -replace '(?s)\s*```$',     '' `
                        | ForEach-Object { $_.Trim() }
                    try {
                        $Parsed = $RetryJson | ConvertFrom-Json -ErrorAction Stop
                    } catch {
                        Write-Warning "$($RetryResult.Backend): retry also failed — metadata enrichment skipped"
                        Write-Verbose "Raw AI response (retry): $($RetryResult.Text)"
                    }
                }
            }
        } else {
            Write-Warning "$($AIResult.Backend): response was not valid JSON — metadata enrichment skipped"
            Write-Verbose "Raw AI response: $RawText"
        }
    }
    if ($null -eq $Parsed) { return $null }

    # Validate pov_tags
    $ValidPovs    = @('accelerationist', 'safetyist', 'skeptic', 'cross-cutting', 'situations')
    $FilteredPovs = @()
    if ($Parsed.pov_tags) {
        $FilteredPovs = @($Parsed.pov_tags | Where-Object { $_ -in $ValidPovs })
        $Rejected = @($Parsed.pov_tags | Where-Object { $_ -notin $ValidPovs })
        if ($Rejected.Count -gt 0) {
            Write-Warning "AI returned unrecognised POV tags (ignored): $($Rejected -join ', ')"
        }
    }

    # Normalise topic_tags to lowercase slugs
    $NormTopics = @()
    if ($Parsed.topic_tags) {
        $NormTopics = @($Parsed.topic_tags | ForEach-Object {
            $_.ToLower() -replace '[^\w\-]', '-' -replace '-{2,}', '-' | ForEach-Object { $_.Trim('-') }
        } | Where-Object { $_ })
    }

    # Validate date_published format (gap 2.1): accept YYYY, YYYY-MM, YYYY-MM-DD
    $ValidDate = $null
    if ($Parsed.date_published) {
        $dp = "$($Parsed.date_published)".Trim()
        if ($dp -match '^\d{4}(-\d{2}(-\d{2})?)?$') {
            $ValidDate = $dp
        } else {
            [datetime]$parsedDt = [datetime]::MinValue
            $fmts = @('MMMM yyyy', 'MMM yyyy', 'MMMM d, yyyy', 'MMM d, yyyy',
                       'd MMMM yyyy', 'd MMM yyyy', 'MM/dd/yyyy', 'dd/MM/yyyy',
                       'yyyy/MM/dd', 'MMMM dd, yyyy', 'MMM dd, yyyy')
            foreach ($fmt in $fmts) {
                if ([datetime]::TryParseExact($dp, $fmt,
                        [System.Globalization.CultureInfo]::InvariantCulture,
                        [System.Globalization.DateTimeStyles]::None, [ref]$parsedDt)) {
                    $ValidDate = $parsedDt.ToString('yyyy-MM-dd')
                    Write-Verbose "Normalized date_published '$dp' → '$ValidDate'"
                    break
                }
            }
            if (-not $ValidDate) {
                Write-Warning "AI returned unrecognised date_published format: '$dp' — field cleared"
            }
        }
    }

    # Enforce title/one_liner length limits (gap 2.2)
    $Title = if ($Parsed.title) { "$($Parsed.title)".Trim() } else { '' }
    if ($Title.Length -gt 200) {
        $Title = $Title.Substring(0, 197) + '...'
        Write-Warning "AI returned title exceeding 200 chars — truncated"
    }
    if (-not $Title -and $FallbackTitle) { $Title = $FallbackTitle }

    $OneLiner = if ($Parsed.one_liner) { "$($Parsed.one_liner)".Trim() } else { '' }
    if ($OneLiner.Length -gt 300) {
        $OneLiner = $OneLiner.Substring(0, 297) + '...'
        Write-Warning "AI returned one_liner exceeding 300 chars — truncated"
    }

    # Deduplicate authors on normalized lowercase (gap 2.3)
    $Authors = @()
    if ($Parsed.authors) {
        $seen = @{}
        foreach ($a in $Parsed.authors) {
            $key = "$a".Trim().ToLower()
            if ($key -and -not $seen.ContainsKey($key)) {
                $seen[$key] = $true
                $Authors += "$a".Trim()
            }
        }
        $dupeCount = @($Parsed.authors).Count - $Authors.Count
        if ($dupeCount -gt 0) {
            Write-Warning "AI returned $dupeCount duplicate author(s) — deduplicated"
        }
    }

    Write-Host "   ✓  AI metadata: title='$Title'  povs=[$($FilteredPovs -join ',')]  topics=[$($NormTopics -join ',')]" -ForegroundColor Green

    return @{
        title          = $Title
        authors        = $Authors
        date_published = $ValidDate
        pov_tags       = $FilteredPovs
        topic_tags     = $NormTopics
        one_liner      = $OneLiner
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Repair-TruncatedJson
#
# Attempts to salvage a JSON string that was truncated mid-output by closing
# any open strings, arrays, and objects.  Returns $null if repair fails.
# ─────────────────────────────────────────────────────────────────────────────
<#
.SYNOPSIS
    Attempts to salvage truncated or malformed JSON from AI responses.
.DESCRIPTION
    AI models sometimes produce JSON that is cut off mid-output due to token
    limits.  This function attempts to repair such output using two strategies:

    Strategy 1 — Close the truncated tail.  If the text is mid-string, closes
    the quote.  Strips trailing commas, colons, and dangling keys.  Rescans for
    open brackets/braces and appends the necessary closing characters.

    Strategy 2 — Truncate back to the last position where the root JSON object
    was fully closed (a complete, valid document).

    Returns the repaired JSON string if either strategy produces valid JSON.
    Returns $null if repair is not possible.
.PARAMETER Text
    The raw (possibly truncated) JSON text to repair.  May include markdown
    code fences, which are stripped automatically.
.EXAMPLE
    $Fixed = Repair-TruncatedJson -Text '{"key": "value", "arr": [1, 2'
    # Returns: '{"key": "value", "arr": [1, 2]}'

.EXAMPLE
    $Fixed = Repair-TruncatedJson -Text $AIResult.Text
    if ($Fixed) { $Obj = $Fixed | ConvertFrom-Json }
#>
function Repair-TruncatedJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Text
    )

    $trimmed = $Text.Trim()

    # Already valid?
    try {
        $null = $trimmed | ConvertFrom-Json -ErrorAction Stop
        return $trimmed
    } catch { }

    # Strip markdown fences if present
    $trimmed = $trimmed -replace '(?s)^```json\s*', '' -replace '(?s)\s*```$', ''
    $trimmed = $trimmed.Trim()

    # Fix trailing commas before } or ] (common LLM output issue)
    $commaFixed = $trimmed -replace ',\s*([\]\}])', '$1'
    if ($commaFixed -ne $trimmed) {
        try {
            $null = $commaFixed | ConvertFrom-Json -ErrorAction Stop
            return $commaFixed
        } catch { }
        $trimmed = $commaFixed   # keep the fix for subsequent strategies
    }

    # Walk the string tracking nesting depth
    $inString  = $false
    $escaped   = $false
    $stack     = [System.Collections.Generic.Stack[char]]::new()
    $lastGood  = -1   # index of last position where a value/element ended cleanly

    for ($i = 0; $i -lt $trimmed.Length; $i++) {
        $c = $trimmed[$i]

        if ($inString) {
            if ($escaped)       { $escaped = $false; continue }
            if ($c -eq '\')     { $escaped = $true;  continue }
            if ($c -eq '"')     { $inString = $false; continue }
            continue
        }

        switch ($c) {
            '"'  { $inString = $true }
            '{'  { $stack.Push('}') }
            '['  { $stack.Push(']') }
            '}'  {
                if ($stack.Count -gt 0 -and $stack.Peek() -eq '}') {
                    [void]$stack.Pop()
                    if ($stack.Count -eq 0) { $lastGood = $i }
                }
            }
            ']'  {
                if ($stack.Count -gt 0 -and $stack.Peek() -eq ']') {
                    [void]$stack.Pop()
                    if ($stack.Count -eq 0) { $lastGood = $i }
                }
            }
        }
    }

    # Strategy 1: close truncated tail then close all remaining open structures.
    # Try progressively stripping back to find a valid boundary.
    if ($stack.Count -gt 0) {
        $repaired = $trimmed
        # If truncated mid-string, close the string
        if ($inString) {
            $repaired += '"'
        }
        # Remove trailing whitespace/comma/colon, then dangling key or incomplete value
        $repaired = $repaired -replace '[,:\s]+$', ''
        # Strip dangling key ("key") left after removing colon
        $repaired = $repaired -replace ',\s*"[^"]*"\s*$', ''
        # Strip dangling key at start of an object: { "key" → {
        $repaired = $repaired -replace '(\{)\s*"[^"]*"\s*$', '$1'

        # Re-scan for open structures after trimming
        $reStack = [System.Collections.Generic.Stack[char]]::new()
        $reInStr = $false; $reEsc = $false
        for ($j = 0; $j -lt $repaired.Length; $j++) {
            $rc = $repaired[$j]
            if ($reInStr) {
                if ($reEsc) { $reEsc = $false; continue }
                if ($rc -eq '\') { $reEsc = $true; continue }
                if ($rc -eq '"') { $reInStr = $false }
                continue
            }
            switch ($rc) {
                '"' { $reInStr = $true }
                '{' { $reStack.Push('}') }
                '[' { $reStack.Push(']') }
                '}' { if ($reStack.Count -gt 0 -and $reStack.Peek() -eq '}') { [void]$reStack.Pop() } }
                ']' { if ($reStack.Count -gt 0 -and $reStack.Peek() -eq ']') { [void]$reStack.Pop() } }
            }
        }
        # Close all remaining open brackets/braces
        while ($reStack.Count -gt 0) {
            $repaired += $reStack.Pop()
        }
        try {
            $null = $repaired | ConvertFrom-Json -ErrorAction Stop
            return $repaired
        } catch { }
    }

    # Strategy 2: truncate back to the last position where the root object
    # was fully closed, if we found one
    if ($lastGood -gt 0) {
        $candidate = $trimmed.Substring(0, $lastGood + 1)
        try {
            $null = $candidate | ConvertFrom-Json -ErrorAction Stop
            return $candidate
        } catch { }
    }

    return $null
}

# ─────────────────────────────────────────────────────────────────────────────
# Backward-compatibility aliases
# ─────────────────────────────────────────────────────────────────────────────
Set-Alias -Name 'Invoke-GeminiApi'   -Value 'Invoke-AIApi'
Set-Alias -Name 'Get-GeminiMetadata' -Value 'Get-AIMetadata'

Export-ModuleMember -Function Invoke-AIApi, Get-AIMetadata, Resolve-AIApiKey, Get-AIApiKeySource, Test-AIApiKeyGeminiOnlyRefusal, Repair-TruncatedJson, Measure-PromptTokens, Set-AIApiCorrelationId, Protect-SensitiveText `
                    -Alias    Invoke-GeminiApi, Get-GeminiMetadata
