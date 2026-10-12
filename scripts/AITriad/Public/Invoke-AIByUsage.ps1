# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

function Invoke-AIByUsage {
    <#
    .SYNOPSIS
        Invoke an AI model by UsageID. Resolves parameters from ai-usages.json
        and delegates to Invoke-AIApi.
    .DESCRIPTION
        Central entry point for the UsageID pattern in PowerShell. Reads the
        registry at repo-root/ai-usages.json, resolves the UsageID (with
        _extends chain), renders any {{var}} templates from -Values, applies
        the optional -Override hashtable, then splats the resulting parameters
        into Invoke-AIApi.

        Delegating to Invoke-AIApi preserves the existing multi-backend routing
        (Gemini/Claude/Groq/OpenAI/Azure), retry with fallback model chains,
        key rotation via Resolve-AIApiKey, and pre-flight token check.
        Invoke-AIByUsage is a config resolver, not a replacement executor.

        Design mirrors the TypeScript server-side generateTextByUsage pattern
        (t/1262) — see docs/design/adr/ for rationale.
    .PARAMETER UsageId
        Identifier from ai-usages.json (e.g., 'enrichment.metadata-extraction').
        Tab-completes against the top-level keys in ai-usages.json.
    .PARAMETER Values
        Hashtable of template placeholder values. Every {{var}} in
        messageTemplate/systemMessageTemplate must have a matching key or
        an ActionableError is thrown at render time.
    .PARAMETER Override
        Optional hashtable of per-call parameter overrides. Keys supported:
        model, temperature, maxTokens, timeoutMs, jsonMode, responseSchema,
        systemMessage. Useful for experimentation without touching ai-usages.json.
    .PARAMETER ApiKey
        Explicit API key. If empty, Invoke-AIApi resolves via Resolve-AIApiKey.
    .PARAMETER FallbackModels
        Explicit fallback chain. If omitted, Invoke-AIApi uses the chain
        declared in ai-models.json for the resolved model.
    .OUTPUTS
        The result object from Invoke-AIApi (six-property .Text/.Backend/etc).
    .EXAMPLE
        Invoke-AIByUsage -UsageId 'enrichment.metadata-extraction' -Values @{
            source_url = 'https://example.com/doc'
            fallback_title = 'Untitled'
            markdown_text = $Doc.Content
        }
    .EXAMPLE
        Invoke-AIByUsage -UsageId 'enrichment.vernacular-description' `
            -Values @{ node_id='acc-b-001'; description='...'; category='belief' } `
            -Override @{ temperature = 0.3 }
    .LINK
        Show-AITriadHelp
    .LINK
        Invoke-BDIWeightAssignment
    .LINK
        Invoke-EdgeWeightEvaluation
    .LINK
        Invoke-VernacularBatch
    .LINK
        Invoke-AphorismBatch
    .LINK
        New-SyntheticCorpus
    #>
    [CmdletBinding()]
    [OutputType([PSCustomObject])]
    param(
        [Parameter(Mandatory)]
        [ArgumentCompleter({
            param($cmd, $param, $wordToComplete)
            $reg = Get-UsageRegistry -ErrorAction SilentlyContinue
            if (-not $reg) { return }
            $reg.PSObject.Properties.Name |
                Where-Object { $_ -notmatch '^_' -and $_ -like "$wordToComplete*" } |
                Sort-Object
        })]
        [ValidateNotNullOrEmpty()]
        [string]$UsageId,

        [hashtable]$Values = @{},

        [hashtable]$Override = @{},

        [string]$ApiKey = '',

        [string[]]$FallbackModels,

        # t/3242 — AI Call Log Scenario tag (e.g. Debate / Chat / Fact Check / Logical Form).
        # Defaults to the UsageId when unset so the logged Scenario is never blank.
        [string]$Scenario = ''
    )

    Set-StrictMode -Version Latest

    # Resolve config with _extends chain
    $config = Get-UsageConfig -UsageId $UsageId

    # Apply -Override on top of resolved config
    foreach ($k in @($Override.Keys)) {
        $config[$k] = $Override[$k]
    }

    # t/1552 — Lint: {{placeholders}} in a non-template field are the classic
    # silent-no-substitution footgun (t/1550#3). Warn naming the field and
    # its intended *Template counterpart. Warning not error — a literal
    # {{...}} in prompt text is conceivable, so don't hard-fail.
    $literalFields = @{ systemMessage = 'systemMessageTemplate'; message = 'messageTemplate' }
    foreach ($k in $literalFields.Keys) {
        if ($config.ContainsKey($k) -and $config[$k] -and ([string]$config[$k]) -match '\{\{[^{}]+\}\}') {
            Write-Warning "UsageID '$UsageId' field '$k' contains {{placeholder}} syntax but is not rendered — placeholders in this field are passed to the model literally. Rename the field to '$($literalFields[$k])' to enable substitution, or remove the {{...}} if the literal text is intentional."
        }
    }

    # Render templates
    $systemMessage = ''
    if ($config.ContainsKey('systemMessageTemplate') -and $config['systemMessageTemplate']) {
        $systemMessage = Convert-UsageTemplate -Template ([string]$config['systemMessageTemplate']) -Values $Values -UsageIdContext $UsageId
    } elseif ($config.ContainsKey('systemMessage') -and $config['systemMessage']) {
        $systemMessage = [string]$config['systemMessage']
    }

    $userMessage = ''
    if ($config.ContainsKey('messageTemplate') -and $config['messageTemplate']) {
        $userMessage = Convert-UsageTemplate -Template ([string]$config['messageTemplate']) -Values $Values -UsageIdContext $UsageId
    } elseif ($config.ContainsKey('message') -and $config['message']) {
        $userMessage = [string]$config['message']
    }

    if ([string]::IsNullOrWhiteSpace($userMessage)) {
        throw (New-ActionableError -PassThru `
            -Goal 'Invoke AI by UsageID' `
            -Problem "UsageID '$UsageId' produced an empty user message after template rendering" `
            -Location 'Invoke-AIByUsage' `
            -NextSteps @(
                "Confirm messageTemplate or message is defined for '$UsageId' in ai-usages.json",
                'Confirm -Values populates every {{var}} in the template'
            ))
    }

    if (-not $config.ContainsKey('model')) {
        throw (New-ActionableError -PassThru `
            -Goal 'Invoke AI by UsageID' `
            -Problem "UsageID '$UsageId' does not declare a model" `
            -Location 'Invoke-AIByUsage' `
            -NextSteps @("Add a 'model' field to the '$UsageId' entry in ai-usages.json"))
    }

    # Build Invoke-AIApi parameter splat
    $invokeParams = @{
        Prompt = $userMessage
        Model  = [string]$config['model']
    }
    if ($systemMessage) { $invokeParams['SystemInstruction'] = $systemMessage }
    if (-not [string]::IsNullOrWhiteSpace($ApiKey)) { $invokeParams['ApiKey'] = $ApiKey }
    if ($config.ContainsKey('temperature'))         { $invokeParams['Temperature'] = [double]$config['temperature'] }
    if ($config.ContainsKey('maxTokens'))           { $invokeParams['MaxTokens']   = [int]$config['maxTokens'] }
    if ($config.ContainsKey('timeoutMs'))           { $invokeParams['TimeoutSec']  = [int]([math]::Ceiling(([int]$config['timeoutMs']) / 1000.0)) }
    if ($config.ContainsKey('jsonMode') -and [bool]$config['jsonMode']) { $invokeParams['JsonMode'] = [switch]::Present }
    if ($config.ContainsKey('responseSchema')) {
        # Response schema may be a hashtable or PSCustomObject from JSON; coerce to hashtable
        $schema = $config['responseSchema']
        if ($schema -is [hashtable]) {
            $invokeParams['ResponseSchema'] = $schema
        } elseif ($schema -is [PSCustomObject]) {
            $invokeParams['ResponseSchema'] = $schema | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
        }
    }
    if ($PSBoundParameters.ContainsKey('FallbackModels')) {
        $invokeParams['FallbackModels'] = $FallbackModels
    }

    Write-Verbose "Invoke-AIByUsage: UsageID='$UsageId' → Model='$($invokeParams.Model)' Temp=$($invokeParams['Temperature']) MaxTokens=$($invokeParams['MaxTokens'])"

    # t/3242 — AI Call Log capture (IoC, TL ruling t/3242#2). Invoke-AIApi lives in a SEPARATE module
    # (AIEnrich) and invokes the logger via `& $CallLogger`; a cross-module `&` runs the block in the
    # CALLER's scope, where the AITriad-private Write-AICallLogEntry is NOT resolvable by name (and
    # resolving a private function via Get-Command is environment-fragile). So the injected closure only
    # APPENDS (RetryCount, Status) to a captured list — a pure, scope-safe op — and we WRITE the records
    # HERE afterward, in AITriad scope where Write-AICallLogEntry resolves natively. The closure fires
    # inside Invoke-AIApi BEFORE its failure $null-return, so failures are captured; the cascade forwards
    # the same closure, so each fallback attempt appends its own entry (one record per attempt).
    # Gated on Test-AICallLogEnabled so the flag-off path adds no logger and no overhead.
    $logEntries = $null
    if (Test-AICallLogEnabled) {
        $logScenario    = if ($Scenario) { $Scenario } else { $UsageId }
        $logPromptStart = $userMessage
        $logEntries     = [System.Collections.Generic.List[object]]::new()
        # t/4088: the third argument carries the model and backend ACTUALLY called (each cascade link
        # passes its own) and where its key came from.
        $invokeParams['CallLogger'] = {
            param($RetryCount, $Status, $Context)
            $logEntries.Add([pscustomobject]@{ RetryCount = $RetryCount; Status = $Status; Context = $Context })
        }.GetNewClosure()
    }

    $result = Invoke-AIApi @invokeParams

    if ($null -ne $logEntries -and $logEntries.Count -gt 0) {
        foreach ($e in $logEntries) {
            # Fail-safe: an audit-log write must never break the AI call it audits.
            try {
                $ctx = $e.Context
                $ctxModel     = if ($ctx -and $ctx.PSObject.Properties['Model'])     { [string]$ctx.Model }     else { '' }
                $ctxBackend   = if ($ctx -and $ctx.PSObject.Properties['Backend'])   { [string]$ctx.Backend }   else { '' }
                $ctxKeySource = if ($ctx -and $ctx.PSObject.Properties['KeySource']) { [string]$ctx.KeySource } else { '' }
                if (-not $ctx) {
                    Write-Warning "Invoke-AIByUsage: Invoke-AIApi passed no call context; logging Model/Backend/KeySource as '' (t/4088)."
                }
                Write-AICallLogEntry -Scenario $logScenario -PromptID $UsageId `
                    -PromptStart $logPromptStart -RetryCount $e.RetryCount -Status $e.Status `
                    -Model $ctxModel -Backend $ctxBackend -KeySource $ctxKeySource
            }
            catch { Write-Warning "Invoke-AIByUsage: AI call-log write failed ($($_.Exception.Message)); continuing." }
        }
    }

    return $result
}
